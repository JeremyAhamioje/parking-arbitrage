import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const db = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
)

// Baseline-relative, event-aware change detection.
//
// Reads the facility_stats summary layer the scrapers already maintain — every
// row carries a rolling price_history window, latest/prev price + spaces and the
// real venue_id — so we DON'T depend on the parking_snapshots/venue_signals tables
// (which were never created in prod). A lot "spikes" when its current price is far
// from ITS OWN recent baseline (z-score), scaled by how noisy that lot usually is,
// past absolute/percent floors. Inventory drops use the prev→latest spaces delta.
// A cooldown over the alerts table debounces repeats AND dedups against the inline
// alerts the scrapers raise. Correlating a move with a nearby Ticketmaster event
// turns a bare stat into "price climbing AND a show in 9 days — secure now".
const Z_THRESHOLD            = parseFloat(process.env.ALERT_Z_THRESHOLD || '2.5')
const MIN_SAMPLES            = parseInt(process.env.ALERT_MIN_SAMPLES || '3', 10)      // baseline points (history minus latest)
const MIN_ABS_PRICE_MOVE     = parseFloat(process.env.ALERT_MIN_ABS_MOVE || '3')
const MIN_PCT_MOVE           = parseFloat(process.env.ALERT_MIN_PCT_MOVE || '12')
const MIN_PRICE_FLOOR        = parseFloat(process.env.ALERT_MIN_PRICE_FLOOR || '5')
const MIN_SPACES_BASE        = parseInt(process.env.ALERT_MIN_SPACES_BASE || '10', 10)
const INVENTORY_DROP_THRESHOLD = parseFloat(process.env.INVENTORY_DROP_THRESHOLD || '40')
const COOLDOWN_HOURS         = parseFloat(process.env.ALERT_COOLDOWN_HOURS || '6')
const EVENT_HORIZON_DAYS     = parseInt(process.env.ALERT_EVENT_HORIZON_DAYS || '21', 10)

const mean = arr => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0)
const stddev = (arr, m) => {
  if (arr.length < 2) return 0
  const mu = m ?? mean(arr)
  return Math.sqrt(arr.reduce((s, x) => s + (x - mu) ** 2, 0) / arr.length)
}
const daysUntil = d => {
  if (!d) return null
  const t = new Date(d).getTime()
  return Number.isNaN(t) ? null : Math.ceil((t - Date.now()) / 86_400_000)
}

async function fetchAll(table, columns, tweak = q => q) {
  const out = []
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await tweak(db.from(table).select(columns)).range(from, from + PAGE - 1)
    if (error) throw new Error(`${table}: ${error.message}`)
    if (!data?.length) break
    out.push(...data)
    if (data.length < PAGE) break
  }
  return out
}

/** venue_id → nearest upcoming event (≤ EVENT_HORIZON_DAYS). The bridge between
 *  price moves and demand: a move that lines up with a known event is signal. */
async function buildUpcomingEventIndex() {
  // Only correlate against Ticketmaster-sourced events: they're venueId-exact, so
  // the venue↔event link is trustworthy. SpotHero-scraped events in this table can
  // be mis-attributed (e.g. a Cubs game showing under MSG), which would produce
  // misleading "secure now" hooks.
  const { data: events } = await db
    .from('events')
    .select('venue_id, event_name, event_date')
    .not('event_date', 'is', null)
    .not('ticketmaster_id', 'is', null)
    .limit(4000)

  // SpotHero is the only platform with no per-lot URL — its alerts can only deep-link
  // to the event MAP (spothero.com/search?kind=event&id=…). The map needs a SpotHero
  // event_id, which the TM rows above don't carry. So index SpotHero's own event-map
  // URLs by venue+date. We DON'T use these to correlate (that's still TM-only, above) —
  // we only ATTACH a map URL when a TM-confirmed event already exists at the SAME
  // venue+date, so the link lands on the right venue's parking for the right date even
  // if SpotHero mislabelled the event. date_only on both sides (TM=date, SH=timestamp).
  const { data: shEvents } = await db
    .from('events')
    .select('venue_id, event_date, source_url')
    .not('event_date', 'is', null)
    .not('source_url', 'is', null)
    .ilike('source_url', '%spothero.com%')
    .limit(4000)
  const shUrlByVenueDate = {}
  for (const e of shEvents || []) {
    const key = `${e.venue_id}|${String(e.event_date).slice(0, 10)}`
    if (!shUrlByVenueDate[key]) shUrlByVenueDate[key] = e.source_url
  }

  const idx = {}
  for (const e of events || []) {
    const d = daysUntil(e.event_date)
    if (d == null || d < 0 || d > EVENT_HORIZON_DAYS) continue
    const cur = idx[e.venue_id]
    if (!cur || d < cur.daysUntil) {
      const key = `${e.venue_id}|${String(e.event_date).slice(0, 10)}`
      idx[e.venue_id] = { name: e.event_name, date: e.event_date, daysUntil: d, spotheroUrl: shUrlByVenueDate[key] || null }
    }
  }
  return idx
}

async function runChangeDetection() {
  console.log('🔍 Starting change detection (facility_stats baseline, event-aware)...\n')

  try {
    const venuesArr = (await db.from('venues').select('id, name')).data || []
    const venueMap = Object.fromEntries(venuesArr.map(v => [v.id, v.name]))
    const eventIndex = await buildUpcomingEventIndex()

    const STAT_COLS = 'venue_id, facility_id, facility_name, address, source, latest_price, prev_price, price_history, latest_spaces, prev_spaces, last_scraped_at'
    // booking_url drives the alert deep link. Tolerate it being un-migrated yet:
    // fall back to the base columns so the z-score pass still runs (alerts just
    // won't carry a link until facility-stats-booking-url.sql is applied).
    let stats
    try {
      stats = await fetchAll('facility_stats', `${STAT_COLS}, booking_url`)
    } catch (e) {
      if (/booking_url/.test(e.message || '')) {
        console.warn('  ⚠ facility_stats.booking_url missing — apply facility-stats-booking-url.sql; alerts have no deep link until then.')
        stats = await fetchAll('facility_stats', STAT_COLS)
      } else throw e
    }
    console.log(`Scanning ${stats.length} facility rows for baseline-relative moves\n`)

    // One cooldown query: facilities alerted within COOLDOWN_HOURS (any alert
    // source) → skip, so we debounce repeats and don't double up on the scraper's
    // own inline alerts.
    const cutoff = new Date(Date.now() - COOLDOWN_HOURS * 3600 * 1000).toISOString()
    const recent = (await db.from('alerts').select('venue_id, facility_id').gte('created_at', cutoff)).data || []
    const onCooldown = new Set(recent.map(a => `${a.venue_id}|${a.facility_id}`))

    let created = 0
    for (const f of stats) {
      const hist = (Array.isArray(f.price_history) ? f.price_history : []).map(Number).filter(n => n > 0)
      const latest = f.latest_price != null ? Number(f.latest_price) : (hist.length ? hist[hist.length - 1] : null)
      if (latest == null) continue

      // Baseline = the window BEFORE the latest observation.
      const baseline = hist.slice(0, -1)

      // --- price spike (z-score vs own baseline) ---
      let isPriceSpike = false, zPrice = null, priceBefore = null, priceChangePct = 0
      if (baseline.length >= MIN_SAMPLES) {
        const mu = mean(baseline), sd = stddev(baseline, mu)
        zPrice = sd > 0 ? (latest - mu) / sd : (latest > mu ? Infinity : 0)
        priceBefore = mu
        priceChangePct = mu > 0 ? ((latest - mu) / mu) * 100 : 0
        isPriceSpike =
          latest >= MIN_PRICE_FLOOR &&
          zPrice >= Z_THRESHOLD &&
          (latest - mu) >= MIN_ABS_PRICE_MOVE &&
          priceChangePct >= MIN_PCT_MOVE
      }

      // --- inventory drop (prev → latest spaces; no spaces history available) ---
      const prevSp = f.prev_spaces != null ? Number(f.prev_spaces) : null
      const curSp = f.latest_spaces != null ? Number(f.latest_spaces) : null
      let isInventoryDrop = false, spaceChangePct = 0
      if (prevSp != null && curSp != null && prevSp >= MIN_SPACES_BASE) {
        spaceChangePct = ((curSp - prevSp) / prevSp) * 100
        isInventoryDrop = spaceChangePct <= -INVENTORY_DROP_THRESHOLD
      }

      if (!isPriceSpike && !isInventoryDrop) continue

      const key = `${f.venue_id}|${f.facility_id}`
      if (onCooldown.has(key)) continue

      const venueName = venueMap[f.venue_id] || 'Unknown'
      const ev = eventIndex[f.venue_id] || null
      const isBoth = isPriceSpike && isInventoryDrop
      const signalType = isBoth ? 'HIGH_PROFILE' : isPriceSpike ? 'PRICE_SPIKE' : 'INVENTORY_DROP'

      const priceFrag = isPriceSpike
        ? `Price up ${Math.abs(priceChangePct).toFixed(0)}% vs its ${baseline.length}-run norm ($${priceBefore.toFixed(2)} → $${latest.toFixed(2)})`
        : ''
      const spaceFrag = isInventoryDrop ? `spaces down ${Math.abs(spaceChangePct).toFixed(0)}% (${prevSp} → ${curSp})` : ''
      const core = [priceFrag, spaceFrag].filter(Boolean).join(', ')
      const eventHook = ev ? ` — ${ev.name} in ${ev.daysUntil}d. Secure passes now.` : ''
      const icon = isBoth ? '🚨' : isPriceSpike ? '📈' : '📉'
      const message = `${icon} ${venueName} — ${f.facility_name || f.address || 'lot'}: ${core}.${eventHook}`

      const { error } = await db.from('alerts').insert({
        // alerts.type enum: price_spike | availability_drop | new_event | price_drop
        type: isPriceSpike ? 'price_spike' : 'availability_drop',
        venue_id: f.venue_id,
        facility_id: String(f.facility_id),
        message,
        metadata: {
          venue_name: venueName,
          facility_name: f.facility_name,
          address: f.address,
          source: f.source,
          signal_type: signalType,
          method: 'zscore',
          // Deep link: exact lot (Way) / venue page (ParkWhiz). NULL for SpotHero
          // (no per-lot URL) — the API's resolveListingUrl labels it by source.
          listing_url: f.booking_url || null,
          z_price: zPrice != null && Number.isFinite(zPrice) ? parseFloat(zPrice.toFixed(2)) : null,
          price_before: priceBefore != null ? parseFloat(priceBefore.toFixed(2)) : null,
          price_after: parseFloat(latest.toFixed(2)),
          price_change_pct: parseFloat(priceChangePct.toFixed(2)),
          delta: priceBefore != null ? parseFloat((latest - priceBefore).toFixed(2)) : null,
          spaces_before: prevSp,
          spaces_after: curSp,
          spaces_change_pct: parseFloat(spaceChangePct.toFixed(2)),
          sample_size: baseline.length,
          event_correlated: !!ev,
          event_name: ev?.name || null,
          event_date: ev?.date || null,
          event_days_until: ev?.daysUntil ?? null,
          // SpotHero event-map for the correlated event. resolveListingUrl only
          // surfaces it when source=spothero (which has no per-lot listing_url);
          // for Way/ParkWhiz their own listing_url wins, so this is a no-op there.
          event_url: ev?.spotheroUrl || null,
          new_scraped_at: f.last_scraped_at, // the "after" run (no exact "before" — z-score over history)
        },
      })
      if (error) { console.error(`  alert insert failed (${venueName} / ${f.facility_id}): ${error.message}`); continue }

      console.log(`  ⭐ [${signalType}${ev ? `, ⟶ ${ev.name} in ${ev.daysUntil}d` : ''}] ${message}`)
      onCooldown.add(key) // don't double-fire within this run for the same lot
      created++
    }

    console.log(`\n✅ Change detection complete. ${created} alert(s) created.`)
  } catch (error) {
    console.error('Change detection failed:', error.message)
    process.exit(1)
  }
}

runChangeDetection()

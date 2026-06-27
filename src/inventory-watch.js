import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

// ---------------------------------------------------------------------------
// Sold-out / inventory-depletion watch.
//
// We list parking on StubHub and buy it from SpotHero/ParkWhiz/Way on
// fulfillment. If a lot sells out on the source platform AFTER we've listed it,
// the StubHub order is unfulfillable — the exact error class that got the account
// flagged. This detector rides the existing event-context scrape: right after a
// platform finishes a run, it diffs THIS run's event-tagged availability against
// the previous run, per (event, lot), and raises an alert the moment a lot that
// was buyable last time is gone or sold out — so the StubHub listing can be pulled
// before it sells.
//
// Data reality (see scrapers): only SpotHero returns a space COUNT. ParkWhiz
// exposes an availability STATUS (unsellable lots are filtered out before storage),
// and Way returns neither. So the UNIVERSAL signal is presence/availability —
// "was buyable last scrape, isn't now" — and for SpotHero we additionally warn on
// THINNING (count falling fast) before it hits zero.
//
// Writes standard rows to the existing `alerts` table (type 'availability_drop',
// metadata.signal_type 'SOLD_OUT' | 'INVENTORY_THINNING'), so they show in the
// in-app alerts feed with no schema change. Fully non-fatal: a failure here must
// never fail the scrape.
// ---------------------------------------------------------------------------

const db = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
)

const COOLDOWN_HOURS       = parseFloat(process.env.SOLDOUT_COOLDOWN_HOURS || '12')      // don't re-alert the same lot
const PREV_RUN_WINDOW_MIN  = parseFloat(process.env.SOLDOUT_PREV_RUN_WINDOW_MIN || '120') // span of the previous run to pull
const THINNING_PCT         = parseFloat(process.env.SOLDOUT_THINNING_PCT || '60')        // SpotHero: spaces drop % to warn
const THINNING_MIN_BASE    = parseInt(process.env.SOLDOUT_THINNING_MIN_BASE || '10', 10)
const COVERAGE_MIN         = parseFloat(process.env.SOLDOUT_MIN_COVERAGE || '0.5')        // disappearance below this run-over-run lot coverage = likely scrape gap → flag unverified

const PLAT_LABEL = { spothero: 'SpotHero', parkwhiz: 'ParkWhiz', way: 'Way' }
const SNAP_COLS = 'event_id, facility_id, facility_name, venue_id, is_available, available_spaces, scraped_at, booking_url'

const daysUntil = d => {
  if (!d) return null
  const t = new Date(d).getTime()
  return Number.isNaN(t) ? null : Math.ceil((t - Date.now()) / 86_400_000)
}

// A row is "buyable" if it's available and (SpotHero only) still has spaces left.
function buyable(source, r) {
  if (r.is_available === false) return false
  if (source === 'spothero' && typeof r.available_spaces === 'number' && r.available_spaces <= 0) return false
  return true
}

// Deterministic, index-friendly pagination. Ordering by scraped_at lets the
// partial index idx_snapshots_event_avail (source, scraped_at DESC) WHERE
// event_id IS NOT NULL serve these range scans; id is the stable tiebreaker so
// pages can't skip/dupe rows that share a timestamp. Without that index this
// seq-scans the (large, growing) snapshots table and can hit the statement
// timeout — see docs / the CREATE INDEX in the repo.
async function fetchAll(columns, tweak = q => q) {
  const out = []
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await tweak(db.from('snapshots').select(columns))
      .order('scraped_at', { ascending: false })
      .order('id', { ascending: false })
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`snapshots: ${error.message}`)
    if (!data?.length) break
    out.push(...data)
    if (data.length < PAGE) break
  }
  return out
}

const groupBy = (rows, key) => {
  const m = {}
  for (const r of rows) (m[r[key]] ||= []).push(r)
  return m
}

// Latest row per facility_id (rows can repeat if a facility appears more than once).
const latestPerFacility = rows => {
  const m = {}
  for (const r of rows) {
    const fid = String(r.facility_id)
    if (!m[fid] || new Date(r.scraped_at) > new Date(m[fid].scraped_at)) m[fid] = r
  }
  return m
}

/**
 * @param {{ source: string, sinceMs: number, dryRun?: boolean }} opts
 *   source  — 'spothero' | 'parkwhiz' | 'way'
 *   sinceMs — run start (ms). Rows scraped_at >= this are "this run".
 *   dryRun  — log would-be alerts without writing (also via SOLDOUT_DRY_RUN=1).
 * @returns {Promise<number>} alerts created
 */
export async function detectInventoryDrops({ source, sinceMs, dryRun = false }) {
  const dry = dryRun || process.env.SOLDOUT_DRY_RUN === '1'

  // Lazy, cached event lookup — only hit for events that actually fire an alert,
  // so we never build a giant id-list query for a run with hundreds of events.
  const eventCache = new Map()
  const getEvent = async id => {
    if (eventCache.has(id)) return eventCache.get(id)
    const { data } = await db.from('events').select('event_name, event_date, source_url').eq('id', id).maybeSingle()
    eventCache.set(id, data || null)
    return data || null
  }

  try {
    const sinceIso = new Date(sinceMs).toISOString()

    // THIS run's event-tagged rows for this platform.
    const curRows = await fetchAll(SNAP_COLS, q =>
      q.eq('source', source).not('event_id', 'is', null).gte('scraped_at', sinceIso))
    if (!curRows.length) { console.log(`  inventory-watch[${source}]: no event rows this run — skipping`); return 0 }

    // Find the previous run (most recent event-scrape before this run) and pull
    // just that run's window — bounded, not a wide scan or a giant IN list.
    const { data: pmax } = await db.from('snapshots').select('scraped_at')
      .eq('source', source).not('event_id', 'is', null).lt('scraped_at', sinceIso)
      .order('scraped_at', { ascending: false }).limit(1)
    if (!pmax?.length) { console.log(`  inventory-watch[${source}]: no prior run to diff against — skipping`); return 0 }
    const prevRunEnd = new Date(pmax[0].scraped_at).getTime()
    const prevWinStartIso = new Date(prevRunEnd - PREV_RUN_WINDOW_MIN * 60_000).toISOString()
    const prevWinEndIso = new Date(prevRunEnd + 1000).toISOString()
    const prevRows = await fetchAll(SNAP_COLS, q =>
      q.eq('source', source).not('event_id', 'is', null).gte('scraped_at', prevWinStartIso).lte('scraped_at', prevWinEndIso))

    const venueMap = Object.fromEntries(((await db.from('venues').select('id, name')).data || []).map(v => [v.id, v.name]))

    // Cooldown: any lot alerted in the last COOLDOWN_HOURS is skipped (debounce +
    // dedupe against the scrapers' inline alerts and change-detection).
    const cutoff = new Date(Date.now() - COOLDOWN_HOURS * 3600_000).toISOString()
    const recent = (await db.from('alerts').select('venue_id, facility_id').gte('created_at', cutoff)).data || []
    const onCooldown = new Set(recent.map(a => `${a.venue_id}|${a.facility_id}`))

    const curByEvent = groupBy(curRows, 'event_id')
    const prevByEvent = groupBy(prevRows, 'event_id')

    // Insert an alert (or just log it, in dry-run). Returns true if it counted.
    const fire = async (row, logLine) => {
      if (dry) { console.log(`  [DRY] ${logLine}`); return true }
      const { error } = await db.from('alerts').insert(row)
      if (error) { console.error(`  inventory-watch alert insert failed: ${error.message}`); return false }
      console.log(`  ${logLine}`)
      return true
    }

    let created = 0
    const counts = { confirmed: 0, likely: 0, unverified: 0 }
    for (const eventId of Object.keys(curByEvent)) {
      const prevBatch = prevByEvent[eventId]
      if (!prevBatch?.length) continue // event not in the previous run → no baseline to diff

      const curMap = latestPerFacility(curByEvent[eventId])
      const prevMap = latestPerFacility(prevBatch)

      // Run-over-run lot coverage for THIS event. If this run saw far fewer lots
      // than the previous run, the scrape was probably partial (soft block / gap),
      // so a lot that "vanished" may not actually be sold out. We DON'T drop those
      // — a missed real sellout is the costlier error (unfulfillable StubHub order)
      // — we down-rank them to 'unverified' so the feed says "verify", not "pull".
      const prevPresent  = Object.keys(prevMap).length
      const curPresent   = Object.keys(curMap).length
      const coverage     = prevPresent ? curPresent / prevPresent : 1
      const underCovered = coverage < COVERAGE_MIN

      // --- SOLD OUT: was buyable last run, now gone or unbuyable ---
      for (const [fid, prev] of Object.entries(prevMap)) {
        if (!buyable(source, prev)) continue
        const curr = curMap[fid]
        const nowGone = !curr
        const nowSoldOut = curr && !buyable(source, curr)
        if (!nowGone && !nowSoldOut) continue

        const venueId = prev.venue_id
        const key = `${venueId}|${fid}`
        if (onCooldown.has(key)) continue

        const ev = await getEvent(eventId)
        const evName = ev?.event_name || 'event'
        const evDateStr = ev?.event_date ? String(ev.event_date).slice(0, 10) : '?'
        const dLeft = daysUntil(ev?.event_date)
        const dFrag = dLeft != null ? `, ${dLeft}d` : ''
        const venueName = venueMap[venueId] || 'Unknown'
        const lot = prev.facility_name || 'lot'
        const reason = nowGone ? 'delisted (no longer offered)' : 'sold out'
        // Confidence: a present-but-unbuyable row (SpotHero count→0 / flag) is a
        // DIRECT signal = 'confirmed'. A pure disappearance is INFERRED: 'likely'
        // when the rest of the event scraped fine, 'unverified' when the run looks
        // partial (possible scrape gap, not a real sellout).
        const confidence = nowSoldOut ? 'confirmed' : (underCovered ? 'unverified' : 'likely')
        const plat = PLAT_LABEL[source] || source
        const head = confidence === 'confirmed' ? '🚫 SOLD OUT'
                   : confidence === 'likely'    ? '🚫 SOLD OUT (inferred)'
                   :                              '⚠️ POSSIBLY GONE (unverified)'
        const action = confidence === 'unverified'
          ? `Verify on ${plat} before pulling — this run scraped only ${curPresent}/${prevPresent} lots for this event, so it may be a scrape gap, not a sellout.`
          : 'Pull the StubHub listing.'
        const message = `${head}: ${venueName} — ${lot} on ${plat} for ${evName} (${evDateStr}${dFrag}). ${action}`

        const ok = await fire({
          type: 'availability_drop', // valid alerts.type enum value
          venue_id: venueId,
          facility_id: fid,
          message,
          metadata: {
            venue_name: venueName, facility_name: lot, source,
            signal_type: 'SOLD_OUT', reason, confidence,
            coverage: parseFloat(coverage.toFixed(2)), lots_this_run: curPresent, lots_prev_run: prevPresent,
            // Deep link: exact lot URL (ParkWhiz) + the event page as a fallback.
            listing_url: prev.booking_url || curr?.booking_url || null,
            event_url: ev?.source_url || null,
            event_id: eventId, event_name: evName, event_date: ev?.event_date || null, event_days_until: dLeft,
            spaces_before: prev.available_spaces ?? null,
            spaces_after: curr ? (curr.available_spaces ?? 0) : null,
            was_available: true, now_available: false,
            context: 'event', category: 'sold_out', // sold-out is always event-context
            prev_scraped_at: prev.scraped_at, new_scraped_at: curr?.scraped_at || sinceIso,
          },
        }, `${confidence === 'unverified' ? '⚠️' : '🚫'} ${confidence.toUpperCase()} [${plat}] ${venueName} — ${lot} · ${evName} (${evDateStr})`)
        if (!ok) continue
        onCooldown.add(key); created++; counts[confidence]++
      }

      // --- THINNING (SpotHero only): count falling fast but not yet zero ---
      if (source === 'spothero') {
        for (const [fid, prev] of Object.entries(prevMap)) {
          const curr = curMap[fid]
          if (!curr || !buyable(source, curr)) continue
          const pb = prev.available_spaces, ca = curr.available_spaces
          if (typeof pb !== 'number' || typeof ca !== 'number' || pb < THINNING_MIN_BASE || ca <= 0) continue
          const dropPct = ((pb - ca) / pb) * 100
          if (dropPct < THINNING_PCT) continue

          const venueId = prev.venue_id
          const key = `${venueId}|${fid}`
          if (onCooldown.has(key)) continue

          const ev = await getEvent(eventId)
          const evName = ev?.event_name || 'event'
          const evDateStr = ev?.event_date ? String(ev.event_date).slice(0, 10) : '?'
          const dLeft = daysUntil(ev?.event_date)
          const dFrag = dLeft != null ? `, ${dLeft}d` : ''
          const venueName = venueMap[venueId] || 'Unknown'
          const lot = prev.facility_name || 'lot'
          const message = `⚠️ ${venueName} — ${lot}: going fast — spaces ${pb} → ${ca} (-${dropPct.toFixed(0)}%) on SpotHero for ${evName} (${evDateStr}${dFrag}). Buy or pull soon.`

          const ok = await fire({
            type: 'availability_drop',
            venue_id: venueId,
            facility_id: fid,
            message,
            metadata: {
              venue_name: venueName, facility_name: lot, source,
              signal_type: 'INVENTORY_THINNING', confidence: 'confirmed',
              listing_url: prev.booking_url || curr?.booking_url || null,
              event_url: ev?.source_url || null,
              event_id: eventId, event_name: evName, event_date: ev?.event_date || null, event_days_until: dLeft,
              spaces_before: pb, spaces_after: ca, spaces_change_pct: parseFloat((-dropPct).toFixed(1)),
              context: 'event', category: 'thinning', // event-context by construction
              prev_scraped_at: prev.scraped_at, new_scraped_at: curr.scraped_at,
            },
          }, `⚠️ THINNING [SpotHero] ${venueName} — ${lot} ${pb}→${ca} · ${evName}`)
          if (!ok) continue
          onCooldown.add(key); created++; counts.confirmed++
        }
      }
    }

    const breakdown = Object.entries(counts).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(', ')
    console.log(`  inventory-watch[${source}]: ${created} alert(s)${breakdown ? ` (${breakdown})` : ''}${dry ? ' [DRY]' : ''}`)
    return created
  } catch (e) {
    // Non-fatal — the scrape result matters more than this detector.
    console.error(`  inventory-watch[${source}] failed (non-fatal): ${e.message}`)
    return 0
  }
}

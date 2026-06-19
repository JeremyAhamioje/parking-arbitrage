import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const db = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
)

// --- Tunables --------------------------------------------------------------
// The detector is now baseline-relative (z-score) instead of comparing two
// consecutive scrapes against a flat %. A lot is "spiking" when its current
// price is far from ITS OWN recent normal, scaled by how noisy that lot usually
// is — so a rock-steady $40 lot trips on a real move while a perpetually-swingy
// lot doesn't cry wolf. Floors keep "20% of a $5 lot" out of the feed, a cooldown
// stops the same move re-firing every run, and a low-sample static fallback keeps
// fresh lots covered until they have enough history to score.
const Z_THRESHOLD             = parseFloat(process.env.ALERT_Z_THRESHOLD || '2.5')   // sigmas from baseline
const HISTORY_N               = parseInt(process.env.ALERT_HISTORY_N || '24', 10)     // rolling window length
const MIN_SAMPLES             = parseInt(process.env.ALERT_MIN_SAMPLES || '4', 10)    // below this → static fallback
const MIN_ABS_PRICE_MOVE      = parseFloat(process.env.ALERT_MIN_ABS_MOVE || '3')     // $ — ignore tiny moves
const MIN_PCT_MOVE            = parseFloat(process.env.ALERT_MIN_PCT_MOVE || '12')    // % vs baseline — belt & suspenders
const MIN_PRICE_FLOOR         = parseFloat(process.env.ALERT_MIN_PRICE_FLOOR || '5')  // ignore spikes on sub-$5 lots
const MIN_SPACES_BASE         = parseInt(process.env.ALERT_MIN_SPACES_BASE || '10', 10) // need a real inventory baseline
const COOLDOWN_HOURS          = parseFloat(process.env.ALERT_COOLDOWN_HOURS || '6')   // dedup the same move
const EVENT_HORIZON_DAYS      = parseInt(process.env.ALERT_EVENT_HORIZON_DAYS || '21', 10)

// Static fallbacks (used only when a lot has < MIN_SAMPLES of history).
const PRICE_SPIKE_THRESHOLD     = parseFloat(process.env.PRICE_SPIKE_THRESHOLD || '20')
const INVENTORY_DROP_THRESHOLD  = parseFloat(process.env.INVENTORY_DROP_THRESHOLD || '40')

const mean = arr => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0)
const stddev = (arr, m) => {
  if (arr.length < 2) return 0
  const mu = m ?? mean(arr)
  return Math.sqrt(arr.reduce((s, x) => s + (x - mu) ** 2, 0) / arr.length)
}
const daysUntil = dateStr => {
  if (!dateStr) return null
  const t = new Date(dateStr).getTime()
  return Number.isNaN(t) ? null : Math.ceil((t - Date.now()) / 86_400_000)
}

/**
 * Build venueName → nearest upcoming event (within EVENT_HORIZON_DAYS). This is
 * the bridge between the two systems: a price/inventory move that lines up with a
 * known event is a real demand signal; the same move with nothing on the calendar
 * is probably noise. We attach the event to the alert so it reads like an
 * opportunity ("price climbing AND Drake plays in 9 days") instead of a bare stat.
 */
async function buildUpcomingEventIndex(venueMap) {
  const { data: events } = await db
    .from('events')
    .select('venue_id, event_name, event_date')
    .not('event_date', 'is', null)
    .limit(2000)

  const idx = {} // venueName → { name, date, daysUntil }
  for (const e of events || []) {
    const d = daysUntil(e.event_date)
    if (d == null || d < 0 || d > EVENT_HORIZON_DAYS) continue
    const name = venueMap[e.venue_id]
    if (!name) continue
    const cur = idx[name]
    if (!cur || d < cur.daysUntil) idx[name] = { name: e.event_name, date: e.event_date, daysUntil: d }
  }
  return idx
}

async function runChangeDetection() {
  console.log('🔍 Starting change detection (baseline-relative, event-aware)...\n')

  try {
    // 1. Latest scraper run timestamp
    const { data: latestRun } = await db
      .from('snapshots')
      .select('scraped_at')
      .order('scraped_at', { ascending: false })
      .limit(1)
      .single()

    if (!latestRun) {
      console.log('No snapshots found. Run the scraper first.')
      return
    }
    const latestScrapedAt = latestRun.scraped_at
    console.log(`Latest scraper run: ${latestScrapedAt}\n`)

    // 2. All listings from the latest run
    const { data: latestSnapshots, error: snapErr } = await db
      .from('snapshots')
      .select('venue_id, facility_name, address, total_price, available_spaces')
      .eq('scraped_at', latestScrapedAt)
    if (snapErr) throw new Error(`Failed to fetch snapshots: ${snapErr.message}`)
    if (!latestSnapshots?.length) {
      console.log('No snapshots in latest run.')
      return
    }

    // 3. Venue names + upcoming-event index
    const { data: venues } = await db.from('venues').select('id, name')
    const venueMap = Object.fromEntries((venues || []).map(v => [v.id, v.name]))
    const eventIndex = await buildUpcomingEventIndex(venueMap)

    // 4. Group the latest run by venue/lot
    const groupedByLot = {}
    for (const snap of latestSnapshots) {
      const venueName = venueMap[snap.venue_id] || 'Unknown'
      const lotAddress = snap.address || 'Unknown'
      const key = `${venueName}|${lotAddress}`
      if (!groupedByLot[key]) groupedByLot[key] = { venueName, lotAddress, prices: [], spaceCounts: [] }
      groupedByLot[key].prices.push(snap.total_price || 0)
      groupedByLot[key].spaceCounts.push(snap.available_spaces || 0)
    }
    console.log(`Found ${Object.keys(groupedByLot).length} unique venue/lot combinations\n`)

    let signalsCreated = 0
    const cooldownCutoff = new Date(Date.now() - COOLDOWN_HOURS * 3600 * 1000).toISOString()

    for (const data of Object.values(groupedByLot)) {
      const avgPrice = mean(data.prices)
      const totalSpaces = data.spaceCounts.reduce((a, b) => a + b, 0)

      // PRIOR history for this lot (excludes the row we're about to insert).
      const { data: history } = await db
        .from('parking_snapshots')
        .select('price, spaces, scraped_at')
        .eq('venue_name', data.venueName)
        .eq('lot_address', data.lotAddress)
        .order('scraped_at', { ascending: false })
        .limit(HISTORY_N)

      // Always persist the current observation so the series keeps growing.
      const { error: insErr } = await db.from('parking_snapshots').insert({
        venue_name: data.venueName,
        lot_address: data.lotAddress,
        price: parseFloat(avgPrice.toFixed(2)),
        spaces: Math.round(totalSpaces),
        scraped_at: latestScrapedAt,
      })
      if (insErr) {
        console.error(`  ❌ insert snapshot failed for ${data.venueName} — ${data.lotAddress}: ${insErr.message}`)
        continue
      }

      const hist = history || []
      if (hist.length === 0) {
        console.log(`  → ${data.venueName} — ${data.lotAddress}: First run (baseline)`)
        continue
      }

      // --- Detection ---------------------------------------------------------
      let isPriceSpike = false, isInventoryDrop = false
      let priceBefore, priceChangePct, spacesBefore, spaceChangePct
      let method, zPrice = null, zSpaces = null

      if (hist.length >= MIN_SAMPLES) {
        // Baseline-relative (z-score)
        const prices = hist.map(h => Number(h.price) || 0)
        const spaces = hist.map(h => (h.spaces == null ? 0 : Number(h.spaces)))
        const muP = mean(prices), sdP = stddev(prices, muP)
        const muS = mean(spaces), sdS = stddev(spaces, muS)

        zPrice = sdP > 0 ? (avgPrice - muP) / sdP : (avgPrice > muP ? Infinity : 0)
        zSpaces = sdS > 0 ? (totalSpaces - muS) / sdS : (totalSpaces < muS ? -Infinity : 0)

        priceBefore = muP
        priceChangePct = muP > 0 ? ((avgPrice - muP) / muP) * 100 : 0
        spacesBefore = Math.round(muS)
        spaceChangePct = muS > 0 ? ((totalSpaces - muS) / muS) * 100 : 0

        isPriceSpike =
          avgPrice >= MIN_PRICE_FLOOR &&
          zPrice >= Z_THRESHOLD &&
          (avgPrice - muP) >= MIN_ABS_PRICE_MOVE &&
          priceChangePct >= MIN_PCT_MOVE

        isInventoryDrop =
          muS >= MIN_SPACES_BASE &&
          zSpaces <= -Z_THRESHOLD &&
          spaceChangePct <= -INVENTORY_DROP_THRESHOLD

        method = 'zscore'
      } else {
        // Static fallback vs the single previous scrape (cold-start safety net)
        const prev = hist[0]
        const prevPrice = Number(prev.price) || 0
        const prevSpaces = prev.spaces == null ? 0 : Number(prev.spaces)
        priceBefore = prevPrice
        priceChangePct = prevPrice > 0 ? ((avgPrice - prevPrice) / prevPrice) * 100 : 0
        spacesBefore = prevSpaces
        spaceChangePct = prevSpaces > 0 ? ((totalSpaces - prevSpaces) / prevSpaces) * 100 : 0

        isPriceSpike =
          avgPrice >= MIN_PRICE_FLOOR &&
          priceChangePct > PRICE_SPIKE_THRESHOLD &&
          (avgPrice - prevPrice) >= MIN_ABS_PRICE_MOVE

        isInventoryDrop =
          prevSpaces >= MIN_SPACES_BASE &&
          spaceChangePct < -INVENTORY_DROP_THRESHOLD

        method = 'fallback'
      }

      if (!isPriceSpike && !isInventoryDrop) {
        console.log(`  ✓ ${data.venueName} — ${data.lotAddress} (stable, ${method})`)
        continue
      }

      // --- Cooldown / debounce ----------------------------------------------
      const { data: recent } = await db
        .from('venue_signals')
        .select('id')
        .eq('venue_name', data.venueName)
        .eq('lot_address', data.lotAddress)
        .gte('tagged_at', cooldownCutoff)
        .limit(1)
      if (recent?.length) {
        console.log(`  ⏳ ${data.venueName} — ${data.lotAddress}: signal within ${COOLDOWN_HOURS}h, skipping (cooldown)`)
        continue
      }

      // --- Event correlation ------------------------------------------------
      const ev = eventIndex[data.venueName] || null

      const isBoth = isPriceSpike && isInventoryDrop
      const signalType = isBoth ? 'HIGH_PROFILE' : isPriceSpike ? 'PRICE_SPIKE' : 'INVENTORY_DROP'

      console.log(`  ⭐ ${data.venueName} — ${data.lotAddress} [${signalType}, ${method}${ev ? `, ⟶ ${ev.name} in ${ev.daysUntil}d` : ''}]`)
      if (isPriceSpike) console.log(`     Price: ${priceBefore.toFixed(2)} → ${avgPrice.toFixed(2)} (${priceChangePct > 0 ? '+' : ''}${priceChangePct.toFixed(1)}% vs ${method === 'zscore' ? 'baseline' : 'prev'}${zPrice != null && Number.isFinite(zPrice) ? `, z=${zPrice.toFixed(1)}` : ''})`)
      if (isInventoryDrop) console.log(`     Spaces: ${spacesBefore} → ${totalSpaces} (${spaceChangePct.toFixed(1)}%)`)

      // --- Persist signal ----------------------------------------------------
      const { error: sigErr } = await db.from('venue_signals').insert({
        venue_name: data.venueName,
        lot_address: data.lotAddress,
        signal_type: signalType,
        price_before: parseFloat(priceBefore.toFixed(2)),
        price_after: parseFloat(avgPrice.toFixed(2)),
        price_change_pct: parseFloat(priceChangePct.toFixed(2)),
        spaces_before: spacesBefore,
        spaces_after: Math.round(totalSpaces),
        spaces_change_pct: parseFloat(spaceChangePct.toFixed(2)),
        resolved: false,
      })
      if (sigErr) {
        console.error(`      Signal creation failed: ${sigErr.message}`)
        continue
      }

      // --- Alert (the human-readable, opportunity-framed line) ---------------
      const priceFrag = isPriceSpike
        ? `Price ${priceChangePct > 0 ? 'up' : 'down'} ${Math.abs(priceChangePct).toFixed(0)}% vs its ${method === 'zscore' ? `${hist.length}-run norm` : 'last scrape'} ($${priceBefore.toFixed(2)} → $${avgPrice.toFixed(2)})`
        : ''
      const spaceFrag = isInventoryDrop
        ? `spaces down ${Math.abs(spaceChangePct).toFixed(0)}% (${spacesBefore} → ${totalSpaces})`
        : ''
      const core = [priceFrag, spaceFrag].filter(Boolean).join(', ')
      const eventHook = ev
        ? ` — ${ev.name} in ${ev.daysUntil}d. ${isInventoryDrop || isPriceSpike ? 'Secure passes now.' : ''}`
        : ''
      const icon = isBoth ? '🚨' : isPriceSpike ? '📈' : '📉'
      const message = `${icon} ${data.venueName} — ${data.lotAddress}: ${core}.${eventHook}`

      const { error: alertErr } = await db.from('alerts').insert({
        // alerts.type is the alert_type enum (price_spike|availability_drop|new_event|
        // price_drop). The richer HIGH_PROFILE/PRICE_SPIKE/INVENTORY_DROP label lives
        // in metadata.signal_type + venue_signals.signal_type (free text).
        type: isPriceSpike ? 'price_spike' : 'availability_drop',
        venue_id: null,
        message,
        metadata: {
          venue_name: data.venueName,
          lot_address: data.lotAddress,
          signal_type: signalType,
          method,
          z_price: zPrice != null && Number.isFinite(zPrice) ? parseFloat(zPrice.toFixed(2)) : null,
          z_spaces: zSpaces != null && Number.isFinite(zSpaces) ? parseFloat(zSpaces.toFixed(2)) : null,
          price_before: parseFloat(priceBefore.toFixed(2)),
          price_after: parseFloat(avgPrice.toFixed(2)),
          price_change_pct: parseFloat(priceChangePct.toFixed(2)),
          delta: parseFloat((avgPrice - priceBefore).toFixed(2)),
          spaces_before: spacesBefore,
          spaces_after: Math.round(totalSpaces),
          spaces_change_pct: parseFloat(spaceChangePct.toFixed(2)),
          sample_size: hist.length,
          event_correlated: !!ev,
          event_name: ev?.name || null,
          event_date: ev?.date || null,
          event_days_until: ev?.daysUntil ?? null,
        },
      })
      if (alertErr) console.error(`      Alert creation failed: ${alertErr.message}`)
      else signalsCreated++
    }

    console.log(`\n✅ Change detection complete. ${signalsCreated} signal(s) created.`)
  } catch (error) {
    console.error('Change detection failed:', error.message)
    process.exit(1)
  }
}

runChangeDetection()

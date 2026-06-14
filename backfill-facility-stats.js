// Backfill facility_stats from existing snapshots.
//
// Replays every snapshot in chronological order through the same rolling-window
// logic used live in db.js upsertFacilityStats(), then writes one final row per
// (venue_id, facility_id). Run once after creating the facility_stats table:
//
//   node backfill-facility-stats.js
//
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const db = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
)

const HISTORY_CAP = 20

async function fetchAllSnapshots() {
  // Page past PostgREST's 1000-row cap. Order by time so the replay is chronological.
  const PAGE_SIZE = 1000
  let all = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await db
      .from('snapshots')
      .select('venue_id, facility_id, facility_name, address, walking_meters, total_price, available_spaces, scraped_at, event_id')
      .order('scraped_at', { ascending: true })
      .range(from, from + PAGE_SIZE - 1)
    if (error) throw new Error(error.message)
    if (!data || data.length === 0) break
    all = all.concat(data)
    if (data.length < PAGE_SIZE) break
  }
  return all
}

async function run() {
  console.log('Fetching all snapshots...')
  const snapshots = await fetchAllSnapshots()
  console.log(`Loaded ${snapshots.length} snapshots.`)

  // Replay per facility, keyed by venue_id|facility_id
  const stats = {}

  for (const s of snapshots) {
    if (!s.venue_id || s.facility_id == null) continue
    const fid = String(s.facility_id)
    const key = `${s.venue_id}|${fid}`
    const price = Number(s.total_price) || 0
    const spaces = typeof s.available_spaces === 'number' ? s.available_spaces : null

    let row = stats[key]
    if (!row) {
      row = stats[key] = {
        venue_id: s.venue_id,
        facility_id: fid,
        facility_name: s.facility_name,
        address: s.address,
        walking_meters: s.walking_meters || null,
        latest_price: null,
        prev_price: null,
        latest_spaces: null,
        prev_spaces: null,
        history: [],
        scrape_count: 0,
        first_scraped_at: s.scraped_at,
        last_scraped_at: s.scraped_at,
        // running sums to derive event vs generic averages
        generic_sum: 0,
        generic_count: 0,
        event_sum: 0,
        event_count: 0,
      }
    }

    row.prev_price = row.latest_price
    row.prev_spaces = row.latest_spaces
    row.latest_price = price
    row.latest_spaces = spaces
    row.facility_name = s.facility_name || row.facility_name
    row.address = s.address || row.address
    row.walking_meters = s.walking_meters || row.walking_meters
    row.history.push(price)
    if (row.history.length > HISTORY_CAP) row.history = row.history.slice(-HISTORY_CAP)
    row.scrape_count += 1
    row.last_scraped_at = s.scraped_at

    // Split into event vs generic buckets by the snapshot's event_id
    if (s.event_id) {
      row.event_sum += price
      row.event_count += 1
    } else {
      row.generic_sum += price
      row.generic_count += 1
    }
  }

  const upserts = Object.values(stats).map(row => {
    const window = row.history
    const minP = Math.min(...window)
    const maxP = Math.max(...window)
    const avgP = window.reduce((a, b) => a + b, 0) / window.length
    const volatility = avgP > 0 ? (maxP - minP) / avgP : 0
    const priceDelta = row.prev_price !== null ? row.latest_price - row.prev_price : 0
    const priceDeltaPct = row.prev_price ? (priceDelta / row.prev_price) * 100 : 0
    const trend = priceDelta > 0.5 ? 'up' : priceDelta < -0.5 ? 'down' : 'flat'

    const genericAvg = row.generic_count ? row.generic_sum / row.generic_count : null
    const eventAvg = row.event_count ? row.event_sum / row.event_count : null
    const eventPremiumPct =
      genericAvg && genericAvg > 0 && eventAvg !== null ? ((eventAvg - genericAvg) / genericAvg) * 100 : null

    return {
      venue_id: row.venue_id,
      facility_id: row.facility_id,
      facility_name: row.facility_name,
      address: row.address,
      walking_meters: row.walking_meters,
      latest_price: row.latest_price,
      prev_price: row.prev_price,
      price_delta: parseFloat(priceDelta.toFixed(2)),
      price_delta_pct: parseFloat(priceDeltaPct.toFixed(2)),
      latest_spaces: row.latest_spaces,
      prev_spaces: row.prev_spaces,
      spaces_delta: row.latest_spaces !== null && row.prev_spaces !== null ? row.latest_spaces - row.prev_spaces : null,
      min_price: parseFloat(minP.toFixed(2)),
      max_price: parseFloat(maxP.toFixed(2)),
      avg_price: parseFloat(avgP.toFixed(2)),
      volatility: parseFloat(volatility.toFixed(4)),
      trend,
      price_history: window,
      scrape_count: row.scrape_count,
      first_scraped_at: row.first_scraped_at,
      last_scraped_at: row.last_scraped_at,
      generic_avg_price: genericAvg !== null ? parseFloat(genericAvg.toFixed(2)) : null,
      generic_count: row.generic_count,
      event_avg_price: eventAvg !== null ? parseFloat(eventAvg.toFixed(2)) : null,
      event_count: row.event_count,
      event_premium_pct: eventPremiumPct !== null ? parseFloat(eventPremiumPct.toFixed(2)) : null,
    }
  })

  console.log(`Writing ${upserts.length} facility_stats rows...`)

  // Upsert in batches to stay well under payload limits
  const BATCH = 500
  for (let i = 0; i < upserts.length; i += BATCH) {
    const chunk = upserts.slice(i, i + BATCH)
    const { error } = await db.from('facility_stats').upsert(chunk, { onConflict: 'venue_id,facility_id' })
    if (error) {
      console.error(`Batch ${i / BATCH} failed: ${error.message}`)
      process.exit(1)
    }
    console.log(`  wrote ${Math.min(i + BATCH, upserts.length)}/${upserts.length}`)
  }

  console.log('Backfill complete.')
}

run().catch(e => { console.error(e); process.exit(1) })

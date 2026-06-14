// Backfill facility_price_log from existing snapshots.
//
// Reconstructs the run-by-run delta history: for each facility, snapshots are
// ordered by time and each one becomes a log row carrying the delta vs the
// previous snapshot. run_id is left null for historical rows (no run grouping
// existed before this feature).
//
//   node backfill-price-log.js
//
// NOTE: this writes roughly one row per snapshot (can be large). Batched inserts.
//
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const db = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
)

async function fetchAllSnapshots() {
  const PAGE_SIZE = 1000
  let all = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await db
      .from('snapshots')
      .select('venue_id, facility_id, facility_name, total_price, available_spaces, scraped_at, event_id')
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

  // Track previous price/spaces per facility as we walk chronologically
  const prevByFacility = {}
  const rows = []

  for (const s of snapshots) {
    if (!s.venue_id || s.facility_id == null) continue
    const fid = String(s.facility_id)
    const key = `${s.venue_id}|${fid}`
    const price = Number(s.total_price) || 0
    const spaces = typeof s.available_spaces === 'number' ? s.available_spaces : null

    const prev = prevByFacility[key]
    const prevPrice = prev ? prev.price : null
    const prevSpaces = prev ? prev.spaces : null

    const priceDelta = prevPrice !== null ? price - prevPrice : null
    const priceDeltaPct = prevPrice ? (priceDelta / prevPrice) * 100 : null
    const spacesDelta = spaces !== null && prevSpaces !== null ? spaces - prevSpaces : null

    rows.push({
      run_id: null,
      scraped_at: s.scraped_at,
      venue_id: s.venue_id,
      facility_id: fid,
      facility_name: s.facility_name,
      price,
      spaces,
      prev_price: prevPrice,
      price_delta: priceDelta !== null ? parseFloat(priceDelta.toFixed(2)) : null,
      price_delta_pct: priceDeltaPct !== null ? parseFloat(priceDeltaPct.toFixed(2)) : null,
      prev_spaces: prevSpaces,
      spaces_delta: spacesDelta,
      event_id: s.event_id || null,
    })

    prevByFacility[key] = { price, spaces }
  }

  console.log(`Writing ${rows.length} facility_price_log rows...`)

  const BATCH = 500
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH)
    const { error } = await db.from('facility_price_log').insert(chunk)
    if (error) {
      console.error(`Batch at ${i} failed: ${error.message}`)
      process.exit(1)
    }
    console.log(`  wrote ${Math.min(i + BATCH, rows.length)}/${rows.length}`)
  }

  console.log('Price-log backfill complete.')
}

run().catch(e => { console.error(e); process.exit(1) })

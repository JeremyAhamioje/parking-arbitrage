// discover-destinations.js
//
// Resolves SpotHero destination_id for every venue in venue-coords.json.
//
// WHY THIS EXISTS: SpotHero's /v2/destinations endpoint ignores its q/lat/lon
// params — it's really a paginated global catalog (~34k entries), each carrying
// title + city + latitude/longitude. The old per-venue "q=name" search never
// worked, which is why 44/50 venues had no destination_id and only ever got
// generic (non-event) scrapes.
//
// APPROACH: scan the full catalog once (cached to spothero-catalog.json), then
// match each venue by EXACT normalized name within a tight geographic radius of
// the venue's known coordinates. Geography disambiguates name duplicates (e.g.
// two "Chicago Theatre" rows) and rejects false positives (e.g. "Days Inn near
// Yankee Stadium"). Each accepted match is confirmed against the /v2/events
// endpoint. Confident matches are written to venue-coords.json AND the DB.
//
// Usage:
//   node discover-destinations.js            # dry run — report only
//   node discover-destinations.js --write    # persist to venue-coords.json + DB
//
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { matchVenue } from './src/destination-finder.js'

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const __dir = dirname(fileURLToPath(import.meta.url))
const COORDS_FILE = join(__dir, 'venue-coords.json')
const CATALOG_CACHE = join(__dir, 'spothero-catalog.json')
const WRITE = process.argv.includes('--write')
const REFRESH = process.argv.includes('--refresh') // force re-scan even if cache exists

async function fetchJson(url, attempts = 4) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json', Referer: 'https://spothero.com/' } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    } catch (e) {
      if (i === attempts - 1) throw e
      await new Promise(r => setTimeout(r, 500 * (i + 1))) // backoff
    }
  }
}

// ---------- 1. catalog ----------
async function loadCatalog() {
  if (!REFRESH && existsSync(CATALOG_CACHE)) {
    const cat = JSON.parse(readFileSync(CATALOG_CACHE, 'utf8'))
    console.log(`Loaded cached catalog: ${cat.length} entries (use --refresh to re-scan)`)
    return cat
  }
  console.log('Scanning full SpotHero destinations catalog (resilient, with retries)...')
  let url = 'https://api.spothero.com/v2/destinations'
  const cat = []
  let page = 0
  while (url) {
    let j
    try {
      j = await fetchJson(url)
    } catch (e) {
      console.warn(`  page ${page} failed after retries (${e.message}); stopping scan with ${cat.length} entries so far`)
      break
    }
    for (const d of j.destinations || []) {
      if (d.latitude && d.longitude) {
        cat.push({ id: Number(d.destination_id), title: d.title || '', city: d.city || '', lat: d.latitude, lon: d.longitude })
      }
    }
    url = j['@next'] || null
    page++
    if (page % 50 === 0) console.log(`  ${page} pages, ${cat.length} entries...`)
  }
  console.log(`Catalog scan complete: ${cat.length} entries across ${page} pages.`)
  writeFileSync(CATALOG_CACHE, JSON.stringify(cat))
  return cat
}

// ---------- 2. event counts (cached across venues), injected into matchVenue ----------
const eventsCache = new Map()
async function getEvents(id) {
  if (eventsCache.has(id)) return eventsCache.get(id)
  let n = -1 // -1 = endpoint failed
  try {
    const j = await fetchJson(`https://api.spothero.com/v2/events?destination_id=${id}`, 2)
    const items = Array.isArray(j) ? j : (j.data || j.events || j.results || [])
    n = items.length
  } catch { n = -1 }
  eventsCache.set(id, n)
  return n
}

// ---------- main ----------
async function run() {
  const coords = JSON.parse(readFileSync(COORDS_FILE, 'utf8'))
  const catalog = await loadCatalog()

  const results = []
  for (const vname of Object.keys(coords)) {
    const co = coords[vname]
    if (!co || typeof co.lat !== 'number') {
      results.push({ vname, status: 'NO_COORDS' })
      continue
    }
    const m = await matchVenue(vname, co.lat, co.lon, catalog, getEvents)
    if (!m) {
      results.push({ vname, status: 'NONE', existing: co.spotheroDestinationId || null })
      continue
    }
    results.push({
      vname,
      status: m.conf,
      id: m.id,
      title: m.title,
      dist: m.dist,
      reason: m.reason,
      events: m.events,
      valid: m.events >= 0, // endpoint responded
      existing: co.spotheroDestinationId || null,
    })
  }

  // ---- report ----
  console.log('\n================ MATCH REPORT ================')
  const tiers = { HIGH: [], MED: [], NONE: [], NO_COORDS: [] }
  for (const r of results) (tiers[r.status] || tiers.NONE).push(r)

  for (const r of results) {
    if (r.status === 'HIGH' || r.status === 'MED') {
      const flag = r.status === 'HIGH' ? '✅' : '🟡'
      const had = r.existing !== null && r.existing !== undefined ? Number(r.existing) : null
      const change = had !== null && had !== r.id ? `  ⚠️ OVERWRITES ${had}` : (had !== null ? '  (unchanged)' : '')
      const ev = r.events < 0 ? '?' : r.events
      console.log(`${flag} ${String(r.id).padEnd(6)} ${(r.dist + 'm').padEnd(7)} ${String(ev).padStart(3)} evt  [${r.reason}]  | ${r.vname.split(/\s[—-]\s/)[0]} → ${r.title}${change}`)
    } else if (r.status === 'NONE') {
      console.log(`❌ NONE              | ${r.vname}`)
    } else {
      console.log(`⚠️  NO COORDS        | ${r.vname}`)
    }
  }
  console.log('=============================================')
  console.log(`HIGH=${tiers.HIGH.length}  MED=${tiers.MED.length}  NONE=${tiers.NONE.length}  NO_COORDS=${tiers.NO_COORDS.length}`)

  // ---- write ----
  const toWrite = results.filter(r => (r.status === 'HIGH' || r.status === 'MED') && r.valid)
  if (!WRITE) {
    console.log(`\nDRY RUN. ${toWrite.length} venues would be written. Re-run with --write to persist.`)
    return
  }

  // venue-coords.json
  for (const r of toWrite) {
    coords[r.vname] = { ...coords[r.vname], spotheroDestinationId: r.id }
  }
  writeFileSync(COORDS_FILE, JSON.stringify(coords, null, 2))
  console.log(`\nWrote ${toWrite.length} destination_ids to venue-coords.json`)

  // DB venues table
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
  const { data: dbVenues } = await db.from('venues').select('id, name')
  const nameToId = {}
  for (const v of dbVenues || []) nameToId[v.name] = v.id

  let dbUpdated = 0, dbMissing = 0
  for (const r of toWrite) {
    const venueId = nameToId[r.vname]
    if (!venueId) { dbMissing++; console.warn(`  (no DB venue row for "${r.vname}")`); continue }
    const { error } = await db.from('venues').update({ spothero_destination_id: r.id }).eq('id', venueId)
    if (error) console.error(`  DB update failed for ${r.vname}: ${error.message}`)
    else dbUpdated++
  }
  console.log(`Updated ${dbUpdated} rows in DB venues table${dbMissing ? ` (${dbMissing} had no matching DB row)` : ''}.`)
  console.log('Done.')
}

run().catch(e => { console.error(e); process.exit(1) })

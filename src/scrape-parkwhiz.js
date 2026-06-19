// Batch ParkWhiz scraper — mirrors src/scrape-way.js in structure, but simpler.
//
// ParkWhiz has NO Cloudflare. Its only gate is an AWS-ELB WAF (Server: awselb/2.0)
// that 403s non-US / reputation-flagged IPs. A US datacenter proxy returns 200
// from the real nginx origin (confirmed live 2026-06-13). So there is no shared
// Cloudflare-cleared browser to keep warm: each venue gets its own short-lived
// browser via scrapeParkWhiz(), and the proxy POOL is rotated per venue (which
// also spreads load across IPs and dodges per-IP rate limits).
//
// Usage:
//   node src/scrape-parkwhiz.js                  — all venues
//   VENUE="Yankee" node src/scrape-parkwhiz.js   — single venue filter (PowerShell: $env:VENUE="Yankee"; npm run scrape:parkwhiz)
//
// Env:
//   PARKWHIZ_PROXY_URLS   comma-separated US datacenter proxies (rotated per call) — REQUIRED
//   PARKWHIZ_PROXY_URL    single proxy fallback
//   PARKWHIZ_TZ_OFFSET    timezone offset for the search window (default -04:00 EDT)

import 'dotenv/config'
import { readVenues } from './sheets.js'
import { scrapeParkWhiz } from './scrapers/parkwhiz.js'
import {
  upsertVenue, insertSnapshots, upsertFacilityStats,
  insertFacilityPriceLog, generateAlerts,
  createScrapeRun, finalizeScrapeRun,
} from './db.js'

// The proxy-chain relay (see _stealth.js) and closing Chromium contexts can emit
// stray async errors AFTER a venue's own try/catch has already handled its result
// — e.g. an upstream proxy socket reset. With no handler, Node turns those into an
// unhandledRejection/uncaughtException and kills the whole 50-venue run with exit
// 1 (this is why ParkWhiz/Way batch jobs were failing while no-proxy SpotHero
// passed). Log and keep going; the per-venue try/catch owns the real outcome.
process.on('unhandledRejection', (reason) => {
  console.error('[parkwhiz] unhandledRejection (ignored):', reason?.message || reason)
})
process.on('uncaughtException', (err) => {
  console.error('[parkwhiz] uncaughtException (ignored):', err?.message || err)
})

let currentRunId = null
let runListingCount = 0

const SOURCE = 'parkwhiz'

// ---------------------------------------------------------------------------
// Map a ParkWhiz listing to the DB snapshot schema (SpotHero-compatible).
// ParkWhiz prices are already dollars here (parkwhiz.js divides cents by 100).
// `distance` is metres from the venue; `spaces` is usually null on ParkWhiz.
// ---------------------------------------------------------------------------
function toDbListing(l) {
  const base  = typeof l.price === 'number' ? l.price : 0
  const allIn = typeof l.allInPrice === 'number' ? l.allInPrice : base
  const total = Math.max(base, allIn)
  return {
    facilityId:      String(l.facilityId || ''),
    name:            l.name || '?',
    address:         l.address || '',
    city:            l.city || '',
    state:           l.state || '',
    facilityType:    '',   // ParkWhiz has no clean facility-type field
    amenities:       Array.isArray(l.amenities) ? l.amenities.join(', ') : '',
    walkingMeters:   typeof l.distance === 'number' ? Math.round(l.distance) : null,
    advertisedPrice: parseFloat(base.toFixed(2)),
    serviceFee:      parseFloat(Math.max(0, total - base).toFixed(2)),
    totalPrice:      parseFloat(total.toFixed(2)),
    availableSpaces: typeof l.spaces === 'number' ? l.spaces : null,
    available:       true,
  }
}

// Stable, comparable search window: tomorrow 18:00–22:00 local (an evening event
// slot). Built as a bare "YYYY-MM-DDTHH:MM:SS" string so scrapeParkWhiz can slice
// it and append PARKWHIZ_TZ_OFFSET without a UTC round-trip shifting the hours.
function tomorrowWindow() {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return { startTime: `${y}-${m}-${day}T18:00:00`, endTime: `${y}-${m}-${day}T22:00:00` }
}

// ---------------------------------------------------------------------------
// DB writes (mirrors saveListings in scrape-way.js — no Google Sheets for ParkWhiz)
// ---------------------------------------------------------------------------
async function saveListings(venue, venueId, listings) {
  if (!listings.length) { console.log('  No listings'); return }

  const dbListings = listings.map(toDbListing)
  console.log(`  ${dbListings.length} listing(s)`)
  dbListings.forEach(l =>
    console.log(`    ${l.name.slice(0, 50).padEnd(50)} $${l.totalPrice.toFixed(2)}` +
      (l.walkingMeters != null ? `  (${(l.walkingMeters / 1609.34).toFixed(1)} mi)` : ''))
  )

  try {
    await insertSnapshots(venueId, dbListings, null, SOURCE)
    const deltas = await upsertFacilityStats(venueId, dbListings, null, SOURCE)
    await insertFacilityPriceLog(currentRunId, venueId, deltas, null)
    await generateAlerts(venueId, venue, dbListings)
    runListingCount += dbListings.length
  } catch (e) {
    console.error(`  DB write failed: ${e.message}`)
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function run() {
  let venues = await readVenues()
  if (!venues.length) {
    console.error('No venues found in Sheet1 column A (A2:A51).')
    process.exit(1)
  }
  if (process.env.VENUE) {
    const filter = process.env.VENUE.toLowerCase()
    venues = venues.filter(v => v.toLowerCase().includes(filter))
    if (!venues.length) {
      console.error(`No venues matched VENUE="${process.env.VENUE}"`)
      process.exit(1)
    }
  }
  console.log(`Found ${venues.length} venue(s) to scrape.\n`)

  if (!process.env.PARKWHIZ_PROXY_URLS && !process.env.PARKWHIZ_PROXY_URL && !process.env.PROXY_URL) {
    console.error('WARNING: No PARKWHIZ_PROXY_URLS/PARKWHIZ_PROXY_URL set — ParkWhiz will 403 from a non-US IP.\n')
  }

  try {
    currentRunId = await createScrapeRun()
    console.log(`Scrape run started: ${currentRunId}\n`)
  } catch (e) {
    console.error(`Could not create scrape run (will continue ungrouped): ${e.message}`)
  }

  const win = tomorrowWindow()
  console.log(`Search window: ${win.startTime} → ${win.endTime} (${process.env.PARKWHIZ_TZ_OFFSET || '-04:00'})\n`)

  const stats = { ok: 0, noListings: 0, blocked: 0, error: 0 }

  for (let i = 0; i < venues.length; i++) {
    const venue = venues[i]
    console.log(`\n[${i + 1}/${venues.length}] ━━ ${venue} ━━`)

    // scrapeParkWhiz rotates PARKWHIZ_PROXY_URLS internally (pickProxy). One retry
    // on a WAF 'blocked' picks a fresh proxy IP, which usually clears it.
    let result
    try {
      result = await scrapeParkWhiz(venue, win)
      if (result.status === 'blocked') {
        console.log('  WAF 403 — retrying on a rotated proxy...')
        await _delay(1500)
        result = await scrapeParkWhiz(venue, win)
      }
    } catch (e) {
      console.error(`  Scrape threw: ${e.message}`)
      stats.error++
      await _delay(2000)
      continue
    }

    console.log(`  status=${result.status}  listings=${result.listings.length}`)

    if (result.status === 'blocked') {
      console.error('  Still WAF-blocked after retry — check proxy pool health.')
      stats.blocked++
      await _delay(1500)
      continue
    }

    if (result.status !== 'ok' || !result.listings.length) {
      console.log(`  No listings (${result.status})${result.error ? ` — ${result.error}` : ''}`)
      stats.noListings++
      await _delay(1500)
      continue
    }

    // Prefer the true venue coordinate (from pw:venue); fall back to the nearest
    // lot's lat/lng, then 0,0 if neither is present.
    const withCoords = result.listings.find(l => l.lat != null && l.lng != null)
    const venueLat = Number.isFinite(result.venueLat) ? result.venueLat : (withCoords ? parseFloat(withCoords.lat) : 0)
    const venueLon = Number.isFinite(result.venueLon) ? result.venueLon : (withCoords ? parseFloat(withCoords.lng) : 0)

    let venueId
    try {
      venueId = await upsertVenue(venue, venueLat || 0, venueLon || 0)
    } catch (e) {
      console.error(`  upsertVenue failed: ${e.message}`)
      stats.error++
      await _delay(2000)
      continue
    }

    await saveListings(venue, venueId, result.listings)
    stats.ok++

    // Polite inter-venue delay (each call also rotates to a new proxy IP)
    if (i < venues.length - 1) await _delay(2000)
  }

  await finalizeScrapeRun(currentRunId, { venueCount: venues.length, listingCount: runListingCount })

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
  console.log(`Done.  ok=${stats.ok}  no_listings=${stats.noListings}  blocked=${stats.blocked}  error=${stats.error}`)
  console.log(`Total listings written: ${runListingCount}`)
}

function _delay(ms) { return new Promise(r => setTimeout(r, ms)) }

// Exit explicitly on success so a lingering proxy-chain relay / browser handle
// can't keep the event loop alive and hang the job to its timeout.
run().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })

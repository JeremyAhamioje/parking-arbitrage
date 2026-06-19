// Batch Way.com scraper — mirrors src/index.js (SpotHero runner) in structure.
//
// Boots one Playwright browser, clears Cloudflare once, then iterates all venues
// from Google Sheets using in-browser fetch calls (no new browser per venue).
//
// Usage:
//   node src/scrape-way.js                  — all venues
//   VENUE="Yankee" node src/scrape-way.js   — single venue filter
//
// Env:
//   WAY_PROXY_URL   residential proxy (required — Way.com is Cloudflare-guarded)
//   WAY_HEADFUL=1   override to headed if headless fails CF challenge

import 'dotenv/config'
import { readVenues } from './sheets.js'
import { initWayBrowser, scrapeWayWithPage } from './scrapers/way.js'
import {
  upsertVenue, insertSnapshots, upsertFacilityStats,
  insertFacilityPriceLog, generateAlerts,
  createScrapeRun, finalizeScrapeRun,
} from './db.js'

// The residential proxy-chain relay (see _stealth.js) and Cloudflare/browser
// teardown can emit stray async errors after a venue's own try/catch has handled
// its result. Without a handler, Node escalates them to unhandledRejection/
// uncaughtException and kills the whole run with exit 1 (the cause of the failing
// Way batch jobs). Log and keep serving — the per-venue try/catch owns the result.
process.on('unhandledRejection', (reason) => {
  console.error('[way] unhandledRejection (ignored):', reason?.message || reason)
})
process.on('uncaughtException', (err) => {
  console.error('[way] uncaughtException (ignored):', err?.message || err)
})

let currentRunId = null
let runListingCount = 0

// ---------------------------------------------------------------------------
// Map a Way.com listing to the DB snapshot schema (SpotHero-compatible).
// Way doesn't return available_spaces; service_fee is derived from tax split.
// ---------------------------------------------------------------------------
function toDbListing(l) {
  const raw = l.raw || {}
  const addr = raw.address || {}
  const base = typeof l.price === 'number' ? l.price : 0
  // Use totalPriceWithTax when available (includes tax + service fee).
  // totalPrice in the raw row is the pre-tax subtotal.
  const total = typeof raw.totalPriceWithTax === 'number' ? raw.totalPriceWithTax
              : typeof raw.totalPrice        === 'number' ? raw.totalPrice
              : base
  return {
    facilityId:      String(l.lotId || ''),
    name:            l.name,
    address:         addr.addressLine1 || '',
    city:            addr.city || '',
    state:           addr.stateCode || addr.state || '',
    facilityType:    raw.parkingType || '',
    amenities:       raw.parkingType || '',
    walkingMeters:   l.distance ? Math.round(l.distance * 1609.34) : null,
    advertisedPrice: parseFloat(base.toFixed(2)),
    serviceFee:      parseFloat(Math.max(0, total - base).toFixed(2)),
    totalPrice:      parseFloat(total.toFixed(2)),
    availableSpaces: null,   // Way city-parking/search doesn't return inventory count
    available:       raw.availability !== false,
  }
}

// ---------------------------------------------------------------------------
// DB writes (mirrors saveListings in index.js — no Google Sheets write for Way)
// ---------------------------------------------------------------------------
async function saveListings(venue, venueId, listings) {
  if (!listings.length) { console.log('  No listings'); return }

  const dbListings = listings.map(toDbListing)
  console.log(`  ${dbListings.length} listing(s)`)
  dbListings.forEach(l =>
    console.log(`    ${l.name.slice(0, 50).padEnd(50)} $${l.totalPrice.toFixed(2)}  (${(l.walkingMeters / 1609.34).toFixed(1)} mi)`)
  )

  try {
    await insertSnapshots(venueId, dbListings, null, 'way')
    const deltas = await upsertFacilityStats(venueId, dbListings, null, 'way')
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
  // --- Load venue list ---
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

  // --- Scrape run record ---
  try {
    currentRunId = await createScrapeRun()
    console.log(`Scrape run started: ${currentRunId}\n`)
  } catch (e) {
    console.error(`Could not create scrape run (will continue ungrouped): ${e.message}`)
  }

  // --- Boot browser (once) ---
  const proxyUrl = process.env.WAY_PROXY_URL || process.env.RESIDENTIAL_PROXY_URL || process.env.PROXY_URL
  if (!proxyUrl) {
    console.error('WARNING: No WAY_PROXY_URL set — Way.com will likely block without a residential proxy.\n')
  }

  // Headed by default — Cloudflare detects headless when the session cookie has
  // expired and blocks the boot. Set WAY_HEADLESS=1 only when cf_clearance is
  // already warm (e.g. ran headed within the last few hours).
  const headless = process.env.WAY_HEADLESS === '1'
  console.log(`Launching Way browser (${headless ? 'headless' : 'headed — window will open briefly for CF boot'})...`)
  let browser, page
  try {
    ;({ browser, page } = await initWayBrowser({ headless }))
  } catch (e) {
    console.error(`Browser boot failed: ${e.message}`)
    await finalizeScrapeRun(currentRunId, { venueCount: 0, listingCount: 0 })
    process.exit(1)
  }

  const stats = { ok: 0, noListings: 0, error: 0, cfBlocked: 0, reboots: 0 }

  // Cloudflare can re-challenge mid-run when cf_clearance expires or the proxy IP
  // rotates. Re-boot the browser (fresh CF clear on the same proxy) up to a cap,
  // then retry the venue that tripped it. Bounded so a truly dead proxy fails fast.
  const MAX_REBOOTS = 2
  async function rebootBrowser() {
    if (stats.reboots >= MAX_REBOOTS) {
      console.error(`  Max reboots (${MAX_REBOOTS}) reached — cannot recover Cloudflare session.`)
      return false
    }
    stats.reboots++
    console.log(`  ⚠ Cloudflare re-challenge — rebooting browser (${stats.reboots}/${MAX_REBOOTS})...`)
    try { await browser?.close() } catch {}
    browser = null; page = null
    await _delay(3000)
    try {
      ;({ browser, page } = await initWayBrowser({ headless }))
      console.log('  ✓ Re-booted — Cloudflare cleared, resuming.')
      return true
    } catch (e) {
      console.error(`  Reboot failed to clear Cloudflare: ${e.message}`)
      return false
    }
  }

  try {
    for (let i = 0; i < venues.length; i++) {
      const venue = venues[i]
      console.log(`\n[${i + 1}/${venues.length}] ━━ ${venue} ━━`)

      if (!browser || !page) {
        console.error('  No active browser session — aborting remaining venues.')
        break
      }

      let result
      try {
        result = await scrapeWayWithPage(page, venue)
        // Mid-run Cloudflare block: reboot once and retry this venue.
        if (result.status === 'cloudflare_challenge') {
          const rebooted = await rebootBrowser()
          if (rebooted && page) result = await scrapeWayWithPage(page, venue)
        }
      } catch (e) {
        console.error(`  Scrape threw: ${e.message}`)
        stats.error++
        await _delay(2000)
        continue
      }

      if (result.status === 'cloudflare_challenge') {
        console.error(`  Still Cloudflare-blocked after reboot (stage=${result.debug?.stage || '?'}).`)
        stats.cfBlocked++
        if (!browser || !page) break   // reboot failed → session gone, stop
        await _delay(1500)
        continue
      }

      console.log(`  status=${result.status}  listings=${result.listings.length}  slug=${result.citySlug || 'n/a'}`)

      if (result.status === 'error') {
        console.error(`  Error: ${result.error}`)
        stats.error++
        await _delay(2000)
        continue
      }

      if (result.status !== 'ok' || !result.listings.length) {
        console.log(`  No listings (${result.status})`)
        if (result.debug) console.log(`  debug: ${JSON.stringify(result.debug)}`)
        stats.noListings++
        await _delay(1500)
        continue
      }

      // Upsert venue using coordinates from the autosuggest response
      let venueId
      try {
        venueId = await upsertVenue(venue, result.venueLat || 0, result.venueLon || 0)
      } catch (e) {
        console.error(`  upsertVenue failed: ${e.message}`)
        stats.error++
        await _delay(2000)
        continue
      }

      await saveListings(venue, venueId, result.listings)
      stats.ok++

      // Polite inter-venue delay — Way.com uses shared Cloudflare context, no need to rush
      if (i < venues.length - 1) await _delay(2500)
    }
  } finally {
    await browser?.close().catch(() => {})
  }

  await finalizeScrapeRun(currentRunId, { venueCount: venues.length, listingCount: runListingCount })

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
  console.log(`Done.  ok=${stats.ok}  no_listings=${stats.noListings}  error=${stats.error}  cf_blocked=${stats.cfBlocked}  reboots=${stats.reboots}`)
  console.log(`Total listings written: ${runListingCount}`)
}

function _delay(ms) { return new Promise(r => setTimeout(r, ms)) }

// Exit explicitly on success so a lingering proxy-chain relay / browser handle
// can't keep the event loop alive and hang the job to its timeout.
run().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })

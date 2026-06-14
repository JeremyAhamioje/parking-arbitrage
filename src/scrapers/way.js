// Way.com parking scraper.
//
// Way.com sits behind Cloudflare Managed Challenge / Turnstile. Requires a
// residential proxy. With a clean residential IP the challenge auto-clears
// passively. If Cloudflare serves the interactive checkbox (known-proxy IP),
// we attempt a click before giving up.
//
// Status codes:
//   ok                            — passed gate, parsed listings
//   passed_no_listings            — past gate, no priced cards
//   cloudflare_challenge          — proxied but still challenged
//   cloudflare_challenge_no_proxy — no proxy set (expected without residential IP)
//   error                         — navigation/runtime failure
//
// CLI:   WAY_PROXY_URL="http://..." node src/scrapers/way.js "Venue Name"
//        WAY_HEADLESS=1  → headless  (default: headed, needed for Cloudflare on first boot)
// Batch: import { initWayBrowser, scrapeWayWithPage } from './scrapers/way.js'
//        initWayBrowser() once, then scrapeWayWithPage(page, venue) per venue.

import 'dotenv/config'
import { dirname, join } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { writeFileSync } from 'fs'
import { parseProxy, launchStealthContext, waitForRealContent, passedChallenge } from './_stealth.js'

const __dir = dirname(fileURLToPath(import.meta.url))
const SESSION_FILE = join(__dir, '../../.way-session.json')
const SEARCH_URL = 'https://www.way.com/parking'

const COUNTRY_TZ = {
  gb: 'Europe/London', uk: 'Europe/London', ca: 'America/Toronto',
  de: 'Europe/Berlin', fr: 'Europe/Paris', au: 'Australia/Sydney',
  nl: 'Europe/Amsterdam', it: 'Europe/Rome', es: 'Europe/Madrid',
  be: 'Europe/Brussels', at: 'Europe/Vienna', us: 'America/New_York',
  jp: 'Asia/Tokyo', br: 'America/Sao_Paulo', mx: 'America/Mexico_City',
  in: 'Asia/Kolkata', sg: 'Asia/Singapore', hk: 'Asia/Hong_Kong',
  za: 'Africa/Johannesburg', ar: 'America/Argentina/Buenos_Aires', cl: 'America/Santiago',
}

function proxyTimezone(proxyUrl) {
  if (!proxyUrl) return 'America/New_York'
  const m = proxyUrl.match(/-([a-z]{2})-\d+:/i)
  if (m) return COUNTRY_TZ[m[1].toLowerCase()] || 'America/New_York'
  return process.env.WAY_TIMEZONE || 'America/New_York'
}

async function tryClickTurnstile(page) {
  const iframes = await page.evaluate(() =>
    Array.from(document.querySelectorAll('iframe')).map(f => f.src || '(no src)')
  ).catch(() => [])
  if (iframes.length) console.error(`[way:cf] iframes: ${iframes.join(' | ')}`)

  for (const frame of page.frames()) {
    const u = frame.url()
    if (!u || u === 'about:blank') continue
    const clicked = await frame.locator('input[type="checkbox"], [role="checkbox"]').first()
      .click({ timeout: 3000 }).then(() => true).catch(() => false)
    if (clicked) { console.error(`[way:cf] clicked checkbox in frame: ${u}`); return true }
  }
  const clicked = await page.locator('input[type="checkbox"], [class*="cf-turnstile"], label:has-text("human")').first()
    .click({ timeout: 3000 }).then(() => true).catch(() => false)
  if (clicked) console.error('[way:cf] clicked page-level checkbox')
  return clicked
}

// ---------------------------------------------------------------------------
// Shared boot: one browser launch per scrape run, reused across all venues.
// ---------------------------------------------------------------------------

/**
 * Launch a stealth browser, navigate to way.com, clear Cloudflare, wait for
 * Angular to boot. Returns { browser, context, page }.
 *
 * Call once per batch run. Pass `page` to scrapeWayWithPage() for each venue.
 * Caller is responsible for browser.close() when done.
 *
 * @param {{ headless?: boolean }} opts
 *   headless — default false (headed passes CF most reliably on first boot).
 *              Set WAY_HEADFUL=1 to override back to headed when running in headless mode.
 */
export async function initWayBrowser({ headless = false } = {}) {
  const proxyUrl = process.env.WAY_PROXY_URL || process.env.RESIDENTIAL_PROXY_URL || process.env.PROXY_URL
  // Sticky session (opt-in via WAY_PROXY_STICKY=1): pin ONE exit IP for this boot
  // so cf_clearance holds across every venue. Generated fresh per boot, so a
  // mid-run reboot lands on a NEW clean IP rather than the one that got challenged.
  // Set WAY_PROXY_SESSION_FORMAT to match your vendor (default "{user}-session-{session}").
  const sessionId = process.env.WAY_PROXY_STICKY === '1'
    ? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
    : null
  const proxy = parseProxy(proxyUrl, {
    sessionId,
    sessionFormat: process.env.WAY_PROXY_SESSION_FORMAT || '{user}-session-{session}',
  })
  if (sessionId) console.error(`[way:init] sticky proxy session=${sessionId}`)
  const headful = process.env.WAY_HEADFUL === '1' ? true : !headless

  const { browser, context } = await launchStealthContext({
    proxy, sessionFile: SESSION_FILE, headful, timezoneId: proxyTimezone(proxyUrl),
  })
  const page = await context.newPage()

  await page.goto(SEARCH_URL, { waitUntil: 'commit', timeout: 30000 })
  await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {})

  const passedPassive = await waitForRealContent(
    page, 'input, [class*="parking" i], [class*="search" i]', { timeout: 20000 }
  )
  if (!passedPassive) {
    console.error('[way:init] passive CF wait timed out — trying Turnstile click')
    await tryClickTurnstile(page)
    await page.waitForTimeout(30000)
  }

  const passed = passedPassive || await passedChallenge(page)
  if (!passed) {
    await browser.close()
    throw new Error(proxy ? 'cloudflare_challenge' : 'cloudflare_challenge_no_proxy — set WAY_PROXY_URL')
  }

  try { writeFileSync(SESSION_FILE, JSON.stringify(await context.storageState())) } catch {}

  // Wait for Angular to complete its boot requests (fires /autosuggest/airports + /ports)
  await page.waitForResponse(
    r => r.url().includes('/autosuggest/airports') || r.url().includes('/autosuggest/ports'),
    { timeout: 30000 }
  ).then(() => true).catch(() => false)

  console.error(`[way:init] ready — CF cleared, Angular booted (headless=${!headful}, proxy=${!!proxy})`)
  return { browser, context, page }
}

// ---------------------------------------------------------------------------
// Per-venue logic — runs on an already-booted page, no browser lifecycle.
// ---------------------------------------------------------------------------

const toSlug = (city, sc) =>
  city.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim().replace(/\s+/g, '-') + '-' + sc.toLowerCase()

// Cloudflare serves these when cf_clearance has expired / the IP rotated mid-run.
// A bare TCP reset surfaces as our in-page fetch's { error: 'fetch_failed' }.
const CF_BLOCK_STATUSES = new Set([401, 403, 429, 503, 520, 521, 522])
function looksLikeCfBlock(resp) {
  if (!resp) return false
  if (resp.error === 'fetch_failed') return true
  return resp.status != null && CF_BLOCK_STATUSES.has(resp.status)
}

async function citySearch(page, pageName, checkin, checkout) {
  return page.evaluate(async ({ pageName, checkin, checkout }) => {
    const r = await fetch('https://www.way.com/way-search/v1/public/city-parking/search', {
      method: 'POST',
      headers: {
        'content-type': 'application/json', 'accept': 'application/json',
        'origin': 'https://www.way.com', 'referer': `https://www.way.com/parking/city/${pageName}/`,
      },
      body: JSON.stringify({
        pageName,
        paginationDto: { pageNumber: 1, pageSize: 100 },
        searchType: 'PARKING',
        parkingFilterDto: { checkin, checkout },
        pricingType: 'Hourly',
        showTotalPriceWithTaxes: false,
      }),
    }).catch(() => null)
    if (!r) return { error: 'fetch_failed' }
    return { status: r.status, body: await r.json().catch(() => null) }
  }, { pageName, checkin, checkout }).catch(e => ({ error: e.message }))
}

/**
 * Scrape parking listings for one venue using an already-booted Way.com page.
 * Reuses the Cloudflare-cleared browser session — do NOT call close() on the
 * page or browser here; that is the caller's responsibility.
 *
 * Returns:
 *   { status, address, listings, cheapest, venueLat, venueLon, citySlug, checkin, checkout }
 *
 * listings items: { name, price, currency, distance, rating, reviews, lat, lon, lotId, raw }
 */
export async function scrapeWayWithPage(page, address) {
  const result = {
    source: 'way.com', address, status: 'unknown',
    listings: [], cheapest: null,
    venueLat: null, venueLon: null,
  }

  try {
    // Step 1: autosuggest → get city + event time
    const autosuggestData = await page.evaluate(async (addr) => {
      const res = await fetch('https://www.way.com/way-search/v2/public/autosuggest', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'accept': 'application/json' },
        body: JSON.stringify({ searchString: addr, serviceType: 'PARKING', parkingSearchTab: 'HOURLY' }),
      }).catch(() => null)
      if (!res) return { error: 'fetch_failed' }
      return { status: res.status, body: await res.json().catch(() => null) }
    }, address)

    // Mid-run CF re-challenge: cf_clearance expired or the proxy IP rotated.
    // Signal it distinctly so the batch runner can reboot the browser and retry.
    if (looksLikeCfBlock(autosuggestData)) {
      result.status = 'cloudflare_challenge'
      result.debug = { stage: 'autosuggest', status: autosuggestData?.status, error: autosuggestData?.error }
      return result
    }

    const suggestions = autosuggestData?.body?.response || []
    const first = suggestions[0]
    if (!first) {
      result.status = 'passed_no_listings'
      result.debug = { autosuggestStatus: autosuggestData?.status }
      return result
    }

    const { lat, lon, city, stateCode } = first.addressDto
    result.venueLat = parseFloat(lat)
    result.venueLon = parseFloat(lon)

    const citySlug = toSlug(city, stateCode)
    result.citySlug = citySlug

    // Time window: event ±2h (event-driven inventory) or generic tomorrow 14:00–18:00
    const fmt = dt => dt.toISOString().slice(0, 19).replace('T', ' ')
    let checkin, checkout
    if (first.eventTime) {
      const evt = new Date(first.eventTime.replace(' ', 'T'))
      checkin  = fmt(new Date(evt.getTime() - 2 * 60 * 60 * 1000))
      checkout = fmt(new Date(evt.getTime() + 3 * 60 * 60 * 1000))
    } else {
      const _d = new Date(); _d.setDate(_d.getDate() + 1)
      const _y = `${_d.getFullYear()}-${String(_d.getMonth()+1).padStart(2,'0')}-${String(_d.getDate()).padStart(2,'0')}`
      checkin = `${_y} 14:00:00`; checkout = `${_y} 18:00:00`
    }
    result.checkin = checkin; result.checkout = checkout

    // Step 2: city-parking/search with bare slug (e.g. "bronx-ny", NOT "bronx-ny/.")
    let lotData = await citySearch(page, citySlug, checkin, checkout)
    if (looksLikeCfBlock(lotData)) {
      result.status = 'cloudflare_challenge'
      result.debug = { stage: 'citySearch', status: lotData?.status, error: lotData?.error }
      return result
    }
    let rows = lotData?.body?.rows || []

    // Fallback: try alternate slugs if primary returns 0
    if (!rows.length && lotData?.body?.totalRecords === 0) {
      const alts = [
        toSlug(city.replace(/\s*city$/i, ''), stateCode),
        toSlug(first.addressDto.state || '', stateCode),
      ].filter((s, i, a) => s !== citySlug && s.length > 3 && a.indexOf(s) === i)

      for (const alt of alts) {
        const r2 = await citySearch(page, alt, checkin, checkout)
        if (r2?.body?.rows?.length) { rows = r2.body.rows; break }
      }
    }

    if (rows.length) {
      result.listings = rows.map(r => ({
        name:     r.listingName || '?',
        price:    r.minPrice != null ? parseFloat(r.minPrice) : null,
        currency: 'USD',
        distance: r.distance != null ? parseFloat(r.distance) : null,
        rating:   r.avgRating ?? null,
        reviews:  r.totalReviews ?? null,
        lat:      r.lat ?? null,
        lon:      r.lon ?? null,
        lotId:    r.listingId ?? null,
        raw:      r,
      }))
      result.cheapest = result.listings.reduce((best, l) =>
        (l.price != null && (best == null || l.price < best.price)) ? l : best, null)
      result.status = 'ok'
    } else {
      result.status = 'passed_no_listings'
      result.debug = { citySlug, checkin, checkout, totalRecords: lotData?.body?.totalRecords }
    }
  } catch (err) {
    result.status = 'error'
    result.error = err.message
  }

  return result
}

// ---------------------------------------------------------------------------
// CLI / single-shot wrapper — manages its own browser lifecycle.
// ---------------------------------------------------------------------------

export async function scrapeWay(address, opts = {}) {
  const proxyUrl = process.env.WAY_PROXY_URL || process.env.RESIDENTIAL_PROXY_URL || process.env.PROXY_URL
  const proxy = parseProxy(proxyUrl)
  // CLI default: headed (passes CF most reliably); WAY_HEADLESS=1 to run headless
  const headless = process.env.WAY_HEADLESS === '1'

  let browser, page, context
  try {
    ;({ browser, context, page } = await initWayBrowser({ headless }))
  } catch (err) {
    return {
      source: 'way.com', address, proxied: !!proxy,
      status: err.message.startsWith('cloudflare') ? err.message : 'error',
      error: err.message, listings: [], cheapest: null,
    }
  }

  // Debug: log all Way API responses
  const apiHits = []
  page.on('response', async res => {
    const url = res.url()
    if (!url.includes('cloudflare') && !url.includes('google') && !url.includes('doubleclick') &&
        (url.includes('way-search') || /way\.com.*(parking|lot|spot|venue|price)/i.test(url))) {
      let body = null
      try { body = await res.json() } catch {}
      console.error(`[way:api] ${res.status()} ${url}`)
      if (body) console.error(`[way:api:body] ${JSON.stringify(body).slice(0, 300)}`)
      apiHits.push({ url, status: res.status(), body })
    }
  })

  const result = await scrapeWayWithPage(page, address)
  result.proxied = !!proxy
  if (apiHits.length) result.apiHits = apiHits.slice(0, 3)

  await page.close().catch(() => {})
  if (!opts.keepBrowser) await browser.close().catch(() => {})
  return result
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const addr = process.argv.slice(2).join(' ') || 'Madison Square Garden, New York'
  const proxyUrl = process.env.WAY_PROXY_URL || process.env.RESIDENTIAL_PROXY_URL || process.env.PROXY_URL
  console.log(`[way] scraping "${addr}" ${proxyUrl ? '(via proxy)' : '(NO proxy — expect a challenge)'}`)
  scrapeWay(addr)
    .then(r => { console.log(JSON.stringify(r, null, 2)); process.exit(r.status === 'ok' ? 0 : 1) })
    .catch(e => { console.error(e); process.exit(1) })
}

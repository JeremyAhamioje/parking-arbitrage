// ParkWhiz parking scraper.
//
// ParkWhiz has NO Cloudflare protection — it blocks only AWS-origin IPs via
// its WAF (awselb/2.0). Any non-AWS IP (including free datacenter proxies like
// Webshare) returns 200 from the main site and the v4/quotes API. Confirmed
// live 2026-06-12: 4×200 + 2×307 from ParkWhiz, API returns 400 (bad params,
// not 403) — data path is OPEN.
//
// Strategy: launch a headless browser (no stealth tricks needed), navigate to
// the ParkWhiz search page, and intercept the api.parkwhiz.com/v4/quotes XHR
// response. This avoids reverse-engineering the exact required query params —
// the browser handles auth, session, and headers automatically.
//
// Status codes returned in result.status:
//   ok                — listings parsed from intercepted API response
//   no_listings       — API responded but returned zero quotes
//   no_api_response   — page loaded but the XHR call never fired (timeout)
//   blocked           — got a non-200 HTTP status (proxy may be blocked/dead)
//   error             — navigation/runtime failure (see result.error)
//
// Env:
//   PARKWHIZ_PROXY_URL   single proxy URL (http://user:pass@host:port)
//   PARKWHIZ_PROXY_URLS  comma-separated list for round-robin rotation
//   PROXY_URL            fallback if neither above is set
//   DEBUG_PARKWHIZ=1     dump raw API response body to stdout (schema discovery)
//
// Run standalone:
//   node src/scrapers/parkwhiz.js "Madison Square Garden, New York" "2025-07-01T18:00:00" "2025-07-01T23:00:00"
//   PARKWHIZ_PROXY_URL="http://user:pass@host:port" node src/scrapers/parkwhiz.js "..."

import 'dotenv/config'
import { dirname, join } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { writeFileSync } from 'fs'
import { parseProxy, launchStealthContext } from './_stealth.js'

const __dir = dirname(fileURLToPath(import.meta.url))
const SESSION_FILE = join(__dir, '../../.parkwhiz-session.json')

// ---------------------------------------------------------------------------
// Proxy rotation
// ---------------------------------------------------------------------------

export function pickProxy() {
  const multi = process.env.PARKWHIZ_PROXY_URLS
  if (multi) {
    const list = multi.split(',').map(s => s.trim()).filter(Boolean)
    if (list.length) return parseProxy(list[Math.floor(Math.random() * list.length)])
  }
  return parseProxy(process.env.PARKWHIZ_PROXY_URL || process.env.PROXY_URL)
}

// ---------------------------------------------------------------------------
// Response parser
// ---------------------------------------------------------------------------

/**
 * Normalize a ParkWhiz v4/quotes API body into a flat listing array.
 * The API returns either a bare array or a wrapped { quotes: [...] } object.
 * Each element may have nested { location, quote } or be flat — handle both.
 */
function parseApiResponse(body) {
  const quotes = Array.isArray(body) ? body : (body.quotes || body.data || body.results || [])

  const listings = []
  for (const item of quotes) {
    // Nested structure: { location: {...}, quote: {...} }
    const loc = item.location || item
    const qt  = item.quote    || item

    const rawPrice = qt.all_in_price ?? qt.price ?? item.all_in_price ?? item.price
    const price = rawPrice != null ? parseFloat(rawPrice) : NaN
    if (!price || price <= 0 || !isFinite(price)) continue

    listings.push({
      id:        loc.id          ?? item.location_id    ?? null,
      name:      loc.name        ?? item.location_name  ?? null,
      address:   loc.address1    ?? loc.address         ?? item.address ?? null,
      city:      loc.city        ?? null,
      state:     loc.state       ?? null,
      price,
      basePrice:      qt.price         != null ? parseFloat(qt.price)         : null,
      allInPrice:     qt.all_in_price  != null ? parseFloat(qt.all_in_price)  : price,
      rating:    loc.rating      ?? item.rating  ?? null,
      spaces:    item.spaces_available ?? item.available_spaces ?? null,
      amenities: toStringArray(qt.amenities ?? item.amenities),
      url:       qt.external_url ?? item.external_url ?? null,
      lat:       loc.latitude    ?? item.latitude  ?? null,
      lng:       loc.longitude   ?? item.longitude ?? null,
    })
  }

  // Cheapest first.
  listings.sort((a, b) => a.price - b.price)
  return listings
}

function toStringArray(val) {
  if (!Array.isArray(val)) return []
  return val.map(a => (typeof a === 'string' ? a : a?.name ?? a?.display_name ?? String(a))).filter(Boolean)
}

// ---------------------------------------------------------------------------
// Main scraper
// ---------------------------------------------------------------------------

/**
 * Scrape ParkWhiz parking listings for an address/venue + time window.
 *
 * @param {string} address       — venue name or street address
 * @param {object} [opts]
 * @param {string} [opts.startTime]   — ISO string for parking start (default: now)
 * @param {string} [opts.endTime]     — ISO string for parking end (default: now + 4h)
 * @param {string} [opts.proxyUrl]    — override proxy URL for this call
 * @returns {Promise<ScrapeParkWhizResult>}
 */
export async function scrapeParkWhiz(address, opts = {}) {
  const now   = new Date()
  const plus4 = new Date(now.getTime() + 4 * 60 * 60 * 1000)
  const fmt = d => d.toISOString().slice(0, 19)  // YYYY-MM-DDTHH:MM:SS (no tz)

  const startTime = opts.startTime ? opts.startTime.slice(0, 19) : fmt(now)
  const endTime   = opts.endTime   ? opts.endTime.slice(0, 19)   : fmt(plus4)

  const proxy = opts.proxyUrl ? parseProxy(opts.proxyUrl) : pickProxy()

  const result = {
    source:    'parkwhiz',
    address,
    startTime,
    endTime,
    status:    'unknown',
    listings:  [],
    cheapest:  null,
    proxied:   !!proxy,
  }

  const headful = opts.headful ?? (process.env.PARKWHIZ_HEADFUL === '1')
  const { browser, context } = await launchStealthContext({
    proxy,
    sessionFile: SESSION_FILE,
    headful,
  })

  // Capture the first v4/quotes API response via XHR interception.
  let captureResolve, captureReject
  const capturePromise = new Promise((res, rej) => {
    captureResolve = res
    captureReject  = rej
  })

  context.on('response', async response => {
    const url = response.url()
    const status = response.status()
    const ct = response.headers()['content-type'] || ''

    // In debug mode log every JSON-returning request so we can find the real endpoint
    if (process.env.DEBUG_PARKWHIZ === '1' && ct.includes('json') && status === 200) {
      console.log(`[parkwhiz] JSON ${status} → ${url.slice(0, 180)}`)
    }

    // Catch any parkwhiz-origin JSON call that looks like listing/quote data
    if (url.includes('parkwhiz.com') && status === 200 && ct.includes('json')) {
      try {
        const body = await response.json()
        const arr = Array.isArray(body) ? body : (body.quotes || body.data || body.results || body.locations || [])
        if (arr.length > 0) {
          if (process.env.DEBUG_PARKWHIZ === '1') {
            console.log('[parkwhiz] candidate response body:', JSON.stringify(body, null, 2).slice(0, 4000))
          }
          captureResolve(body)
        }
      } catch { /* non-JSON or already consumed */ }
    } else if (url.includes('parkwhiz.com') && (status === 403 || status === 429)) {
      captureReject(new Error(`parkwhiz ${status} — proxy may be blocked`))
    }
  })

  const page = await context.newPage()

  try {
    // ParkWhiz uses venue-slug URLs: /madison-square-garden-parking/?start=...&end=...&daily=1
    // Times must include a timezone offset (e.g. -04:00 for EDT).
    const searchUrl = buildSearchUrl(address, startTime, endTime, opts.slug ?? null)
    console.log(`[parkwhiz] → ${searchUrl}`)

    // 'commit' fires on first byte — doesn't hang on slow proxies like 'domcontentloaded'
    const navRes = await page.goto(searchUrl, { waitUntil: 'commit', timeout: 45000 })
    const httpStatus = navRes?.status() ?? 0

    if (httpStatus === 403) {
      result.status = 'blocked'
      result.error = 'HTTP 403 — proxy is blocked or IP is blacklisted'
      return await finish()
    }

    if (httpStatus === 404) {
      // Slug didn't match — store the derived slug so the caller can override it
      result.status = 'slug_not_found'
      result.error  = `Venue slug not found: ${venueSlug(address)} — pass opts.slug to override`
      return await finish()
    }

    // commit fires on first byte — wait for DOM to be parsed; non-fatal on slow proxies
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {})
    // Give the page JS time to hydrate and write __INITIAL_STATE__
    await page.waitForTimeout(5000)

    if (process.env.DEBUG_PARKWHIZ === '1') {
      // Dump first 4000 chars of rendered HTML so we can identify the real structure
      const snippet = await page.evaluate(() => document.documentElement.innerHTML.slice(0, 4000))
      console.log('[parkwhiz] page HTML snippet:\n', snippet)
    }

    const pageData = await page.evaluate(() => {
      // Next.js embeds all server props here
      const el = document.getElementById('__NEXT_DATA__')
      if (el) {
        try { return { type: 'nextdata', data: JSON.parse(el.textContent) } } catch {}
      }
      // Fallback: look for window.__INITIAL_STATE__ or similar global
      for (const key of ['__INITIAL_STATE__', '__PRELOADED_STATE__', '__APP_STATE__', 'PW_DATA', '__pw_data__']) {
        if (window[key]) return { type: key, data: window[key] }
      }
      return null
    })

    if (process.env.DEBUG_PARKWHIZ === '1') {
      if (pageData) {
        // Targeted dump: first locations item in full (price/embedded structure recon)
        const firstLoc = pageData.data.locations?.[0]
        if (firstLoc) {
          console.log('[parkwhiz] locations[0] full:', JSON.stringify(firstLoc, null, 2).slice(0, 3000))
        }

        // Dump top-level keys first, then a targeted deep slice
        const keys = Object.keys(pageData.data)
        console.log(`[parkwhiz] __INITIAL_STATE__ top-level keys: ${JSON.stringify(keys)}`)
        // Dump each key's shape (type + if array, first element keys)
        for (const k of keys) {
          const v = pageData.data[k]
          if (Array.isArray(v) && v.length) {
            console.log(`  ${k}: Array(${v.length}), first item keys: ${JSON.stringify(Object.keys(v[0] || {}))}`)
          } else if (v && typeof v === 'object') {
            console.log(`  ${k}: Object, keys: ${JSON.stringify(Object.keys(v).slice(0, 15))}`)
          } else {
            console.log(`  ${k}: ${JSON.stringify(v)}`)
          }
        }
      } else {
        console.log('[parkwhiz] no embedded data found (__NEXT_DATA__ absent)')
      }
    }

    let listings = []
    if (pageData) {
      listings = extractListingsFromPageData(pageData)
      // True venue coordinates (pw:venue.coordinates is a [lat, lng] array) — a
      // better anchor for the venue record than a random lot's location.
      const vc = pageData.data?.locations?.[0]?._embedded?.['pw:venue']?.coordinates
              ?? pageData.data?.venue?.coordinates
      if (Array.isArray(vc)) { result.venueLat = parseFloat(vc[0]); result.venueLon = parseFloat(vc[1]) }
      else if (vc && typeof vc === 'object') {
        result.venueLat = parseFloat(vc.lat ?? vc.latitude)
        result.venueLon = parseFloat(vc.lng ?? vc.longitude)
      }
    }

    // Fallback: DOM scrape if embedded data yielded nothing
    if (!listings.length) {
      listings = await scrapeListingsFromDom(page)
      if (process.env.DEBUG_PARKWHIZ === '1') {
        console.log('[parkwhiz] DOM fallback listings:', JSON.stringify(listings, null, 2).slice(0, 3000))
      }
    }

    result.listings = listings
    result.cheapest = listings.length ? listings[0].price : null
    result.status   = listings.length ? 'ok' : 'no_listings'

    // Persist session (no cf_clearance needed, but keeps any PW session cookies).
    try {
      writeFileSync(SESSION_FILE, JSON.stringify(await context.storageState()))
    } catch { /* non-fatal */ }

  } catch (err) {
    if (err.message === 'timeout') {
      result.status = 'no_api_response'
      result.error  = 'Page load or data extraction timed out'
    } else {
      result.status = 'error'
      result.error  = err.message
    }
  }

  return await finish()

  async function finish() {
    await page.close().catch(() => {})
    await browser.close().catch(() => {})
    return result
  }
}

/**
 * Extract listings from ParkWhiz's __INITIAL_STATE__.locations array.
 *
 * State shape (confirmed live 2026-06-13):
 *   locations[]: { location_id, name:"", distance:{straight_line:{meters}}, purchase_options[], _embedded }
 *   purchase_options[]: {
 *     base_price:{ USD:"37.00" }, price:{ USD:"39.59" },   // dollar STRINGS under a currency key
 *     fees:[{ price:{USD}, type, label }],
 *     space_availability:{ status:"available" },           // status only, NO count
 *     amenities:[{ name, key, enabled, visible }],
 *   }
 *   _embedded['pw:location']: { id, name, address1, city, state, site_url, rating_summary, entrances[] }
 *
 * The lot-level `name` is empty — the real name/address live under pw:location.
 * Prices are already DOLLARS (not cents), so no /100.
 */
export function extractListingsFromPageData({ data }) {
  // Redux SSR puts it at .locations; some Next builds nest it under props.pageProps.
  const locations =
    (Array.isArray(data?.locations) && data.locations) ||
    (Array.isArray(data?.props?.pageProps?.locations) && data.props.pageProps.locations) ||
    null
  if (!locations || !locations.length) return []

  return locations.map(item => {
    const opts = Array.isArray(item.purchase_options) ? item.purchase_options : []

    // Each option's all-in price (price.USD) + base (base_price.USD), in dollars.
    // SOLD-OUT lots still emit a STUB option: epoch-zero window (1969/1970),
    // base_price $0.00, a nominal ~$0.99 service fee, space_availability
    // "unavailable". Those produced bogus "$0.99 · Available" listings that don't
    // exist as buyable passes on parkwhiz.com — so reject any option that is
    // unavailable OR carries a non-real (pre-2000) start window.
    const priced = opts
      .map(o => {
        const allIn  = money(o.price ?? o.all_in_price)
        const base   = money(o.base_price ?? o.price)
        const status = String(o.space_availability?.status || '').toLowerCase()
        const startYr = new Date(o.start_time || 0).getUTCFullYear()
        const sellable = status !== 'unavailable' && status !== 'sold_out' && status !== 'soldout' && startYr >= 2000
        return { allIn, base: base ?? allIn, sellable }
      })
      .filter(p => p.allIn != null && p.allIn > 0 && p.sellable)
    if (!priced.length) return null

    const best = priced.reduce((a, b) => (b.allIn < a.allIn ? b : a)) // cheapest all-in
    const allInPrice = round2(best.allIn)
    const price      = round2(best.base ?? best.allIn)

    const emb = item._embedded || {}
    const pw  = emb['pw:location'] || emb['location'] || {}

    const meters = item.distance?.straight_line?.meters
                 ?? item.distance?.meters
                 ?? (typeof item.distance === 'number' ? item.distance : null)

    // entrances[0].coordinates is a [lat, lng] ARRAY (not {lat,lng}).
    const entCoords = (Array.isArray(pw.entrances) ? pw.entrances[0] : null)?.coordinates
    const [lat, lng] = Array.isArray(entCoords)
      ? [num(entCoords[0]), num(entCoords[1])]
      : [num(pw.latitude) ?? num(pw.lat), num(pw.longitude) ?? num(pw.lng)]

    return {
      facilityId:  String(item.location_id ?? pw.id ?? ''),
      name:        pw.name || item.name || null,
      address:     pw.address1 || pw.address || null,
      city:        pw.city ?? null,
      state:       pw.state ?? null,
      price,
      allInPrice,
      available:   true, // only sellable (in-stock, real-window) options survived the filter
      rating:      num(pw.rating_summary?.rating) ?? num(pw.rating_summary?.average) ?? num(pw.rating),
      distance:    meters,   // metres from venue
      spaces:      null,     // ParkWhiz exposes an availability STATUS, not a count
      amenities:   collectAmenities(opts),
      url:         pw.site_url ? `https://www.parkwhiz.com${pw.site_url}` : null,
      lat,
      lng,
    }
  }).filter(Boolean).sort((a, b) => a.price - b.price)
}

/** Parse a ParkWhiz money value: { USD:"39.59" } | "39.59" | 39.59 → Number (dollars). */
function money(v) {
  if (v == null) return null
  if (typeof v === 'object') {
    const raw = v.USD ?? v.usd ?? Object.values(v)[0]
    const n = parseFloat(raw)
    return isFinite(n) ? n : null
  }
  const n = parseFloat(v)
  return isFinite(n) ? n : null
}

function num(v) { if (v == null) return null; const n = parseFloat(v); return isFinite(n) ? n : null }
function round2(n) { return parseFloat(Number(n).toFixed(2)) }

/** Distinct names of enabled+visible amenities across a lot's purchase options. */
function collectAmenities(opts) {
  const set = new Set()
  for (const o of opts) {
    for (const a of (Array.isArray(o.amenities) ? o.amenities : [])) {
      if (a && a.enabled && a.visible && a.name) set.add(a.name)
    }
  }
  return [...set]
}

/** Scrape price + name from the rendered DOM cards. */
async function scrapeListingsFromDom(page) {
  return page.evaluate(() => {
    const out = []
    const cards = Array.from(document.querySelectorAll(
      '[class*="location" i], [class*="spot" i], [class*="listing" i], [class*="result" i], article, li'
    ))
    for (const card of cards) {
      const priceEl = card.querySelector('[class*="price" i], [class*="rate" i], [class*="cost" i]')
      if (!priceEl) continue
      const m = priceEl.textContent.match(/\$\s?(\d+(?:\.\d{1,2})?)/)
      if (!m) continue
      // ParkWhiz stores raw cents in the DOM (e.g. 2140 = $21.40)
      const raw = parseFloat(m[1])
      if (!raw || raw <= 0) continue
      const price = raw > 200 ? parseFloat((raw / 100).toFixed(2)) : raw
      const nameEl = card.querySelector('h1,h2,h3,h4,[class*="name" i],[class*="title" i]')
      const addrEl = card.querySelector('[class*="address" i], [class*="street" i]')
      const name    = nameEl?.textContent?.trim().slice(0, 120) ?? null
      const address = addrEl?.textContent?.trim().slice(0, 120) ?? null
      // Stable ID derived from the facility name — used for price-trend tracking
      // until we wire up __INITIAL_STATE__ to get the real ParkWhiz location id
      const facilityId = name
        ? name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
        : null
      out.push({ facilityId, name, address, price, allInPrice: price })
    }
    const seen = new Set()
    return out
      .filter(l => { const k = `${l.name}|${l.price}`; if (seen.has(k)) return false; seen.add(k); return true })
      .sort((a, b) => a.price - b.price)
  })
}

/**
 * Derive the ParkWhiz venue slug from a venue name or address.
 * "Madison Square Garden, New York" → "madison-square-garden-parking"
 * Override per-call via opts.slug if the derived slug is wrong.
 */
export function venueSlug(address) {
  const name = address.split(',')[0]         // drop city/state suffix
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')            // keep only alphanumeric + spaces
    .trim()
    .replace(/\s+/g, '-')                    // spaces → hyphens
    .replace(/-+/g, '-')                     // collapse runs of hyphens
  return `${name}-parking`
}

/**
 * Build the ParkWhiz venue URL.
 * Format confirmed from live URL:
 *   /madison-square-garden-parking/?start=2026-07-15T19:00:00-04:00&end=...&daily=1
 * Timezone offset defaults to EDT (-04:00). Set PARKWHIZ_TZ_OFFSET for other zones.
 */
export function buildSearchUrl(address, startTime, endTime, slug = null) {
  const tz   = process.env.PARKWHIZ_TZ_OFFSET || '-04:00'
  const start = encodeURIComponent(`${startTime}${tz}`)
  const end   = encodeURIComponent(`${endTime}${tz}`)
  const s     = slug || venueSlug(address)
  return `https://www.parkwhiz.com/${s}/?start=${start}&end=${end}&daily=1`
}

// ---------------------------------------------------------------------------
// Standalone CLI runner
// ---------------------------------------------------------------------------

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [,, addr = 'Madison Square Garden, New York', start, end] = process.argv
  const proxy = process.env.PARKWHIZ_PROXY_URL || process.env.PARKWHIZ_PROXY_URLS?.split(',')[0] || process.env.PROXY_URL
  console.log(`[parkwhiz] scraping "${addr}"${proxy ? ' (via proxy)' : ' (NO proxy)'}`)
  if (start) console.log(`[parkwhiz]   window: ${start} → ${end || '(+4h)'}`)

  scrapeParkWhiz(addr, { startTime: start, endTime: end })
    .then(r => {
      console.log(JSON.stringify(r, null, 2))
      process.exit(r.status === 'ok' ? 0 : 1)
    })
    .catch(e => { console.error(e); process.exit(1) })
}

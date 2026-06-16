// ParkWhiz live fetch — event-specific (Tool 1) and date-specific (Tool 2).
//
// ParkWhiz embeds its full events list in the venue page's SSR state
// (__INITIAL_STATE__.events[] = { id, name, start_time, end_time, site_url }).
// Event isolation: fuzzy-match the user's event against that list, then run the
// PROVEN venue-slug transient search scoped to the matched event's exact
// start/end window. (The event's own site_url page lazy-loads via XHR and often
// returns 0 SSR lots, so the time-window path on the venue slug is what we use —
// same event-window strategy as SpotHero and Way, and it reuses the verified
// extractor in scrapers/parkwhiz.js.)
//
// No Cloudflare — only an AWS-ELB WAF that 403s non-US IPs, cleared by the US
// datacenter proxy pool (PARKWHIZ_PROXY_URLS).

import { launchStealthContext } from '../../scrapers/_stealth.js'
import { pickProxy, venueSlug, buildSearchUrl, extractListingsFromPageData } from '../../scrapers/parkwhiz.js'
import { bestMatch, THRESHOLDS } from '../match.js'

const PLATFORM = 'parkwhiz'
const HORIZON_MS = 365 * 24 * 3600e3

function mapListing(l) {
  return {
    spot:           l.name || '',
    address:        [l.address, l.city, l.state].filter(Boolean).join(', '),
    price:          l.allInPrice ?? l.price ?? null,
    advertised:     l.price ?? null,
    currency:       'USD',
    available:      l.available ?? true,
    availableSpaces: null,
    distanceMeters: typeof l.distance === 'number' ? Math.round(l.distance) : null,
    facilityId:     String(l.facilityId || ''),
    amenities:      Array.isArray(l.amenities) ? l.amenities.join(', ') : '',
    lat:            l.lat ?? null,
    lng:            l.lng ?? null,
  }
}

/** Read the venue page's embedded events, filtered to genuine upcoming ones
 *  (the array contains stale 2098 "postponed" placeholders). */
async function readEvents(page) {
  return page.evaluate(({ horizon }) => {
    const now = Date.now()
    return (window.__INITIAL_STATE__?.events || [])
      .filter(e => { const t = new Date(e.start_time).getTime(); return t > now && t < now + horizon })
      .sort((a, b) => new Date(a.start_time) - new Date(b.start_time))
      .map(e => ({ id: e.id, name: e.name, start: e.start_time, end: e.end_time }))
  }, { horizon: HORIZON_MS })
}

/** Navigate a search URL and pull listings from __INITIAL_STATE__.locations. */
async function fetchListings(page, url) {
  await page.goto(url, { waitUntil: 'commit', timeout: 45000 })
  await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {})
  await page.waitForTimeout(5000)
  // grab just the locations array (state is ~150KB) — retry across hydration nav
  let locations = []
  for (let i = 0; i < 3; i++) {
    try {
      locations = await page.evaluate(() => window.__INITIAL_STATE__?.locations || [])
      if (locations.length) break
      await page.waitForTimeout(2000)
    } catch { await page.waitForTimeout(1500) }
  }
  return extractListingsFromPageData({ data: { locations } }).map(mapListing)
}

async function withBrowser(fn) {
  const proxy = pickProxy()
  const { browser, context } = await launchStealthContext({ proxy, headful: false })
  const page = await context.newPage()
  try { return await fn(page, !!proxy) }
  finally { await browser.close().catch(() => {}) }
}

// naive ISO (strip offset) so buildSearchUrl can append PARKWHIZ_TZ_OFFSET cleanly
const naive = iso => String(iso || '').slice(0, 19)

// --- public API ------------------------------------------------------------

export async function eventFetch({ venue, event }) {
  const out = { platform: PLATFORM, status: 'error', venueConfidence: null, eventConfidence: null, matchedEvent: null, candidates: [], listings: [] }
  try {
    return await withBrowser(async (page, proxied) => {
      out.venueConfidence = proxied ? 100 : null
      await page.goto(`https://www.parkwhiz.com/${venueSlug(venue)}/`, { waitUntil: 'commit', timeout: 45000 })
      await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {})
      await page.waitForTimeout(5000)

      const events = await readEvents(page)
      if (!events.length) { out.status = 'no_events'; return out }

      const m = bestMatch(event, events, e => e.name)
      out.eventConfidence = m.confidence
      out.candidates = events.slice(0, 12).map(e => ({ title: e.name, date: (e.start || '').slice(0, 10) }))
      if (m.confidence < THRESHOLDS.ambiguous) { out.status = 'event_not_found'; return out }

      const ev = m.item
      out.matchedEvent = ev.name
      out.matchedEventDate = (ev.start || '').slice(0, 10)
      out.needsConfirmation = m.confidence < THRESHOLDS.confident

      const start = naive(ev.start)
      const end = ev.end ? naive(ev.end) : naive(new Date(new Date(ev.start).getTime() + 4 * 3600e3).toISOString())
      out.listings = await fetchListings(page, buildSearchUrl(venue, start, end))
      out.status = out.listings.length ? 'ok' : 'no_listings'
      return out
    })
  } catch (e) { out.error = e.message; return out }
}

export async function dateFetch({ venue, start, end }) {
  const out = { platform: PLATFORM, status: 'error', venueConfidence: null, listings: [] }
  try {
    return await withBrowser(async (page, proxied) => {
      out.venueConfidence = proxied ? 100 : null
      // buildSearchUrl slices to 19 chars + appends PARKWHIZ_TZ_OFFSET; daily=1 (daily rate).
      const url = buildSearchUrl(venue, start, end)
      out.listings = await fetchListings(page, url)
      out.status = out.listings.length ? 'ok' : 'no_listings'
      return out
    })
  } catch (e) { out.error = e.message; return out }
}

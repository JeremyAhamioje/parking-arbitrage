// SpotHero live fetch — event-specific (Tool 1) and date-specific (Tool 2).
//
// Event isolation is API-first, exactly as the spec demands:
//   1. resolve destination_id for the venue (catalog/geo match)
//   2. GET /v2/events?destination_id=  → the venue's real events (with event_id)
//   3. fuzzy-match the user's event text against those titles (confidence)
//   4. transient search scoped to the matched event's id + parking_window
// We never scrape the generic venue page; the event window + event_id is what
// makes the inventory event-specific.
//
// All HTTP goes through the Playwright page (browser context) because
// api.spothero.com rejects bare Node fetch that doesn't share the session.

import { randomUUID } from 'crypto'
import {
  createSpotHeroContext,
  geocodeVenue, discoverDestinationAndEvents,
} from '../../scrapers/spothero.js'
import { bestMatch, THRESHOLDS } from '../match.js'
import { createPagePool } from '../ctx-pool.js'

const PLATFORM = 'spothero'

// Warm pool of independent SpotHero contexts — reused across requests (no cold
// boot) and lets up to SPOTHERO_POOL_MAX live fetches run in parallel.
const pool = createPagePool({
  name: 'spothero',
  max: +(process.env.SPOTHERO_POOL_MAX || 2),
  boot: createSpotHeroContext,
})

// --- in-browser API calls --------------------------------------------------

/** Full events for a destination, preserving event_id + parking_window (the
 *  existing scraper mappers drop event_id, which we need for scoping). */
async function fetchEvents(page, destinationId) {
  const raw = await page.evaluate(async (id) => {
    try {
      const res = await fetch(`https://api.spothero.com/v2/events?destination_id=${id}`, {
        headers: { Accept: 'application/json', Referer: 'https://spothero.com/', Origin: 'https://spothero.com' },
      })
      if (!res.ok) return { error: `HTTP ${res.status}` }
      return { data: (await res.json()).data || [] }
    } catch (e) { return { error: e.message } }
  }, destinationId)

  if (raw.error) return []
  const now = Date.now()
  return (raw.data || [])
    .map(e => ({
      eventId:  e.event_id ?? e.id ?? null,
      title:    e.title || e.name || 'Unknown Event',
      starts:   e.parking_window?.starts || e.starts || null,
      ends:     e.parking_window?.ends   || e.ends   || null,
      date:     e.starts ? e.starts.slice(0, 10) : null,
      seoUrl:   e.seo_url || null,
    }))
    .filter(e => e.starts && new Date(e.starts).getTime() > now - 6 * 3600e3) // upcoming-ish
}

/** Transient search, scoped to an event window (and event_id when available). */
async function searchTransient(page, { lat, lon, starts, ends, eventId, destinationId }) {
  const ids = () => randomUUID()
  let url = `https://api.spothero.com/v2/search/transient?oversize=false&sort_by=relevance&include_walking_distance=true`
    + `&lat=${lat}&lon=${lon}&starts=${encodeURIComponent(starts)}&ends=${encodeURIComponent(ends)}`
    + `&show_unavailable=false&initial_search=true&action=${eventId ? 'LIST_EVENT' : 'LIST_DESTINATION'}`
    + `&session_id=${ids()}&search_id=${ids()}&action_id=${ids()}&fingerprint=${ids()}`
  if (eventId) url += `&event_id=${encodeURIComponent(eventId)}`
  if (destinationId) url += `&destination_id=${encodeURIComponent(destinationId)}`

  const all = []
  let next = url
  while (next) {
    const r = await page.evaluate(async (u) => {
      try {
        const res = await fetch(u, { headers: { Accept: 'application/json', Referer: 'https://spothero.com/', Origin: 'https://spothero.com' } })
        const body = await res.text()
        if (!res.ok) return { error: `HTTP ${res.status}` }
        const j = JSON.parse(body)
        return { results: j.results || [], next: j['@next'] || null }
      } catch (e) { return { error: e.message } }
    }, next)
    if (r.error) { if (all.length) break; throw new Error(`spothero search ${r.error}`) }
    all.push(...r.results)
    next = r.next
    if (next) await new Promise(z => setTimeout(z, 350))
  }
  return all.map(mapListing)
}

/** SpotHero result item → unified listing shape. */
function mapListing(r) {
  const f = r.facility?.common || {}
  const addr = f.addresses?.[0] || {}
  const quote = r.rates?.[0]?.quote
  const avail = r.availability || {}
  const advertised = (quote?.advertised_price?.value || 0) / 100
  const total = (quote?.total_price?.value || 0) / 100
  return {
    spot:           f.title || '',
    address:        [addr.street_address, addr.city, addr.state].filter(Boolean).join(', '),
    price:          total || advertised || null,
    advertised:     advertised || null,
    currency:       'USD',
    available:      avail.available ?? null,
    availableSpaces: typeof avail.available_spaces === 'number' ? avail.available_spaces : null,
    distanceMeters: r.distance?.walking_meters ?? null,
    facilityId:     String(f.id || ''),
  }
}

// --- public API ------------------------------------------------------------

/** Tool 1 — event-specific. Returns the unified platform-result envelope. */
export async function eventFetch({ venue, event, date }) {
  const out = { platform: PLATFORM, status: 'error', venueConfidence: null, eventConfidence: null, matchedEvent: null, candidates: [], listings: [] }
  const h = await pool.acquire()
  let broken = false
  try {
    const page = h.page
    const { lat, lon } = await geocodeVenue(venue)
    const { destinationId } = await discoverDestinationAndEvents(venue, lat, lon)
    if (!destinationId) { out.status = 'no_destination'; return out }
    out.venueConfidence = 100 // catalog/geo resolved

    const events = await fetchEvents(page, destinationId)
    if (!events.length) { out.status = 'no_events'; return out }

    const m = bestMatch(event, events, e => e.title)
    out.eventConfidence = m.confidence
    out.candidates = events.slice(0, 12).map(e => ({ title: e.title, date: e.date }))
    if (m.confidence < THRESHOLDS.ambiguous) { out.status = 'event_not_found'; return out }

    const ev = m.item
    out.matchedEvent = ev.title
    out.matchedEventDate = ev.date
    out.needsConfirmation = m.confidence < THRESHOLDS.confident
    out.listings = await searchTransient(page, {
      lat, lon, starts: ev.starts, ends: ev.ends, eventId: ev.eventId, destinationId,
    })
    out.status = 'ok'
    return out
  } catch (e) {
    broken = true
    out.error = e.message
    return out
  } finally {
    h.release(broken)
  }
}

/** Tool 2 — date-specific generic inventory (no event). */
export async function dateFetch({ venue, start, end }) {
  const out = { platform: PLATFORM, status: 'error', venueConfidence: null, listings: [] }
  const h = await pool.acquire()
  let broken = false
  try {
    const page = h.page
    const { lat, lon } = await geocodeVenue(venue)
    out.venueConfidence = 100
    out.listings = await searchTransient(page, { lat, lon, starts: start, ends: end })
    out.status = 'ok'
    return out
  } catch (e) {
    broken = true
    out.error = e.message
    return out
  } finally {
    h.release(broken)
  }
}

// Way.com live fetch — event-specific (Tool 1) and date-specific (Tool 2).
//
// HOW WAY EVENTS WORK (probed live 2026-06-14): the autosuggest endpoint is a
// fuzzy search over events. Searching the VENUE alone returns only a top-6 set
// (often missing the event you want); searching "<event> <venue>" returns that
// venue's matching events. Each event suggestion looks like:
//   { suggestion: "Goose - The Band, Madison Square Garden",  ← event name + venue
//     eventVenueName: "Madison Square Garden", eventVenueId: 8803,
//     eventTime: "2026-06-19 19:30:00", addressDto: { city, stateCode, lat, lon } }
// (The earlier bug read a non-existent `searchString` field and fell back to the
// city name, so nothing ever matched.) "Event-specific" parking is then Way's
// city-parking priced for the matched event's window (checkin = eventTime − 2h,
// checkout = +3h) — Way has no per-event lot isolation.
//
// Way is residential-metered + Cloudflare-gated, so it runs on a WARM POOL
// (boot once, reuse) — see way-pool.js. Set WAY_PROXY_STICKY=1 so the IP holds.

import { getWayPage, closeWayPool } from '../way-pool.js'
import { bestMatch, THRESHOLDS, similarity, confidence } from '../match.js'

const PLATFORM = 'way'

// Normalize a loose date to ISO YYYY-MM-DD. The sheet may carry "6/19/2026" while
// Way returns "2026-06-19 19:30:00" — without this they never compare equal.
function toISODate(v) {
  if (!v) return ''
  const s = String(v).trim()
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
  const m = s.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/) // M/D/YYYY or M/D/YY
  if (m) { const yr = m[3].length === 2 ? '20' + m[3] : m[3]; return `${yr}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` }
  const d = new Date(s)
  return isNaN(d) ? '' : d.toISOString().slice(0, 10)
}

// --- in-browser API calls (same endpoints way.js uses) ---------------------

async function autosuggest(page, searchString) {
  return page.evaluate(async (s) => {
    try {
      const res = await fetch('https://www.way.com/way-search/v2/public/autosuggest', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ searchString: s, serviceType: 'PARKING', parkingSearchTab: 'HOURLY' }),
      })
      return { status: res.status, body: await res.json().catch(() => null) }
    } catch (e) { return { error: e.message } }
  }, searchString)
}

async function citySearch(page, pageName, checkin, checkout) {
  return page.evaluate(async ({ pageName, checkin, checkout }) => {
    try {
      const res = await fetch('https://www.way.com/way-search/v1/public/city-parking/search', {
        method: 'POST',
        headers: {
          'content-type': 'application/json', accept: 'application/json',
          origin: 'https://www.way.com', referer: `https://www.way.com/parking/city/${pageName}/`,
        },
        body: JSON.stringify({
          pageName,
          paginationDto: { pageNumber: 1, pageSize: 100 },
          searchType: 'PARKING',
          parkingFilterDto: { checkin, checkout },
          pricingType: 'Hourly',
          showTotalPriceWithTaxes: false,
        }),
      })
      return { status: res.status, body: await res.json().catch(() => null) }
    } catch (e) { return { error: e.message } }
  }, { pageName, checkin, checkout })
}

// Event name from a suggestion: strip the trailing ", <venue>" → "Goose - The Band".
function eventName(s) {
  const full = (s.suggestion || '').trim()
  const v = (s.eventVenueName || '').trim()
  if (v && full.toLowerCase().endsWith((', ' + v).toLowerCase())) return full.slice(0, full.length - v.length - 2).trim()
  const i = full.lastIndexOf(',')
  return i > 0 ? full.slice(0, i).trim() : full
}

const slugify = c => c.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim().replace(/\s+/g, '-')

// Candidate Way city pageNames to try (the addressDto city → slug isn't always
// Way's exact page slug, so we fall through a few sensible variants).
function citySlugs(a) {
  const sc = (a.stateCode || '').toLowerCase()
  const city = a.city || ''
  const out = [`${slugify(city)}-${sc}`]
  if (/new york city/i.test(city)) out.push(`new-york-${sc}`, `manhattan-${sc}`)
  out.push(`${slugify(city.replace(/\s*city$/i, ''))}-${sc}`)
  return [...new Set(out)].filter(s => s.length > 3)
}

const fmt = dt => dt.toISOString().slice(0, 19).replace('T', ' ')

function mapRows(rows) {
  return rows.map(r => {
    const addr = r.address || {}
    const base = r.minPrice != null ? parseFloat(r.minPrice) : null
    const total = typeof r.totalPriceWithTax === 'number' ? r.totalPriceWithTax
                : typeof r.totalPrice === 'number' ? r.totalPrice : base
    return {
      spot:           r.listingName || '',
      address:        [addr.addressLine1, addr.city, addr.stateCode].filter(Boolean).join(', '),
      price:          total ?? base ?? null,
      advertised:     base ?? null,
      currency:       'USD',
      available:      r.availability !== false,
      availableSpaces: null,
      distanceMeters: r.distance != null ? Math.round(parseFloat(r.distance) * 1609.34) : null,
      facilityId:     String(r.listingId ?? ''),
      facilityType:   r.parkingType || '',
    }
  })
}

// Run city-parking/search across candidate slugs until one returns rows.
// Returns { rows } or { blocked, error }.
async function searchAcrossSlugs(page, addressDto, checkin, checkout) {
  for (const slug of citySlugs(addressDto)) {
    const res = await citySearch(page, slug, checkin, checkout)
    if (res.error) return { blocked: true, error: res.error }
    if (res.body?.rows?.length) return { rows: res.body.rows }
  }
  return { rows: [] }
}

// --- public API ------------------------------------------------------------

export async function eventFetch({ venue, event, date }) {
  const out = { platform: PLATFORM, status: 'error', venueConfidence: null, eventConfidence: null, matchedEvent: null, candidates: [], listings: [] }
  let page
  try { page = await getWayPage() }
  catch (e) {
    out.status = String(e.message).startsWith('cloudflare') ? 'blocked' : 'error'
    out.error = e.message
    await closeWayPool()
    return out
  }
  try {
    // Search by EVENT + VENUE so we get this venue's matching events (not the top-6).
    const sug = await autosuggest(page, `${event} ${venue}`)
    if (sug.error) { out.status = 'blocked'; out.error = sug.error; await closeWayPool(); return out }

    const events = (sug.body?.response || []).filter(s => s.indexServiceType === 'EVENTS' && s.suggestion)
    if (!events.length) { out.status = 'no_events'; return out }
    out.venueConfidence = 100

    const scoped = events.filter(s => similarity(venue, s.eventVenueName || '') >= 0.5)
    const pool = scoped.length ? scoped : events

    // Pick the event. venue + DATE is a stronger identifier than the event name —
    // platforms label the same show differently ("An Evening With Goose" vs
    // "Goose - The Band"). So if the user's date pins exactly one show at this
    // venue, that IS the match, regardless of how the name fuzzy-scores.
    const wantISO = toISODate(date)
    let ev, conf
    if (wantISO) {
      const sameDay = pool.filter(s => toISODate(s.eventTime) === wantISO)
      if (sameDay.length === 1) {
        ev = sameDay[0]
        conf = Math.max(confidence(event, eventName(ev)), 90) // venue+date pin it
      } else if (sameDay.length > 1) {
        const m = bestMatch(event, sameDay, eventName); ev = m.item; conf = m.confidence
      }
    }
    if (!ev) { const m = bestMatch(event, pool, eventName); ev = m.item; conf = m.confidence } // no date / no day-match → name only

    out.eventConfidence = conf
    out.candidates = pool.slice(0, 12).map(s => ({ title: eventName(s), date: toISODate(s.eventTime) }))
    if (!ev || conf < THRESHOLDS.ambiguous) { out.status = 'event_not_found'; return out }

    out.matchedEvent = eventName(ev)
    out.matchedEventDate = toISODate(ev.eventTime)
    out.needsConfirmation = conf < THRESHOLDS.confident

    const evt = new Date(String(ev.eventTime).replace(' ', 'T'))
    const checkin = fmt(new Date(evt.getTime() - 2 * 3600e3))
    const checkout = fmt(new Date(evt.getTime() + 3 * 3600e3))
    const r = await searchAcrossSlugs(page, ev.addressDto || {}, checkin, checkout)
    if (r.blocked) { out.status = 'blocked'; out.error = r.error; await closeWayPool(); return out }
    out.listings = mapRows(r.rows)
    out.status = out.listings.length ? 'ok' : 'no_listings'
    return out
  } catch (e) {
    out.error = e.message
    await closeWayPool()
    return out
  }
}

export async function dateFetch({ venue, start, end }) {
  const out = { platform: PLATFORM, status: 'error', venueConfidence: null, listings: [] }
  let page
  try { page = await getWayPage() }
  catch (e) {
    out.status = String(e.message).startsWith('cloudflare') ? 'blocked' : 'error'
    out.error = e.message
    await closeWayPool()
    return out
  }
  try {
    const sug = await autosuggest(page, venue)
    const first = sug.body?.response?.[0]
    if (!first) { out.status = 'no_results'; return out }
    out.venueConfidence = 100
    const checkin = String(start).replace('T', ' '), checkout = String(end).replace('T', ' ')
    const r = await searchAcrossSlugs(page, first.addressDto || {}, checkin, checkout)
    if (r.blocked) { out.status = 'blocked'; out.error = r.error; await closeWayPool(); return out }
    out.listings = mapRows(r.rows)
    out.status = out.listings.length ? 'ok' : 'no_listings'
    return out
  } catch (e) {
    out.error = e.message
    await closeWayPool()
    return out
  }
}

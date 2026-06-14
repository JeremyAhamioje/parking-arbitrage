// Shared SpotHero destination_id matcher.
//
// SpotHero's /v2/destinations endpoint ignores q/lat/lon — it's a paginated
// global catalog (~57k entries) where each row carries lat/lon. Venues are often
// listed under sponsor/team/old names (Amalie Arena = "Benchmark International
// Arena"). So we resolve a venue's destination_id by GEOGRAPHY + EVENT ACTIVITY,
// not name search: exact name wins when present; otherwise the busiest
// destination in a tight same-site cluster wins; the venue's own city tokens are
// stripped so e.g. "Las Vegas Convention Center" can't latch onto a casino.
//
// matchVenue() is transport-agnostic: the caller injects an async getEvents(id)
// so the standalone discovery script can use Node fetch while the scraper uses
// its Playwright browser context (Node fetch can't interleave with the live
// browser session against api.spothero.com).

import { readFileSync, existsSync } from 'fs'

export const RADIUS_M = 600   // consider catalog entries within this distance of the venue
export const CLUSTER_M = 150  // "same physical site" radius for the event-activity fallback
export const NEAR_CAP = 8     // fetch events for at most this many nearest cluster candidates
export const MIN_EVENTS = 5   // a name-less geo match must be this active to count as the venue

export const GENERIC = new Set(['arena', 'center', 'centre', 'stadium', 'theatre', 'theater', 'hall', 'park', 'field', 'garden', 'gardens', 'bowl', 'pavilion', 'place', 'palace', 'forum', 'dome', 'square', 'convention', 'music', 'the', 'of'])

export const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()

export function haversine(la1, lo1, la2, lo2) {
  const R = 6371000, p = Math.PI / 180
  const dla = (la2 - la1) * p, dlo = (lo2 - lo1) * p
  const a = Math.sin(dla / 2) ** 2 + Math.cos(la1 * p) * Math.cos(la2 * p) * Math.sin(dlo / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

/** Load the catalog cache written by discover-destinations.js, or null if absent. */
export function loadCachedCatalog(path) {
  if (!existsSync(path)) return null
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

/**
 * Resolve a venue to a catalog entry.
 * @param vname    venue name (may carry " — City, ST" suffix)
 * @param lat,lon  venue coordinates
 * @param catalog  array of { id, title, city, lat, lon }
 * @param getEvents async (id) => number  (upcoming/known event count; -1 on failure)
 * @returns { id, title, dist, events, conf:'HIGH'|'MED', reason } or null
 */
export async function matchVenue(vname, lat, lon, catalog, getEvents) {
  const parts = vname.split(/\s[—-]\s/)
  const shortName = norm(parts[0])
  const cityTokens = new Set(parts[1] ? norm(parts[1].split(',')[0]).split(' ') : [])
  const distinctive = shortName.split(' ').filter(w => w.length > 2 && !GENERIC.has(w) && !cityTokens.has(w))
  const isNameHit = t => distinctive.length > 0 && distinctive.every(w => t.includes(w))

  const near = catalog
    .map(d => ({ ...d, dist: haversine(lat, lon, d.lat, d.lon), t: norm(d.title) }))
    .filter(d => d.dist < RADIUS_M)
    .sort((a, b) => a.dist - b.dist)

  if (near.length === 0) return null

  // Tier 1 — exact normalized name anywhere in radius (not truncated).
  const exact = near.filter(d => d.t === shortName)
  if (exact[0]) {
    for (const e of exact) e.events = await getEvents(e.id)
    exact.sort((a, b) => (b.events - a.events) || (a.dist - b.dist))
    return { id: exact[0].id, title: exact[0].title, dist: Math.round(exact[0].dist), events: exact[0].events, conf: 'HIGH', reason: 'exact name' }
  }

  // Tier 2 — tight same-site cluster, pick the genuinely active destination.
  const cluster = near.filter(d => d.dist < CLUSTER_M).slice(0, NEAR_CAP)
  for (const d of cluster) { d.events = await getEvents(d.id); d.nameHit = isNameHit(d.t) }
  const active = cluster.filter(d => d.events >= MIN_EVENTS)
  if (active.length) {
    active.sort((a, b) => (Number(b.nameHit) - Number(a.nameHit)) || (b.events - a.events) || (a.dist - b.dist))
    const top = active[0]
    return { id: top.id, title: top.title, dist: Math.round(top.dist), events: top.events, conf: top.nameHit ? 'HIGH' : 'MED', reason: top.nameHit ? 'name+geo+activity' : 'geo+activity' }
  }

  // Tier 3 — distinctive name match in radius even if quiet.
  const nameHits = near.filter(d => isNameHit(d.t)).sort((a, b) => a.dist - b.dist)
  if (nameHits[0]) {
    const ev = await getEvents(nameHits[0].id)
    return { id: nameHits[0].id, title: nameHits[0].title, dist: Math.round(nameHits[0].dist), events: ev, conf: 'MED', reason: 'name only (quiet)' }
  }

  return null
}

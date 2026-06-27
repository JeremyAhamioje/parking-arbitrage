// Live orchestrator for Tool 1 (event fetch) and Tool 2 (date fetch).
//
// Runs the three platform modules IN PARALLEL with a per-platform timeout, then
// flattens everything into the unified table the spec asks for. One platform
// failing (timeout, anti-bot, no match) never blanks the others — we return
// partial results plus a per-platform status block so the UI can show what
// happened.

import * as spothero from './platforms/spothero.js'
import * as way from './platforms/way.js'
import * as parkwhiz from './platforms/parkwhiz.js'

const PLATFORMS = { spothero, way, parkwhiz }

// Per-platform timeout ceilings (env-configurable; bump on a slow host/link).
// Way pays a Cloudflare boot, so it gets a longer ceiling than the quick readers.
const TIMEOUTS = {
  spothero: +(process.env.ENGINE_TIMEOUT_SPOTHERO || 60_000),
  parkwhiz: +(process.env.ENGINE_TIMEOUT_PARKWHIZ || 60_000),
  way:      +(process.env.ENGINE_TIMEOUT_WAY || 90_000),
}

// Radius cap (all platforms): drop lots farther than this from the venue. Set
// MAX_RADIUS_MILES=0 to disable. Lots with an unknown distance are kept (Way
// occasionally omits it) — we can't range-filter what we can't measure.
const MAX_RADIUS_MILES = +(process.env.MAX_RADIUS_MILES ?? 2)

// Statuses worth retrying — transient network / anti-bot, not definitive misses.
const RETRYABLE = new Set(['error', 'timeout', 'blocked'])
const MAX_ATTEMPTS = Math.max(1, +(process.env.ENGINE_RETRIES || 1) + 1)

function withTimeout(promise, ms, platform) {
  let t
  const timeout = new Promise(resolve => {
    t = setTimeout(() => resolve({ platform, status: 'timeout', listings: [], error: `timed out after ${ms / 1000}s` }), ms)
  })
  return Promise.race([promise.finally(() => clearTimeout(t)), timeout])
}

// One platform attempt with retry + linear backoff on transient failures
// (ECONNRESET, ERR_TIMED_OUT, anti-bot blocks). Definitive results — ok, or a
// real not-found — return immediately without burning a retry. ParkWhiz rotates
// its proxy per call and Way re-boots, so a retry often lands on a fresh IP.
async function runPlatform(k, fn, query) {
  let last
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    last = await withTimeout(
      Promise.resolve().then(() => fn(query)).catch(e => ({ platform: k, status: 'error', listings: [], error: e.message })),
      TIMEOUTS[k] || 60_000, k,
    )
    last.attempts = attempt
    if (!RETRYABLE.has(last.status) || attempt === MAX_ATTEMPTS) break
    await new Promise(r => setTimeout(r, 1200 * attempt))
  }
  return last
}

/** Flatten a platform envelope into unified table rows (the spec's columns). */
function toRows(env, q) {
  const ts = new Date().toISOString()
  const date = q.date || (q.start ? String(q.start).slice(0, 10) : null) || env.matchedEventDate || null
  return (env.listings || []).map(l => ({
    platform:     env.platform,
    venue:        q.venue,
    event:        env.matchedEvent || q.event || null,
    spot:         l.spot,
    address:      l.address,
    price:        l.price,
    advertised:   l.advertised ?? null,
    currency:     l.currency || 'USD',
    availability: l.available === true ? 'Available' : l.available === false ? 'Sold Out' : (l.availableSpaces != null ? `${l.availableSpaces} spaces` : 'Unknown'),
    availableSpaces: l.availableSpaces ?? null,
    distanceMeters: l.distanceMeters ?? null,
    distanceMiles:  l.distanceMeters != null ? +(l.distanceMeters / 1609.34).toFixed(2) : null,
    confidence:   env.eventConfidence ?? env.venueConfidence ?? null,
    date,
    amenities:    l.amenities || '',
    timestamp:    ts,
    url:          l.url ?? null, // deep link to the lot/event on the buying platform
  }))
}

async function orchestrate(mode, query, platformKeys) {
  const keys = (platformKeys && platformKeys.length ? platformKeys : Object.keys(PLATFORMS))
    .filter(k => PLATFORMS[k])

  const run = k => runPlatform(k, mode === 'event' ? PLATFORMS[k].eventFetch : PLATFORMS[k].dateFetch, query)
  // ENGINE_SEQUENTIAL=1 → run platforms one at a time (peak ~1 browser, fits a
  // 512MB / free instance; slower, since platforms no longer overlap). Default:
  // parallel (faster, wants ~1-2GB).
  let settled
  if (process.env.ENGINE_SEQUENTIAL === '1') {
    settled = []
    for (const k of keys) settled.push(await run(k))
  } else {
    settled = await Promise.all(keys.map(run))
  }

  const rows = []
  const platforms = settled.map(env => {
    rows.push(...toRows(env, query))
    return {
      platform: env.platform,
      status: env.status,
      count: (env.listings || []).length,
      matchedEvent: env.matchedEvent ?? null,
      eventConfidence: env.eventConfidence ?? null,
      venueConfidence: env.venueConfidence ?? null,
      needsConfirmation: env.needsConfirmation ?? false,
      candidates: env.candidates ?? [],
      error: env.error ?? null,
    }
  })

  // Radius cap — keep only lots within MAX_RADIUS_MILES of the venue (unknown
  // distance is kept). Applies uniformly to SpotHero, ParkWhiz, and Way.
  if (MAX_RADIUS_MILES > 0) {
    const maxMeters = MAX_RADIUS_MILES * 1609.34
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].distanceMeters != null && rows[i].distanceMeters > maxMeters) rows.splice(i, 1)
    }
  }

  // Group by platform (SpotHero → ParkWhiz → Way) so the table and the XLSX
  // aren't a messy cross-platform interleave; cheapest-first WITHIN each platform.
  const ORDER = { spothero: 0, parkwhiz: 1, way: 2 }
  rows.sort((a, b) => {
    const pa = ORDER[a.platform] ?? 99, pb = ORDER[b.platform] ?? 99
    if (pa !== pb) return pa - pb
    return (a.price ?? Infinity) - (b.price ?? Infinity)
  })

  return {
    query,
    mode,
    platforms,
    rows,
    summary: {
      totalRows: rows.length,
      platformsOk: platforms.filter(p => p.status === 'ok').length,
      platformsTotal: platforms.length,
      needsConfirmation: platforms.some(p => p.needsConfirmation),
      generatedAt: new Date().toISOString(),
    },
  }
}

/** Tool 1 — live event fetch across platforms. */
export function liveEventFetch({ venue, event, date, platforms }) {
  return orchestrate('event', { venue, event, date: date || null }, platforms)
}

/** 'YYYY-MM-DDTHH:mm' (datetime-local) or longer → naive 'YYYY-MM-DDTHH:mm:ss'. */
function toNaiveDateTime(v) {
  const s = String(v || '').trim()
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s)) return s + ':00'
  return s.slice(0, 19)
}

/**
 * Tool 2 — manual date & time generic inventory across platforms.
 * Accepts an explicit time period { start, end } (each 'YYYY-MM-DDTHH:mm[:ss]').
 * For backward-compat (the sheet pipeline passes a bare `date`), a date with no
 * window defaults to that day's 18:00–23:00.
 */
export function liveDateFetch({ venue, date, start, end, platforms }) {
  let s = start, e = end
  if (!(s && e) && date) { s = `${date}T18:00:00`; e = `${date}T23:00:00` }
  return orchestrate('date', { venue, start: toNaiveDateTime(s), end: toNaiveDateTime(e) }, platforms)
}

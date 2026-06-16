// Tool 3 — normalization + matching pipeline. The most important tool.
//
// Flow (spec): parse → XLSX→JSON (pure backend) → normalize/detect columns →
// sequential execution queue → live scrape per row → Gemini adjudication
// (2/3 rule) → enriched sheet. HARD RULE: never overwrite user values; original
// columns pass through untouched and we only APPEND enriched columns.
//
// Scraping is injected (`eventFetch`/`dateFetch`) so the pipeline is unit-testable
// without a browser; the server wires in the real live orchestrator.

import { parseSheet } from './xlsx.js'
import { similarity } from './match.js'
import { adjudicate } from './gemini.js'

// Canonical roles → header aliases. Detection fuzzy-matches each sheet header
// against these so messy / abbreviated columns ("vnue", "evt", "comp $") resolve.
//
// venue = the EVENT venue (MSG). spot = the specific parking facility/address the
// user is trading (23 W 4th St). These are kept distinct on purpose: `venue` is
// the search anchor, `spot` is matched against the live listings. The address-ish
// aliases (location/place/site/address) live under `spot`, not `venue`, so a
// parking sheet's lot column can't be mistaken for the venue.
const ROLE_ALIASES = {
  venue:      ['venue', 'event venue', 'arena', 'stadium', 'ballpark', 'coliseum'],
  spot:       ['spot', 'lot', 'garage', 'facility', 'structure', 'parking spot', 'parking', 'address', 'street', 'location', 'place', 'site', 'section', 'our section'],
  event:      ['event', 'event name', 'show', 'game', 'concert', 'artist', 'performer', 'match', 'fixture'],
  date:       ['date', 'event date', 'day', 'when', 'show date'],
  buyingPrice: ['buying price', 'buy price', 'cost', 'our price', 'purchase price', 'paid'],
  competitorPrice: ['competitor price', 'comp price', 'market price', 'comp', 'competition'],
  status:     ['status', 'state', 'listing status'],
  remarks:    ['remarks', 'notes', 'note', 'comment', 'comments'],
}

// Each platform gets its OWN spot columns — your lot is matched independently
// against SpotHero, ParkWhiz, and Way, regardless of what the others found.
const SPOT_PLATFORMS = [
  { key: 'spothero', label: 'SpotHero' },
  { key: 'parkwhiz', label: 'ParkWhiz' },
  { key: 'way', label: 'Way' },
]

// Enriched column names we append (metric-major: all "Spot Price" together, etc.).
// Suffixed if they'd collide with an original header.
const ENRICHED = [
  ...SPOT_PLATFORMS.map(p => `Live Spot Price ${p.label}`),
  ...SPOT_PLATFORMS.map(p => `Live Spot ${p.label}`),
  ...SPOT_PLATFORMS.map(p => `Spot Match ${p.label}`),
  ...SPOT_PLATFORMS.map(p => `Live Low Price ${p.label}`),
  'Matched Event', 'Match Confidence', 'Match Status', 'Error Flag', 'Platforms', 'Fetched At',
]

// Spot confidence at/above this counts as a hit (report that lot's live price).
const SPOT_THRESHOLD = 0.6

// True if every char of `a` appears in `b` in order — catches vowel-dropped
// header abbreviations like "vnue"⊂"venue", "evt"⊂"event".
function isSubsequence(a, b) {
  if (!a || a.length > b.length) return false
  let i = 0
  for (let j = 0; j < b.length && i < a.length; j++) if (a[i] === b[j]) i++
  return i === a.length
}

const despace = s => s.toLowerCase().replace(/[^a-z0-9]/g, '')

/** How well a header matches a role: best over the role's aliases, blending
 *  fuzzy similarity with a subsequence boost for abbreviations. 0..1. */
function headerScore(header, role) {
  let best = 0
  for (const alias of ROLE_ALIASES[role]) {
    const sim = similarity(header, alias)
    const h = despace(header), a = despace(alias)
    // Subsequence boost for vowel-dropped abbreviations ("vnue"⊂"venue"), but
    // only when the shorter string is a real abbreviation of the longer — at
    // least 60% its length. Without this, "bar"⊂"ballpark" or "lot"⊂"location"
    // produce false venue/spot hits on unrelated short headers.
    const ratio = Math.min(h.length, a.length) / Math.max(h.length, a.length)
    const sub = (h.length >= 3 && ratio >= 0.6 && (isSubsequence(h, a) || isSubsequence(a, h))) ? 0.85 : 0
    best = Math.max(best, sim, sub)
  }
  return best
}

/**
 * Best-effort header → role map via GLOBAL-greedy assignment: score every
 * (role, header) pair, then claim the highest-scoring pairs first so an exact
 * alias hit ("show date" → date) wins over a weaker substring hit ("show" →
 * event). Each role and each header is used at most once.
 */
export function detectColumns(headers) {
  const pairs = []
  for (const role of Object.keys(ROLE_ALIASES))
    for (const h of headers) pairs.push({ role, header: h, score: headerScore(h, role) })
  pairs.sort((a, b) => b.score - a.score)

  const map = {}
  const usedHeaders = new Set()
  for (const p of pairs) {
    if (p.score < 0.6) break
    if (map[p.role] || usedHeaders.has(p.header)) continue
    map[p.role] = p.header
    usedHeaders.add(p.header)
  }
  return map
}

const val = (row, header) => (header && row[header] != null ? String(row[header]).trim() : '')

// Ticket-reseller exports pollute venue/event with boilerplate no parking
// platform will match ("PARKING PASSES ONLY …", "… Complex Parking Lots"). Strip
// it for SEARCH ONLY — the user's original columns are never modified.
//   event: 'PARKING PASSES ONLY "World of Warcraft®: 20 Years of Music"' -> 'World of Warcraft: 20 Years of Music'
//   venue: 'The Theatre at Resorts World Las Vegas - Complex Parking Lots'  -> 'The Theatre at Resorts World Las Vegas'
export function cleanEventName(s) {
  return String(s || '')
    .replace(/^\s*parking\s+passes?\s+only\s*/i, '') // reseller prefix
    .replace(/[®™]/g, '')
    .replace(/^["'“”\s]+|["'“”\s]+$/g, '') // wrapping quotes/space
    .trim()
}
export function cleanVenueName(s) {
  return String(s || '')
    .replace(/[®™]/g, '')
    // trailing "(- )(Complex )Parking( Lot/Lots)" — the reseller's parking-lot tag
    .replace(/\s*[-–—]?\s*(complex\s+)?parking(\s+lots?)?\s*$/i, '')
    .replace(/\s*[-–—]\s*$/, '') // any dangling separator left behind
    .trim() || String(s || '').trim() // never strip a venue down to nothing
}

/** Pick the strongest 'ok' platform from a live-orchestrator result. */
function bestPlatform(live) {
  const ok = (live.platforms || []).filter(p => p.status === 'ok' && p.count > 0)
  if (!ok.length) return null
  ok.sort((a, b) => (b.eventConfidence ?? b.venueConfidence ?? 0) - (a.eventConfidence ?? a.venueConfidence ?? 0))
  return ok[0]
}

/**
 * Fuzzy-match the user's spot against a platform's listings, by lot name AND
 * address (take the stronger of the two). Returns { row, score } or null.
 * This is the step that isolates "23 W 4th St" within the event's parking,
 * instead of just reporting the cheapest lot.
 */
function matchSpot(spotQuery, pRows) {
  if (!spotQuery || !pRows.length) return null
  let best = null
  for (const r of pRows) {
    const score = Math.max(similarity(spotQuery, r.spot || ''), similarity(spotQuery, r.address || ''))
    if (!best || score > best.score) best = { row: r, score }
  }
  return best
}

/**
 * Process a sheet buffer end-to-end.
 * @param buffer        XLSX/CSV bytes
 * @param opts.eventFetch  async ({venue,event,date}) => orchestrator result
 * @param opts.dateFetch   async ({venue,date}) => orchestrator result
 * @param opts.limit       cap rows processed (safety on huge sheets)
 * @param opts.onProgress  (i, total, row) => void
 * @returns { columns, detected, rows, stats }  rows = original + enriched
 */
export async function processSheet(buffer, opts = {}) {
  const { eventFetch, dateFetch, limit = 200, onProgress } = opts
  const { headers, rows } = parseSheet(buffer)
  if (!rows.length) return { columns: headers, detected: {}, rows: [], stats: { total: 0 } }

  const detected = detectColumns(headers)

  // Resolve enriched column names that don't clash with originals.
  const enrichedCols = ENRICHED.map(c => headers.includes(c) ? `${c} (live)` : c)
  const E = Object.fromEntries(ENRICHED.map((c, i) => [c, enrichedCols[i]]))

  const out = []
  const stats = { total: rows.length, processed: 0, matched: 0, flagged: 0, noData: 0, skipped: 0, errors: 0, viaGemini: 0, viaLocal: 0, viaFallback: 0, spotMatched: 0 }
  const queue = rows.slice(0, limit)

  for (let i = 0; i < queue.length; i++) {
    const row = queue[i]
    const venue = cleanVenueName(val(row, detected.venue))
    const event = cleanEventName(val(row, detected.event))
    const date = val(row, detected.date)
    const spot = val(row, detected.spot)

    // Preserve original row EXACTLY; enrich a shallow copy.
    const enriched = { ...row }
    for (const c of enrichedCols) if (!(c in enriched)) enriched[c] = ''

    if (onProgress) onProgress(i + 1, queue.length, { venue, event, date })

    if (!venue) {
      enriched[E['Match Status']] = 'SKIPPED'
      enriched[E['Error Flag']] = 'no_venue_column_value'
      stats.skipped++; out.push(enriched); continue
    }

    let live
    try {
      live = event && eventFetch ? await eventFetch({ venue, event, date })
           : dateFetch ? await dateFetch({ venue, date })
           : null
    } catch (e) {
      enriched[E['Match Status']] = 'ERROR'
      enriched[E['Error Flag']] = `scrape_error: ${e.message}`
      stats.errors++; out.push(enriched); continue
    }

    stats.processed++
    const bp = live ? bestPlatform(live) : null
    if (!bp) {
      enriched[E['Match Status']] = 'NO_DATA'
      enriched[E['Error Flag']] = 'no_live_inventory'
      enriched[E['Platforms Found']] = (live?.platforms || []).map(p => `${p.platform}:${p.status}`).join(', ')
      enriched[E['Fetched At']] = new Date().toISOString()
      stats.noData++; out.push(enriched); continue
    }

    // Match the user's spot against EACH platform independently — its own price,
    // its own matched lot, its own confidence — regardless of the others.
    let anySpotHit = false
    for (const p of SPOT_PLATFORMS) {
      const pRows = (live.rows || []).filter(r => r.platform === p.key)
      const low = pRows.reduce((m, r) => (r.price != null && (m == null || r.price < m) ? r.price : m), null)
      const sm = matchSpot(spot, pRows)
      const hit = sm && sm.score >= SPOT_THRESHOLD ? sm.row : null
      if (hit) anySpotHit = true
      enriched[E[`Live Spot Price ${p.label}`]] = hit ? hit.price : ''
      enriched[E[`Live Spot ${p.label}`]]       = hit ? hit.spot : ''
      enriched[E[`Spot Match ${p.label}`]]      = (spot && pRows.length) ? `${Math.round((sm?.score || 0) * 100)}%` : ''
      enriched[E[`Live Low Price ${p.label}`]]  = low ?? ''
    }

    // Event-level match (which event we found) uses the strongest platform.
    const bpRows = (live.rows || []).filter(r => r.platform === bp.platform)
    const scraped = { venue, event: bp.matchedEvent, date: bpRows[0]?.date || date }
    const judged = await adjudicate({ venue, event, date }, scraped)
    if (judged.via === 'gemini') stats.viaGemini++
    else if (judged.via === 'local-fallback') stats.viaFallback++
    else stats.viaLocal++ // local-decisive (gate skipped) or no key

    const flags = judged.flags.filter(f => f !== 'NEEDS_REVIEW')
    if (spot && !anySpotHit) flags.push('spot_not_found_any')

    enriched[E['Matched Event']]    = bp.matchedEvent || ''
    enriched[E['Match Confidence']] = judged.confidence
    enriched[E['Match Status']]     = judged.match ? 'MATCHED' : 'FLAGGED'
    enriched[E['Error Flag']]       = flags.join(', ')
    enriched[E['Platforms']]        = (live.platforms || []).map(p => `${p.platform}:${p.status}`).join(', ')
    enriched[E['Fetched At']]       = new Date().toISOString()

    if (judged.match) stats.matched++; else stats.flagged++
    if (anySpotHit) stats.spotMatched++
    out.push(enriched)
  }

  // Any rows beyond the limit pass through untouched (originals preserved).
  for (let i = queue.length; i < rows.length; i++) out.push({ ...rows[i] })

  return { columns: [...headers, ...enrichedCols], detected, rows: out, stats }
}

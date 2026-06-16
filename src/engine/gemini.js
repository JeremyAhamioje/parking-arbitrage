// Tool 3 matching layer. Per the spec, Gemini DOES NOT scrape — it only compares
// an input row against the scraped result and produces a match + confidence +
// per-field flags. We then enforce the deterministic 2/3 rule (venue, event,
// date) in code, so the final decision never rests on the LLM alone.
//
// Calls the Gemini REST API directly (no SDK dependency). If GEMINI_API_KEY is
// absent or the call fails, falls back to the local fuzzy matcher so the pipeline
// always produces a result — just flagged as `via: 'local'`.

import { similarity, confidence as localConfidence } from './match.js'

const MODEL_ID = process.env.GEMINI_MODEL_ID || 'gemini-2.5-flash'
const ENDPOINT = key => `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_ID}:generateContent?key=${key}`

export function geminiConfigured() { return !!process.env.GEMINI_API_KEY }

/**
 * Lightweight liveness check: is the configured key actually accepted by Gemini?
 * Used at engine startup so a missing/invalid/expired key surfaces loudly instead
 * of silently degrading to local matching. Returns:
 *   { ok, configured, model?, status?, message? }
 */
export async function verifyGemini() {
  if (!geminiConfigured()) return { ok: false, configured: false, message: 'GEMINI_API_KEY not set' }
  try {
    const res = await geminiPost({ contents: [{ role: 'user', parts: [{ text: 'ping' }] }], generationConfig: { maxOutputTokens: 5, thinkingConfig: { thinkingBudget: 0 } } })
    if (res.ok) return { ok: true, configured: true, model: MODEL_ID }
    const j = await res.json().catch(() => ({}))
    return { ok: false, configured: true, status: res.status, message: j?.error?.message || `HTTP ${res.status}` }
  } catch (e) {
    // Network failure (e.g. AV TLS interception), not a real rejection.
    return { ok: false, configured: true, network: true, message: `could not reach Gemini (${e.message})` }
  }
}

const SYSTEM = `You compare a user's parking-arbitrage spreadsheet row against a scraped live event result.
Decide, field by field, whether they refer to the same venue, the same event, and the same date.
Be tolerant of abbreviations, typos, partial names, and date formats (e.g. "MSG" = "Madison Square Garden",
"T swft" = "Taylor Swift", "7/23" = "2026-07-23"). Respond ONLY with JSON of shape:
{"venueMatch":bool,"eventMatch":bool,"dateMatch":bool,"confidence":0-100,"reason":"short"}.`

/** YYYY-MM-DD from a loose date value, or '' if unparseable. */
function isoDate(v) {
  if (!v) return ''
  if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10)
  const s = String(v).trim()
  const d = new Date(s)
  if (!isNaN(d)) return d.toISOString().slice(0, 10)
  const m = s.match(/(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/) // 7/23 or 7/23/26
  if (m) {
    const yr = m[3] ? (m[3].length === 2 ? '20' + m[3] : m[3]) : String(new Date().getFullYear())
    return `${yr}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`
  }
  return ''
}

/** Local per-field judgement (fallback + deterministic gate inputs). */
function localFields(input, scraped) {
  const vs = input.venue && scraped.venue ? similarity(input.venue, scraped.venue) : 0
  const es = input.event && scraped.event ? similarity(input.event, scraped.event) : 0
  const venueMatch = vs >= 0.6
  const eventMatch = es >= 0.55
  const di = isoDate(input.date), ds = isoDate(scraped.date)
  const dateMatch = di && ds ? di === ds : false
  const conf = Math.round(((venueMatch ? 1 : 0) + (eventMatch ? 1 : 0) + (dateMatch ? 1 : 0)) / 3 * 100)
  return { venueMatch, eventMatch, dateMatch, confidence: conf, reason: 'local fuzzy match', scores: { venue: vs, event: es } }
}

/**
 * Deterministic gate — decide whether a row even NEEDS Gemini. Skips the call
 * (saving credits) when the local result is unambiguous either way:
 *   • clear MATCH  — venue AND event both score high → Gemini would just confirm.
 *   • clear NON-match — venue clearly wrong → Gemini can't rescue a wrong venue.
 * Only the ambiguous middle (e.g. a semantic event-name difference like
 * "An Evening With Goose" vs "Goose - The Band") is worth a Gemini call.
 * Disable with GEMINI_GATE=0 (always call Gemini).
 */
function needsGemini({ scores }) {
  if (process.env.GEMINI_GATE === '0') return true
  const { venue: v, event: e } = scores
  if (v >= 0.8 && e >= 0.8) return false // decisive match
  if (v < 0.4) return false              // decisive non-match (wrong venue)
  return true
}

// POST to Gemini with a small retry on transient NETWORK errors ("fetch failed"
// — common behind a TLS-intercepting AV like Avast). HTTP errors (400/403) are
// returned as-is (not retried — a bad key won't fix itself).
async function geminiPost(body, attempts = 3) {
  let lastErr
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetch(ENDPOINT(process.env.GEMINI_API_KEY), {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      })
    } catch (e) { lastErr = e; if (i < attempts - 1) await new Promise((r) => setTimeout(r, 400 * (i + 1))) }
  }
  throw lastErr
}

async function callGemini(input, scraped) {
  const prompt = `INPUT ROW:\nvenue: ${input.venue || ''}\nevent: ${input.event || ''}\ndate: ${input.date || ''}\n\n`
    + `SCRAPED RESULT:\nvenue: ${scraped.venue || ''}\nevent: ${scraped.event || ''}\ndate: ${scraped.date || ''}`
  const res = await geminiPost({
    system_instruction: { parts: [{ text: SYSTEM }] },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0, thinkingConfig: { thinkingBudget: 0 }, maxOutputTokens: 300 },
  })
  if (!res.ok) throw new Error(`gemini HTTP ${res.status}`)
  const data = await res.json()
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim()
  if (!text) throw new Error('gemini empty response')
  return JSON.parse(text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim())
}

/**
 * Adjudicate one input row vs its scraped candidate.
 * Returns: { match, confidence, venueMatch, eventMatch, dateMatch, fieldsMatched, reason, via, flags[] }
 * The 2/3 rule is applied here in code regardless of source — `match` is only
 * true when at least 2 of {venue, event, date} match.
 */
export async function adjudicate(input, scraped) {
  // Local judgement first — it's also the gate input and the fallback.
  const local = localFields(input, scraped)

  let fields, via
  if (geminiConfigured() && needsGemini(local)) {
    try { fields = await callGemini(input, scraped); via = 'gemini' }
    catch { fields = local; via = 'local-fallback' }
  } else {
    fields = local
    via = geminiConfigured() ? 'local-decisive' : 'local'  // skipped on purpose vs. no key
  }

  const venueMatch = !!fields.venueMatch
  const eventMatch = !!fields.eventMatch
  const dateMatch = !!fields.dateMatch
  const fieldsMatched = (venueMatch ? 1 : 0) + (eventMatch ? 1 : 0) + (dateMatch ? 1 : 0)
  const match = fieldsMatched >= 2 // deterministic 2/3 validation rule

  const flags = []
  if (!venueMatch) flags.push('venue_mismatch')
  if (!eventMatch) flags.push('event_mismatch')
  if (!dateMatch) flags.push('date_mismatch')
  if (!match) flags.push('NEEDS_REVIEW')

  return {
    match,
    confidence: typeof fields.confidence === 'number' ? Math.round(fields.confidence) : localConfidence(input.event || '', scraped.event || ''),
    venueMatch, eventMatch, dateMatch,
    fieldsMatched,
    reason: fields.reason || '',
    via,
    flags,
  }
}

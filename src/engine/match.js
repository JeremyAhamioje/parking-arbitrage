// Dependency-free fuzzy matching for venue + event resolution (Tool 1) and
// sheet-field normalization (Tool 3).
//
// Strategy: normalize aggressively (lowercase, strip punctuation, expand the
// abbreviations that actually show up in venue/event names), then score with a
// blend of Dice-coefficient bigram overlap (typo-tolerant) + token-set overlap
// (word-order / subset tolerant) + acronym matching ("MSG" → Madison Square
// Garden). Returns a 0..1 score and a 0..100 confidence integer.
//
// No LLM here — this is the fast, free, deterministic layer. Gemini is reserved
// for Tool 3's row-vs-scraped semantic adjudication (see engine/gemini.js).

// Abbreviations common in US venue / arena / event names. Conservative on
// purpose — only expansions that are unambiguous in this domain.
const ALIASES = {
  sq: 'square', sqr: 'square',
  gdn: 'garden', grdn: 'garden', grd: 'garden',
  ctr: 'center', cntr: 'center', cent: 'center',
  stdm: 'stadium', stad: 'stadium',
  amph: 'amphitheater', amphitheatre: 'amphitheater',
  ampitheater: 'amphitheater', ampitheatre: 'amphitheater',
  pk: 'park', fld: 'field',
  univ: 'university', u: 'university',
  intl: 'international', natl: 'national',
  mt: 'mount', ft: 'fort',
  hgts: 'heights', jr: 'junior',
  coliseum: 'coliseum', colosseum: 'coliseum',
  theatre: 'theater',
  and: 'and', '&': 'and',
}

// Tokens that add no discriminating signal — dropped before scoring.
const STOPWORDS = new Set(['the', 'at', 'of', 'a', 'an', 'in', 'on', 'arena', 'llc', 'inc'])

const stripAccents = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '')

/** Normalize to a canonical token string: lowercase, de-punctuated, alias-expanded. */
export function normalize(raw) {
  if (raw == null) return ''
  let s = stripAccents(String(raw)).toLowerCase()
  s = s.replace(/&/g, ' and ')
  s = s.replace(/[^a-z0-9\s]/g, ' ')      // punctuation → space
  s = s.replace(/\s+/g, ' ').trim()
  const tokens = s.split(' ')
    .map(t => ALIASES[t] || t)
    .filter(t => t && !STOPWORDS.has(t))
  return tokens.join(' ')
}

/** Tokens of a normalized string. */
export function tokens(raw) {
  const n = normalize(raw)
  return n ? n.split(' ') : []
}

/** Acronym from significant tokens: "madison square garden" → "msg". */
function acronym(normStr) {
  const t = normStr.split(' ').filter(Boolean)
  if (t.length < 2) return ''
  return t.map(w => w[0]).join('')
}

/** Set of character bigrams across the whole string (spaces removed). */
function bigrams(str) {
  const s = str.replace(/\s+/g, '')
  const grams = new Set()
  for (let i = 0; i < s.length - 1; i++) grams.add(s.slice(i, i + 2))
  return grams
}

/** Sørensen–Dice coefficient over character bigrams: typo-tolerant 0..1. */
function dice(a, b) {
  if (a === b) return 1
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0
  const A = bigrams(a), B = bigrams(b)
  let inter = 0
  for (const g of A) if (B.has(g)) inter++
  return (2 * inter) / (A.size + B.size)
}

/** Token-set overlap (Jaccard) + subset bonus: word-order / containment tolerant. */
function tokenSet(a, b) {
  const A = new Set(a.split(' ').filter(Boolean))
  const B = new Set(b.split(' ').filter(Boolean))
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const t of A) if (B.has(t)) inter++
  const union = A.size + B.size - inter
  const jaccard = inter / union
  // If the shorter set is fully contained in the longer (e.g. "taylor swift" ⊂
  // "taylor swift eras tour"), treat that as a strong signal.
  const containment = inter / Math.min(A.size, B.size)
  return Math.max(jaccard, 0.5 * jaccard + 0.5 * containment)
}

/**
 * Similarity between a free-text query and a candidate string. 0..1.
 * Blends acronym, Dice, and token-set so typos, abbreviations, word-order, and
 * acronyms ("MSG") all resolve.
 */
export function similarity(query, candidate) {
  const q = normalize(query)
  const c = normalize(candidate)
  if (!q || !c) return 0
  if (q === c) return 1

  // Acronym match in either direction (query is an acronym of candidate or v.v.)
  const qNoSpace = q.replace(/\s/g, '')
  const cAcr = acronym(c)
  const qAcr = acronym(q)
  let acrScore = 0
  if (cAcr && qNoSpace === cAcr) acrScore = 0.94
  else if (qAcr && c.replace(/\s/g, '') === qAcr) acrScore = 0.94
  else if (cAcr && dice(qNoSpace, cAcr) > 0.8) acrScore = 0.85

  const diceScore = dice(q, c)
  const tokScore = tokenSet(q, c)

  // Weighted blend, then let a strong single signal dominate.
  const blend = 0.5 * diceScore + 0.5 * tokScore
  return Math.max(acrScore, blend, diceScore, tokScore * 0.95)
}

/** similarity as a 0..100 integer confidence. */
export function confidence(query, candidate) {
  return Math.round(similarity(query, candidate) * 100)
}

/**
 * Best match of `query` against `items`. `keyFn` maps an item to its match
 * string (default: identity). Returns null on empty input, else:
 *   { item, score, confidence, index, alternatives: [{item,confidence}, ...] }
 * `alternatives` are the runner-up candidates (for confirmation UIs).
 */
export function bestMatch(query, items, keyFn = x => x) {
  if (!items || !items.length) return null
  const scored = items.map((item, index) => {
    const s = similarity(query, keyFn(item))
    return { item, index, score: s, confidence: Math.round(s * 100) }
  }).sort((a, b) => b.score - a.score)

  const top = scored[0]
  return {
    ...top,
    alternatives: scored.slice(1, 4).map(({ item, confidence }) => ({ item, confidence })),
  }
}

// Confidence thresholds shared across tools (spec: <80% → ask for confirmation).
export const THRESHOLDS = { confident: 80, ambiguous: 55 }

/** 'confident' | 'review' | 'reject' bucket for a 0..100 confidence. */
export function band(conf) {
  if (conf >= THRESHOLDS.confident) return 'confident'
  if (conf >= THRESHOLDS.ambiguous) return 'review'
  return 'reject'
}

// --- self-test: `node src/engine/match.js` --------------------------------
import { pathToFileURL } from 'url'
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cases = [
    ['Madision sq garden', 'Madison Square Garden', 80],
    ['Madison sq grd', 'Madison Square Garden', 80],
    ['msg', 'Madison Square Garden', 80],
    ['MSG', 'Madison Square Garden', 80],
    ['Tylor Swift', 'Taylor Swift', 80],
    ['Taylor Swift', 'Taylor Swift Eras Tour', 70],
    ['yankee stadium', 'Yankee Stadium', 95],
    ['barclays', 'Barclays Center', 70],
    ['random text', 'Madison Square Garden', 0],
  ]
  let pass = 0
  for (const [q, c, min] of cases) {
    const got = confidence(q, c)
    const ok = min === 0 ? got < 55 : got >= min
    if (ok) pass++
    console.log(`${ok ? 'PASS' : 'FAIL'}  conf=${String(got).padStart(3)}  "${q}" ~ "${c}"  (expect ${min === 0 ? '<55' : '>=' + min})`)
  }
  console.log(`\n${pass}/${cases.length} passed`)
  process.exit(pass === cases.length ? 0 : 1)
}

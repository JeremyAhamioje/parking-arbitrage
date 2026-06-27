// One-off ParkWhiz slug audit. For every venue in the sheet, runs the real
// ParkWhiz resolver and reports whether its slug resolves — and to WHAT. Catches
// the "silent gap" class (venue exists, Way/SpotHero find it, but our derived slug
// 404s) across the whole list at once, instead of waiting for it to show up.
//
// Run ON THE BOX (needs the ParkWhiz proxy + US IP):
//   cd /opt/parking-arbitrage && node scripts/audit-parkwhiz-slugs.mjs
//   VENUE="State Farm" node scripts/audit-parkwhiz-slugs.mjs   # filter to a subset
//
// Output: a table (status + derived vs resolved slug) and a ready-to-paste
// PARKWHIZ_SLUG_OVERRIDES JSON for every venue whose real slug ≠ the derived one.
import 'dotenv/config'
import { readVenues } from '../src/sheets.js'
import { scrapeParkWhiz, venueSlug } from '../src/scrapers/parkwhiz.js'

const delay = ms => new Promise(r => setTimeout(r, ms))

// A near-future evening window — same shape production uses.
const d = new Date(); d.setDate(d.getDate() + 1)
const day = d.toISOString().slice(0, 10)
const win = { startTime: `${day}T18:00:00`, endTime: `${day}T22:00:00` }

let venues = await readVenues()
if (process.env.VENUE) {
  const f = process.env.VENUE.toLowerCase()
  venues = venues.filter(v => v.toLowerCase().includes(f))
}
console.log(`Auditing ${venues.length} venue(s)…\n`)

const overrides = {}   // derived slug -> real slug (only where they differ)
const unresolved = []  // genuinely not found (all candidates 404)
const rows = []

for (let i = 0; i < venues.length; i++) {
  const venue = venues[i]
  const derived = venueSlug(venue)
  let r
  try {
    r = await scrapeParkWhiz(venue, win)
    if (r.status === 'blocked') { await delay(1500); r = await scrapeParkWhiz(venue, win) }
  } catch (e) {
    rows.push({ venue, status: 'threw', derived, resolved: '', n: 0 }); await delay(1500); continue
  }
  const resolved = r.slug || ''
  rows.push({ venue, status: r.status, derived, resolved, n: r.listings?.length || 0 })
  if (r.status === 'slug_not_found') unresolved.push(venue)
  else if (resolved && resolved !== derived) overrides[derived] = resolved // needed a -N / different slug
  console.log(
    `[${i + 1}/${venues.length}] ${r.status.padEnd(14)} ${resolved && resolved !== derived ? `${derived} → ${resolved}` : derived}  (${r.listings?.length || 0} lots) — ${venue}`
  )
  await delay(2000)
}

console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
console.log(`ok=${rows.filter(r => r.status === 'ok').length}  needs_override=${Object.keys(overrides).length}  unresolved=${unresolved.length}`)

if (Object.keys(overrides).length) {
  console.log(`\nAdd these to PARKWHIZ_SLUG_OVERRIDES (or bake into SLUG_OVERRIDES in parkwhiz.js):`)
  console.log(`PARKWHIZ_SLUG_OVERRIDES='${JSON.stringify(overrides)}'`)
}
if (unresolved.length) {
  console.log(`\n⚠️  Still UNRESOLVED — find the real slug on parkwhiz.com manually:`)
  for (const v of unresolved) console.log(`     • ${v}  (derived: ${venueSlug(v)})`)
}
process.exit(0)

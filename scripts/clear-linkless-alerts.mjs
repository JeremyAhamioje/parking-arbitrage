// Clear "linkless" alerts — rows whose metadata carries neither a per-lot
// listing_url (Way exact / ParkWhiz venue page) nor an event_url (SpotHero map),
// so the API's resolveListingUrl shows no deep link for them. These are the old
// alerts from before the deep-link work (notably the z-score change-detection
// pass) and the cases nothing can link to (e.g. SpotHero generic price moves).
//
// The deletion is precise, not a wipe: it only removes rows where BOTH fields are
// null, so anything resolveListingUrl WOULD link is kept. Clearing them also drops
// those facilities' alert cooldown, so the next detect run can re-alert them — with
// links once facility_stats.booking_url is populated.
//
// Uses the service key (PostgREST DELETE is allowed; only TRUNCATE/DDL needs a PAT).
//
// Usage:
//   node scripts/clear-linkless-alerts.mjs            — delete linkless alerts
//   node scripts/clear-linkless-alerts.mjs --dry-run  — count only, delete nothing
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
})

const DRY = process.argv.includes('--dry-run')
const LINKLESS = q => q.is('metadata->>listing_url', null).is('metadata->>event_url', null)

const { count: total } = await db.from('alerts').select('*', { count: 'exact', head: true })
const { count: linkless } = await LINKLESS(db.from('alerts').select('*', { count: 'exact', head: true }))

console.log(`Total alerts:               ${total}`)
console.log(`Linkless (no link):         ${linkless}`)
console.log(`Linked (keep):              ${total - linkless}`)

if (!linkless) { console.log('\nNothing to clear.'); process.exit(0) }
if (DRY) { console.log('\n--dry-run: nothing deleted.'); process.exit(0) }

const { error, count: deleted } = await LINKLESS(db.from('alerts').delete({ count: 'exact' }))
if (error) { console.error(`\nDelete failed: ${error.message}`); process.exit(1) }

const { count: remaining } = await db.from('alerts').select('*', { count: 'exact', head: true })
console.log(`\nDeleted:                    ${deleted}`)
console.log(`Remaining (all linked):     ${remaining}`)

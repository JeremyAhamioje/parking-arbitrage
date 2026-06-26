// Standalone retention prune — keeps the Supabase DB under the free-tier 500 MB
// cap by deleting scrape rows older than RETENTION_DAYS (default 3). Run daily
// from VPS cron:  0 4 * * *  cd /opt/parking-arbitrage && node src/prune.js
import 'dotenv/config'
import { pruneOldData, pruneOldAlerts } from './db.js'

try {
  const r = await pruneOldData()
  console.log(`[prune] cutoff=${r.cutoff} (keeping ${r.days}d) ->`, JSON.stringify(r.summary))
  // Alerts use created_at (not scraped_at) so pruneOldData never touches them —
  // prune them too: short window for the noise, long for sold-out signals.
  const a = await pruneOldAlerts()
  console.log(`[prune] alerts noise<${a.days}d soldout<${a.soldoutDays}d ->`, JSON.stringify(a.summary))
  process.exit(0)
} catch (e) {
  console.error('[prune] failed:', e.message)
  process.exit(1)
}

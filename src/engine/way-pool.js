// Warm Way browser pool. Way is the only residential-metered, Cloudflare-gated
// platform, so re-booting it per request is expensive in BOTH bandwidth (the
// way.com SPA re-downloads) and latency (~30s CF clear). This keeps ONE browser
// alive and reuses its page across fetches; it closes after an idle window to
// free memory. The engine serializes browser work (single-flight), so the only
// concurrency we guard is the initial boot.

import { initWayBrowser } from '../scrapers/way.js'

let _browser = null
let _page = null
let _booting = null
let _idleTimer = null
const IDLE_MS = +(process.env.WAY_POOL_IDLE_MS || 10 * 60 * 1000)

function armIdleClose() {
  clearTimeout(_idleTimer)
  _idleTimer = setTimeout(() => { closeWayPool().catch(() => {}) }, IDLE_MS)
  if (_idleTimer.unref) _idleTimer.unref()
}

/** Live, Cloudflare-cleared Way page — booted on first use, reused after. */
export async function getWayPage() {
  if (_page && !_page.isClosed()) { armIdleClose(); return _page }
  if (_booting) return _booting
  _booting = (async () => {
    const { browser } = await initWayBrowser({ headless: process.env.WAY_HEADLESS === '1' })
    _browser = browser
    const ctx = browser.contexts()[0]
    _page = ctx.pages()[0] || await ctx.newPage()
    armIdleClose()
    return _page
  })()
  try { return await _booting } finally { _booting = null }
}

/** Tear down the pool (call after a Cloudflare re-challenge so the next fetch re-boots fresh). */
export async function closeWayPool() {
  clearTimeout(_idleTimer); _idleTimer = null
  const b = _browser
  _browser = null; _page = null
  try { await b?.close() } catch {}
}

export function wayPoolWarm() { return !!(_page && !_page.isClosed()) }

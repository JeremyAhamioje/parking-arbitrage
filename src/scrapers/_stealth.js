// Shared stealth browser + proxy + session plumbing for Cloudflare-guarded
// scrapers (Way.com today, ParkWhiz next). The strategy, per our probe of
// way.com, is NOT to click the "verify you are human" widget — Cloudflare's
// Managed Challenge / Turnstile passes a *real-looking* browser passively. So
// we: (1) run a stealth-patched Chromium that hides the automation tells the
// challenge JS inspects, (2) route through a residential proxy so the IP isn't
// datacenter-flagged, (3) persist the cf_clearance cookie via storageState so
// later runs skip the challenge entirely, and (4) wait the challenge out.
//
// playwright-extra + puppeteer-extra-plugin-stealth are already in package.json.

import { chromium } from 'playwright-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import { existsSync, readFileSync } from 'fs'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'

let _stealthApplied = false
function applyStealth() {
  if (_stealthApplied) return
  try {
    chromium.use(StealthPlugin())
  } catch (e) {
    console.warn(`  [stealth] plugin failed to apply (${e.message}); continuing without it`)
  }
  _stealthApplied = true
}

/**
 * Parse a proxy URL from env into Playwright's { server, username, password }.
 * Accepts full URLs (http://user:pass@host:port) or bare host:port.
 * Returns null when no proxy is configured (so callers degrade gracefully).
 *
 * Sticky sessions: rotating residential gateways (Webshare, Smartproxy, etc.)
 * rotate the exit IP per request by default, which breaks a Cloudflare
 * cf_clearance cookie (bound to one IP) mid-run. Passing { sessionId } rewrites
 * the username via `sessionFormat` to pin one exit IP for the session's life.
 * Format placeholders: {user} = original username, {session} = sessionId.
 * Vendor examples — Webshare/Smartproxy: "{user}-session-{session}".
 *
 * @param {string} envValue
 * @param {{ sessionId?: string|null, sessionFormat?: string }} [opts]
 */
export function parseProxy(envValue, { sessionId = null, sessionFormat = '{user}-session-{session}' } = {}) {
  if (!envValue) return null
  try {
    const u = new URL(envValue.includes('://') ? envValue : `http://${envValue}`)
    const proxy = { server: `${u.protocol}//${u.host}` } // u.host includes the port
    if (u.username) {
      let user = decodeURIComponent(u.username)
      if (sessionId) user = sessionFormat.replace('{user}', user).replace('{session}', sessionId)
      proxy.username = user
    }
    if (u.password) proxy.password = decodeURIComponent(u.password)
    return proxy
  } catch {
    return { server: envValue.startsWith('http') ? envValue : `http://${envValue}` }
  }
}

/**
 * Launch a stealth Chromium + hardened context.
 * @param proxy        { server, username?, password? } | null
 * @param sessionFile  path to a storageState JSON (reused if present → keeps cf_clearance)
 * @param headful      true = headed (most reliable vs Cloudflare); false = headless
 * @param timezoneId   IANA tz, should match the proxy's region (mismatch is a bot tell)
 * @param blockAssets  true (default) = abort image/media/font requests to save proxy
 *                     bandwidth — our scrapers read JSON / SSR state, never render.
 *                     Scripts, CSS, and XHR still pass so Cloudflare + SSR work.
 * @returns { browser, context }
 */
export async function launchStealthContext({ proxy = null, sessionFile = null, headful = true, timezoneId = 'America/New_York', blockAssets = true } = {}) {
  applyStealth()

  const browser = await chromium.launch({
    headless: !headful,
    proxy: proxy || undefined,
    args: ['--disable-blink-features=AutomationControlled'],
  })

  const ctxOpts = {
    userAgent: UA,
    locale: 'en-US',
    timezoneId,
    viewport: { width: 1366, height: 768 },
    extraHTTPHeaders: {
      'sec-ch-ua': '"Chromium";v="136", "Google Chrome";v="136", "Not.A/Brand";v="99"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  }

  // Reuse a prior session (cf_clearance) when available — bound to IP + UA, so
  // keep the proxy and UA stable between the save and the reuse.
  if (sessionFile && existsSync(sessionFile)) {
    try {
      ctxOpts.storageState = JSON.parse(readFileSync(sessionFile, 'utf8'))
    } catch {
      /* corrupt/empty session file — ignore and re-challenge */
    }
  }

  const context = await browser.newContext(ctxOpts)

  // Bandwidth saver: drop the heavy resource types we never use. On Way (residential,
  // metered) this is the difference between ~MBs and ~KBs per fetch. Cloudflare's
  // Turnstile is script-driven, so blocking image/media/font doesn't affect it.
  if (blockAssets) {
    const BLOCK = new Set(['image', 'media', 'font'])
    await context.route('**/*', route =>
      BLOCK.has(route.request().resourceType()) ? route.abort() : route.continue())
  }

  return { browser, context }
}

/** True when the page is NOT sitting on a Cloudflare interstitial. */
export async function passedChallenge(page) {
  const title = (await page.title().catch(() => '')) || ''
  if (/just a moment|attention required|verifying you are human|checking your browser/i.test(title)) return false
  const cfWidget = await page.locator('iframe[src*="challenges.cloudflare.com"]').count().catch(() => 0)
  return cfWidget === 0
}

/**
 * Poll until the Cloudflare challenge clears AND real content is present (or the
 * timeout elapses). We never interact with the widget — we let Turnstile's
 * passive checks pass us. Returns true if we believe we're through.
 */
export async function waitForRealContent(page, contentSelector, { timeout = 30000 } = {}) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (await passedChallenge(page)) {
      const found = await page.locator(contentSelector).first().count().catch(() => 0)
      if (found) return true
    }
    await page.waitForTimeout(1000)
  }
  // Even without the content selector, report whether the gate itself cleared.
  return await passedChallenge(page)
}

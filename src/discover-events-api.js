/**
 * Events API discovery script.
 *
 * Two-pronged approach:
 * 1. Navigate to the venue page and intercept all api.spothero.com responses
 * 2. Directly probe candidate events endpoint patterns via page.evaluate()
 *    (runs inside Chrome context to bypass WAF)
 *
 * Run: node src/discover-events-api.js
 * Output: api-discovery.json
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'fs';

const DESTINATION_ID = 666; // The Auditorium Chicago
const VENUE_URL = `https://spothero.com/search?kind=destination&id=${DESTINATION_ID}`;

// Candidate event endpoint patterns to probe directly
const CANDIDATE_ENDPOINTS = [
  `https://api.spothero.com/v2/destinations/${DESTINATION_ID}/events`,
  `https://api.spothero.com/v2/destinations/${DESTINATION_ID}`,
  `https://api.spothero.com/v1/destinations/${DESTINATION_ID}/events`,
  `https://api.spothero.com/v2/events?destination_id=${DESTINATION_ID}`,
  `https://api.spothero.com/v2/search/events?destination_id=${DESTINATION_ID}`,
];

async function run() {
  const browser = await chromium.launch({
    headless: false,
    slowMo: 200,
  });

  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
    locale: 'en-US',
    viewport: { width: 1280, height: 900 },
  });

  const captured = [];

  ctx.on('response', async (response) => {
    const url = response.url();
    if (!url.includes('api.spothero.com')) return;
    const ct = response.headers()['content-type'] || '';
    if (!ct.includes('json')) return;
    try {
      const json = await response.json();
      const endpoint = url.split('?')[0].replace('https://api.spothero.com', '');
      captured.push({ url, endpoint, json });
      console.log(`[INTERCEPT] ${endpoint}`);
    } catch {}
  });

  const page = await ctx.newPage();

  // --- Step 1: Load the venue page and intercept all API calls ---
  console.log(`\nNavigating to: ${VENUE_URL}`);
  try {
    await page.goto(VENUE_URL, { waitUntil: 'networkidle', timeout: 60_000 });
  } catch {
    console.log('  (networkidle timed out — continuing)');
  }

  // Log the final URL — SpotHero may have redirected and added params
  const finalUrl = page.url();
  console.log(`\nFinal URL after navigation: ${finalUrl}`);

  await page.waitForTimeout(3000);

  // Attempt to click the events button (may or may not exist)
  let clickedEvents = false;
  for (const selector of [
    'text=View Upcoming Events',
    'text=Upcoming Events',
    '[data-testid="upcoming-events"]',
    'button:has-text("Events")',
  ]) {
    try {
      const el = page.locator(selector).first();
      await el.waitFor({ timeout: 3000 });
      await el.click();
      console.log(`\nClicked: "${selector}"`);
      await page.waitForTimeout(3000);
      clickedEvents = true;
      break;
    } catch {}
  }

  if (!clickedEvents) {
    console.log('\nEvents button not found — trying scroll to trigger lazy load...');
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(2000);
  }

  // --- Step 2: Probe candidate endpoints directly via page.evaluate() ---
  console.log('\n--- Probing candidate events endpoints ---');
  const probeResults = [];

  for (const url of CANDIDATE_ENDPOINTS) {
    const result = await page.evaluate(async (u) => {
      try {
        const res = await fetch(u, {
          headers: {
            'Accept': 'application/json',
            'Referer': 'https://spothero.com/',
            'Origin': 'https://spothero.com',
          },
        });
        const body = await res.text();
        let json = null;
        try { json = JSON.parse(body); } catch {}
        return { status: res.status, ok: res.ok, body: body.slice(0, 500), json };
      } catch (e) {
        return { error: e.message };
      }
    }, url);

    const endpoint = url.replace('https://api.spothero.com', '');
    console.log(`\n  PROBE: ${endpoint}`);
    if (result.error) {
      console.log(`  ERROR: ${result.error}`);
    } else {
      console.log(`  HTTP ${result.status}`);
      if (result.ok && result.json) {
        console.log(`  KEYS: ${Object.keys(result.json).join(', ')}`);
        console.log(`  SAMPLE: ${result.body.slice(0, 200)}`);
      } else {
        console.log(`  BODY: ${result.body.slice(0, 150)}`);
      }
    }
    probeResults.push({ url, endpoint, ...result });
  }

  // --- Save everything ---
  const output = {
    venueUrl: VENUE_URL,
    finalUrl,
    clickedEvents,
    intercepted: captured,
    probed: probeResults,
  };

  writeFileSync('api-discovery.json', JSON.stringify(output, null, 2));
  console.log('\nSaved full capture → api-discovery.json');
  console.log('\nInspect the browser manually, then press Ctrl+C to close.');

  await page.waitForTimeout(30_000);
  await browser.close();
}

run().catch(console.error);

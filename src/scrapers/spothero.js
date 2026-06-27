import { chromium } from 'playwright';
import { randomUUID } from 'crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { matchVenue, loadCachedCatalog } from '../destination-finder.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = join(__dir, '../../venue-coords.json');
const CATALOG_FILE = join(__dir, '../../spothero-catalog.json');

let _catalog = null;
function getCatalog() {
  if (_catalog === null) _catalog = loadCachedCatalog(CATALOG_FILE) || [];
  return _catalog;
}

function loadCache() {
  if (existsSync(CACHE_FILE)) {
    try { return JSON.parse(readFileSync(CACHE_FILE, 'utf8')); } catch {}
  }
  return {};
}

function saveCache(cache) {
  writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

let _browser = null;
let _page = null;

export async function initBrowser() {
  _browser = await chromium.launch({
    headless: true,
    args: ['--disable-dev-shm-usage', '--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
  });
  const ctx = await _browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
    locale: 'en-US',
    extraHTTPHeaders: {
      'sec-ch-ua': '"Chromium";v="136", "Google Chrome";v="136", "Not.A/Brand";v="99"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
    },
  });
  _page = await ctx.newPage();
  await _page.goto('about:blank');
}

// Independent browser+page (NOT the module singleton) for the engine's warm
// pool — lets multiple live fetches run concurrently without clobbering the
// batch scraper's global page. Same fingerprint as initBrowser().
export async function createSpotHeroContext() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-dev-shm-usage', '--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
  });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
    locale: 'en-US',
    extraHTTPHeaders: {
      'sec-ch-ua': '"Chromium";v="136", "Google Chrome";v="136", "Not.A/Brand";v="99"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
    },
  });
  const page = await ctx.newPage();
  await page.goto('about:blank');
  return { browser, page };
}

export async function closeBrowser() {
  if (_browser) await _browser.close();
}

/** Returns cached { lat, lon, spotheroDestinationId? } for a venue, or null if not yet geocoded. */
export function getCoords(venueName) {
  const cache = loadCache();
  return cache[venueName] || null;
}

/** Persists a discovered destination_id into venue-coords.json. */
export function cacheDestinationId(venueName, destinationId) {
  const cache = loadCache();
  cache[venueName] = { ...cache[venueName], spotheroDestinationId: destinationId };
  saveCache(cache);
}

/** Exposes the active Playwright page so other scrapers can reuse the browser context. */
export function getPage() {
  return _page;
}

/**
 * Discover SpotHero destination_id for a venue, then fetch its upcoming events.
 *
 * Resolves the destination_id by matching the venue against the cached SpotHero
 * destinations catalog (spothero-catalog.json, built by discover-destinations.js)
 * using geography + event activity — see src/destination-finder.js. The old
 * `/v2/destinations?q=` search is dead (SpotHero ignores q/lat/lon), so this is
 * the only working path. All network calls go through the browser context, since
 * Node fetch to api.spothero.com can't interleave with the live browser session.
 *
 * Returns { destinationId, events }. Only called when destination_id is not yet cached.
 */
async function fetchEventCount(page, id) {
  return page.evaluate(async (i) => {
    try {
      const res = await fetch(`https://api.spothero.com/v2/events?destination_id=${i}`, {
        headers: { Accept: 'application/json', Referer: 'https://spothero.com/', Origin: 'https://spothero.com' },
      });
      if (!res.ok) return -1;
      const j = await res.json();
      const items = Array.isArray(j) ? j : (j.data || j.events || j.results || []);
      return items.length;
    } catch { return -1; }
  }, id);
}

export async function discoverDestinationAndEvents(venueName, lat, lon, page = _page) {
  const catalog = getCatalog();
  if (!catalog.length) {
    console.warn('  [discover] no spothero-catalog.json — run `node discover-destinations.js` to build it; falling back to generic scrape');
    return { destinationId: null, events: [] };
  }

  // Events lookup via the browser context, memoized for this discovery call.
  const evCache = new Map();
  const getEvents = async (id) => {
    if (evCache.has(id)) return evCache.get(id);
    const n = await fetchEventCount(page, id);
    evCache.set(id, n);
    return n;
  };

  const match = await matchVenue(venueName, lat, lon, catalog, getEvents);
  if (!match) {
    console.log(`  [discover] no catalog match for "${venueName}"`);
    return { destinationId: null, events: [] };
  }
  console.log(`  [discover] destId=${match.id} (${match.reason}, ${match.dist}m, ${match.events} evt) → ${match.title}`);

  // Fetch the full upcoming events for the matched destination
  const rawEvents = await page.evaluate(async (id) => {
    try {
      const res = await fetch(`https://api.spothero.com/v2/events?destination_id=${id}`, {
        headers: { Accept: 'application/json', Referer: 'https://spothero.com/' },
      });
      if (!res.ok) return [];
      const j = await res.json();
      return j.data || [];
    } catch { return []; }
  }, match.id);

  const now = new Date();
  const events = rawEvents
    .filter(e => e.parking_window?.starts && new Date(e.parking_window.starts) > now)
    .map(e => {
      // SpotHero's working event-map link is /search?kind=event&id={eventId}; the
      // /events/{seo_url} path is unreliable, so only fall back to it without an id.
      const eid = e.event_id ?? e.id ?? null;
      return {
        name:      e.title || 'Unknown Event',
        startsAt:  e.parking_window.starts,
        endsAt:    e.parking_window.ends,
        date:      e.starts ? e.starts.slice(0, 10) : null,
        sourceUrl: eid
          ? `https://spothero.com/search?kind=event&id=${eid}&hide_event_modal=true&view=dl`
          : (e.seo_url ? `https://spothero.com/events/${e.seo_url}` : null),
      };
    });

  return { destinationId: match.id, events };
}

/**
 * @param {string} venueName
 * @param {string|null} startsAt  ISO datetime string for event start
 * @param {string|null} endsAt    ISO datetime string for event end
 * @returns {{ listings: Array, destinationId: number|null }}
 */
export async function scrapeSpotHero(venueName, startsAt = null, endsAt = null) {
  try {
    const coords = await geocode(venueName);
    const { lat, lon } = coords;
    console.log(`  Geocoded "${venueName}": ${lat.toFixed(5)}, ${lon.toFixed(5)}`);
    const { listings, destinationId } = await fetchListings(lat, lon, startsAt, endsAt);

    // Cache destination_id alongside coords for future event lookups
    if (destinationId && !coords.spotheroDestinationId) {
      const cache = loadCache();
      cache[venueName] = { ...cache[venueName], spotheroDestinationId: destinationId };
      saveCache(cache);
      console.log(`  Cached SpotHero destination_id=${destinationId} for "${venueName}"`);
    }

    return { listings, destinationId: destinationId || coords.spotheroDestinationId || null };
  } catch (err) {
    console.error(`  SpotHero failed for "${venueName}": ${err.message}`);
    return { listings: [], destinationId: null };
  }
}

/** Public wrapper so the live engine can geocode a venue without re-implementing Photon. */
export async function geocodeVenue(venue) {
  return geocode(venue);
}

async function geocode(venue) {
  const cache = loadCache();
  if (cache[venue]) return cache[venue];

  // Not cached — call Photon (OpenStreetMap data, no API key, different server from Nominatim)
  console.log(`  Geocoding (not cached): "${venue}"`);
  await new Promise(r => setTimeout(r, 1500));

  const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(venue)}&limit=1`;
  const res = await fetch(url, { headers: { 'User-Agent': 'parking-arbitrage-tool/1.0' } });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error(`Photon returned non-JSON (HTTP ${res.status}): ${text.slice(0, 120)}`); }

  const features = data.features || [];
  if (!features.length) throw new Error(`Could not geocode: ${venue}`);

  const [lon, lat] = features[0].geometry.coordinates;
  const coords = { lat, lon };
  cache[venue] = coords;
  saveCache(cache);
  return coords;
}

async function fetchListings(lat, lon, startsAt = null, endsAt = null) {
  const fmt = d => {
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00`;
  };

  let starts, ends;
  if (startsAt && endsAt) {
    // Strip timezone suffix so SpotHero gets a naive local datetime
    starts = { formatted: startsAt.slice(0, 16).replace('T', 'T') + ':00' };
    ends   = { formatted: endsAt.slice(0, 16) + ':00' };
    // reuse fmt() pattern: just pass the ISO string sliced to 19 chars
    starts = startsAt.slice(0, 19);
    ends   = endsAt.slice(0, 19);
  } else {
    // Default: tomorrow 6pm–midnight (generic pricing check)
    const s = new Date();
    s.setDate(s.getDate() + 1);
    s.setHours(18, 0, 0, 0);
    const e = new Date(s);
    e.setHours(23, 59, 0, 0);
    starts = fmt(s);
    ends   = fmt(e);
  }

  const firstUrl = `https://api.spothero.com/v2/search/transient?oversize=false&sort_by=relevance&include_walking_distance=true&lat=${lat}&lon=${lon}&starts=${encodeURIComponent(starts)}&ends=${encodeURIComponent(ends)}&show_unavailable=false&initial_search=true&action=LIST_DESTINATION&session_id=${randomUUID()}&search_id=${randomUUID()}&action_id=${randomUUID()}&fingerprint=${randomUUID()}`;

  const allResults = [];
  let nextUrl = firstUrl;
  let page = 1;
  let destinationId = null;

  while (nextUrl) {
    const result = await _page.evaluate(async (url) => {
      try {
        const res = await fetch(url, {
          headers: {
            'Accept': 'application/json, text/plain, */*',
            'Referer': 'https://spothero.com/',
            'Origin': 'https://spothero.com',
          },
        });
        const body = await res.text();
        if (!res.ok) return { error: `HTTP ${res.status}: ${body.slice(0, 300)}` };
        try {
          const json = JSON.parse(body);
          // destination_id lives on each result item, not at the top level
          const firstResult = (json.results || [])[0] || {};
          const destId = firstResult.destination_id
            || firstResult.destination?.destination_id
            // fallback: parse from the @next pagination URL which always carries it
            || (json['@next'] ? new URL(json['@next']).searchParams.get('destination_id') : null)
            || null;
          return { results: json.results || [], next: json['@next'] || null, destinationId: destId };
        } catch {
          return { error: `SpotHero non-JSON (HTTP ${res.status}): ${body.slice(0, 200)}` };
        }
      } catch (e) {
        return { error: `fetch threw: ${e.message}` };
      }
    }, nextUrl);

    if (result.error) throw new Error(`SpotHero API ${result.error}`);

    allResults.push(...result.results);
    if (!destinationId && result.destinationId) destinationId = result.destinationId;
    nextUrl = result.next || null;
    page++;

    if (nextUrl) await new Promise(r => setTimeout(r, 400)); // polite pause between pages
  }

  console.log(`  Found ${allResults.length} listings (${page - 1} page${page > 2 ? 's' : ''})`);
  return { listings: parseListings(allResults), destinationId };
}

function parseListings(results) {
  return results.map(r => {
    const facility = r.facility?.common || {};
    const addr = facility.addresses?.[0] || {};
    const rate = r.rates?.[0];
    const quote = rate?.quote;
    const avail = r.availability || {};
    const dist = r.distance || {};

    const advertised = (quote?.advertised_price?.value || 0) / 100;
    const total = (quote?.total_price?.value || 0) / 100;
    const fee = parseFloat((total - advertised).toFixed(2));
    const amenities = rate?.transient?.amenities?.map(a => a.display_name).join(', ') || '';

    return {
      facilityId: facility.id || '',
      name: facility.title || '',
      address: addr.street_address || '',
      city: addr.city || '',
      state: addr.state || '',
      facilityType: facility.facility_type || '',
      advertisedPrice: advertised,
      serviceFee: fee,
      totalPrice: total,
      availableSpaces: avail.available_spaces ?? '',
      available: avail.available ?? '',
      walkingMeters: dist.walking_meters || '',
      amenities,
    };
  });
}

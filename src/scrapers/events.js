/**
 * Fetches upcoming events for a venue directly from SpotHero.
 * Uses the Playwright page (already authenticated via browser context)
 * to call SpotHero's destination events endpoint.
 *
 * Requires a SpotHero destination_id for the venue.
 * destination_ids are discovered automatically from the parking search response
 * and cached in venue-coords.json.
 */

/**
 * @param {import('playwright').Page} page  - existing Playwright page
 * @param {number} destinationId            - SpotHero destination ID for this venue
 * @returns {Array<{ name, startsAt, endsAt, date, sourceUrl }>}
 */
export async function getSpotHeroEvents(page, destinationId) {
  if (!destinationId) return [];

  const url = `https://api.spothero.com/v2/events?destination_id=${destinationId}`;

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
      return { status: res.status, body };
    } catch (e) {
      return { error: e.message };
    }
  }, url);

  if (result.error) {
    console.warn(`  [events] SpotHero fetch failed: ${result.error}`);
    return [];
  }

  if (result.status !== 200) {
    console.warn(`  [events] SpotHero events returned HTTP ${result.status} for destination ${destinationId}`);
    return [];
  }

  let json;
  try {
    json = JSON.parse(result.body);
  } catch {
    console.warn(`  [events] SpotHero events: non-JSON response`);
    return [];
  }

  // Response shape: { data: [ { title, starts, ends, parking_window: { starts, ends }, event_id, seo_url, ... } ] }
  const items = Array.isArray(json) ? json : (json.data || json.events || json.results || []);

  const now = new Date();

  return items
    .filter(e => {
      // Only upcoming events — compare parking window start (or event start) to now
      const windowStart = e.parking_window?.starts || e.starts;
      return windowStart && new Date(windowStart) > now;
    })
    .map(e => {
      const name = e.title || e.name || 'Unknown Event';
      // parking_window is SpotHero's pre-calculated optimal search window for this event
      const startsAt  = e.parking_window?.starts || e.starts || null;
      const endsAt    = e.parking_window?.ends   || e.ends   || null;
      const date      = e.starts ? e.starts.slice(0, 10) : null;
      // SpotHero's working event-map link is /search?kind=event&id={eventId}; the
      // /events/{seo_url} path is unreliable (redirects to a marketing page), so
      // only fall back to it without an id. Mirrors scrapers/spothero.js — this is
      // the cached fast-path that actually runs once a venue's dest_id is known.
      const eid = e.event_id ?? e.id ?? null;
      const sourceUrl = eid
        ? `https://spothero.com/search?kind=event&id=${eid}&hide_event_modal=true&view=dl`
        : (e.seo_url ? `https://spothero.com/events/${e.seo_url}` : null);

      return { name, startsAt, endsAt, date, sourceUrl };
    })
    .filter(e => e.startsAt);
}

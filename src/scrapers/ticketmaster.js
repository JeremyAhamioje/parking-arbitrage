/**
 * Ticketmaster Discovery API wrapper for event discovery.
 *
 * IMPORTANT — we deliberately query ONLY by exact venueId. The old
 * keyword/lat-long searches ("events near here" / "keyword = venue name") were
 * the source of nearly every false positive: a keyword search for "Park" or a
 * 50-mile radius pulls in unrelated shows at other rooms, and the keyword path
 * even carried a typo (`nospäter`) that made its on-sale date permanently null.
 * Those functions are gone. venueId is exact: every event it returns is actually
 * AT the venue we asked about. Genuinely-new detection is handled downstream
 * (discovery.js dedupes by ticketmaster_id and baselines a venue's first poll).
 */

const API_KEY = process.env.TICKETMASTER_API_KEY;
const BASE_URL = 'https://app.ticketmaster.com/discovery/v2';

if (!API_KEY) {
  throw new Error('TICKETMASTER_API_KEY must be set in .env');
}

// Segments that actually drive parking demand. Comedy/concerts/games fill lots;
// Film (a movie screening) and Miscellaneous (undefined) usually don't, and are
// the bulk of the low-signal noise. Events with no classification are kept
// (defensive — better to surface than silently drop a real arena show).
const PARKING_SEGMENTS = new Set(['Music', 'Sports', 'Arts & Theatre']);

function isParkingRelevant(segment) {
  if (!segment) return true; // unknown → keep, let the date/venue filters decide
  return PARKING_SEGMENTS.has(segment);
}

/**
 * Resolve a venue name to its Ticketmaster venue ID.
 * Returns the venue ID from the top search result, or null if not found.
 * (Keyword search is acceptable HERE — we're resolving an ID once and caching
 * it; the actual event queries below are exact-by-ID.)
 */
export async function resolveVenueToTicketmasterId(venueName) {
  try {
    const response = await fetch(
      `${BASE_URL}/venues.json?keyword=${encodeURIComponent(venueName)}&apikey=${API_KEY}&size=10`,
      { headers: { Accept: 'application/json' } }
    );

    if (!response.ok) {
      console.error(`Ticketmaster venues API error: ${response.status}`);
      return null;
    }

    const data = await response.json();
    const venues = data._embedded?.venues || [];

    if (venues.length === 0) {
      console.warn(`No Ticketmaster venue found for "${venueName}"`);
      return null;
    }

    const topVenue = venues[0];
    console.log(`  Resolved "${venueName}" → Ticketmaster ID: ${topVenue.id} (${topVenue.name})`);
    return topVenue.id;
  } catch (error) {
    console.error(`resolveVenueToTicketmasterId error for "${venueName}":`, error.message);
    return null;
  }
}

/**
 * Search for events by exact Ticketmaster venue ID — the ONLY clean event path.
 *
 * Returns normalized, parking-relevant, non-cancelled events:
 *   { ticketmaster_id, name, event_date, public_visibility_start,
 *     onsale_start, onsale_end, status, segment, url }
 *
 * @param {string} ticketmasterVenueId
 * @returns {Array}
 */
export async function searchEventsByVenueId(ticketmasterVenueId) {
  try {
    const response = await fetch(
      `${BASE_URL}/events.json?venueId=${encodeURIComponent(ticketmasterVenueId)}&apikey=${API_KEY}&size=200&sort=onSaleStartDate,asc`,
      { headers: { Accept: 'application/json' } }
    );

    if (!response.ok) {
      console.error(`Ticketmaster API error: ${response.status}`);
      return [];
    }

    const data = await response.json();
    const raw = data._embedded?.events || [];

    // Cutoff = start of today. Events before this have already happened — no
    // parking demand left, so we never store them (most of the noise).
    const cutoff = new Date(); cutoff.setHours(0, 0, 0, 0);

    const events = [];
    for (const e of raw) {
      const statusCode = (e.dates?.status?.code || '').toLowerCase(); // onsale|offsale|cancelled|postponed|rescheduled
      if (statusCode === 'cancelled') continue; // a cancelled show has no parking demand — drop it

      const segment = e.classifications?.[0]?.segment?.name || null;
      if (!isParkingRelevant(segment)) continue; // Film / Miscellaneous → skip

      const eventDate = e.dates?.start?.dateTime || e.dates?.start?.localDate || null;
      if (!eventDate) continue; // undated event is unusable for our timing logic
      if (new Date(eventDate).getTime() < cutoff.getTime()) continue; // already happened → skip

      // On-sale start: prefer the public on-sale, fall back to the earliest
      // presale (the true "secure passes early" window opens at the presale).
      let onsaleStart = e.sales?.public?.startDateTime || null;
      const presales = e.sales?.presales || [];
      for (const p of presales) {
        if (p.startDateTime && (!onsaleStart || new Date(p.startDateTime) < new Date(onsaleStart))) {
          onsaleStart = p.startDateTime;
        }
      }

      events.push({
        ticketmaster_id: e.id,
        name: e.name,
        event_date: eventDate,
        public_visibility_start: e.sales?.public?.startDateTime || null,
        onsale_start: onsaleStart,
        onsale_end: e.sales?.public?.endDateTime || null,
        status: statusCode || null,
        segment,
        url: e.url,
      });
    }

    return events;
  } catch (error) {
    console.error(`searchEventsByVenueId error (${ticketmasterVenueId}):`, error.message);
    return [];
  }
}

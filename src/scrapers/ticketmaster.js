/**
 * Ticketmaster API wrapper for event discovery.
 * Queries events by venue name or coordinates.
 */

const API_KEY = process.env.TICKETMASTER_API_KEY;
const BASE_URL = 'https://app.ticketmaster.com/discovery/v2';

if (!API_KEY) {
  throw new Error('TICKETMASTER_API_KEY must be set in .env');
}

/**
 * Search for events at a venue by name or coordinates.
 * Returns array of event objects: { name, date, onSaleDate, venueId, url }
 */
export async function searchEventsByVenue(venueName, lat, lon) {
  try {
    // Try by venue name first
    const response = await fetch(
      `${BASE_URL}/events.json?keyword=${encodeURIComponent(venueName)}&apikey=${API_KEY}&size=200&sort=date,asc`,
      { headers: { Accept: 'application/json' } }
    );

    if (!response.ok) {
      console.error(`Ticketmaster API error: ${response.status}`);
      return [];
    }

    const data = await response.json();
    const events = (data._embedded?.events || []).map(e => ({
      name: e.name,
      date: e.dates?.start?.dateTime || e.dates?.start?.localDate,
      onSaleDate: e.dates?.start?.nospäter || null,
      venueId: e._embedded?.venues?.[0]?.id,
      venueName: e._embedded?.venues?.[0]?.name,
      url: e.url,
      id: e.id,
    }));

    return events;
  } catch (error) {
    console.error(`searchEventsByVenue error for "${venueName}":`, error.message);
    return [];
  }
}

/**
 * Search for events by coordinates (lat/lon) within a radius.
 * Returns array of events.
 */
export async function searchEventsByCoordinates(lat, lon, radiusMiles = 50) {
  try {
    const response = await fetch(
      `${BASE_URL}/events.json?latlong=${lat},${lon}&radius=${radiusMiles}&apikey=${API_KEY}&size=200&sort=date,asc`,
      { headers: { Accept: 'application/json' } }
    );

    if (!response.ok) {
      console.error(`Ticketmaster API error: ${response.status}`);
      return [];
    }

    const data = await response.json();
    const events = (data._embedded?.events || []).map(e => ({
      name: e.name,
      date: e.dates?.start?.dateTime || e.dates?.start?.localDate,
      onSaleDate: e.dates?.start?.onSaleStartDateTime || null,
      venueId: e._embedded?.venues?.[0]?.id,
      venueName: e._embedded?.venues?.[0]?.name,
      url: e.url,
      id: e.id,
    }));

    return events;
  } catch (error) {
    console.error(`searchEventsByCoordinates error (${lat}, ${lon}):`, error.message);
    return [];
  }
}

/**
 * Batch search for events across multiple venues.
 */
export async function searchEventsByVenues(venues) {
  const allEvents = [];

  for (const venue of venues) {
    const events = await searchEventsByVenue(venue.name, venue.lat, venue.lon);
    allEvents.push(...events.map(e => ({ ...e, sourceName: venue.name })));

    // Rate limit: Ticketmaster allows 5000 requests/day, so space them out
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  return allEvents;
}

/**
 * Resolve a venue name to its Ticketmaster venue ID.
 * Returns the venue ID from the top search result, or null if not found.
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
 * Search for events by Ticketmaster venue ID.
 * Returns all upcoming events (Ticketmaster API doesn't support announcement-date filtering).
 * The watermark approach: client-side, we deduplicate by ticketmaster_id.
 *
 * @param {string} ticketmasterVenueId - Ticketmaster venue ID
 * @returns {Array} Array of normalized event objects
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
    const events = (data._embedded?.events || []).map(e => {
      // Extract on-sale date: prefer public on-sale, fall back to presale if earlier
      let onSaleStart = e.sales?.public?.startDateTime || null;
      if (e.sales?.presales && e.sales.presales.length > 0) {
        const earliestPresale = e.sales.presales[0].startDateTime;
        if (earliestPresale && (!onSaleStart || new Date(earliestPresale) < new Date(onSaleStart))) {
          onSaleStart = earliestPresale;
        }
      }

      return {
        ticketmaster_id: e.id,
        name: e.name,
        event_date: e.dates?.start?.dateTime || e.dates?.start?.localDate,
        public_visibility_start: e.sales?.public?.startDateTime || null,
        onsale_start: onSaleStart,
        onsale_end: e.sales?.public?.endDateTime || null,
        url: e.url,
      };
    });

    return events;
  } catch (error) {
    console.error(`searchEventsByVenueId error (${ticketmasterVenueId}):`, error.message);
    return [];
  }
}

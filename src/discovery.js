import 'dotenv/config';
import { resolveVenueToTicketmasterId, searchEventsByVenueId } from './scrapers/ticketmaster.js';
import {
  getOrCreateVenueDiscoveryState,
  updateDiscoveryStateVenueId,
  advanceDiscoveryWatermark,
  upsertTicketmasterEventByID,
} from './db.js';
import { createClient } from '@supabase/supabase-js';

const db = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);

async function getVenues() {
  const { data, error } = await db.from('venues').select('id, name, lat, lon');
  if (error) throw new Error(`Failed to fetch venues: ${error.message}`);
  return data || [];
}

/** How many events we already track for a venue — 0 ⇒ this is its first poll. */
async function existingEventCount(venueId) {
  const { count, error } = await db
    .from('events')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', venueId);
  if (error) {
    console.warn(`  Could not count existing events (${error.message}); treating as steady-state.`);
    return 1; // safe default: NOT baseline, so we don't suppress real announcements
  }
  return count ?? 0;
}

/**
 * Venue names in our DB carry a " — City, ST" suffix (e.g. "Dodger Stadium —
 * Los Angeles, CA"), which breaks Ticketmaster's keyword venue lookup. Strip it
 * to the bare venue name for resolution. Only splits on a space-surrounded dash,
 * so names like "T-Mobile Arena" are left intact.
 */
function cleanVenueForSearch(name) {
  return String(name).split(/\s+[—–-]\s+/)[0].trim();
}

/** Whole-day difference from now (negative = past). */
function daysUntil(dateStr) {
  if (!dateStr) return null;
  const t = new Date(dateStr).getTime();
  if (Number.isNaN(t)) return null;
  return Math.ceil((t - Date.now()) / 86_400_000);
}

/**
 * Fire a single "new event announced" alert. This is the thing that makes the
 * Discovery feature useful: a real, dated heads-up the moment a parking-relevant
 * show is announced — the start of the "secure passes early" window. Only called
 * for genuinely fresh announcements (not baseline imports, not re-seen events).
 */
async function createNewEventAlert(venue, event) {
  const dUntil = daysUntil(event.event_date);
  const onsale = event.onsale_start ? new Date(event.onsale_start) : null;
  const onsaleSoon = onsale && onsale.getTime() > Date.now();
  const onsaleHook = onsaleSoon
    ? ` Tickets on sale ${onsale.toISOString().slice(0, 10)} — grab parking early.`
    : '';

  const { error } = await db.from('alerts').insert({
    type: 'new_event', // must match the alert_type enum (price_spike|availability_drop|new_event|price_drop)
    venue_id: venue.id,
    message: `🎟️ New ${event.segment || 'event'} at ${venue.name}: "${event.name}" on ${String(event.event_date).slice(0, 10)}${dUntil != null ? ` (${dUntil}d out)` : ''}.${onsaleHook}`,
    metadata: {
      source: 'ticketmaster',
      ticketmaster_id: event.ticketmaster_id,
      event_name: event.name,
      event_date: event.event_date,
      onsale_start: event.onsale_start,
      segment: event.segment,
      days_until: dUntil,
      url: event.url,
    },
  });
  if (error) console.warn(`    Alert insert failed: ${error.message}`);
}

/**
 * Watermark-driven event discovery:
 * 1. For each venue, resolve its Ticketmaster venue ID (once, cached in state).
 * 2. Query events by EXACT venueId (no keyword/coordinate false positives).
 * 3. Upsert deduped by ticketmaster_id. A venue's FIRST poll is baselined
 *    (recorded but not announced); later polls surface genuinely-new events.
 * 4. Alert on each fresh announcement, advance the watermark.
 */
async function runDiscovery() {
  console.log('🎟️  Starting Ticketmaster event discovery (watermark-driven, venueId-exact)...\n');

  const venues = await getVenues();
  if (venues.length === 0) {
    console.log('No venues found in database.');
    return;
  }

  console.log(`Checking ${venues.length} venue(s) for newly announced events.\n`);

  let totalFresh = 0;
  let totalBaselined = 0;

  for (const venue of venues) {
    console.log(`▸ ${venue.name}`);

    try {
      const state = await getOrCreateVenueDiscoveryState(venue.id);

      // Resolve venue ID (one-time cache)
      let ticketmasterVenueId = state.ticketmaster_venue_id;
      if (!ticketmasterVenueId) {
        console.log(`  Resolving venue ID...`);
        ticketmasterVenueId = await resolveVenueToTicketmasterId(cleanVenueForSearch(venue.name));
        if (!ticketmasterVenueId) {
          console.log(`  ⚠️  Could not resolve venue to Ticketmaster ID`);
          await advanceDiscoveryWatermark(venue.id);
          continue;
        }
        await updateDiscoveryStateVenueId(venue.id, ticketmasterVenueId);
      }

      // Baseline mode = this venue's first-ever poll. Suppress the flood.
      const priorCount = await existingEventCount(venue.id);
      const baseline = priorCount === 0;
      if (baseline) console.log(`  First poll — baselining existing calendar (no "new" alerts).`);

      const events = await searchEventsByVenueId(ticketmasterVenueId);
      if (events.length === 0) {
        console.log(`  No parking-relevant events found`);
        await advanceDiscoveryWatermark(venue.id);
        continue;
      }

      console.log(`  Found ${events.length} parking-relevant event(s)`);

      let fresh = 0;
      let baselined = 0;
      for (const event of events) {
        try {
          const { isFreshAnnouncement } = await upsertTicketmasterEventByID(venue.id, event, { baseline });
          if (isFreshAnnouncement) {
            fresh++;
            console.log(`    ⭐ NEW "${event.name}" (${String(event.event_date).slice(0, 10)}, on-sale: ${event.onsale_start ? event.onsale_start.slice(0, 10) : 'TBA'})`);
            await createNewEventAlert(venue, event);
          } else if (baseline) {
            baselined++;
          }
        } catch (err) {
          console.error(`    Error processing event: ${err.message}`);
        }
      }

      if (baseline) console.log(`  Baselined ${baselined} existing event(s).`);
      console.log(`  ⭐ ${fresh} newly announced event(s).`);
      totalFresh += fresh;
      totalBaselined += baselined;

      await advanceDiscoveryWatermark(venue.id);
    } catch (err) {
      console.error(`  Error: ${err.message}`);
    }
  }

  console.log(`\n✅ Discovery complete. ${totalFresh} new announcement(s)${totalBaselined ? `, ${totalBaselined} baselined` : ''}.`);
}

runDiscovery().catch(err => {
  console.error('Discovery failed:', err.message);
  process.exit(1);
});

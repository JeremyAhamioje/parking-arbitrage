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

/**
 * Watermark-driven event discovery flow:
 * 1. Get all venues
 * 2. For each venue:
 *    a. Get/create discovery state (tracking last_polled_at watermark)
 *    b. Resolve venue name → Ticketmaster venue ID (once, cached)
 *    c. Query Ticketmaster for events announced since watermark
 *    d. Upsert events (deduplicated by ticketmaster_id)
 *    e. Advance watermark
 * 3. Report on genuinely new announcements
 */
async function runDiscovery() {
  console.log('🎟️  Starting Ticketmaster event discovery (watermark-driven)...\n');

  const venues = await getVenues();
  if (venues.length === 0) {
    console.log('No venues found in database.');
    return;
  }

  console.log(`Checking ${venues.length} venue(s) for newly announced events.\n`);

  let totalNewEventsAnnounced = 0;

  for (const venue of venues) {
    console.log(`▸ ${venue.name}`);

    try {
      // Step 1: Get or create discovery state (watermark)
      const state = await getOrCreateVenueDiscoveryState(venue.id);
      console.log(`  Last polled: ${new Date(state.last_polled_at).toISOString()}`);

      // Step 2: Resolve venue ID (one-time cache)
      let ticketmasterVenueId = state.ticketmaster_venue_id;
      if (!ticketmasterVenueId) {
        console.log(`  Resolving venue ID...`);
        ticketmasterVenueId = await resolveVenueToTicketmasterId(venue.name);
        if (!ticketmasterVenueId) {
          console.log(`  ⚠️  Could not resolve venue to Ticketmaster ID`);
          continue;
        }
        await updateDiscoveryStateVenueId(venue.id, ticketmasterVenueId);
      }

      // Step 3: Query for all events at venue
      const events = await searchEventsByVenueId(ticketmasterVenueId);

      if (events.length === 0) {
        console.log(`  No events found`);
        await advanceDiscoveryWatermark(venue.id);
        continue;
      }

      console.log(`  Found ${events.length} event(s)`);

      // Step 4: Upsert events (deduplicated by ticketmaster_id)
      let newCount = 0;
      for (const event of events) {
        try {
          const result = await upsertTicketmasterEventByID(venue.id, event);
          console.log(
            `    + "${event.name}" (${event.event_date}, on-sale: ${event.onsale_start || 'TBA'})`
          );
          if (result.isNew) newCount++;
        } catch (err) {
          console.error(`    Error processing event: ${err.message}`);
        }
      }

      console.log(`  ⭐ ${newCount} newly discovered event(s)`);
      totalNewEventsAnnounced += newCount;

      // Step 5: Advance watermark
      await advanceDiscoveryWatermark(venue.id);
    } catch (err) {
      console.error(`  Error: ${err.message}`);
    }
  }

  console.log(`\n✅ Discovery complete. Found ${totalNewEventsAnnounced} newly announced event(s).`);
}

runDiscovery().catch(err => {
  console.error('Discovery failed:', err.message);
  process.exit(1);
});

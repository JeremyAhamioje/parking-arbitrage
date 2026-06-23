import 'dotenv/config';
import { readVenues, appendParkingListings, ensureListingsSheet } from './sheets.js';
import { scrapeSpotHero, initBrowser, closeBrowser, getCoords, getPage, discoverDestinationAndEvents, cacheDestinationId } from './scrapers/spothero.js';
import { getSpotHeroEvents } from './scrapers/events.js';
import { upsertVenue, insertSnapshots, generateAlerts, upsertEvent, updateVenueDestinationId, upsertFacilityStats, createScrapeRun, finalizeScrapeRun, insertFacilityPriceLog } from './db.js';

// Set once per execution; every facility_price_log row from this run is tagged with it.
let currentRunId = null;
let runListingCount = 0;

async function run() {
  let venues = await readVenues();
  if (venues.length === 0) {
    console.error('No venues found in Sheet1 column A (A2:A51).');
    process.exit(1);
  }
  if (process.env.VENUE) {
    const filter = process.env.VENUE.toLowerCase();
    venues = venues.filter(v => v.toLowerCase().includes(filter));
    if (venues.length === 0) {
      console.error(`No venues matched VENUE="${process.env.VENUE}"`);
      process.exit(1);
    }
  }
  console.log(`Found ${venues.length} venue(s) to scrape.\n`);

  // Open a scrape run so every price-log row this execution writes is grouped + timestamped together.
  try {
    currentRunId = await createScrapeRun();
    console.log(`Scrape run started: ${currentRunId}\n`);
  } catch (e) {
    console.error(`Could not create scrape run (price log will be ungrouped): ${e.message}`);
  }

  // Legacy Sheets mirror — must not gate the scrape. If the tab can't be ensured
  // (auth, cell limit, API down), warn and carry on; the per-venue appends are
  // already non-fatal and Supabase is the source of truth.
  try {
    await ensureListingsSheet();
  } catch (e) {
    console.error(`Could not ensure Listings sheet (non-fatal): ${e.message}`);
  }
  console.log('Launching browser...');
  await initBrowser();

  try {
    for (const venue of venues) {
      console.log(`\n━━ ${venue} ━━`);

      const coords = getCoords(venue);
      if (!coords) {
        console.warn(`  No cached coords — skipping "${venue}"`);
        continue;
      }

      // Upsert venue row (idempotent)
      let venueId;
      try {
        venueId = await upsertVenue(venue, coords.lat, coords.lon);
      } catch (e) {
        console.error(`  DB venue upsert failed: ${e.message}`);
        continue;
      }

      // --- Step 1: Get SpotHero events for this venue ---
      let destId = coords.spotheroDestinationId || null;
      let events = [];

      if (destId) {
        // Fast path: destination_id already cached — call the events API directly
        const page = getPage();
        events = await getSpotHeroEvents(page, destId);
        console.log(`  SpotHero events found: ${events.length} (cached dest_id=${destId})`);
      } else {
        // First-time: navigate SpotHero to intercept the events call and capture dest_id
        console.log('  Discovering destination_id (first run — navigating SpotHero page)...');
        const discovered = await discoverDestinationAndEvents(venue, coords.lat, coords.lon);
        destId = discovered.destinationId;
        events = discovered.events;

        if (destId) {
          cacheDestinationId(venue, destId);
          try { await updateVenueDestinationId(venueId, destId); } catch {}
          console.log(`  Cached destination_id=${destId} for "${venue}"`);
        }

        console.log(`  SpotHero events found: ${events.length}${destId ? ` (dest_id=${destId})` : ' (no destination found)'}`);
      }

      if (events.length === 0) {
        // No upcoming events (or no SpotHero destination for this venue) — generic scrape
        console.log('  Running generic scrape (no event context)...');
        const { listings } = await scrapeSpotHero(venue);
        await saveListings(venue, venueId, null, listings);
      } else {
        // --- Step 2: Scrape parking for each specific event ---
        for (const event of events) {
          console.log(`\n  → "${event.name}"  ${event.date}  ${event.startsAt?.slice(11, 16) || ''}`);

          let eventId = null;
          try {
            const rows = await upsertEvent(venueId, event);
            eventId = rows?.[0]?.id || null;
          } catch (e) {
            console.warn(`    upsertEvent failed: ${e.message}`);
          }

          const { listings } = await scrapeSpotHero(venue, event.startsAt, event.endsAt);
          await saveListings(venue, venueId, event, listings, eventId);
        }
      }
    }
  } finally {
    await closeBrowser();
  }

  await finalizeScrapeRun(currentRunId, { venueCount: venues.length, listingCount: runListingCount });

  console.log('\nAll done.');
}

async function saveListings(venue, venueId, event, listings, eventId = null) {
  if (listings.length === 0) {
    console.log(`    No listings found`);
    return;
  }

  const label = event ? `"${event.name}" (${event.date})` : 'generic';
  console.log(`    ${listings.length} listings for ${label}`);
  listings.forEach(l => console.log(`      ${l.name} — $${l.totalPrice} — ${l.availableSpaces ?? '?'} spaces`));

  // Supabase
  try {
    await insertSnapshots(venueId, listings, eventId, 'spothero');
    // upsertFacilityStats computes the per-facility deltas; reuse them for the price log.
    const deltas = await upsertFacilityStats(venueId, listings, eventId, 'spothero');
    await insertFacilityPriceLog(currentRunId, venueId, deltas, eventId);
    await generateAlerts(venueId, venue, listings);
    runListingCount += listings.length;
  } catch (e) {
    console.error(`    DB write failed: ${e.message}`);
  }

  // Google Sheets — a LEGACY MIRROR; Supabase (above) is the source of truth.
  // Isolated so a Sheets failure (e.g. the tab hitting Google's cell limit) logs
  // and continues instead of propagating up and aborting the whole run + every
  // venue after it. The DB already has this venue's data.
  try {
    await appendParkingListings(venue, listings, event);
  } catch (e) {
    console.error(`    Sheets append failed (non-fatal): ${e.message}`);
  }
}

// Fail loudly (exit 1) on a fatal error — e.g. a missing SUPABASE_URL/Sheets
// config — instead of swallowing it. Swallowing made the Actions job report green
// while writing nothing, which hid a missing-secret outage for a day. Per-venue
// errors are still caught inside run() and don't reach here.
run().catch(e => { console.error(e); process.exit(1); });

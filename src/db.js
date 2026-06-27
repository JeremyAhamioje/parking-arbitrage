import { createClient } from '@supabase/supabase-js';

let _client = null;

function getClient() {
  if (!_client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY;
    if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in .env');
    _client = createClient(url, key, { auth: { persistSession: false } });
  }
  return _client;
}

/**
 * Aggressive retention prune — delete time-series scrape rows older than `days`
 * so the database stays under Supabase's free-tier 500 MB cap. The tool is
 * real-time-first, so a short window is enough; rolling aggregates
 * (facility_stats) and reference tables (venues, events) are maintained
 * incrementally and are intentionally NOT pruned. Configure with RETENTION_DAYS
 * (default 3). Returns a { cutoff, days, summary } report of rows deleted/table.
 */
export async function pruneOldData(days = Number(process.env.RETENTION_DAYS || 3)) {
  const db = getClient();
  const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
  // Both keyed by `scraped_at`; `snapshots` is ~99% of the volume. (parking_snapshots
  // is intentionally omitted — it was never created in prod.)
  const TABLES = ['snapshots', 'facility_price_log'];
  // Delete in batches: one DELETE of a large backlog can blow Postgres' statement
  // timeout and throw (which previously failed the whole Actions job). Selecting +
  // deleting a bounded id set per round keeps every statement small and the URL
  // short, and a per-table try/catch means one table's hiccup can't abort the run.
  const BATCH = Number(process.env.PRUNE_BATCH || 200);
  const summary = {};
  for (const table of TABLES) {
    let removed = 0;
    try {
      for (let i = 0; i < 100_000; i++) { // hard cap; breaks when no old rows remain
        const { data: rows, error: selErr } = await db
          .from(table).select('id').lt('scraped_at', cutoff).limit(BATCH);
        if (selErr) throw new Error(selErr.message);
        if (!rows || rows.length === 0) break;
        const { error: delErr } = await db.from(table).delete().in('id', rows.map(r => r.id));
        if (delErr) throw new Error(delErr.message);
        removed += rows.length;
        if (rows.length < BATCH) break;
      }
      summary[table] = removed;
    } catch (e) {
      summary[table] = `error after ${removed}: ${e.message}`;
    }
  }
  return { cutoff, days, summary };
}

/**
 * Retention prune for the `alerts` table — pruneOldData() only deletes by
 * scraped_at, so alerts (keyed by created_at) were never pruned and grew
 * unbounded (150k+ rows, mostly low-value price moves). Tiered: the noise
 * (everything that isn't a sold-out signal) gets a short window; SOLD_OUT /
 * INVENTORY_THINNING are the high-value ones and are kept far longer. Batched
 * deletes keep each statement small (same reasoning as pruneOldData). Configure
 * with ALERT_RETENTION_DAYS (default 14) and ALERT_SOLDOUT_RETENTION_DAYS (60).
 */
export async function pruneOldAlerts({
  days = Number(process.env.ALERT_RETENTION_DAYS || 14),
  soldoutDays = Number(process.env.ALERT_SOLDOUT_RETENTION_DAYS || 60),
} = {}) {
  const db = getClient();
  const BATCH = Number(process.env.PRUNE_BATCH || 200);
  const shortCutoff = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
  const longCutoff = new Date(Date.now() - soldoutDays * 24 * 3600 * 1000).toISOString();

  // Delete a filtered set of alerts in bounded batches (select ids → delete by id).
  async function deleteBatched(applyFilter) {
    let removed = 0;
    for (let i = 0; i < 100_000; i++) {
      const { data: rows, error: selErr } = await applyFilter(db.from('alerts').select('id').limit(BATCH));
      if (selErr) throw new Error(selErr.message);
      if (!rows || rows.length === 0) break;
      const { error: delErr } = await db.from('alerts').delete().in('id', rows.map(r => r.id));
      if (delErr) throw new Error(delErr.message);
      removed += rows.length;
      if (rows.length < BATCH) break;
    }
    return removed;
  }

  const summary = {};
  // The noise: everything that isn't a sold-out signal (null signal_type included)
  // — short retention.
  try {
    summary.noise = await deleteBatched(q => q
      .lt('created_at', shortCutoff)
      .or('metadata->>signal_type.is.null,metadata->>signal_type.not.in.(SOLD_OUT,INVENTORY_THINNING)'));
  } catch (e) { summary.noise = `error: ${e.message}`; }
  // Sold-out / thinning — the high-value alerts, kept far longer.
  try {
    summary.soldout = await deleteBatched(q => q
      .lt('created_at', longCutoff)
      .or('metadata->>signal_type.eq.SOLD_OUT,metadata->>signal_type.eq.INVENTORY_THINNING'));
  } catch (e) { summary.soldout = `error: ${e.message}`; }

  return { shortCutoff, longCutoff, days, soldoutDays, summary };
}

export async function updateVenueDestinationId(venueId, destinationId) {
  const db = getClient();
  const { error } = await db
    .from('venues')
    .update({ spothero_destination_id: destinationId })
    .eq('id', venueId);
  if (error) throw new Error(`updateVenueDestinationId failed: ${error.message}`);
}

/**
 * Upsert a venue by name. Returns the venue row (with its UUID).
 */
export async function upsertVenue(name, lat, lon) {
  const db = getClient();
  const { data, error } = await db
    .from('venues')
    .upsert({ name, lat, lon }, { onConflict: 'name' })
    .select('id')
    .single();
  if (error) throw new Error(`upsertVenue failed: ${error.message}`);
  return data.id;
}

/**
 * Write a batch of parking listing snapshots for a venue.
 * listings = array of objects from parseListings() in spothero.js
 * eventId  = UUID of the events row this scrape is for (null = generic/no event)
 * source   = data origin ('spothero' | 'way' | 'parkwhiz') — tags each row so the
 *            UI can filter one provider's data out of the shared table.
 */
export async function insertSnapshots(venueId, listings, eventId = null, source = 'spothero') {
  if (!listings.length) return;
  const db = getClient();

  const rows = listings.map(l => ({
    venue_id:         venueId,
    event_id:         eventId,
    source,
    facility_id:      String(l.facilityId),
    facility_name:    l.name,
    address:          l.address,
    city:             l.city,
    state:            l.state,
    facility_type:    l.facilityType,
    amenities:        l.amenities,
    walking_meters:   l.walkingMeters || null,
    advertised_price: l.advertisedPrice,
    service_fee:      l.serviceFee,
    total_price:      l.totalPrice,
    available_spaces: typeof l.availableSpaces === 'number' ? l.availableSpaces : null,
    is_available:     l.available === true || l.available === 'Yes',
    booking_url:      l.bookingUrl || null, // ParkWhiz per-lot URL; null for SpotHero/Way
  }));

  const { error } = await db.from('snapshots').insert(rows);
  if (error) throw new Error(`insertSnapshots failed: ${error.message}`);
}

/**
 * Maintain the facility_stats summary layer — one row per (venue, facility).
 * Call this right after insertSnapshots(). It reads each facility's previous
 * stats row, then writes back the latest price/spaces, deltas, a rolling price
 * window, and volatility. The UI reads this table directly (no raw-snapshot
 * loops), and the volatility column feeds the downstream LLM buy/wait model.
 */
const HISTORY_CAP = 20; // rolling window length for volatility / sparkline

export async function upsertFacilityStats(venueId, listings, eventId = null, source = 'spothero') {
  if (!listings.length) return;
  const db = getClient();
  const isEventScrape = eventId !== null && eventId !== undefined;

  const facilityIds = listings.map(l => String(l.facilityId));

  // One query for all previous rows for these facilities (avoid N round-trips).
  // Scope to `source` so a Way scrape reads Way's prior stats, not SpotHero's.
  const { data: existingRows } = await db
    .from('facility_stats')
    .select('*')
    .eq('venue_id', venueId)
    .eq('source', source)
    .in('facility_id', facilityIds);

  const existingMap = {};
  for (const row of existingRows || []) existingMap[row.facility_id] = row;

  const now = new Date().toISOString();
  const upserts = [];
  const deltas = []; // returned so insertFacilityPriceLog() reuses prev prices (no re-query)

  for (const l of listings) {
    const fid = String(l.facilityId);
    const price = Number(l.totalPrice) || 0;
    const spaces = typeof l.availableSpaces === 'number' ? l.availableSpaces : null;
    const existing = existingMap[fid];

    const prevPrice = existing && existing.latest_price !== null ? Number(existing.latest_price) : null;
    const prevSpaces = existing ? existing.latest_spaces : null;

    // Rolling price window (oldest → newest)
    const history = Array.isArray(existing?.price_history) ? existing.price_history.map(Number) : [];
    history.push(price);
    const window = history.slice(-HISTORY_CAP);

    const minP = Math.min(...window);
    const maxP = Math.max(...window);
    const avgP = window.reduce((a, b) => a + b, 0) / window.length;
    const volatility = avgP > 0 ? (maxP - minP) / avgP : 0;

    const priceDelta = prevPrice !== null ? price - prevPrice : 0;
    const priceDeltaPct = prevPrice ? (priceDelta / prevPrice) * 100 : 0;
    const spacesDelta = spaces !== null && prevSpaces !== null ? spaces - prevSpaces : null;
    const trend = priceDelta > 0.5 ? 'up' : priceDelta < -0.5 ? 'down' : 'flat';

    // Running averages split by scrape context. Update only the bucket this
    // scrape belongs to (event vs generic), using the incremental-mean formula:
    //   newAvg = (oldAvg*oldCount + price) / (oldCount + 1)
    let genericAvg = existing?.generic_avg_price !== null && existing?.generic_avg_price !== undefined ? Number(existing.generic_avg_price) : null;
    let genericCount = existing?.generic_count || 0;
    let eventAvg = existing?.event_avg_price !== null && existing?.event_avg_price !== undefined ? Number(existing.event_avg_price) : null;
    let eventCount = existing?.event_count || 0;

    if (isEventScrape) {
      eventAvg = ((eventAvg || 0) * eventCount + price) / (eventCount + 1);
      eventCount += 1;
    } else {
      genericAvg = ((genericAvg || 0) * genericCount + price) / (genericCount + 1);
      genericCount += 1;
    }

    // Premium only meaningful once we have BOTH a baseline and an event price.
    const eventPremiumPct =
      genericAvg && genericAvg > 0 && eventAvg !== null
        ? ((eventAvg - genericAvg) / genericAvg) * 100
        : null;

    upserts.push({
      venue_id: venueId,
      facility_id: fid,
      source,
      facility_name: l.name,
      address: l.address,
      walking_meters: l.walkingMeters || null,
      latest_price: price,
      prev_price: prevPrice,
      price_delta: parseFloat(priceDelta.toFixed(2)),
      price_delta_pct: parseFloat(priceDeltaPct.toFixed(2)),
      latest_spaces: spaces,
      prev_spaces: prevSpaces,
      spaces_delta: spacesDelta,
      min_price: parseFloat(minP.toFixed(2)),
      max_price: parseFloat(maxP.toFixed(2)),
      avg_price: parseFloat(avgP.toFixed(2)),
      volatility: parseFloat(volatility.toFixed(4)),
      trend,
      price_history: window,
      scrape_count: (existing?.scrape_count || 0) + 1,
      first_scraped_at: existing?.first_scraped_at || now,
      last_scraped_at: now,
      generic_avg_price: genericAvg !== null ? parseFloat(genericAvg.toFixed(2)) : null,
      generic_count: genericCount,
      event_avg_price: eventAvg !== null ? parseFloat(eventAvg.toFixed(2)) : null,
      event_count: eventCount,
      event_premium_pct: eventPremiumPct !== null ? parseFloat(eventPremiumPct.toFixed(2)) : null,
    });

    deltas.push({
      facility_id: fid,
      facility_name: l.name,
      price,
      spaces,
      prev_price: prevPrice,
      price_delta: prevPrice !== null ? parseFloat(priceDelta.toFixed(2)) : null,
      price_delta_pct: prevPrice ? parseFloat(priceDeltaPct.toFixed(2)) : null,
      prev_spaces: prevSpaces,
      spaces_delta: spacesDelta,
    });
  }

  const { error } = await db
    .from('facility_stats')
    .upsert(upserts, { onConflict: 'venue_id,facility_id,source' });
  if (error) throw new Error(`upsertFacilityStats failed: ${error.message}`);

  return deltas;
}

/**
 * Create a scrape_runs row at the start of an execution. Returns the run id
 * that every facility_price_log row from this run is tagged with.
 */
export async function createScrapeRun() {
  const db = getClient();
  const { data, error } = await db
    .from('scrape_runs')
    .insert({ started_at: new Date().toISOString() })
    .select('id')
    .single();
  if (error) throw new Error(`createScrapeRun failed: ${error.message}`);
  return data.id;
}

/**
 * Stamp a run as finished with summary counts.
 */
export async function finalizeScrapeRun(runId, { venueCount, listingCount }) {
  if (!runId) return;
  const db = getClient();
  const { error } = await db
    .from('scrape_runs')
    .update({
      finished_at: new Date().toISOString(),
      venue_count: venueCount,
      listing_count: listingCount,
    })
    .eq('id', runId);
  if (error) console.error(`  finalizeScrapeRun failed: ${error.message}`);
}

/**
 * Append one facility_price_log row per facility for this run. Consumes the
 * `deltas` array returned by upsertFacilityStats() so no prices are re-queried.
 * This is the timestamped, run-by-run price changelog the drill-down + LLM read.
 */
export async function insertFacilityPriceLog(runId, venueId, deltas, eventId = null) {
  if (!deltas || !deltas.length) return;
  const db = getClient();
  const now = new Date().toISOString();

  const rows = deltas.map(d => ({
    run_id: runId,
    scraped_at: now,
    venue_id: venueId,
    facility_id: d.facility_id,
    facility_name: d.facility_name,
    price: d.price,
    spaces: d.spaces,
    prev_price: d.prev_price,
    price_delta: d.price_delta,
    price_delta_pct: d.price_delta_pct,
    prev_spaces: d.prev_spaces,
    spaces_delta: d.spaces_delta,
    event_id: eventId,
  }));

  const { error } = await db.from('facility_price_log').insert(rows);
  if (error) throw new Error(`insertFacilityPriceLog failed: ${error.message}`);
}

/**
 * After inserting snapshots, compare to the previous run and
 * generate alerts for significant price spikes or availability drops.
 *
 * "Significant" = price up by $5+ or available_spaces dropped by 50%+
 */
// Noise control: only alert on meaningful moves (was a flat $5). BOTH floors must
// clear, so trivial wiggles don't flood the feed. Tunable via env.
const ALERT_MIN_MOVE_ABS = parseFloat(process.env.ALERT_MIN_MOVE_ABS || '12');
const ALERT_MIN_MOVE_PCT = parseFloat(process.env.ALERT_MIN_MOVE_PCT || '20');

export async function generateAlerts(venueId, venueName, listings, opts = {}) {
  const db = getClient();
  const source = opts.source || null;
  const context = opts.eventId ? 'event' : 'generic'; // event-context scrape vs generic
  const alerts = [];

  for (const l of listings) {
    // Get the two most recent snapshots for this facility at this venue
    const { data: history } = await db
      .from('snapshots')
      .select('total_price, available_spaces, scraped_at')
      .eq('venue_id', venueId)
      .eq('facility_id', String(l.facilityId))
      .order('scraped_at', { ascending: false })
      .limit(2);

    if (!history || history.length < 2) continue; // not enough history yet

    const [current, previous] = history;
    const priceDelta = current.total_price - previous.total_price;
    const pricePct = previous.total_price > 0 ? (priceDelta / previous.total_price) * 100 : 0;
    // Meaningful only if it clears BOTH an absolute and a percent floor.
    const meaningful = Math.abs(priceDelta) >= ALERT_MIN_MOVE_ABS && Math.abs(pricePct) >= ALERT_MIN_MOVE_PCT;

    // Shared metadata: source + context (event/generic) drive the UI filters and
    // the provenance label; the scrape times drive the run-window display.
    const baseMeta = {
      prev_price: previous.total_price,
      new_price: current.total_price,
      delta: priceDelta,
      change_pct: parseFloat(pricePct.toFixed(1)),
      facility_name: l.name,
      source,
      context,
      // Deep link: exact lot (ParkWhiz/Way) when we have one; for event-context
      // alerts also carry the event name + its page so the feed shows WHICH event
      // and can offer a "View event" link (SpotHero, which has no per-lot URL).
      listing_url: l.bookingUrl || l.url || null,
      event_name: opts.eventName || null,
      event_url: opts.eventUrl || null,
      prev_scraped_at: previous.scraped_at,
      new_scraped_at: current.scraped_at,
    };

    if (meaningful && priceDelta > 0) {
      alerts.push({
        type: 'price_spike',
        venue_id: venueId,
        facility_id: String(l.facilityId),
        message: `${venueName} — ${l.name}: price jumped $${priceDelta.toFixed(2)} (${pricePct.toFixed(0)}%, $${previous.total_price} → $${current.total_price})`,
        metadata: { ...baseMeta, category: 'price_spike' },
      });
    }

    if (meaningful && priceDelta < 0) {
      alerts.push({
        type: 'price_drop',
        venue_id: venueId,
        facility_id: String(l.facilityId),
        message: `${venueName} — ${l.name}: price dropped $${Math.abs(priceDelta).toFixed(2)} (${Math.abs(pricePct).toFixed(0)}%, $${previous.total_price} → $${current.total_price})`,
        metadata: { ...baseMeta, category: 'price_drop' },
      });
    }

    const prevSpaces = previous.available_spaces;
    const currSpaces = current.available_spaces;
    if (prevSpaces && currSpaces !== null && prevSpaces > 10 && currSpaces < prevSpaces * 0.5) {
      alerts.push({
        type: 'availability_drop',
        venue_id: venueId,
        facility_id: String(l.facilityId),
        message: `${venueName} — ${l.name}: spaces dropped from ${prevSpaces} to ${currSpaces}`,
        metadata: { prev_spaces: prevSpaces, new_spaces: currSpaces, facility_name: l.name, source, context, category: 'inventory_drop', prev_scraped_at: previous.scraped_at, new_scraped_at: current.scraped_at },
      });
    }
  }

  if (alerts.length > 0) {
    const { error } = await db.from('alerts').insert(alerts);
    if (error) console.error(`  Alert insert failed: ${error.message}`);
    else console.log(`  Generated ${alerts.length} alert(s) for "${venueName}"`);
  }
}

/**
 * Upsert an event discovered for a venue.
 * Returns true if this is a newly discovered event (for the new_event alert).
 */
export async function upsertEvent(venueId, event) {
  const db = getClient();
  const { data, error } = await db
    .from('events')
    .upsert({
      venue_id:   venueId,
      event_name: event.name,
      event_date: event.date || null,
      starts_at:  event.startsAt || null,
      ends_at:    event.endsAt || null,
      source_url: event.sourceUrl || null,
    }, { onConflict: 'venue_id,event_name,starts_at', ignoreDuplicates: false })
    .select('id, discovered_at');

  if (error) throw new Error(`upsertEvent failed: ${error.message}`);
  return data;
}

/**
 * Upcoming events for a venue, for event-context scraping (ParkWhiz/Way tag their
 * snapshots with these event_ids so the per-event premium/ROI analysis works for
 * all platforms, not just SpotHero). Bounds are date-only strings so they compare
 * correctly against both date-only (Ticketmaster) and timestamp (SpotHero) values.
 *
 * The per-venue cost lever is DISTINCT DATES (`maxDates`), not event rows — each
 * date is one parking scrape. The ticket feed imports many same-day variants of
 * one game (e.g. "Yankees v Reds", "...Premium Seating", "Pinstripe Pass...") as
 * separate events; counting rows would burn the whole budget on a single day. So
 * we keep EVERY event that lands on one of the soonest `maxDates` distinct dates —
 * they all get tagged off that day's single scrape. `limit` is accepted as a
 * legacy alias for `maxDates`.
 */
export async function getUpcomingEventsForVenue(venueId, { horizonDays = 14, maxDates, limit } = {}) {
  const db = getClient();
  const dateBudget = maxDates ?? limit ?? 4;
  // UTC date strings (not local-midnight → toISOString, which rolls back a day in
  // positive-offset timezones). The box runs UTC, so "today" = today's UTC date.
  const now = Date.now();
  const todayStr = new Date(now).toISOString().slice(0, 10);
  const endStr = new Date(now + horizonDays * 86_400_000).toISOString().slice(0, 10);
  // Fetch enough soonest rows that the date budget is reachable even when the
  // earliest days are dense with duplicate variants. Bounded so a huge horizon
  // can't pull hundreds of rows for a daily-event venue.
  const rowCap = Math.min(500, Math.max(60, dateBudget * 25));
  const { data, error } = await db
    .from('events')
    .select('id, event_name, event_date')
    .eq('venue_id', venueId)
    .gte('event_date', todayStr)
    .lte('event_date', endStr)
    .order('event_date', { ascending: true })
    .limit(rowCap);
  if (error) { console.error(`  getUpcomingEventsForVenue(${venueId}) failed: ${error.message}`); return []; }
  // Keep all events on the soonest `dateBudget` distinct dates (rows are already
  // date-ascending, so the first distinct dates seen are the soonest).
  const seenDates = new Set();
  const out = [];
  for (const e of data || []) {
    const d = String(e.event_date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    if (!seenDates.has(d)) {
      if (seenDates.size >= dateBudget) break;
      seenDates.add(d);
    }
    out.push(e);
  }
  return out;
}

/**
 * Get all previously discovered events for a venue (for diffing).
 */
export async function getPreviousEventsSnapshot(venueId) {
  const db = getClient();
  const { data, error } = await db
    .from('events')
    .select('id, event_name, event_date, starts_at, discovered_at')
    .eq('venue_id', venueId);

  if (error) throw new Error(`getPreviousEventsSnapshot failed: ${error.message}`);
  return data || [];
}

/**
 * Upsert a Ticketmaster-discovered event.
 * Returns the event ID and whether it's new.
 */
export async function upsertTicketmasterEvent(venueId, venueDbId, event) {
  const db = getClient();

  // Check if event already exists
  const { data: existing } = await db
    .from('events')
    .select('id')
    .eq('venue_id', venueDbId)
    .eq('event_name', event.name)
    .eq('event_date', event.date)
    .limit(1);

  if (existing && existing.length > 0) {
    return { eventId: existing[0].id, isNew: false };
  }

  // Insert new event
  const { data, error } = await db
    .from('events')
    .insert({
      venue_id: venueDbId,
      event_name: event.name,
      event_date: event.date,
      starts_at: event.date,
      ends_at: null,
      source_url: event.url,
    })
    .select('id');

  if (error) throw new Error(`upsertTicketmasterEvent failed: ${error.message}`);

  return { eventId: data?.[0]?.id, isNew: true };
}

/**
 * Create a discovery alert for new events.
 */
export async function createEventDiscoveryAlert(venueId, venueName, event) {
  const db = getClient();

  const { error } = await db.from('alerts').insert({
    type: 'new_event_discovered',
    venue_id: venueId,
    message: `New event at ${venueName}: "${event.name}" on ${event.date}`,
    metadata: {
      event_name: event.name,
      event_date: event.date,
      on_sale_date: event.onSaleDate,
      source: 'ticketmaster',
      url: event.url,
    },
  });

  if (error) throw new Error(`createEventDiscoveryAlert failed: ${error.message}`);
}

/**
 * Get or create venue discovery state (watermark tracking).
 * Returns { id, venue_id, ticketmaster_venue_id, last_polled_at, updated_at }
 */
export async function getOrCreateVenueDiscoveryState(venueId) {
  const db = getClient();

  // Try to fetch existing state
  const { data: existing, error: fetchError } = await db
    .from('venue_discovery_state')
    .select('*')
    .eq('venue_id', venueId)
    .single();

  // If exists, return it
  if (existing && !fetchError) {
    return existing;
  }

  // If not found, create new state with default last_polled_at = 3 months ago
  const threeMonthsAgo = new Date();
  threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

  const { data: created, error: createError } = await db
    .from('venue_discovery_state')
    .insert({
      venue_id: venueId,
      last_polled_at: threeMonthsAgo.toISOString(),
    })
    .select('*')
    .single();

  if (createError) {
    // Handle case where it was just created by another process
    const { data: retry } = await db
      .from('venue_discovery_state')
      .select('*')
      .eq('venue_id', venueId)
      .single();
    if (retry) return retry;
    throw new Error(`getOrCreateVenueDiscoveryState failed: ${createError.message}`);
  }

  return created;
}

/**
 * Update ticketmaster_venue_id in discovery state.
 */
export async function updateDiscoveryStateVenueId(venueId, ticketmasterVenueId) {
  const db = getClient();
  const { error } = await db
    .from('venue_discovery_state')
    .update({ ticketmaster_venue_id: ticketmasterVenueId })
    .eq('venue_id', venueId);

  if (error) throw new Error(`updateDiscoveryStateVenueId failed: ${error.message}`);
}

/**
 * Advance the watermark for a venue (after successful poll).
 */
export async function advanceDiscoveryWatermark(venueId) {
  const db = getClient();
  const { error } = await db
    .from('venue_discovery_state')
    .update({ last_polled_at: new Date().toISOString() })
    .eq('venue_id', venueId);

  if (error) throw new Error(`advanceDiscoveryWatermark failed: ${error.message}`);
}

/**
 * Upsert a Ticketmaster event (watermark-based approach).
 * Matches by ticketmaster_id to avoid duplicates.
 *
 * `baseline` distinguishes a venue's FIRST-EVER poll from steady-state polling.
 * On a first poll every event is technically "new to us", which would flood the
 * UI's newly-announced feed with the venue's entire pre-existing calendar. So in
 * baseline mode we record the events but leave first_seen_at NULL — they're known
 * history, not fresh announcements. Only events that appear in LATER polls get a
 * first_seen_at stamp and therefore surface as genuinely new.
 *
 * Returns { eventId, isNew, isFreshAnnouncement } where isFreshAnnouncement is
 * isNew && !baseline (i.e. worth alerting on).
 */
export async function upsertTicketmasterEventByID(venueId, event, { baseline = false } = {}) {
  const db = getClient();

  // event object: { ticketmaster_id, name, event_date, public_visibility_start, onsale_start, onsale_end, url }

  // First, check if event already exists
  const { data: existing } = await db
    .from('events')
    .select('id')
    .eq('ticketmaster_id', event.ticketmaster_id)
    .limit(1);

  const isNew = !existing || existing.length === 0;
  const isFreshAnnouncement = isNew && !baseline;

  // Only stamp first_seen_at when this is a genuine NEW announcement (not the
  // initial baseline import, and not an update to an event we already track).
  const firstSeenStamp = isNew ? (baseline ? null : new Date().toISOString()) : undefined;

  const { data, error } = await db
    .from('events')
    .upsert(
      {
        ticketmaster_id: event.ticketmaster_id,
        venue_id: venueId,
        event_name: event.name,
        event_date: event.event_date,
        public_visibility_start: event.public_visibility_start,
        onsale_start: event.onsale_start,
        onsale_end: event.onsale_end,
        source_url: event.url,
        first_seen_at: firstSeenStamp,
      },
      { onConflict: 'ticketmaster_id' }
    )
    .select('id');

  if (error) throw new Error(`upsertTicketmasterEventByID failed: ${error.message}`);

  return { eventId: data?.[0]?.id, isNew, isFreshAnnouncement };
}

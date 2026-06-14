# Event Discovery Implementation Guide

## What Changed

The event discovery system has been completely rewritten to use **watermark-driven incremental polling** instead of snapshot diffing. This fixes the "0 events showing" problem.

### Before (Broken)
- Fetches all events for a venue from Ticketmaster
- Diffs against database state ("new to my DB" ≠ "newly announced")
- Result: Massive backlog on first run, noise on subsequent runs, UI shows stale/empty data

### After (Fixed)
- Tracks `last_polled_at` watermark per venue
- Queries only events announced *since last poll* using Ticketmaster's `publicVisibilityStartDateTime` filter
- Deduplicates by Ticketmaster event ID
- Result: Clean signal, UI shows genuinely new announcements

---

## 3-Step Setup

### Step 1: Run Schema Migration

Open your Supabase database SQL editor and run the migration:

```bash
cat C:\Users\jenni\Downloads\parking-arbitrage\SCHEMA_MIGRATION.sql
```

Copy the SQL and paste it into Supabase → SQL Editor → Run.

**What it does:**
- Creates `venue_discovery_state` table (watermark tracking)
- Adds timestamp columns to `ticketmaster_events` table
- Creates indexes for performance

**Verify:**
```sql
SELECT COUNT(*) FROM venue_discovery_state;
SELECT COUNT(*) FROM ticketmaster_events;
-- Both should return 0 if fresh, or existing counts if already populated
```

### Step 2: Verify Ticketmaster API Key

Ensure your `.env` file has:
```env
TICKETMASTER_API_KEY=your_api_key_here
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your_service_key_here
```

Get a free API key from: https://developer.ticketmaster.com/

### Step 3: Run Discovery

```bash
cd C:\Users\jenni\Downloads\parking-arbitrage
node src/discovery.js
```

---

## What to Expect

### First Run (New Venue)

**Setup:** No venues in `venue_discovery_state` yet.

**Flow:**
1. Creates discovery state with `last_polled_at = now - 3 months` (backlog window)
2. Resolves "Madison Square Garden" → Ticketmaster ID (cached)
3. Queries: "Show events announced in last 3 months"
4. Returns: ~50–200 events (depending on venue activity)
5. Inserts all into DB
6. Advances watermark to now

**Console Output:**
```
▸ Madison Square Garden
  Last polled: 2026-03-07T14:30:00Z
  Resolving venue ID...
  Resolved "Madison Square Garden" → Ticketmaster ID: v1234567
  Found 85 event(s) announced since 2026-03-07T14:30:00Z
    + "Concert: The Weeknd" (2026-08-15T20:00:00Z, on-sale: 2026-07-20T10:00:00Z)
    + "Broadway: Hamilton" (2026-09-10T19:00:00Z, on-sale: 2026-08-15T10:00:00Z)
    ... (more events)
  ⭐ 85 newly discovered event(s)
✅ Discovery complete. Found 85 newly announced event(s).
```

### Subsequent Runs (24 Hours Later)

**Setup:** Discovery state has watermark from last run.

**Flow:**
1. Fetches discovery state (has watermark from 24h ago)
2. Cached venue ID is ready (no re-resolution)
3. Queries: "Show events announced in last 24 hours"
4. Returns: 2–5 new events (realistic daily announcement rate)
5. Inserts only genuinely new announcements
6. Advances watermark

**Console Output:**
```
▸ Madison Square Garden
  Last polled: 2026-06-06T14:30:00Z
  Found 3 event(s) announced since 2026-06-06T14:30:00Z
    + "Concert: Taylor Swift" (2026-10-05T19:00:00Z, on-sale: 2026-07-15T10:00:00Z)
    + "Festival: Coachella Early Birds" (2026-04-12T00:00:00Z, on-sale: 2026-01-20T10:00:00Z)
    + "Theater: Wicked Reboot" (2026-11-01T20:00:00Z, on-sale: 2026-08-01T10:00:00Z)
  ⭐ 3 newly discovered event(s)
✅ Discovery complete. Found 3 newly announced event(s).
```

---

## Testing the Flow

### Test 1: Verify Schema

```bash
# In Supabase SQL Editor
SELECT * FROM venue_discovery_state LIMIT 1;
SELECT * FROM ticketmaster_events LIMIT 1;
```

Both should have data after first run.

### Test 2: Check Watermark Advancement

Run discovery twice in a row:

```bash
node src/discovery.js
# Check console: "Last polled: 2026-06-06T14:30:00Z, Found 50 events"

# Wait 10 seconds, run again:
node src/discovery.js
# Check console: "Last polled: 2026-06-06T14:32:00Z, Found 0 events"
# (0 events because it's been <24h, Ticketmaster API only returns new announcements)
```

### Test 3: Frontend Integration

Once discovery populates `ticketmaster_events`, verify the UI fetches it:

1. Start the frontend:
   ```bash
   cd C:\Users\jenni\Downloads\parking-arbitrage-ui
   npm run dev
   ```

2. Go to `/explore` → "Event Discovery" or check the homepage event feed
3. You should see newly announced events with dates and on-sale information

---

## File Changes Summary

| File | Change |
|------|--------|
| `src/db.js` | Added functions: `getOrCreateVenueDiscoveryState`, `updateDiscoveryStateVenueId`, `advanceDiscoveryWatermark`, `upsertTicketmasterEventByID` |
| `src/scrapers/ticketmaster.js` | Added functions: `resolveVenueToTicketmasterId`, `searchEventsByVenueIdSince` |
| `src/discovery.js` | Complete rewrite: watermark-driven flow instead of snapshot diffing |
| `SCHEMA_MIGRATION.sql` | Database schema changes (new table, new columns, indexes) |

---

## Troubleshooting

### Issue: "Could not resolve venue to Ticketmaster ID"

**Cause:** Ticketmaster doesn't have that venue listed.

**Fix:**
1. Verify venue name matches Ticketmaster spelling (e.g., "Madison Square Garden" not "MSG")
2. Check Ticketmaster directly: https://www.ticketmaster.com/discover/
3. Use a different venue name
4. Or add the venue manually via Supabase → Update `venue_discovery_state.ticketmaster_venue_id` directly

### Issue: "Found 0 events" on every run

**Cause:** No events have been announced at that venue since the watermark.

**Fix:**
1. Check if venue is popular (Ticketmaster has events for it)
2. Manually reset watermark to older date:
   ```sql
   UPDATE venue_discovery_state
   SET last_polled_at = NOW() - INTERVAL '7 days'
   WHERE venue_id = 'your_venue_id';
   ```

### Issue: Frontend still shows no events

**Cause:** API endpoint not wired up or discovery hasn't run yet.

**Fix:**
1. Verify discovery has run: check `ticketmaster_events` table has rows
2. Check frontend is fetching from `/api/ticketmaster-events` or similar endpoint
3. Verify API endpoint exists in `parking-api`

---

## Monitoring & Maintenance

### Daily Monitoring

Run discovery daily (automated via cron or GitHub Actions):

```bash
# Manual run
cd C:\Users\jenni\Downloads\parking-arbitrage && node src/discovery.js

# Or schedule via cron (Linux/Mac) or Task Scheduler (Windows)
```

### Weekly Audit

Check for stale watermarks:

```sql
SELECT 
  v.name,
  ds.last_polled_at,
  NOW() - ds.last_polled_at as time_since_last_poll,
  COUNT(te.id) as total_events
FROM venues v
LEFT JOIN venue_discovery_state ds ON v.id = ds.venue_id
LEFT JOIN ticketmaster_events te ON v.id = te.venue_id
GROUP BY v.id, v.name, ds.last_polled_at
ORDER BY ds.last_polled_at ASC;
```

If `time_since_last_poll` > 7 days for any venue, something's wrong.

### Backfill Historical Events (Optional)

If you want to load more historical events (beyond 3 months), manually update the watermark:

```sql
UPDATE venue_discovery_state
SET last_polled_at = '2025-01-01'::timestamp with time zone
WHERE venue_id = 'your_venue_id';
```

Then run `node src/discovery.js` to fetch events from Jan 1 onwards.

---

## Next: Frontend Copy Update

The `/learn/event-discovery` page needs to be updated to reflect the corrected flow. Use the copy in `DISCOVERY_COPY.md` to replace the current page text.

Frontend file: `app/learn/event-discovery/page.tsx`

Update the "How It Works" and "Discovery Workflow" sections with content from `DISCOVERY_COPY.md`.

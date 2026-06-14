# Ticketmaster Event Discovery — Corrected Backend Spec

## Problem Statement

Current flow diffs full event snapshots against database state, treating "not in my database" as "newly announced." This causes:
- **First run of new venue:** dumped with 6–12 months of backlog
- **Keyword search noise:** "Radio City" returns 200 events including tour dates already in system
- **Lost recency signal:** can't distinguish "just announced" from "events you haven't recorded yet"
- **Result:** UI shows 0 events because discovery fires on ancient data or nothing at all

## Solution: Watermark-Driven Incremental Polling

Use Ticketmaster's built-in timestamp filters to request only what became publicly visible *since last poll*.

---

## Database Schema Changes

### Add `venue_discovery_state` table

Tracks polling watermark per venue.

```sql
CREATE TABLE venue_discovery_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id UUID NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  ticketmaster_venue_id TEXT, -- Resolved once and cached
  last_polled_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(venue_id)
);
```

### Update `ticketmaster_events` table

Add timestamps for better tracking.

```sql
ALTER TABLE ticketmaster_events
ADD COLUMN IF NOT EXISTS public_visibility_start TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS onsale_start TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
ADD COLUMN IF NOT EXISTS ticketmaster_id TEXT UNIQUE;
```

---

## API Query Strategy

### Phase 1: Resolve Venue → Ticketmaster `venueId` (One-Time)

**Endpoint:** `GET https://app.ticketmaster.com/discovery/v2/venues.json`

**Query:**
```
?keyword={venue_name}
&apikey={TICKETMASTER_API_KEY}
&size=10
```

**Extract:** The top result's `id` field is the Ticketmaster `venueId`.

**Store:** In `venue_discovery_state.ticketmaster_venue_id` for future queries.

**Why:** Keyword→venueId resolves *once*. Future queries use the ID directly, no keyword ambiguity.

---

### Phase 2: Poll for New Events (Per Venue, Per Run)

**Endpoint:** `GET https://app.ticketmaster.com/discovery/v2/events.json`

**Query Parameters:**
```
venueId={ticketmaster_venue_id}
&apikey={TICKETMASTER_API_KEY}
&publicVisibilityStartDateTime={last_polled_at}Z
&onsaleStartDateTime={today}T00:00:00Z  (or omit to include presales)
&size=200
&sort=onSaleStartDate,asc
```

**Explanation:**
- `publicVisibilityStartDateTime={last_polled_at}` — returns *only* events whose listing became public at or after this instant. First run: use a reasonable historical window (e.g., 3 months ago) to avoid 1+ year of backlog. Subsequent runs: use `last_polled_at` from DB.
- `onsaleStartDateTime={today}` — optional filter for tickets going on sale from today forward.
- `sort=onSaleStartDate,asc` — soonest on-sales first.

**Response Structure:**
```json
{
  "_embedded": {
    "events": [
      {
        "id": "12345",
        "name": "Concert: The Weeknd",
        "url": "https://...",
        "dates": {
          "start": {
            "dateTime": "2026-08-15T20:00:00Z",
            "localDate": "2026-08-15"
          }
        },
        "sales": {
          "public": {
            "startDateTime": "2026-07-20T10:00:00Z"
          },
          "presales": [
            {
              "startDateTime": "2026-07-15T10:00:00Z",
              "name": "Verified Fan Presale"
            }
          ]
        },
        "_embedded": {
          "venues": [
            {
              "id": "venue_id_from_api",
              "name": "Madison Square Garden"
            }
          ]
        }
      }
    ]
  }
}
```

---

## Processing Logic

### For Each Venue:

1. **Fetch state:**
   ```ts
   const state = await db
     .from('venue_discovery_state')
     .select('*')
     .eq('venue_id', venue.id)
     .single();
   ```
   - If not found: create with `last_polled_at = now() - 3 months` (backlog window)
   - If found but no `ticketmaster_venue_id`: resolve it (Phase 1 query above)

2. **Query Ticketmaster:**
   ```ts
   const events = await fetch(
     `${BASE_URL}/events.json?venueId=${state.ticketmaster_venue_id}` +
     `&publicVisibilityStartDateTime=${state.last_polled_at.toISOString()}` +
     `&apikey=${API_KEY}&size=200&sort=onSaleStartDate,asc`
   );
   ```

3. **Extract & Normalize:**
   ```ts
   const normalized = events._embedded.events.map(e => ({
     ticketmaster_id: e.id,
     name: e.name,
     event_date: e.dates.start.dateTime || e.dates.start.localDate,
     public_visibility_start: e.sales.public.startDateTime,
     onsale_start: e.sales.public.startDateTime, // or presale if earlier
     onsale_end: e.sales.public.endDateTime || null,
     url: e.url,
     venue_id: venue.id,
     ticketmaster_venue_id: e._embedded.venues[0].id,
   }));
   ```

4. **Upsert (by `ticketmaster_id`):**
   ```ts
   for (const event of normalized) {
     const { data, error } = await db
       .from('ticketmaster_events')
       .upsert(
         {
           ticketmaster_id: event.ticketmaster_id,
           name: event.name,
           event_date: event.event_date,
           public_visibility_start: event.public_visibility_start,
           onsale_start: event.onsale_start,
           onsale_end: event.onsale_end,
           url: event.url,
           venue_id: event.venue_id,
           first_seen_at: new Date(),
         },
         { onConflict: 'ticketmaster_id' }
       );
   }
   ```
   - "Upsert by `ticketmaster_id`" means: if event already exists, update timestamps; if new, insert.
   - This prevents duplicates across runs.

5. **Alert on New Events:**
   - Return only events where `first_seen_at` was set in this run (insertion, not update).
   - Log: `"+ {name} (event date: {event_date}, tickets on sale: {onsale_start})"`

6. **Advance Watermark:**
   ```ts
   await db
     .from('venue_discovery_state')
     .update({ last_polled_at: new Date() })
     .eq('venue_id', venue.id);
   ```

---

## Example Flow for New Venue

**Venue:** "Madison Square Garden" (never polled before)

**Run 1:**
- State not found → create with `last_polled_at = now() - 3 months`
- Query: `publicVisibilityStartDateTime=2026-03-07T...` (3 months ago)
- Returns: 150 events from March–June that *became publicly visible* in that window
- Upsert all 150 into DB
- Alert on all 150 as "newly discovered" (not "newly announced")
- Update watermark to now

**Run 2 (24 hours later):**
- State found, has watermark
- Query: `publicVisibilityStartDateTime={yesterday}T...` 
- Returns: only events that became public *in the last 24 hours*
- Upsert (update timestamps if already in DB)
- Alert only on genuinely new announcements
- Update watermark

---

## Key Improvements

| Issue | Before | After |
|-------|--------|-------|
| **First run** | Dumps year of backlog | Controllable 3-month window |
| **Subsequent runs** | "New to DB" noise | Only genuinely announced events |
| **Duplicates** | Recreated per run | Deduplicated by Ticketmaster ID |
| **On-sale timing** | Lost | Captured in `onsale_start` |
| **Recency signal** | None | `public_visibility_start` timestamp |

---

## Implementation Checklist

- [ ] Add `venue_discovery_state` table
- [ ] Add timestamp columns to `ticketmaster_events`
- [ ] Implement Phase 1: venue ID resolution (one-time per venue)
- [ ] Update `discovery.js` to use watermark-based queries
- [ ] Update upsert logic to match by `ticketmaster_id`
- [ ] Test with 1–2 venues, verify:
  - [ ] First run captures ~3 months of events
  - [ ] Second run captures only events announced in last 24h
  - [ ] No duplicates on re-run
- [ ] Update frontend copy (see `DISCOVERY_COPY.md`)

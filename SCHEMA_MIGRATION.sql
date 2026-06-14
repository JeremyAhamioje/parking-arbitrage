-- Schema migration for watermark-driven event discovery
-- Run this in your Supabase database

-- 1. Create venue_discovery_state table (tracks polling watermark per venue)
CREATE TABLE IF NOT EXISTS venue_discovery_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id UUID NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  ticketmaster_venue_id TEXT,
  last_polled_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(venue_id)
);

-- 2. Add Ticketmaster-specific columns to events table (if not already present)
ALTER TABLE events
ADD COLUMN IF NOT EXISTS ticketmaster_id TEXT UNIQUE,
ADD COLUMN IF NOT EXISTS public_visibility_start TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS onsale_start TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS onsale_end TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();

-- 3. Create index on ticketmaster_id for faster upserts
CREATE INDEX IF NOT EXISTS events_ticketmaster_id_idx
ON events(ticketmaster_id);

-- 4. Create index on venue_id for discovery queries
CREATE INDEX IF NOT EXISTS venue_discovery_state_venue_id_idx
ON venue_discovery_state(venue_id);

-- Verify migration success
SELECT 'venue_discovery_state' as table_name, COUNT(*) as row_count
FROM venue_discovery_state
UNION ALL
SELECT 'events (with new columns)', COUNT(*)
FROM events;

-- MVP #3: Change Detection Engine
-- Creates parking_snapshots and venue_signals tables

-- Historical parking snapshots (one row per venue/lot per scraper run)
CREATE TABLE IF NOT EXISTS parking_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_name TEXT NOT NULL,
  lot_address TEXT NOT NULL,
  price NUMERIC NOT NULL,
  spaces INTEGER NOT NULL,
  scraped_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create index for quick lookups of latest snapshot per venue/lot
CREATE INDEX IF NOT EXISTS idx_parking_snapshots_venue_lot_time
  ON parking_snapshots(venue_name, lot_address, scraped_at DESC);

-- Venue signals: tags for anomalous price/space changes
CREATE TABLE IF NOT EXISTS venue_signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_name TEXT NOT NULL,
  lot_address TEXT NOT NULL,
  signal_type TEXT NOT NULL, -- 'PRICE_SPIKE', 'INVENTORY_DROP', 'HIGH_PROFILE'
  price_before NUMERIC NOT NULL,
  price_after NUMERIC NOT NULL,
  price_change_pct NUMERIC NOT NULL,
  spaces_before INTEGER NOT NULL,
  spaces_after INTEGER NOT NULL,
  spaces_change_pct NUMERIC NOT NULL,
  tagged_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  resolved BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create index for finding unresolved signals
CREATE INDEX IF NOT EXISTS idx_venue_signals_unresolved
  ON venue_signals(resolved, tagged_at DESC);

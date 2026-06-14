-- Add a `source` dimension so SpotHero / Way.com / ParkWhiz data can be
-- filtered separately while still living in the same tables.
--
-- Run in the Supabase SQL editor BEFORE deploying the source-aware scraper +
-- API changes. Existing rows default to 'spothero' (all current data is SpotHero).
--
--   source values: 'spothero' | 'way' | 'parkwhiz'

ALTER TABLE snapshots      ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'spothero';
ALTER TABLE facility_stats ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'spothero';

CREATE INDEX IF NOT EXISTS idx_snapshots_source      ON snapshots(source);
CREATE INDEX IF NOT EXISTS idx_facility_stats_source ON facility_stats(source);

-- facility_stats is keyed per (venue, facility). With a source dimension the
-- same facility can now hold one summary row per source, so the upsert conflict
-- target must include source. Recreate the uniqueness constraint accordingly.
ALTER TABLE facility_stats DROP CONSTRAINT IF EXISTS facility_stats_venue_id_facility_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS facility_stats_venue_facility_source_key
  ON facility_stats(venue_id, facility_id, source);

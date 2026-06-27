-- Deep-link support for the z-score change-detection pass.
-- The baseline alert generator (src/change-detection.js) reads facility_stats, not
-- snapshots, so the booking_url added to snapshots never reached its alerts. Mirror
-- the column here so each facility's exact-lot URL (Way) / venue page (ParkWhiz)
-- rides along on its rolling-stats row and the "vs N-run norm" alerts can deep-link.
-- SpotHero has no per-lot URL, so this stays NULL for it. Nullable, no default →
-- instant metadata-only change, safe to run on the live table.
ALTER TABLE facility_stats ADD COLUMN IF NOT EXISTS booking_url text;

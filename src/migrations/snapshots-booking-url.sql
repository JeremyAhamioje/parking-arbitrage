-- Deep-link support: store the source-platform listing URL alongside each snapshot.
-- ParkWhiz's scraper already returns a real per-lot URL (site_url/external_url);
-- this column persists it so alerts can link straight to the exact lot to buy.
-- SpotHero/Way don't expose a per-lot URL, so this stays NULL for them and the
-- UI falls back to the event page. Nullable, no default → instant metadata-only
-- change, safe to run on the live table.
ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS booking_url text;

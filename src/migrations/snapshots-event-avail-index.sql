-- Index for the sold-out / inventory-depletion watch (src/inventory-watch.js).
--
-- The detector diffs event-tagged snapshots for one platform across consecutive
-- runs, filtering by (source, scraped_at) over rows where event_id IS NOT NULL.
-- snapshots is large and growing (200k+ rows); without this index those filtered
-- range scans seq-scan the whole table and hit the statement timeout at SpotHero's
-- volume. This partial index covers exactly the detector's predicate.
--
-- Run ONCE in the Supabase SQL editor. CONCURRENTLY avoids locking the table
-- while the scrapers are writing (must be run as its own statement, not in a tx).

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_snapshots_event_avail
  ON snapshots (source, scraped_at DESC)
  WHERE event_id IS NOT NULL;

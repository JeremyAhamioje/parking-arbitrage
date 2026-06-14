-- ============================================================
-- facility_stats — current-state summary layer for the price-trends table
--
-- One row per (venue_id, facility_id). Updated on every scraper run by
-- upsertFacilityStats() in db.js. The UI reads ONLY this table for the
-- price-trends table view — it never loops over raw snapshots.
--
-- snapshots stays the append-only audit log / source of truth.
-- facility_stats is the cheap, fixed-size (~750 rows) read layer that
-- also feeds the volatility signals for the downstream LLM buy/wait model.
--
-- Run in Supabase SQL editor.
-- ============================================================

create table if not exists facility_stats (
  venue_id          uuid not null references venues(id) on delete cascade,
  facility_id       text not null,
  facility_name     text,
  address           text,
  walking_meters    integer,

  -- latest vs previous (computed at write time, no query-time math)
  latest_price      numeric(8,2),
  prev_price        numeric(8,2),
  price_delta       numeric(8,2),   -- latest_price - prev_price
  price_delta_pct   numeric(8,2),   -- percent change vs prev

  latest_spaces     integer,
  prev_spaces       integer,
  spaces_delta      integer,

  -- rolling-window aggregates (over price_history)
  min_price         numeric(8,2),
  max_price         numeric(8,2),
  avg_price         numeric(8,2),
  volatility        numeric(8,4),   -- (max-min)/avg over the window — the LLM signal

  trend             text,           -- 'up' | 'down' | 'flat'
  price_history     jsonb,          -- rolling last N prices (oldest → newest) for sparkline

  scrape_count      integer not null default 0,
  first_scraped_at  timestamptz,
  last_scraped_at   timestamptz,

  primary key (venue_id, facility_id)
);

create index if not exists idx_facility_stats_venue on facility_stats(venue_id);
create index if not exists idx_facility_stats_volatility on facility_stats(volatility desc);

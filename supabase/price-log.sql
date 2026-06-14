-- ============================================================
-- Delta-log architecture: timestamped price-change history
--
-- scrape_runs        — one row per execution of the scraper
-- facility_price_log — one row per facility per run: the price/spaces
--                      observed in that run AND the delta vs the previous run.
--
-- This is the HISTORY layer. facility_stats stays the CURRENT-STATE layer.
-- snapshots stays the raw audit log.
--
-- Read path for the LLM and the drill-down view:
--   "give me the full run-by-run price trajectory for this one lot"
--   = select * from facility_price_log
--       where venue_id=? and facility_id=? order by scraped_at desc
--
-- Run in Supabase SQL editor.
-- ============================================================

create table if not exists scrape_runs (
  id            uuid primary key default gen_random_uuid(),
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  venue_count   integer,
  listing_count integer
);

create table if not exists facility_price_log (
  id              uuid primary key default gen_random_uuid(),
  run_id          uuid references scrape_runs(id) on delete set null,
  scraped_at      timestamptz not null default now(),
  venue_id        uuid not null references venues(id) on delete cascade,
  facility_id     text not null,
  facility_name   text,
  -- the observation in THIS run
  price           numeric(8,2),
  spaces          integer,
  -- the delta vs the SAME facility's previous run
  prev_price      numeric(8,2),
  price_delta     numeric(8,2),
  price_delta_pct numeric(8,2),
  prev_spaces     integer,
  spaces_delta    integer,
  -- context: null = generic scrape, set = event-specific scrape
  event_id        uuid references events(id) on delete set null
);

-- Per-facility time-series read (the drill-down + LLM input)
create index if not exists idx_fpl_venue_facility_time
  on facility_price_log(venue_id, facility_id, scraped_at desc);

-- "everything that happened in run N"
create index if not exists idx_fpl_run on facility_price_log(run_id);

-- Privileges (raw-SQL tables don't always inherit Supabase defaults)
grant select, insert, update, delete on public.scrape_runs to service_role;
grant select, insert, update, delete on public.facility_price_log to service_role;
grant select on public.scrape_runs to anon, authenticated;
grant select on public.facility_price_log to anon, authenticated;

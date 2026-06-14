-- ============================================================
-- Parking Arbitrage Platform — Supabase Schema
-- Run this in your Supabase SQL editor (project > SQL editor > New query)
-- ============================================================

-- 1. Venues — the 50 event venues we monitor
create table if not exists venues (
  id                      uuid primary key default gen_random_uuid(),
  name                    text not null unique,
  lat                     double precision not null,
  lon                     double precision not null,
  spothero_destination_id integer,          -- fill in once we map venue → SpotHero ID
  created_at              timestamptz not null default now()
);

-- 2. Snapshots — every price/availability reading per facility per venue
--    One row = one facility observed near one venue at one point in time.
--    Denormalized on purpose so queries don't need joins.
create table if not exists snapshots (
  id                uuid primary key default gen_random_uuid(),
  venue_id          uuid not null references venues(id) on delete cascade,
  scraped_at        timestamptz not null default now(),
  -- facility identity
  facility_id       text not null,   -- SpotHero's internal facility ID
  facility_name     text not null,
  address           text,
  city              text,
  state             text,
  facility_type     text,
  amenities         text,
  walking_meters    integer,
  -- price
  advertised_price  numeric(8,2) not null,
  service_fee       numeric(8,2) not null,
  total_price       numeric(8,2) not null,
  -- availability
  available_spaces  integer,
  is_available      boolean not null default true,
  -- event context (null = generic scrape, set = event-specific scrape)
  event_id          uuid references events(id) on delete set null
);

-- Index for change detection queries (latest snapshot per facility per venue)
create index if not exists idx_snapshots_venue_facility_time
  on snapshots(venue_id, facility_id, scraped_at desc);

-- 3. Events — upcoming events at each venue (discovered by scraper)
create table if not exists events (
  id            uuid primary key default gen_random_uuid(),
  venue_id      uuid not null references venues(id) on delete cascade,
  event_name    text not null,
  event_date    date,
  starts_at     timestamptz,
  ends_at       timestamptz,
  source_url    text,
  discovered_at timestamptz not null default now(),
  unique(venue_id, event_name, starts_at)  -- prevent duplicate event rows
);

-- 4. Alerts — generated when something interesting happens
--    Dashboard subscribes to this table via Supabase Realtime.
create type alert_type as enum (
  'price_spike',
  'availability_drop',
  'new_event',
  'price_drop'
);

create table if not exists alerts (
  id          uuid primary key default gen_random_uuid(),
  type        alert_type not null,
  venue_id    uuid references venues(id) on delete cascade,
  facility_id text,          -- which parking spot triggered this (nullable for event alerts)
  message     text not null,
  metadata    jsonb,         -- e.g. { prev_price: 25, new_price: 45, delta: 20 }
  is_read     boolean not null default false,
  created_at  timestamptz not null default now()
);

-- Index so the dashboard can efficiently load unread alerts
create index if not exists idx_alerts_unread on alerts(is_read, created_at desc);

-- ============================================================
-- Useful views
-- ============================================================

-- Latest snapshot per facility per venue (for the dashboard "current state" view)
create or replace view latest_snapshots as
select distinct on (venue_id, facility_id)
  s.*,
  v.name as venue_name
from snapshots s
join venues v on v.id = s.venue_id
order by venue_id, facility_id, scraped_at desc;

-- Price change view: compare latest vs previous snapshot
-- Returns rows where total_price changed by more than $1
create or replace view price_changes as
with ranked as (
  select
    *,
    lag(total_price) over (partition by venue_id, facility_id order by scraped_at) as prev_price,
    lag(scraped_at)  over (partition by venue_id, facility_id order by scraped_at) as prev_scraped_at
  from snapshots
)
select
  r.*,
  v.name as venue_name,
  round(r.total_price - r.prev_price, 2) as price_delta
from ranked r
join venues v on v.id = r.venue_id
where r.prev_price is not null
  and abs(r.total_price - r.prev_price) > 1
order by r.scraped_at desc;

-- ============================================================
-- Enable Realtime on alerts table
-- (Supabase Realtime lets the Next.js dashboard get push updates)
-- ============================================================
alter publication supabase_realtime add table alerts;

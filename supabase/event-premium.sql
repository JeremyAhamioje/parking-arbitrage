-- ============================================================
-- event_premium_pct — how much pricier a lot is during events vs normal days
--
-- Adds two running averages to facility_stats:
--   generic_avg_price (event_id IS NULL scrapes) — the baseline
--   event_avg_price   (event_id IS NOT NULL scrapes) — event-day price
-- plus the counts needed to update those averages incrementally, and the
-- derived premium:
--   event_premium_pct = (event_avg_price - generic_avg_price)/generic_avg_price * 100
--
-- This is the cleanest single "buy signal" input for the LLM: it turns
-- "this lot is volatile" into "this lot predictably goes from $20 to $40
-- around events (+100%)".
--
-- Run in Supabase SQL editor.
-- ============================================================

alter table facility_stats add column if not exists generic_avg_price  numeric(8,2);
alter table facility_stats add column if not exists generic_count      integer not null default 0;
alter table facility_stats add column if not exists event_avg_price    numeric(8,2);
alter table facility_stats add column if not exists event_count        integer not null default 0;
alter table facility_stats add column if not exists event_premium_pct  numeric(8,2);

create index if not exists idx_facility_stats_premium
  on facility_stats(event_premium_pct desc nulls last);

-- ============================================================
-- event_sentiment — cached LLM (Gemini) arbitrage read for each event
--
-- The /api/event-stats endpoint already turns raw snapshots into precise,
-- numeric per-event signals (premium, cross-lot spread, temporal volatility,
-- inventory drawdown, ROI). This table caches Gemini's interpretation of those
-- signals so we don't re-call the model on every page view.
--
-- Cache key = (event_id). input_hash is a fingerprint of the SIGNAL VALUES the
-- model was given. When a new scrape changes the numbers, the hash changes and
-- the next request re-generates; otherwise we serve the cached read for free.
--
-- One row per event. Source is 'spothero' for now (the only platform we can
-- reliably scrape) — kept as a column so ParkWhiz/Way rows can join later.
--
-- Run in Supabase SQL editor.
-- ============================================================

create table if not exists event_sentiment (
  event_id          uuid primary key references events(id) on delete cascade,
  venue_id          uuid references venues(id) on delete set null,
  source            text not null default 'spothero',

  input_hash        text not null,          -- fingerprint of the signals fed to the model

  -- model output
  sentiment         text,                   -- 'Bullish' | 'Neutral' | 'Bearish'
  confidence        numeric(4,3),           -- 0.000–1.000
  headline          text,                   -- one-line analyst takeaway
  narrative         text,                   -- 2–4 sentence grounded explanation
  recommended_play  text,                   -- the concrete arbitrage action
  key_drivers       jsonb,                  -- string[] of the signals that drove the call
  risk_caveats      jsonb,                  -- string[] of what could invalidate it

  -- provenance / the exact signals the model saw (for audit + UI)
  signals           jsonb,
  roi_label         text,
  premium_pct       numeric(8,2),
  volatility        numeric(8,4),
  spread_pct        numeric(8,2),

  model_id          text,
  generated_at      timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists idx_event_sentiment_venue on event_sentiment(venue_id);
create index if not exists idx_event_sentiment_sentiment on event_sentiment(sentiment);
create index if not exists idx_event_sentiment_generated on event_sentiment(generated_at desc);

-- ============================================================
-- Grants — REQUIRED. The API caches sentiment with the service_role key.
-- "permission denied for table event_sentiment" (Postgres 42501) means the
-- service_role lacks table privileges here (the CREATE didn't grant them).
-- service_role bypasses RLS, so these grants are the actual fix. Safe to re-run.
-- ============================================================
grant all on table event_sentiment to service_role;
grant select on table event_sentiment to anon, authenticated;

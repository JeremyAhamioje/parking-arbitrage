# Parking Arbitrage

Real-time parking price intelligence across SpotHero, ParkWhiz, and Way.com. Scraper writes to Supabase; API serves the data; UI displays it.

## Repos / folders

| Folder | What it is |
|--------|-----------|
| `parking-arbitrage/` | Scrapers + DB writes (this repo) |
| `parking-arbitrage-ui/` | Next.js dashboard |
| `parking-api/` | Express API (Supabase → UI) |

---

## Running locally

### 1. Frontend (Next.js UI)
```bash
cd ../parking-arbitrage-ui
npm install
npm run dev
# → http://localhost:3000
```

### 2. API server (read-only Supabase analytics)
```bash
cd ../parking-api
npm install
npm run dev          # nodemon, auto-restarts on save
# or: node src/server.js
# → http://localhost:3001
```

### 2b. Live engine (on-demand scraping + sheet pipeline)
Powers the three action tools (Live Event Fetch, Date Inventory, Sheet Normalizer).
Separate from the API above — this one drives Playwright live.
```bash
cd ../parking-arbitrage
npm run engine
# → http://localhost:4000   (set ENGINE_PORT to change)
```
Endpoints: `POST /api/live/event`, `POST /api/live/date`, `POST /api/pipeline/preview`,
`POST /api/pipeline/process`, `POST /api/export/xlsx`, `GET /health`.
Add `GEMINI_API_KEY` to `parking-arbitrage/.env` to enable LLM row-matching in the
pipeline (without it, matching falls back to the local fuzzy matcher).

### 3. Scraper — SpotHero batch (50 venues)
```bash
cd ../parking-arbitrage
npm install
npx playwright install chromium
node src/index.js
```

### 4. Scraper — Way.com batch (50 venues)
```bash
cd ../parking-arbitrage
npm run scrape:way
# WAY_HEADFUL=1 npm run scrape:way   ← if Cloudflare blocks headless
```

Cloudflare needs a **US residential** IP. Because cf_clearance is bound to one IP,
use a **sticky session** so it survives the whole run (a rotating gateway changes
IP per request and re-challenges mid-batch). Opt in:
```powershell
$env:WAY_PROXY_STICKY="1"; npm run scrape:way
# If your provider isn't Webshare/Smartproxy, set the username format:
# $env:WAY_PROXY_SESSION_FORMAT="{user}-{session}"
```
If CF still re-challenges mid-run, the batch auto-reboots the browser (max 2x) on a
fresh sticky IP and retries the venue — the run summary reports `cf_blocked` / `reboots`.

Single venue (PowerShell):
```powershell
$env:VENUE="Yankee Stadium"; npm run scrape:way
```

### 5. Scraper — ParkWhiz batch (50 venues)
```bash
cd ../parking-arbitrage
npm run scrape:parkwhiz
```
ParkWhiz has **no Cloudflare** — only an AWS-ELB WAF that 403s non-US IPs. A **US
datacenter proxy is enough** (no residential, no headed browser). Set
`PARKWHIZ_PROXY_URLS` (comma-separated, rotated per venue). PowerShell single venue:
```powershell
$env:VENUE="Yankee Stadium"; npm run scrape:parkwhiz
```

### 6. Scraper — single venue quick check
```bash
npm run check:way "Madison Square Garden"
npm run check:parkwhiz "Yankee Stadium"
```

---

## Environment variables

Copy `.env.example` to `.env` in each folder that needs one.

### `parking-arbitrage/.env`
```
SUPABASE_URL=
SUPABASE_SERVICE_KEY=
GOOGLE_SERVICE_ACCOUNT_EMAIL=
GOOGLE_PRIVATE_KEY=
GOOGLE_SHEET_ID=
WAY_PROXY_URL=http://user:pass@host:port   # US residential proxy — required for Way.com
RESIDENTIAL_PROXY_URL=                     # fallback alias
WAY_PROXY_STICKY=                          # 1 = pin one exit IP per run (keeps cf_clearance)
WAY_PROXY_SESSION_FORMAT=                  # username template, default {user}-session-{session}
PARKWHIZ_PROXY_URLS=http://u:p@ip:port,... # US datacenter proxies, rotated per venue (ParkWhiz)
PARKWHIZ_TZ_OFFSET=-04:00                  # search-window timezone (default EDT)
TICKETMASTER_API_KEY=
GEMINI_API_KEY=
```

### `parking-api/.env`
```
SUPABASE_URL=
SUPABASE_SERVICE_KEY=
PORT=3001
```

### `parking-arbitrage-ui/.env.local`
```
NEXT_PUBLIC_API_URL=http://localhost:3001     # read-only analytics API
NEXT_PUBLIC_ENGINE_URL=http://localhost:4000  # live engine (event/date fetch + sheet pipeline)
```

---

## Scrapers

### SpotHero (`src/index.js`)
- Reads venue list from Google Sheet column A (A2:A51)
- Discovers SpotHero `destination_id` per venue via catalog match
- Scrapes parking listings per upcoming event
- Writes → `snapshots`, `facility_stats`, `facility_price_log`, `alerts`

### Way.com (`src/scrape-way.js`)
- Same venue list from Google Sheet
- Boots one Playwright browser (CF residential proxy bypass, once per run)
- Calls `/way-search/v1/public/city-parking/search` per venue
- Writes to same Supabase tables

### ParkWhiz (`src/scrape-parkwhiz.js`)
- Same venue list from Google Sheet
- No Cloudflare — only an AWS-ELB WAF that 403s non-US IPs; a US datacenter proxy clears it
- Launches a short-lived browser per venue, rotating `PARKWHIZ_PROXY_URLS` per call
- Reads listings from ParkWhiz's `__INITIAL_STATE__` (SSR), writes to same Supabase tables with `source='parkwhiz'`

---

## Database (Supabase)

Key tables: `venues`, `events`, `snapshots`, `facility_stats`, `facility_price_log`, `alerts`, `scrape_runs`

---

## Deployment

- **UI** → Vercel (`parking-arbitrage-ui/`)
- **API** → Render (`parking-api/`, `npm start`)
- **Live engine** → Render web service (`parking-arbitrage/`, `npm run engine`)
- **Scraper** → Render cron job (`npm run scrape:way` / `node src/index.js`)
  - Way.com needs `xvfb` on the server: `xvfb-run --auto-servernum -- npm run scrape:way`
  - Install browsers in the build step: `npx playwright install --with-deps chromium`

---

## Scaling & costs

Two metered third-party resources gate scale: **Gemini** (sheet matching + sentiment) and the **Webshare residential proxy** (Way only). Neither is expensive — the free tiers are just small.

### Gemini (LLM matching + sentiment)
- The free tier is a **rate/daily cap**, not a price wall. `gemini-2.5-flash` is fractions of a cent per row (~300–500 tokens). To lift the cap, **enable billing** on the Google Cloud project (`GOOGLE_CLOUD_PROJECT_ID`).
- **Two built-in cost controls:**
  1. **Deterministic gate** (`engine/gemini.js`) — the Sheet Normalizer only calls Gemini for *ambiguous* rows. A clear match (venue + event both score high — common, since the scraped event name usually equals the sheet's) or a clear non-match (wrong venue) is decided locally for free. Typically cuts calls 60–80%. Disable with `GEMINI_GATE=0`.
  2. **Sentiment cache** (`event_sentiment` table) — Gemini's per-event read is cached by a hash of the underlying signals; it only re-generates when the numbers change. **Requires the table grants** in `supabase/event-sentiment.sql` (`grant all ... to service_role`), else writes fail with `permission denied for table event_sentiment` (computed but not cached → every view re-calls Gemini).
- Without a key (or on a Gemini error) the pipeline **falls back to local fuzzy matching** — degraded but never blocked.

### Proxies (Way = residential, ParkWhiz = datacenter)
- **Only Way uses the residential proxy** (the metered 1 GB tier). SpotHero uses no proxy; ParkWhiz uses datacenter (separate, larger allowance). So 2 of 3 platforms scale freely.
- **Built-in bandwidth savers** (`scrapers/_stealth.js`, `engine/way-pool.js`):
  - Image/media/font requests are **blocked** on every proxied context (~70–90% less bandwidth) — we read JSON/SSR, never render.
  - The live engine keeps a **warm Way browser** (boot once, reuse), so the way.com SPA + Cloudflare clear is paid once, not per fetch (`WAY_POOL_IDLE_MS`, default 10 min).
- If residential bandwidth runs out, **top it up** or only the Way leg fails (others unaffected). `WAY_PROXY_STICKY=1` keeps one exit IP so `cf_clearance` holds.

### Hosting the live engine (Render)
- A single Tool-1 fetch launches **up to 3 chromium instances in parallel** (~1 GB) — use a **1–2 GB instance**, not the 512 MB free tier.
- Outbound IP is a datacenter IP, so **SpotHero may also need a proxy in production** (it works from a clean home IP but can be rate-limited from a datacenter).
- The engine **single-flights** browser jobs, so concurrent requests don't multiply the browser count.

### Tunable env knobs
```
GEMINI_GATE=0                  # force Gemini on every row (default: gate on)
ENGINE_RETRIES=1               # transient-failure retries per platform
ENGINE_TIMEOUT_WAY=90000       # per-platform timeout ms (also _SPOTHERO / _PARKWHIZ)
WAY_POOL_IDLE_MS=600000        # close the warm Way browser after this idle window
WAY_PROXY_STICKY=1             # pin one residential exit IP per Way boot
```

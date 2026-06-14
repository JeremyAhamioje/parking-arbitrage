# Deployment — Vercel + Render

Three deployables, plus Supabase (already live) and the GitHub Actions cron scrapers:

| Piece | Host | What |
|---|---|---|
| `parking-arbitrage-ui` | **Vercel** | Next.js UI |
| `parking-api` | **Render** (Node web service) | read-only Supabase analytics API |
| `parking-arbitrage` | **Render** (Docker web service) | live engine (Tool 1/2/3, Playwright) |

---

## 0. FIRST — fix the git repos (blocker + security)

Right now there is **no `.git` inside these projects** — they inherit one repo rooted at `C:\Users\jenni` (your whole home folder) pointing at `jeremyai.git`. Never push that: it would publish `.ssh` keys, every `.env`, AppData, etc.

> If that home repo was **ever pushed**, treat all secrets as leaked and **rotate them** (Supabase service key, proxy passwords, Gemini key, Google private key, Ticketmaster key).

Give each project its **own** repo (`.gitignore`s already exclude `.env`, `node_modules`, build output, session files — verified). From Git Bash:

```bash
# run once per project folder
cd /c/Users/jenni/Downloads/parking-arbitrage-ui     # then repeat for the other two
git init -b main
git add .
git commit -m "Initial commit"
gh repo create parking-arbitrage-ui --private --source=. --push   # needs the gh CLI, logged in
# no gh? create the empty repo on github.com, then:
#   git remote add origin https://github.com/<you>/parking-arbitrage-ui.git
#   git push -u origin main
```

Repeat for `parking-api` and `parking-arbitrage`. You end with **3 repos**. (`git init` inside each folder creates a nested repo that git uses instead of the home one — the home repo is left alone.)

Public vs private: **private** is safer, but GitHub Actions only gives ~2000 free min/mo on private repos (the cron scrapers eat that). Public = unlimited Actions. Pick per your comfort; if private + minutes get tight, move the scrapers to Render Cron.

---

## 1. Supabase (run once)

In the SQL editor, run any migrations you haven't yet:
- `migrations/add_source_column.sql` (per-source data)
- `supabase/event-sentiment.sql` (incl. the new `grant ... to service_role` — fixes `permission denied for table event_sentiment`)

---

## 2. Render — analytics API (`parking-api`)

New **Web Service** → connect the `parking-api` repo.
- Environment: **Node**
- Build command: `npm install`
- Start command: `npm start`
- Instance: Free works (cold-starts after idle) or Starter to stay warm.
- **Environment variables:**
  ```
  SUPABASE_URL            = <your supabase url>
  SUPABASE_SERVICE_KEY    = <service_role key>
  GEMINI_API_KEY          = <your key>     # event sentiment
  GEMINI_MODEL_ID         = gemini-2.5-flash
  ```
  (Don't set PORT — Render injects it; the server already reads `process.env.PORT`.)

Note the URL, e.g. `https://parking-api.onrender.com`.

---

## 3. Render — live engine (`parking-arbitrage`, Docker)

New **Web Service** → connect the `parking-arbitrage` repo. Render auto-detects the **Dockerfile**.
- Environment: **Docker**
- Instance: **≥ 1 GB RAM** (a Tool-1 fetch launches up to 3 Chromium in parallel — the 512 MB free tier will OOM).
- **Environment variables:**
  ```
  GEMINI_API_KEY          = <your key>
  GEMINI_MODEL_ID         = gemini-2.5-flash
  WAY_PROXY_URL           = http://user:pass@p.webshare.io:80
  RESIDENTIAL_PROXY_URL   = http://user:pass@p.webshare.io:80
  WAY_PROXY_STICKY        = 1
  PARKWHIZ_PROXY_URLS     = http://user:pass@ip:port,http://user:pass@ip:port,...
  PARKWHIZ_TZ_OFFSET      = -04:00
  ```
  **Do NOT set `NODE_TLS_REJECT_UNAUTHORIZED=0`** — that was a local sandbox workaround; it disables TLS verification and must not ship.
  Optional gate/perf knobs: `GEMINI_GATE`, `ENGINE_RETRIES`, `ENGINE_TIMEOUT_WAY`, `WAY_POOL_IDLE_MS` (see README → Scaling & costs).

Note the URL, e.g. `https://parking-engine.onrender.com`. Check `GET /health` returns `"gemini": { "valid": true }`.

> Render's datacenter IP: **SpotHero uses no proxy**, so it may get rate-limited from Render. If live SpotHero comes back empty, route it through a proxy too (small code change — ask me).

---

## 4. Vercel — UI (`parking-arbitrage-ui`)

New project → import the `parking-arbitrage-ui` repo (Vercel auto-detects Next.js; root dir = repo root).
- **Environment variables:**
  ```
  NEXT_PUBLIC_API_URL     = https://parking-api.onrender.com
  NEXT_PUBLIC_ENGINE_URL  = https://parking-engine.onrender.com
  ```
- Deploy. (`NEXT_PUBLIC_*` are baked at build time — if you change them, redeploy.)

Images are external Cloudinary `<img>` tags, so no `next/image` remote config needed.

---

## 5. GitHub Actions cron scrapers (in the `parking-arbitrage` repo)

The three workflows (`.github/workflows/scrape-*.yml`) run only once pushed to the repo's default branch. Add the secrets in **repo → Settings → Secrets and variables → Actions**:
```
SUPABASE_URL  SUPABASE_SERVICE_KEY
GOOGLE_SERVICE_ACCOUNT_EMAIL  GOOGLE_PRIVATE_KEY  GOOGLE_SHEET_ID
TICKETMASTER_API_KEY  PARKWHIZ_PROXY_URLS  PARKWHIZ_TZ_OFFSET
WAY_PROXY_URL  RESIDENTIAL_PROXY_URL
```
Paste `GOOGLE_PRIVATE_KEY` exactly as in `.env` (with the `\n` escapes). Test each via **Actions → Run workflow** before trusting the cron. (SpotHero+ParkWhiz hourly, Way every 6h — bandwidth.)

---

## 6. Smoke test after deploy
1. `https://parking-engine.onrender.com/health` → `ok: true`, `gemini.valid: true`.
2. `https://parking-api.onrender.com/api/metrics` → JSON.
3. Open the Vercel URL → homepage loads; **SpotHero Data** shows venues; **Live Event Fetch** returns rows (Way will be the slow leg).
4. Trigger one cron workflow manually → check Supabase tables get new rows.

## Deploy order
Supabase migrations → Render API + Render engine (get their URLs) → set those URLs as Vercel env → deploy UI → add Actions secrets → test.

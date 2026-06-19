# Box-side cron: ParkWhiz + Way

ParkWhiz and Way scrape from the **box**, not GitHub Actions, because Actions'
datacenter runner IP can't reach their targets:

- **ParkWhiz** — its WAF `403`s GitHub's IP, so the Actions job wrote **0 rows ever**
  (it exited green anyway, masking it). The box's own US IP clears the WAF with **no
  proxy**.
- **Way** — its residential proxy refuses the runner IP
  (`net::ERR_TUNNEL_CONNECTION_FAILED`). From the box, the residential proxy works
  (the live engine uses it daily).

**SpotHero stays on GitHub Actions** (rotating runner IPs are an asset there).
The ParkWhiz/Way GitHub workflows are now **manual-only** (`workflow_dispatch`) so
they stop auto-failing.

## Install (one time, on the box)

```bash
cd /opt/parking-arbitrage
git pull
bash scripts/box-cron/install.sh
```

That registers the crontab (`crontab.txt`) and creates `/var/log/parking`.

## Schedule (UTC)

| Job      | Cron          | Notes                                  |
|----------|---------------|----------------------------------------|
| ParkWhiz | `0 */3 * * *` | every 3h, box US IP, no proxy          |
| Way      | `30 */6 * * *`| every 6h, residential proxy, offset 30m|

`flock -n` prevents overlapping runs. Each run appends to
`/var/log/parking/<platform>.log`.

## Prerequisites on the box

- The repo `.env` at `/opt/parking-arbitrage/.env` with `SUPABASE_URL`,
  `SUPABASE_SERVICE_KEY`, `GOOGLE_*`, and **Way's** `WAY_PROXY_URL` /
  `RESIDENTIAL_PROXY_URL`. (ParkWhiz is forced no-proxy by the wrapper, so its
  proxy vars don't matter.)
- `xvfb` installed (`sudo apt-get install -y xvfb`) — Way needs it.
- `flock` (from `util-linux`, present by default) and Node on `PATH`.

## Verify

```bash
# one-off single-venue smoke test
cd /opt/parking-arbitrage
VENUE=Yankee bash scripts/box-cron/scrape.sh parkwhiz
tail -n 40 /var/log/parking/parkwhiz.log     # expect "ok=1 ... listings written"

# tail live
tail -f /var/log/parking/parkwhiz.log
```

A healthy ParkWhiz run ends with `Done. ok=N no_listings=.. blocked=0`. If you see
`blocked=50`, the box IP is being WAF'd — check the box's outbound IP is US.

## Uninstall

```bash
crontab -l | sed '/# >>> parking-box-cron >>>/,/# <<< parking-box-cron <<</d' | crontab -
```

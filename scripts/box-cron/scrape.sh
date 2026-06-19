#!/usr/bin/env bash
#
# Box-side scraper runner for ParkWhiz + Way (prune optional).
#
# Why on the box and not GitHub Actions: ParkWhiz's WAF 403s GitHub's datacenter
# runner IP (0 rows ever written), and Way's residential proxy refuses the runner
# IP (net::ERR_TUNNEL_CONNECTION_FAILED). The box has the working network —
# ParkWhiz clears on the box's own US IP (NO proxy), Way clears Cloudflare via the
# residential proxy from the box. SpotHero stays on GitHub Actions.
#
# `flock -n` guarantees a slow run can't overlap the next cron tick. Output is
# appended per-platform under $PARKING_LOGDIR. The node scripts read the repo
# .env (the same config the live engine uses).
#
# Usage:  scrape.sh <parkwhiz|way|prune>
set -uo pipefail

REPO="${PARKING_REPO:-/opt/parking-arbitrage}"
LOGDIR="${PARKING_LOGDIR:-/var/log/parking}"

# Cron runs with a minimal PATH — make node / xvfb-run / flock discoverable,
# including an nvm-installed node if that's how the box has it.
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH:-}"
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true

p="${1:-}"
case "$p" in
  # ParkWhiz: force NO proxy so it uses the box's clean US IP. Empty env vars stop
  # dotenv from re-injecting a (dead) datacenter proxy from .env.
  parkwhiz) cmd=(env PARKWHIZ_PROXY_URLS= PARKWHIZ_PROXY_URL= PROXY_URL= node src/scrape-parkwhiz.js) ;;
  # Way: headed Chromium needs a virtual display for Cloudflare; residential proxy
  # comes from .env (WAY_PROXY_URL / RESIDENTIAL_PROXY_URL).
  way)      cmd=(xvfb-run -a --server-args="-screen 0 1366x768x24" node src/scrape-way.js) ;;
  prune)    cmd=(node src/prune.js) ;;
  *) echo "usage: $0 <parkwhiz|way|prune>" >&2; exit 2 ;;
esac

mkdir -p "$LOGDIR" 2>/dev/null || true
log="$LOGDIR/$p.log"

{
  echo "===== $(date -u +%FT%TZ) start $p ====="
  cd "$REPO" || { echo "repo not found: $REPO"; exit 1; }
  # -n: skip if a previous run still holds the lock. -E 99: distinct code for that
  # skip so it isn't mistaken for a scraper failure.
  flock -n -E 99 "/tmp/parking-$p.lock" "${cmd[@]}"
  rc=$?
  if [ "$rc" -eq 99 ]; then echo "(skipped: previous $p run still active)"; rc=0; fi
  echo "===== $(date -u +%FT%TZ) end $p (exit $rc) ====="
  exit "$rc"
} >> "$log" 2>&1

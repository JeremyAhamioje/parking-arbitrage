#!/usr/bin/env bash
#
# Run ONCE on the box to register the ParkWhiz + Way cron jobs. Idempotent —
# re-running replaces the parking block, leaving any other crontab entries alone.
#
#   cd /opt/parking-arbitrage && git pull && bash scripts/box-cron/install.sh
#
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

chmod +x "$DIR/scrape.sh"

# Log directory (owned by the cron user so flock/logging works without sudo).
if [ ! -d /var/log/parking ]; then
  sudo mkdir -p /var/log/parking && sudo chown "$USER" /var/log/parking
fi

# Strip any previous parking-box-cron block, keep everything else, append fresh.
tmp="$(mktemp)"
crontab -l 2>/dev/null | sed '/# >>> parking-box-cron >>>/,/# <<< parking-box-cron <<</d' > "$tmp" || true
cat "$DIR/crontab.txt" >> "$tmp"
crontab "$tmp"
rm -f "$tmp"

echo "✅ Installed. Active parking cron:"
crontab -l | sed -n '/# >>> parking-box-cron >>>/,/# <<< parking-box-cron <<</p'
echo
echo "Logs: /var/log/parking/{parkwhiz,way}.log"
echo "Smoke-test now (single venue):"
echo "  cd $(dirname "$DIR")/.. && VENUE=Yankee bash scripts/box-cron/scrape.sh parkwhiz && tail -n 30 /var/log/parking/parkwhiz.log"

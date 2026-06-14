# Live engine (Tool 1/2/3) for Render — Playwright + a virtual display.
# Way runs HEADED Chromium to clear Cloudflare, which needs an X server, so the
# whole server runs under xvfb-run. SpotHero/ParkWhiz run headless within this.

FROM node:22-bookworm-slim

WORKDIR /app

# xvfb gives headed Chromium a virtual display; xauth is required by xvfb-run;
# ca-certificates for TLS.
RUN apt-get update && apt-get install -y --no-install-recommends xvfb xauth ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install JS deps, then the Chromium build matching the installed Playwright
# version (+ its apt dependencies). Keeps browser/lib versions in lockstep.
COPY package*.json ./
RUN npm install --omit=dev || npm install
RUN npx playwright install --with-deps chromium

COPY . .

ENV NODE_ENV=production
# Render injects PORT; the server already reads process.env.PORT.
EXPOSE 4000

# Start a background virtual display (for Way's headed Cloudflare browser), then
# exec Node so it's the main process — binds the port immediately and streams logs
# straight to the host. If Xvfb fails, the server still runs (Way degrades only).
CMD ["sh", "-c", "Xvfb :99 -screen 0 1366x768x24 -nolisten tcp >/tmp/xvfb.log 2>&1 & export DISPLAY=:99; exec node src/engine/server.js"]

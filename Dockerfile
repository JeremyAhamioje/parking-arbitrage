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

# Run the engine under a virtual display so Way's headed Cloudflare boot works.
CMD ["xvfb-run", "-a", "--server-args=-screen 0 1366x768x24", "node", "src/engine/server.js"]

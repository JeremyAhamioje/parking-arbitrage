// Random delay to mimic human behavior and avoid bot detection
export function randomDelay(min = 1500, max = 4000) {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Calculate margin status based on thresholds
export function getStatus(margin) {
  const buyThreshold = parseFloat(process.env.MARGIN_BUY_THRESHOLD || 5);
  const watchThreshold = parseFloat(process.env.MARGIN_WATCH_THRESHOLD || 1);

  if (margin >= buyThreshold) return 'Buy';
  if (margin >= watchThreshold) return 'Watch';
  return 'Skip';
}

// Get current timestamp
export function getTimestamp() {
  return new Date().toISOString().replace('T', ' ').substring(0, 16);
}

// Log errors to console with context
export function logError(platform, address, error) {
  console.error(`[ERROR] ${platform} | ${address} | ${error.message}`);
}

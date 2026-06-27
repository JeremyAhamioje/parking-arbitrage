// Google Sheets access via the REST API + a service-account JWT, using Node's
// NATIVE fetch (undici). We deliberately do NOT use the `googleapis` library: its
// bundled gaxios 6 / node-fetch throws ERR_STREAM_PREMATURE_CLOSE while
// gunzip-ing Google's gzipped responses under Node 22, which broke the batch
// scrapers on the VPS (gtoken uses its own gaxios, so it couldn't be overridden).
// Native fetch handles the same gzip fine, so we sign the JWT ourselves and call
// the REST endpoints directly.
import crypto from 'crypto';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://sheets.googleapis.com/v4/spreadsheets';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

const b64url = (input) =>
  Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

let _token = null; // { value, expMs } — cached so we don't re-auth per call

async function getAccessToken() {
  if (_token && _token.expMs > Date.now() + 60_000) return _token.value;
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!email || !key) throw new Error('GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_PRIVATE_KEY must be set');

  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 }));
  const signature = b64url(crypto.createSign('RSA-SHA256').update(`${header}.${claims}`).sign(key));
  const assertion = `${header}.${claims}.${signature}`;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  if (!res.ok) throw new Error(`Google token error ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  _token = { value: j.access_token, expMs: Date.now() + (j.expires_in || 3600) * 1000 };
  return _token.value;
}

// Thin Sheets-REST helper, scoped to GOOGLE_SHEET_ID. `path` is appended to the
// spreadsheet base (e.g. '' for metadata, '/values/<range>', ':batchUpdate').
async function api(path, { method = 'GET', query, body } = {}) {
  const token = await getAccessToken();
  const qs = query ? `?${new URLSearchParams(query)}` : '';
  const res = await fetch(`${API}/${process.env.GOOGLE_SHEET_ID}${path}${qs}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Sheets ${method} ${path} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// Reads all venue names from Sheet1 column A (A2 down, skips blank rows). The
// range is generous (not capped at 50) so newly-added venues are picked up
// automatically on the next scrape — readVenues filters blanks, so an over-wide
// range costs nothing.
export async function readVenues() {
  const data = await api(`/values/${encodeURIComponent('Sheet1!A2:A1000')}`);
  const rows = data.values || [];
  return rows.map(r => r[0]).filter(Boolean);
}

// Appends a venue name to Sheet1 column A if it's not already present (case-
// insensitive dedupe). Returns { added: boolean, name }. The scrapers pick it up
// on their next run. Used by the "add venue" flow so a user-entered venue starts
// being tracked without hand-editing the sheet.
export async function addVenue(rawName) {
  const name = String(rawName || '').trim();
  if (!name) throw new Error('venue name required');
  const existing = await readVenues();
  if (existing.some(v => v.toLowerCase() === name.toLowerCase())) {
    return { added: false, name, reason: 'already tracked' };
  }
  await api(`/values/${encodeURIComponent('Sheet1!A:A')}:append`, {
    method: 'POST',
    query: { valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS' },
    body: { values: [[name]] },
  });
  return { added: true, name };
}

/**
 * @param {string} venueName
 * @param {Array}  listings
 * @param {{ name: string, date: string, startsAt: string }|null} event
 */
export async function appendParkingListings(venueName, listings, event = null) {
  if (listings.length === 0) return;

  const timestamp = new Date().toISOString();
  const eventName = event?.name || '';
  const eventDate = event?.date || '';

  const rows = listings.map(l => [
    timestamp,
    venueName,
    eventName,
    eventDate,
    l.name,
    l.address,
    `${l.city}, ${l.state}`,
    l.facilityType,
    l.advertisedPrice,
    l.serviceFee,
    l.totalPrice,
    l.availableSpaces,
    l.available ? 'Yes' : 'No',
    l.walkingMeters,
    l.amenities,
    l.facilityId,
  ]);

  await api(`/values/${encodeURIComponent('Listings!A:P')}:append`, {
    method: 'POST',
    query: { valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS' },
    body: { values: rows },
  });

  const label = event ? `"${event.name}" @ ${venueName}` : venueName;
  console.log(`  Wrote ${rows.length} listings → "${label}"`);
}

export async function ensureListingsSheet() {
  const meta = await api('');
  const exists = (meta.sheets || []).some(s => s.properties.title === 'Listings');
  if (exists) return;

  await api(':batchUpdate', {
    method: 'POST',
    body: { requests: [{ addSheet: { properties: { title: 'Listings' } } }] },
  });
  await api(`/values/${encodeURIComponent('Listings!A1:P1')}`, {
    method: 'PUT',
    query: { valueInputOption: 'RAW' },
    body: {
      values: [[
        'Timestamp', 'Venue', 'Event Name', 'Event Date',
        'Facility Name', 'Address', 'City/State',
        'Type', 'Advertised ($)', 'Service Fee ($)', 'Total ($)',
        'Available Spaces', 'Available', 'Walking (m)', 'Amenities', 'Facility ID',
      ]],
    },
  });
  console.log('Created "Listings" sheet with headers.');
}

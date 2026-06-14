import { google } from 'googleapis';

function getAuth() {
  return new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

// Reads all venue names from Sheet1 column A (A2 down, skips blank rows)
export async function readVenues() {
  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: 'Sheet1!A2:A51',
  });
  const rows = response.data.values || [];
  return rows.map(r => r[0]).filter(Boolean);
}

/**
 * @param {string} venueName
 * @param {Array}  listings
 * @param {{ name: string, date: string, startsAt: string }|null} event
 */
export async function appendParkingListings(venueName, listings, event = null) {
  if (listings.length === 0) return;

  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });
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

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: 'Listings!A:P',
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows },
  });

  const label = event ? `"${event.name}" @ ${venueName}` : venueName;
  console.log(`  Wrote ${rows.length} listings → "${label}"`);
}

export async function ensureListingsSheet() {
  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  // Check if Listings tab exists
  const meta = await sheets.spreadsheets.get({ spreadsheetId: process.env.GOOGLE_SHEET_ID });
  const exists = meta.data.sheets.some(s => s.properties.title === 'Listings');

  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: 'Listings' } } }] },
    });
    // Write header row
    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Listings!A1:P1',
      valueInputOption: 'RAW',
      requestBody: {
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
}

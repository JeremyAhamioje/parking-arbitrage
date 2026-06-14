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

// Read all listing rows from the sheet
export async function readListings() {
  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: 'Sheet1!A2:E', // Reads from row 2 (skips header) columns A to E
  });

  const rows = response.data.values || [];

  return rows.map((row, index) => ({
    rowIndex: index + 2,
    listingId: row[0] || '',
    name: row[1] || '',
    address: row[2] || '',   // Column C: Auditorium Theatre Parking Lots etc.
    eventDate: row[3] || '',  // Column D: 2026-07-22T19:00:00
    stubhubPrice: parseFloat(row[4]) || 0, // Column E: your listing price
  })).filter(r => r.address);
}

// Write scraped results back to the sheet
export async function writeResults(rowIndex, data) {
  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: `Sheet1!F${rowIndex}:L${rowIndex}`,
    valueInputOption: 'RAW',
    requestBody: {
      values: [[
        data.spothero,
        data.parkwhiz,
        data.way,
        data.bestPrice,
        data.margin,
        data.status,
        data.updatedAt,
      ]],
    },
  });
}

// XLSX / CSV I/O for Tool 3 (and Tool 1/2 exports). Pure backend parsing — no
// LLM (per spec: "Convert XLSX → JSON. Pure backend. NOT LLM").

import * as XLSX from 'xlsx'

/**
 * Parse an uploaded sheet buffer into rows of objects keyed by header.
 * Handles XLSX, XLS, and CSV (SheetJS sniffs the format). Returns:
 *   { headers: string[], rows: Array<Record<string,any>>, sheetName }
 * Blank rows are dropped; headers preserve their original order + casing so we
 * can write the original columns back untouched.
 */
export function parseSheet(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true })
  const sheetName = wb.SheetNames[0]
  const ws = wb.Sheets[sheetName]
  if (!ws) return { headers: [], rows: [], sheetName: null }

  // header:1 gives the literal header row so we keep original column order.
  const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: '' })
  if (!matrix.length) return { headers: [], rows: [], sheetName }

  const headers = matrix[0].map(h => String(h ?? '').trim())
  const rows = []
  for (let i = 1; i < matrix.length; i++) {
    const arr = matrix[i]
    if (!arr || arr.every(c => c === '' || c == null)) continue
    const obj = {}
    headers.forEach((h, j) => { if (h) obj[h] = arr[j] ?? '' })
    rows.push(obj)
  }
  return { headers, rows, sheetName }
}

/**
 * Serialize rows (array of objects) to an XLSX buffer. Column order follows
 * `columns` when provided, else the union of keys in first-seen order.
 */
export function rowsToXlsxBuffer(rows, { sheetName = 'Results', columns = null } = {}) {
  const cols = columns || dedupeKeys(rows)
  const ws = XLSX.utils.json_to_sheet(rows, { header: cols })
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31))
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
}

/** CSV string from rows (for clipboard / lightweight export). */
export function rowsToCsv(rows, columns = null) {
  const cols = columns || dedupeKeys(rows)
  const ws = XLSX.utils.json_to_sheet(rows, { header: cols })
  return XLSX.utils.sheet_to_csv(ws)
}

function dedupeKeys(rows) {
  const seen = []
  const set = new Set()
  for (const r of rows) for (const k of Object.keys(r)) if (!set.has(k)) { set.add(k); seen.push(k) }
  return seen
}

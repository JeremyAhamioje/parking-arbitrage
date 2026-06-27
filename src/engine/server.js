// Live-engine HTTP service. Owns Playwright + the 3 scrapers + matching + the
// sheet pipeline. The Next.js UI calls this directly (NEXT_PUBLIC_ENGINE_URL);
// the existing parking-api stays the read-only Supabase analytics API.
//
//   GET  /health
//   POST /api/live/event     { venue, event, date?, platforms? }   → Tool 1
//   POST /api/live/date      { venue, date, platforms? }           → Tool 2
//   POST /api/pipeline/preview  (multipart: file)                  → Tool 3 column detect
//   POST /api/pipeline/process  (multipart: file, limit?)          → Tool 3 enrich
//   POST /api/export/xlsx    { rows, columns?, filename? }         → shared export
//
// Run: ENGINE_PORT=4000 node src/engine/server.js

import 'dotenv/config'
import { randomUUID } from 'crypto'
import express from 'express'
import cors from 'cors'
import multer from 'multer'
import { liveEventFetch, liveDateFetch } from './live.js'
import { processSheet, detectColumns } from './pipeline.js'
import { parseSheet, rowsToXlsxBuffer } from './xlsx.js'
import { geminiConfigured, verifyGemini } from './gemini.js'
import { addVenue } from '../sheets.js'
import { upsertVenue } from '../db.js'

// A stray rejection from a closing browser (stealth-plugin CDP calls, in-flight
// request route handlers) must NEVER take down a long-running server. Log and
// keep serving — the per-platform try/catch has already handled the real result.
process.on('unhandledRejection', (reason) => {
  console.error('[engine] unhandledRejection (ignored):', reason?.message || reason)
})
process.on('uncaughtException', (err) => {
  console.error('[engine] uncaughtException (ignored):', err?.message || err)
})

const app = express()
app.use(cors())
app.use(express.json({ limit: '4mb' }))
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } })

const PORT = process.env.PORT || process.env.ENGINE_PORT || 4000 // Render/hosts inject PORT

// Concurrency is now bounded per-platform by warm pools (SpotHero/ParkWhiz, size
// SPOTHERO_POOL_MAX/PARKWHIZ_POOL_MAX) and a Way mutex — so multiple fetches run
// in parallel and queue only when a platform's pool is saturated. No global
// single-flight needed; total browser pages cap at the sum of the pool sizes.

const bad = (res, msg) => res.status(400).json({ error: msg })

// Gemini liveness, checked once at startup (see app.listen). `null` = not checked yet.
let geminiStatus = { configured: geminiConfigured(), ok: null }

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'parking-live-engine',
    platforms: ['spothero', 'way', 'parkwhiz'],
    gemini: {
      configured: geminiStatus.configured,
      valid: geminiStatus.ok,                                  // true/false/null(unchecked)
      matching: geminiStatus.ok ? 'gemini' : 'local-fallback', // what the pipeline will actually use
      ...(geminiStatus.message ? { error: geminiStatus.message } : {}),
    },
  })
})

// API-key gate: when ENGINE_API_KEY is set, every /api/* call must carry a
// matching X-API-Key header (the Vercel proxy injects it). /health stays open
// (registered above) for uptime probes. Unset → open, for local dev.
const API_KEY = process.env.ENGINE_API_KEY
app.use('/api', (req, res, next) => {
  if (!API_KEY || req.get('x-api-key') === API_KEY) return next()
  res.status(401).json({ error: 'unauthorized' })
})

// --- Tool 1: live event fetch ---------------------------------------------
app.post('/api/live/event', async (req, res) => {
  const { venue, event, date, platforms } = req.body || {}
  if (!venue || !String(venue).trim()) return bad(res, 'venue is required')
  if (!event || !String(event).trim()) return bad(res, 'event is required')
  try {
    const result = await liveEventFetch({ venue: String(venue).trim(), event: String(event).trim(), date: date || null, platforms })
    res.json(result)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// --- Tool 2: manual date & time generic inventory -------------------------
app.post('/api/live/date', async (req, res) => {
  const { venue, start, end, date, platforms } = req.body || {}
  if (!venue || !String(venue).trim()) return bad(res, 'venue is required')
  const dt = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/
  if (start || end) {
    if (!dt.test(start || '') || !dt.test(end || '')) return bad(res, 'start and end are required as YYYY-MM-DDTHH:mm')
    if (String(start) >= String(end)) return bad(res, 'end must be after start')
  } else if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return bad(res, 'provide start and end (YYYY-MM-DDTHH:mm), or a date (YYYY-MM-DD)')
  }
  try {
    const result = await liveDateFetch({ venue: String(venue).trim(), start, end, date, platforms })
    res.json(result)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// --- Add venue: validate it's real, dedupe, append to the tracking sheet ---
// Open submission but gated: the name must geocode to a real place (filters typos
// /junk) and not already be tracked, before it's committed to permanent scraping.
// Appending to the sheet → the scrapers pick it up on their next run. We also seed
// the venues table so it appears in the UI right away (no pricing until scraped).
async function geocodeVenue(q) {
  try {
    const res = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=1`, {
      headers: { 'User-Agent': 'parking-arbitrage/1.0' },
    })
    if (!res.ok) return null
    const c = (await res.json())?.features?.[0]?.geometry?.coordinates
    if (!Array.isArray(c) || c.length < 2) return null
    const [lon, lat] = c
    return (Number.isFinite(lat) && Number.isFinite(lon)) ? { lat, lon } : null
  } catch { return null }
}

app.post('/api/venues', async (req, res) => {
  const name = String(req.body?.name || '').trim()
  if (!name) return bad(res, 'name is required')
  if (name.length > 120) return bad(res, 'name is too long')
  try {
    const geo = await geocodeVenue(name)
    if (!geo) {
      return res.status(422).json({ added: false, name, reason: "couldn't find that venue — check the spelling or include city/state" })
    }
    const result = await addVenue(name) // dedupe-checked append to Sheet1 col A
    if (result.added) {
      // Non-fatal: makes it visible in the UI immediately; the scrape fills in pricing.
      try { await upsertVenue(name, geo.lat, geo.lon) } catch (e) { console.error('[engine] upsertVenue (non-fatal):', e.message) }
    }
    return res.status(result.added ? 201 : 409).json({ ...result, lat: geo.lat, lon: geo.lon })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// --- Tool 3: column preview (no scraping) ---------------------------------
app.post('/api/pipeline/preview', upload.single('file'), (req, res) => {
  if (!req.file) return bad(res, 'file is required (multipart field "file")')
  try {
    const { headers, rows } = parseSheet(req.file.buffer)
    res.json({ headers, detected: detectColumns(headers), rowCount: rows.length, sample: rows.slice(0, 5) })
  } catch (e) { res.status(400).json({ error: `parse failed: ${e.message}` }) }
})

// --- Tool 3: full enrich pipeline (async job model) -----------------------
// Processing is detached from the request so it survives the client navigating
// away — the browser polls GET /api/pipeline/job/:id for progress + result.
// In-memory store (lost on engine restart); finished jobs expire after the TTL.
const jobs = new Map()
const JOB_TTL_MS = 20 * 60 * 1000
const _sweep = setInterval(() => {
  const now = Date.now()
  for (const [id, j] of jobs) if (j.finishedAt && now - j.finishedAt > JOB_TTL_MS) jobs.delete(id)
}, 60_000)
if (_sweep.unref) _sweep.unref()

app.post('/api/pipeline/process', upload.single('file'), (req, res) => {
  if (!req.file) return bad(res, 'file is required (multipart field "file")')
  const limit = Math.min(parseInt(req.body?.limit || '50', 10) || 50, 200)
  const id = randomUUID()
  const buffer = req.file.buffer
  const job = { status: 'queued', processed: 0, total: 0, result: null, error: null, startedAt: Date.now(), finishedAt: null }
  jobs.set(id, job)

  // Not awaited — the sheet processes its rows sequentially, each row's fetch
  // sharing the same warm pools as live requests (so a sheet job and live
  // fetches interleave instead of blocking each other).
  job.status = 'running'
  processSheet(buffer, {
    eventFetch: liveEventFetch,
    dateFetch: liveDateFetch,
    limit,
    onProgress: (i, total) => { job.processed = i; job.total = total },
  }).then((result) => {
    job.result = result; job.status = 'done'; job.finishedAt = Date.now()
  }).catch((err) => {
    job.error = err.message; job.status = 'error'; job.finishedAt = Date.now()
  })

  res.json({ jobId: id })
})

app.get('/api/pipeline/job/:id', (req, res) => {
  const job = jobs.get(req.params.id)
  if (!job) return res.status(404).json({ error: 'job not found (it may have expired, or the engine restarted)' })
  res.json({
    id: req.params.id,
    status: job.status,
    processed: job.processed,
    total: job.total,
    done: job.status === 'done',
    error: job.error,
    elapsedMs: (job.finishedAt || Date.now()) - job.startedAt,
    result: job.status === 'done' ? job.result : undefined,
  })
})

// --- Shared export: rows → XLSX download -----------------------------------
app.post('/api/export/xlsx', (req, res) => {
  const { rows, columns, filename } = req.body || {}
  if (!Array.isArray(rows) || !rows.length) return bad(res, 'rows[] is required')
  try {
    const buf = rowsToXlsxBuffer(rows, { columns: columns || null, sheetName: 'Parking' })
    const name = (filename || 'parking-export').replace(/[^a-z0-9_-]+/gi, '_')
    res.setHeader('Content-Disposition', `attachment; filename="${name}.xlsx"`)
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.send(buf)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

console.log(`[engine] starting, binding 0.0.0.0:${PORT} ...`)
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`[engine] parking-live-engine listening on :${PORT}`)
  // Verify Gemini once so a missing/invalid key is loud, not a silent local fallback.
  const v = await verifyGemini()
  geminiStatus = { configured: v.configured, ok: v.ok, message: v.message }
  if (!v.configured) {
    console.log('[engine] Gemini not configured (GEMINI_API_KEY unset) — Sheet Normalizer will use LOCAL fuzzy matching.')
  } else if (v.ok) {
    console.log(`[engine] ✓ Gemini matching enabled (${v.model})`)
  } else if (v.network) {
    console.warn(`[engine] ⚠ couldn't reach Gemini at startup (${v.message}) — likely a transient network/AV blip. It retries per request; local matching is used only if it stays unreachable.`)
  } else {
    console.warn(`[engine] ⚠ GEMINI_API_KEY REJECTED (${v.status || '?'}) — ${v.message || ''}. Sheet Normalizer will use LOCAL fuzzy matching.`)
  }
})

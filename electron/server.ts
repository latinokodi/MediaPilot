// ─────────────────────────────────────────────────────────────
// TorDownloader PRO — headless web server (browser access on a
// headless Linux box). Serves the same React frontend (dist/) and
// exposes the same API the Electron app's IPC layer did, over HTTP
// + SSE for events. Desktop Electron mode is untouched.
// ─────────────────────────────────────────────────────────────
import http from 'http'
import https from 'https'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { spawn } from 'child_process'
import { URL } from 'url'

import { initDB, getSettings, updateSettings, getDownloads, addDownload, updateDownload, deleteDownload, getDownloadByTorboxId } from './db'
import { initMetaSearch, getMetaSearch, type SearchProgress } from './metasearch'
import { startWorker, cancelLocalDownload } from './worker'
import { listWatchlist, getWatchlistItem, addWatchlistItem, updateWatchlistItem, removeWatchlistItem, grabHistoryForItem, recentGrabs, normalizeLanguageProfile, normalizeMediaType } from './watchlist'
import { startMonitor, stopMonitor, kickMonitor, forceCheckItem, getMonitorStatus, getMonitorLastSummary, startUpgradeScan, getUpgradeScan, applyUpgrade, getCalendar, healLibraryFolders } from './monitor'
import { reconcileDebrid } from './debrid-reconcile'
import { getAccountStatus, isInCooldown } from './debrid-status'
import { scanLibrary, deleteMovie, deleteSeries, deleteSeason, deleteEpisode, resolveTargetPath, fetchJellyfinPoster } from './library'
import { TorboxAPI } from './torbox'
import { RealDebridAPI, RD_OPENSOURCE_CLIENT_ID } from './realdebrid'
import { eventBus } from './event-bus'

const PORT = parseInt(process.env.TDP_PORT || '9650', 10)
const HOST = process.env.TDP_HOST || '0.0.0.0'
const DIST_DIR = path.join(__dirname, '..', 'dist')
const PKG = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'))

// ── Log collector (mirrors main.ts so the UI log panel works) ──
const logBuffer: Array<{ ts: string; text: string; level: string }> = []
const LOG_MAX = 1500

// Cache de las colecciones de Explorar (spawnear Python + ~45 llamadas a TMDB es caro).
let listsCache: { at: number; body: any } | null = null
const LISTS_CACHE_TTL_MS = 30 * 60 * 1000
function sendLog(level: string, ...args: any[]) {
  const text = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
  const entry = { ts: new Date().toISOString().slice(11, 19), text, level }
  logBuffer.push(entry)
  if (logBuffer.length > LOG_MAX) logBuffer.shift()
  eventBus.emit('app-log', entry)
}
const _origLog = console.log
const _origWarn = console.warn
const _origError = console.error
const _origDebug = console.debug
console.log = (...a: any[]) => { _origLog(...a); sendLog('info', ...a) }
console.warn = (...a: any[]) => { _origWarn(...a); sendLog('warn', ...a) }
console.error = (...a: any[]) => { _origError(...a); sendLog('error', ...a) }
console.debug = (...a: any[]) => { _origDebug(...a); sendLog('debug', ...a) }

// ── Python spawn helpers (Linux: python3 + .py scripts) ──
function scriptPath(scriptName: string): string {
  return path.join(__dirname, '..', 'electron', scriptName)
}
function spawnPython(scriptName: string, args: string[], env: Record<string, string> = {}) {
  const py = process.env.TDP_PYTHON || 'python3'
  return spawn(py, [scriptPath(scriptName), ...args], {
    env: { ...process.env as any, ...env },
    windowsHide: true,
  })
}

// ── HTTP helpers ──────────────────────────────────────────
function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (c) => (data += c))
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {})
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
}

function sendJson(res: http.ServerResponse, status: number, body: any) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(payload)
}

function send(res: http.ServerResponse, status: number, contentType: string, body: string | Buffer) {
  res.writeHead(status, { 'Content-Type': contentType })
  res.end(body)
}

function notFound(res: http.ServerResponse) {
  sendJson(res, 404, { success: false, error: 'Not found' })
}

// ── TMDB / Stremio catalog fetch (shared) ────────────────
function httpsGetJson(url: string, timeoutMs = 15000): Promise<any> {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { 'User-Agent': 'TorDownloader-PRO/1.0' } }, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => {
        try {
          resolve(JSON.parse(body))
        } catch {
          resolve(null)
        }
      })
    })
    req.on('error', () => resolve(null))
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null) })
  })
}

// ── Jackett / metasearch env ───────────────────────────────────
// The metasearch backend (meta-search.py) needs Jackett's Torznab
// credentials + a TMDB key. Auto-discover Jackett from the local
// config file so the web UI works with zero extra setup.
const DEFAULT_JACKETT_INDEXERS = [
  '1337x', 'eztv', 'thepiratebay', 'yts', 'torrentgalaxyclone',
  'torrentdownloads', 'therarbg', 'subsplease',
  'dontorrent', 'divxtotal', 'wolfmax4k', 'catorrent', 'limetorrents',
  'extratorrent-st', 'torrentproject2', 'torrent9',
]

function ensureSearchEnv(tmdbKey: string) {
  if (!process.env.JACKETT_API_KEY) {
    try {
      const cfgPath = process.env.JACKETT_CONFIG || path.join(os.homedir(), 'appdata', 'jackett', 'Jackett', 'ServerConfig.json')
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
      if (cfg.APIKey) {
        process.env.JACKETT_URL = process.env.JACKETT_URL || `http://127.0.0.1:${cfg.Port || 9117}`
        process.env.JACKETT_API_KEY = cfg.APIKey
      }
    } catch {
      // No local Jackett config — JACKETT_URL / JACKETT_API_KEY env vars can be set manually
    }
  }
  if (!process.env.JACKETT_INDEXERS) {
    process.env.JACKETT_INDEXERS = DEFAULT_JACKETT_INDEXERS.join(',')
  }
  if (tmdbKey) process.env.TMDB_API_KEY = tmdbKey
}

// ── Handler implementations (ported from main.ts IPC) ─────

async function addMagnetHandler(magnet: string, service: string, type: string, destFolder?: string) {
  const settings = getSettings()
  if (service === 'realdebrid') {
    if (!settings.realdebrid_token) return { success: false, error: 'Real-Debrid token is not configured' }
    try {
      const rd = new RealDebridAPI(settings.realdebrid_token)
      const result = await rd.addMagnet(magnet)
      if (result.success && result.data) {
        const { id } = RealDebridAPI.torrentIdentity(result.data)
        if (id) {
          const existing = getDownloadByTorboxId(id)
          if (existing) updateDownload(id, { local_status: 'pending', service: 'realdebrid', type: type as any })
          else addDownload({ torbox_id: id, name: result.data.filename || result.data.name || 'Pending...', status: 'waiting_files_selection', progress: 0, service: 'realdebrid', type: type as any })
          eventBus.emit('downloads-updated')
        }
      }
      return result
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  }
  if (!settings.torbox_token) return { success: false, error: 'TorBox token is not configured' }
  try {
    const tb = new TorboxAPI(settings.torbox_token)
    const result = await tb.addMagnet(magnet)
    if (result.success && result.data) {
      const { id } = TorboxAPI.torrentIdentity(result.data)
      if (id) {
        const existing = getDownloadByTorboxId(id)
        if (existing) updateDownload(id, { local_status: 'pending', service: 'torbox', type: type as any, ...(destFolder ? { dest_folder: destFolder } : {}) })
        else addDownload({ torbox_id: id, name: result.data.name || 'Pending...', status: 'pending', progress: 0, local_status: 'pending', service: 'torbox', type: type as any, ...(destFolder ? { dest_folder: destFolder } : {}) })
        eventBus.emit('downloads-updated')
      }
    }
    return result
  } catch (error: any) {
    return { success: false, error: error.message }
  }
}

async function addTorrentUrlHandler(url: string, service: string, type: string) {
  const settings = getSettings()
  if (service === 'realdebrid') {
    if (!settings.realdebrid_token) return { success: false, error: 'Real-Debrid token is not configured' }
    try {
      const rd = new RealDebridAPI(settings.realdebrid_token)
      const result = await rd.addTorrentFromUrl(url)
      if (result.success && result.data) {
        const { id } = RealDebridAPI.torrentIdentity(result.data)
        if (id) {
          const existing = getDownloadByTorboxId(id)
          if (existing) updateDownload(id, { local_status: 'pending', service: 'realdebrid', type: type as any })
          else addDownload({ torbox_id: id, name: result.data.filename || result.data.name || 'Pending...', status: 'waiting_files_selection', progress: 0, service: 'realdebrid', type: type as any })
          eventBus.emit('downloads-updated')
        }
      }
      return result
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  }
  if (!settings.torbox_token) return { success: false, error: 'TorBox token is not configured' }
  try {
    const tb = new TorboxAPI(settings.torbox_token)
    const result = await tb.addTorrentFromUrl(url)
    if (result.success && result.data) {
      const { id } = TorboxAPI.torrentIdentity(result.data)
      if (id) {
        const existing = getDownloadByTorboxId(id)
        if (existing) updateDownload(id, { local_status: 'pending', service: 'torbox', type: type as any })
        else addDownload({ torbox_id: id, name: result.data.name || 'Pending...', status: 'pending', progress: 0, service: 'torbox', type: type as any })
        eventBus.emit('downloads-updated')
      }
    }
    return result
  } catch (error: any) {
    return { success: false, error: error.message }
  }
}

async function clearCompletedHandler() {
  const settings = getSettings()
  const downloads = getDownloads()
  const completed = downloads.filter(
    (d) =>
      ['completed', 'downloaded', 'cached', 'finished'].includes((d.status || '').toLowerCase()) &&
      (d.local_status || '').toLowerCase() === 'completed',
  )
  for (const d of completed) {
    if (d.service === 'realdebrid' && settings.realdebrid_token) {
      try { await new RealDebridAPI(settings.realdebrid_token).deleteTorrent(d.torbox_id) } catch { /* ignore */ }
    } else if (settings.torbox_token) {
      try { await new TorboxAPI(settings.torbox_token).controlTorrent(d.torbox_id, 'Delete') } catch { /* ignore */ }
    }
    deleteDownload(d.torbox_id)
  }
  eventBus.emit('downloads-updated')
  return { success: true }
}

function spawnTmdb(scriptName: string, args: string[], apiKey: string): Promise<any> {
  return new Promise((resolve) => {
    const label = `${scriptName} ${args.join(' ')}`
    const proc = spawnPython(scriptName, args, { TMDB_API_KEY: apiKey })
    let stdout = ''
    let stderr = ''
    proc.stdout?.on('data', (c: Buffer) => (stdout += c.toString('utf-8')))
    proc.stderr?.on('data', (c: Buffer) => (stderr += c.toString('utf-8')))
    const timer = setTimeout(() => proc.kill('SIGTERM'), 30_000)
    proc.on('close', () => {
      clearTimeout(timer)
      try {
        const data = JSON.parse(stdout)
        if (data.error) resolve({ success: false, error: data.error })
        else resolve({ success: true, data })
      } catch {
        resolve({ success: false, error: `Failed to parse ${label}: ${stdout.slice(0, 300) || stderr.slice(0, 300)}` })
      }
    })
    proc.on('error', (err) => {
      clearTimeout(timer)
      resolve({ success: false, error: err.message })
    })
  })
}

const CATALOG_BASE =
  'https://btttr.cc/pVjfb-M2DP5XBD9sDwsBu-l1Sd6a9O464HotkvSKwzAMjM0kWmXJk-TkckX_90GOHdtRfrTYm0N9H8mQFEnoJYjRolALEwz-DARaMhbSoFN9mqATWJXgphBuv2oZBp0gVimXi-K4_DT1pwNYTTKpILsfDpSpLBeoi4Pqe6s8K6D4bCHLZ4N_cmO5BOBpMgOrMtBoKYFUrTiZFjJR8scGIEW9IgExl5Si5THkkq9IG3qLWrsCs1TrtuIZyblG-SwcYVYEictknsfPbVyMmUUuJWYoUoAoDCNYaCrjWjgMag4oBFietv0xWWR5ySmhG5VDmrs8EMGM5kpTIUt4myq4WV6GPdh51Tr9G8kFAraetHTjBpa4IpC0Ig1LQp2Amh_WbXVOEGueEiQqzlOSFvUGDGmnbs5F2uJZskvUXEmA5EgGjJI8XqPWXGkAY1HDGrWBGKWSRYAEl3QiEWgoASUBt84Zq_RmLx8yVnLOdQpglrmFPAOUCazRxssWUlOickSUBKCVEEWRWiUJjEtJncWqPk7kkYToqlwmVcR3xe3V1ZwnrlBnAHhx2TpZcIHJAsDkM01Jwl0NCIotV7Ktwi5dXTwDYIwJpRvANerEbKs047HNNcGaS0naHKz_UlL6eLD8XckYi1kGsFRaKx10gjSZCe5M5LPBRdS_3BdddK_2RN2wd-GJ-l0fdYDY80V9X1foi_b96ob9D77IsxiFv3uiKNoXda889VHkO9HzdYUHLHr_MQr3Xb24inrBX50gJYvB4OXNTXLwEkhMKRgEf9zdDAdsqjI2dgB2t-uiwSCYBa_vaqe12rvr8bePX9iowrDHxoX3NZ_rvcf9nX5jk6o-fb2n-nStc0jGsrtmA_c1vbeT19odlH0uoWV8mZqzayHYtGwWvr13dv89c6WV7ypnd7mxbELEhgWjkN3wI1b9wdFIaWOW-Mz3D5VacxGcls-4Ybe4IvbVUdito7D7-Rmf3zCQaptTnRMbOTC7qcFsUoDZL-xTOb98e0cGWa36ZnSm2t8452qNE4uaPaE2bOQgrDkKzxX9wZnYqH13zpRkyKbjx49sMr0ffz92BU4Nz4a3y9yyx6zDrmXCnqrJ6uv7fyO2tjfectnEcX81LArD-r5V_eEtN-70nN6v14ft6an20x7ntYLr7XD3CSenfCPC1TGbtJaAA8X6nm2g4eAWza4LNANWtMiHLZ491dvD8VZ-ZI1o3kB8toNdGE83cn_jqBXdVivIjuftIjX4S7ssSpbxWG5dafiqskbntktia6KqE6b75GKxqclfyc4F_3HaYLH5-JzWOD5kqOnl7fD-nJFer5nlFH8qyR6KLniO2G8aykV-9u-EzZbIjaTNb2c5l8e8OxeH_ocD1s6Srvb_0xmG2wJrxkillGyOg6OoWUFLzYUgfRTudsfGDY85fOIndIfHLsChIml6PRyOzqTBLaPNVuDay4mQNCtq5JJ1AtvKksa0eBA4hC0W20P3rya8ulcCY6loBe6NYBBgbpV7PNBqocmYYOBGXvnKMEX3qLEV_Juj4HazFc1RGOoErj19JqmpAjnBGC2Xi0qCC6oEFUlp543SfMEliuD19T8'

async function catalogFetch(p: string): Promise<any> {
  return await httpsGetJson(`${CATALOG_BASE}${p}`)
}

// ── SSE event fan-out ────────────────────────────────────
const sseClients = new Set<http.ServerResponse>()
const SSE_CHANNELS = ['downloads-updated', 'app-log', 'search-progress', 'search-error', 'latino-search-progress', 'watchlist-updated', 'monitor-updated', 'latino-ddl-pending']
const sseUnsubs = SSE_CHANNELS.map((ch) =>
  eventBus.on(ch, (data) => {
    const payload = `event: ${ch}\ndata: ${JSON.stringify(data ?? {})}\n\n`
    for (const res of sseClients) {
      try { res.write(payload) } catch { sseClients.delete(res) }
    }
  }),
)

function handleSSE(req: http.IncomingMessage, res: http.ServerResponse) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.write(': connected\n\n')
  sseClients.add(res)
  req.on('close', () => sseClients.delete(res))
}

// ── Router ───────────────────────────────────────────────
async function route(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  const p = url.pathname
  const method = (req.method || 'GET').toUpperCase()

  // API namespace
  if (p.startsWith('/api/')) {
    const api = p.slice(5)
    try {
      if (api === 'events' && method === 'GET') return handleSSE(req, res)
      if (api === 'settings' && method === 'GET') return sendJson(res, 200, getSettings())
      if (api === 'settings' && method === 'POST') {
        const body = await readBody(req)
        updateSettings(body)
        // Automation loop config changed — restart the timer with new values.
        if ('monitor_enabled' in body || 'monitor_interval_minutes' in body) {
          try { startMonitor() } catch (e: any) { console.error('[settings] monitor restart failed:', e.message) }
        }
        return sendJson(res, 200, { success: true })
      }
      if (api === 'downloads' && method === 'GET') return sendJson(res, 200, getDownloads())
      if (api === 'downloads/add' && method === 'POST') {
        const body = await readBody(req)
        return sendJson(res, 200, await addMagnetHandler(body.magnet, body.service || 'torbox', body.type || '', body.dest_folder || undefined))
      }
      if (api === 'downloads/add-torrent-url' && method === 'POST') {
        const body = await readBody(req)
        return sendJson(res, 200, await addTorrentUrlHandler(body.url, body.service || 'torbox', body.type || ''))
      }
      if (api === 'downloads/clear-completed' && method === 'POST') return sendJson(res, 200, await clearCompletedHandler())
      if (api.startsWith('downloads/cancel/') && method === 'POST') {
        const id = api.split('/')[2]
        return sendJson(res, 200, { success: cancelLocalDownload(id) })
      }
      if (api.startsWith('downloads/') && method === 'DELETE') {
        const id = api.split('/')[1]
        const settings = getSettings()

        // 1. Stop an in-flight/queued local download for this id before purging.
        let cancelled = false
        try { cancelled = cancelLocalDownload(id) } catch { /* nothing active */ }

        // 2. Best-effort remote delete. It must never block local cleanup:
        //    the torrent may already be gone from TorBox (deleted by hand there).
        let remote: any = { success: false, error: 'NoToken', detail: 'TorBox token is not configured' }
        if (settings.torbox_token) {
          try {
            remote = await new TorboxAPI(settings.torbox_token).controlTorrent(id, 'delete')
          } catch (e: any) {
            remote = { success: false, error: 'RequestError', detail: e?.message || String(e) }
          }
        }

        // 3. Always drop the local bookkeeping row, otherwise an entry whose
        //    torrent no longer exists remotely becomes an undeletable ghost.
        deleteDownload(id)
        eventBus.emit('downloads-updated')
        return sendJson(res, 200, { success: true, cancelled, remote })
      }

      // ── Watchlist (automation engine) ──────────────────────
      if (api === 'watchlist' && method === 'GET') {
        return sendJson(res, 200, { success: true, data: listWatchlist() })
      }
      if (api === 'watchlist' && method === 'POST') {
        const body = await readBody(req)
        try {
          const mediaType = normalizeMediaType(body.media_type)
          const tmdbId = Math.trunc(Number(body.tmdb_id))
          const title = typeof body.title === 'string' ? body.title.trim().slice(0, 500) : ''
          if (!mediaType || !Number.isFinite(tmdbId) || tmdbId <= 0 || !title) {
            return sendJson(res, 400, { success: false, error: 'tmdb_id (positive int), media_type (movie|series) and title are required' })
          }
          const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
          const result = addWatchlistItem({
            tmdb_id: tmdbId,
            media_type: mediaType,
            title,
            year: str(body.year, 10),
            overview: str(body.overview, 2000),
            poster: str(body.poster, 1000),
            backdrop: str(body.backdrop, 1000),
            imdb_id: str(body.imdb_id, 20),
            language_profile: normalizeLanguageProfile(body.language_profile, getSettings().language_profile),
            backfill: body.backfill,
          })
          eventBus.emit('watchlist-updated', { action: 'add', item: result.item })
          if (result.created) {
            // Un título ya estrenado debe intentarse YA, no en el próximo tick
            // (hasta 30 min). El kick es en background y nunca bloquea la respuesta.
            setTimeout(() => {
              try {
                if (!forceCheckItem(result.item.id)) console.error('[watchlist] immediate check could not start for item', result.item.id)
              } catch (e: any) {
                console.error('[watchlist] immediate check failed:', e.message)
              }
            }, 1500)
          }
          return sendJson(res, result.created ? 201 : 200, { success: true, data: result.item, created: result.created })
        } catch (e: any) {
          return sendJson(res, 400, { success: false, error: e.message })
        }
      }
      if (api.startsWith('watchlist/') && api.endsWith('/check') && method === 'POST') {
        const id = Math.trunc(Number(api.split('/')[1]))
        if (!Number.isFinite(id) || !forceCheckItem(id)) return sendJson(res, 404, { success: false, error: 'Watchlist item not found' })
        return sendJson(res, 200, { success: true })
      }
      if (api.startsWith('watchlist/') && api.endsWith('/history') && method === 'GET') {
        const id = Math.trunc(Number(api.split('/')[1]))
        if (!Number.isFinite(id) || !getWatchlistItem(id)) return sendJson(res, 404, { success: false, error: 'Watchlist item not found' })
        return sendJson(res, 200, { success: true, data: grabHistoryForItem(id, 100) })
      }
      // ── Reemplazo manual EN → latino (el usuario decide) ──
      if (api.startsWith('watchlist/') && api.endsWith('/upgrades/scan') && method === 'POST') {
        const id = Math.trunc(Number(api.split('/')[1]))
        if (!Number.isFinite(id) || !getWatchlistItem(id)) return sendJson(res, 404, { success: false, error: 'Watchlist item not found' })
        const started = startUpgradeScan(id)
        return sendJson(res, 200, { success: true, started })
      }
      if (api.startsWith('watchlist/') && api.endsWith('/upgrades') && method === 'GET') {
        const id = Math.trunc(Number(api.split('/')[1]))
        if (!Number.isFinite(id) || !getWatchlistItem(id)) return sendJson(res, 404, { success: false, error: 'Watchlist item not found' })
        return sendJson(res, 200, { success: true, data: getUpgradeScan(id) })
      }
      if (api.startsWith('watchlist/') && api.endsWith('/upgrade') && method === 'POST') {
        const id = Math.trunc(Number(api.split('/')[1]))
        if (!Number.isFinite(id) || !getWatchlistItem(id)) return sendJson(res, 404, { success: false, error: 'Watchlist item not found' })
        const body = await readBody(req)
        const season = body.season === undefined || body.season === null ? null : Math.trunc(Number(body.season))
        const episode = body.episode === undefined || body.episode === null ? null : Math.trunc(Number(body.episode))
        if (season !== null && (!Number.isFinite(season) || !Number.isFinite(episode))) {
          return sendJson(res, 400, { success: false, error: 'Invalid season/episode' })
        }
        const result = await applyUpgrade(id, season, episode)
        if (!result.ok) return sendJson(res, 202, { success: false, error: result.error })
        eventBus.emit('watchlist-updated', { action: 'upgrade', id })
        return sendJson(res, 200, { success: true, data: result })
      }
      if (api.startsWith('watchlist/') && method === 'DELETE') {
        const id = Math.trunc(Number(api.split('/')[1]))
        if (!Number.isFinite(id) || !removeWatchlistItem(id)) return sendJson(res, 404, { success: false, error: 'Watchlist item not found' })
        eventBus.emit('watchlist-updated', { action: 'remove', id })
        return sendJson(res, 200, { success: true })
      }
      if (api.startsWith('watchlist/') && method === 'PATCH') {
        const id = Math.trunc(Number(api.split('/')[1]))
        if (!Number.isFinite(id) || !getWatchlistItem(id)) return sendJson(res, 404, { success: false, error: 'Watchlist item not found' })
        const body = await readBody(req)
        const patch: { monitored?: boolean; language_profile?: any; imdb_id?: string; backfill?: any; poster?: string; backdrop?: string } = {}
        if (typeof body.monitored === 'boolean') patch.monitored = body.monitored
        if (body.language_profile !== undefined) patch.language_profile = normalizeLanguageProfile(body.language_profile, getSettings().language_profile)
        if (body.backfill !== undefined) patch.backfill = body.backfill
        if (typeof body.poster === 'string') patch.poster = body.poster
        if (typeof body.backdrop === 'string') patch.backdrop = body.backdrop
        if (typeof body.imdb_id === 'string' && body.imdb_id.trim()) patch.imdb_id = body.imdb_id.trim().slice(0, 20)
        const item = updateWatchlistItem(id, patch)
        eventBus.emit('watchlist-updated', { action: 'update', item })
        if (patch.backfill !== undefined && item) {
          // Cambiar el alcance puede hacer "deseados" episodios ya emitidos —
          // inténtalo ya, sin esperar al tick.
          setTimeout(() => {
            try { forceCheckItem(item.id) } catch (e: any) { console.error('[watchlist] scope check failed:', e.message) }
          }, 1500)
        }
        return sendJson(res, 200, { success: true, data: item })
      }
      if (api === 'watchlist/recent-grabs' && method === 'GET') {
        return sendJson(res, 200, { success: true, data: recentGrabs(30) })
      }

      // ── Biblioteca (listado + borrado fiable) ─────────────
      if (api === 'library' && method === 'GET') {
        return sendJson(res, 200, { success: true, data: await scanLibrary() })
      }
      if (api === 'library/poster' && method === 'GET') {
        const q = new URL(req.url || '', 'http://localhost').searchParams
        const folder = q.get('f') || ''
        const kind = q.get('t') === 'series' ? 'series' : 'movie'
        if (!folder) return sendJson(res, 400, { success: false, error: 'f required' })
        const poster = await fetchJellyfinPoster(folder, kind)
        if (!poster) {
          res.writeHead(404, { 'Content-Type': 'text/plain' })
          return res.end('no poster')
        }
        res.writeHead(200, { 'Content-Type': poster.contentType, 'Cache-Control': 'public, max-age=86400' })
        return res.end(poster.buffer)
      }
      if (api === 'library/delete' && method === 'POST') {
        const body = await readBody(req)
        const type = String(body.type || '')
        const dir = typeof body.dir === 'string' ? body.dir : ''
        const title = typeof body.title === 'string' ? body.title : ''
        const season = typeof body.season === 'string' ? body.season : ''
        const file = typeof body.file === 'string' ? body.file : ''
        const forgetHistory = Boolean(body.forgetHistory)
        const settings = getSettings()
        let result
        try {
          if (type === 'movie') {
            result = await deleteMovie(resolveTargetPath(settings.movies_folder, { dir, title }), forgetHistory)
          } else if (type === 'series') {
            result = await deleteSeries(resolveTargetPath(settings.series_folder, { dir, title }), forgetHistory)
          } else if (type === 'season') {
            result = await deleteSeason(resolveTargetPath(settings.series_folder, { dir, title, sub: season }), forgetHistory)
          } else if (type === 'episode') {
            result = await deleteEpisode(resolveTargetPath(settings.series_folder, { dir, title, sub: season, file }), forgetHistory)
          } else {
            return sendJson(res, 400, { success: false, error: 'type must be movie|series|season|episode' })
          }
        } catch (e: any) {
          return sendJson(res, 400, { success: false, error: e.message })
        }
        if (!result.ok) return sendJson(res, 400, { success: false, error: result.error })
        return sendJson(res, 200, { success: true, data: result })
      }

      // ── Monitor control ───────────────────────────────────
      if (api === 'calendar' && method === 'GET') {
        const q = new URL(req.url || '', 'http://localhost').searchParams
        const days = Math.min(180, Math.max(7, Math.trunc(Number(q.get('days')) || 60)))
        const force = q.get('refresh') === '1'
        return sendJson(res, 200, { success: true, data: await getCalendar(days, force) })
      }
      if (api === 'monitor/status' && method === 'GET') {
        return sendJson(res, 200, { success: true, data: getMonitorStatus() })
      }
      if (api === 'monitor/run' && method === 'POST') {
        kickMonitor(true)
        return sendJson(res, 200, { success: true, started: true })
      }
      // Consolidación manual de la biblioteca (carpetas duplicadas del mismo
      // título por un cambio de título en TMDB). El monitor ya lo hace solo
      // cada 30 min; esto es para forzarlo desde la UI.
      if (api === 'library/heal' && method === 'POST') {
        const result = await healLibraryFolders(true)
        return sendJson(res, 200, { success: true, data: result })
      }
      // Reconciliación con el debrid (spec B9): adopta los torrents que la cuenta
      // ya tiene listos y que la app no baja por no tener fila. El monitor lo hace
      // solo al arrancar y cada 15 min; esto es para forzarlo desde la UI.
      if (api === 'debrid/reconcile' && method === 'POST') {
        const dry = /[?&]dry=1/.test(req.url || '')
        const result = await reconcileDebrid({ dry })
        return sendJson(res, 200, {
          success: true,
          data: {
            adopted: result.adopted,
            skipped: result.skipped,
            ready: result.plan.adopt.filter((d) => d.ready).length,
            adopt: result.plan.adopt.map((d) => ({
              torrentId: d.torrentId,
              name: d.name.slice(0, 120),
              tmdbId: d.tmdbId,
              mediaType: d.mediaType,
              season: d.season,
              episode: d.episode,
              ready: d.ready,
              sizeGb: Math.round(d.sizeGb * 100) / 100,
            })),
            skip: result.plan.skip.slice(0, 40).map((s) => ({ name: s.name.slice(0, 100), reason: s.reason })),
            skipped_total: result.plan.skip.length,
            reason: result.reason,
          },
        })
      }

      // Estado de la cuenta en el debrid (spec B10): cooldown, para que la UI
      // pueda avisar en vez de dejar que la app martillee sin explicación.
      if (api === 'debrid/status') {
        const settings = getSettings()
        const force = /[?&]refresh=1/.test(req.url || '')
        const status = await getAccountStatus({ token: settings.automation_service === 'torbox' ? settings.torbox_token : undefined, force })
        return sendJson(res, 200, {
          success: true,
          data: {
            service: settings.automation_service,
            inCooldown: isInCooldown(status),
            cooldownUntil: status?.cooldownUntil || null,
            plan: status?.plan ?? null,
            checkedAt: status?.at ? new Date(status.at).toISOString() : null,
            error: status?.error || null,
          },
        })
      }

      if (api === 'search' && method === 'POST') {
        const body = await readBody(req)
        // Fresh env for the metasearch backend: Jackett (Torznab) + TMDB (latino resolution)
        ensureSearchEnv(getSettings().tmdb_api_key || '')
        const ms = getMetaSearch()
        const allResults: any[] = []
        const seen = new Map<string, any>()
        await ms.searchStream(body.query || '', {
          onProgress: (progress: SearchProgress) => {
            // Accumulate streamed engine results (stream mode does NOT dedupe)
            if (progress.type === 'engine_results' && Array.isArray(progress.results)) {
              for (const r of progress.results) {
                const key = r.info_hash || r.link
                if (key && seen.has(key)) {
                  if (r.seeders > seen.get(key).seeders) {
                    allResults[allResults.indexOf(seen.get(key))] = r
                    seen.set(key, r)
                  }
                  continue
                }
                if (key) seen.set(key, r)
                allResults.push(r)
              }
            }
            eventBus.emit('search-progress', { tabId: null, ...progress })
          },
          onDone: () => { /* results already accumulated via onProgress */ },
          onError: (err) => eventBus.emit('search-error', err.message),
        })
        return sendJson(res, 200, { success: true, data: allResults })
      }
      if (api === 'select-folder' && method === 'POST') {
        // Headless: no folder dialog — the user types paths in Settings.
        return sendJson(res, 200, { path: null })
      }
      if (api === 'auth/start' && method === 'POST') {
        try { return sendJson(res, 200, await new TorboxAPI().getDeviceCode()) } catch (e: any) { return sendJson(res, 200, { success: false, error: e.message }) }
      }
      if (api === 'auth/user' && method === 'GET') {
        const settings = getSettings()
        if (!settings.torbox_token) return sendJson(res, 200, { success: false, error: 'No token' })
        try { return sendJson(res, 200, await new TorboxAPI(settings.torbox_token).getUserInfo()) } catch (e: any) { return sendJson(res, 200, { success: false, error: e.message }) }
      }
      if (api.startsWith('auth/poll/') && method === 'POST') {
        const deviceCode = api.split('/')[2]
        try {
          const resBody = await new TorboxAPI().getToken(deviceCode)
          if (resBody.success && resBody.data) {
            let token = resBody.data
            if (typeof token === 'object') token = token.access_token || token.token
            if (token) updateSettings({ torbox_token: token })
          }
          return sendJson(res, 200, resBody)
        } catch (e: any) { return sendJson(res, 200, { success: false, error: e.message }) }
      }
      if (api === 'settings/test-metasearch' && method === 'POST') {
        try {
          const ms = getMetaSearch()
          const results = await ms.search('ubuntu')
          return sendJson(res, 200, { success: true, detail: `MetaSearch ready — ${results.length} results from built-in plugins` })
        } catch (e: any) {
          return sendJson(res, 200, { success: false, error: e.message, detail: e.message })
        }
      }
      if (api === 'plugins/check' || api === 'plugins/update') return sendJson(res, 200, { success: false, error: 'Plugin management is not available in web mode' })
      if (api === 'logs' && method === 'GET') return sendJson(res, 200, [...logBuffer])
      if (api === 'version' && method === 'GET') return sendJson(res, 200, PKG.version || '1.0.0')

      // Real-Debrid
      if (api === 'rd/auth/start' && method === 'POST') {
        try { return sendJson(res, 200, await RealDebridAPI.getDeviceCode()) } catch (e: any) { return sendJson(res, 200, { success: false, error: e.message }) }
      }
      if (api.startsWith('rd/auth/poll/') && method === 'POST') {
        const deviceCode = api.split('/')[3]
        try {
          const credRes = await RealDebridAPI.getCredentials(RD_OPENSOURCE_CLIENT_ID, deviceCode)
          if (!credRes.success) return sendJson(res, 200, credRes)
          const { client_id, client_secret } = credRes.data
          if (!client_id || !client_secret) return sendJson(res, 200, { success: false, error: 'Invalid credentials response' })
          const tokenRes = await RealDebridAPI.getToken(client_id, client_secret, deviceCode)
          if (!tokenRes.success || !tokenRes.data) return sendJson(res, 200, { success: false, error: tokenRes.error || 'Failed to get token' })
          const { access_token, refresh_token } = tokenRes.data
          if (!access_token) return sendJson(res, 200, { success: false, error: 'No access token in response' })
          updateSettings({
            realdebrid_token: access_token,
            realdebrid_refresh_token: refresh_token || '',
            realdebrid_client_id: client_id,
            realdebrid_client_secret: client_secret,
          })
          return sendJson(res, 200, { success: true, data: { access_token } })
        } catch (e: any) { return sendJson(res, 200, { success: false, error: e.message }) }
      }
      if (api === 'rd/user' && method === 'GET') {
        const settings = getSettings()
        if (!settings.realdebrid_token) return sendJson(res, 200, { success: false, error: 'No token' })
        try { return sendJson(res, 200, await new RealDebridAPI(settings.realdebrid_token).getUserInfo()) } catch (e: any) { return sendJson(res, 200, { success: false, error: e.message }) }
      }
      if (api === 'rd/traffic' && method === 'GET') {
        const settings = getSettings()
        if (!settings.realdebrid_token) return sendJson(res, 200, { success: false, error: 'No token' })
        try { return sendJson(res, 200, await new RealDebridAPI(settings.realdebrid_token).getTraffic()) } catch (e: any) { return sendJson(res, 200, { success: false, error: e.message }) }
      }
      if (api === 'rd/select-files' && method === 'POST') {
        const settings = getSettings()
        const body = await readBody(req)
        if (!settings.realdebrid_token) return sendJson(res, 200, { success: false, error: 'No token' })
        try {
          const rd = new RealDebridAPI(settings.realdebrid_token)
          const infoRes = await rd.getTorrentInfo(body.torrentId)
          if (!infoRes.success || !infoRes.data) return sendJson(res, 200, { success: false, error: 'Failed to get torrent info' })
          const files = infoRes.data.files || []
          if (files.length === 0) return sendJson(res, 200, { success: false, error: 'No files in torrent' })
          const fileIds = files.map((f: any) => String(f.id))
          const selectRes = await rd.selectFiles(body.torrentId, fileIds)
          if (selectRes.success) {
            updateDownload(body.torrentId, { status: 'downloading' })
            eventBus.emit('downloads-updated')
          }
          return sendJson(res, 200, selectRes)
        } catch (e: any) { return sendJson(res, 200, { success: false, error: e.message }) }
      }

      // TMDB (spawns tmdb-provider.py)
      if (api.startsWith('tmdb/lists') && method === 'GET') {
        const settings = getSettings()
        if (!settings.tmdb_api_key) return sendJson(res, 200, { success: false, error: 'TMDB API key not configured' })
        const force = (req.url || '').includes('refresh=1')
        if (!force && listsCache && Date.now() - listsCache.at < LISTS_CACHE_TTL_MS) {
          return sendJson(res, 200, listsCache.body)
        }
        const body = await spawnTmdb('tmdb-provider.py', ['lists'], settings.tmdb_api_key)
        if (body?.success) listsCache = { at: Date.now(), body }
        return sendJson(res, 200, body)
      }
      if (api.startsWith('tmdb/detail/') && method === 'GET') {
        // api = "tmdb/detail/<id>/<type>" → skip 2 segments
        const [, , id, mediaType] = api.split('/')
        const settings = getSettings()
        if (!settings.tmdb_api_key) return sendJson(res, 200, { success: false, error: 'TMDB API key not configured' })
        return sendJson(res, 200, await spawnTmdb('tmdb-provider.py', ['detail', id, mediaType], settings.tmdb_api_key))
      }
      if (api.startsWith('tmdb/season/') && method === 'GET') {
        const [, , id, season] = api.split('/')
        const settings = getSettings()
        if (!settings.tmdb_api_key) return sendJson(res, 200, { success: false, error: 'TMDB API key not configured' })
        return sendJson(res, 200, await spawnTmdb('tmdb-provider.py', ['season', id, season], settings.tmdb_api_key))
      }
      if (api.startsWith('tmdb/search') && method === 'GET') {
        const settings = getSettings()
        if (!settings.tmdb_api_key) return sendJson(res, 200, { success: false, error: 'TMDB API key not configured' })
        return sendJson(res, 200, await spawnTmdb('tmdb-provider.py', ['search', url.searchParams.get('q') || ''], settings.tmdb_api_key))
      }
      if (api === 'tmdb/validate' && method === 'POST') {
        const body = await readBody(req)
        const data = await httpsGetJson(`https://api.themoviedb.org/3/configuration?api_key=${encodeURIComponent(body.apiKey || '')}`)
        if (data?.images) {
          updateSettings({ tmdb_api_key: body.apiKey })
          return sendJson(res, 200, { success: true })
        }
        return sendJson(res, 200, { success: false, error: data?.status_message || 'Invalid API key' })
      }

      // Latino search (spawns latino-providers.py --stream + Jackett)
      if (api === 'latino/search' && method === 'POST') {
        const body = await readBody(req)
        const args = ['--stream', body.imdbId, body.mediaType]
        if (body.season) args.push(body.season)
        if (body.episode) args.push(body.episode)
        // Pass the TMDB key so latino-providers.py can resolve Spanish titles
        const settings = getSettings()
        const env: Record<string, string> = {}
        if (settings.tmdb_api_key) env.TMDB_API_KEY = settings.tmdb_api_key

        // Build a Jackett query from the IMDB id (best effort — English title
        // via TMDB find + "SxxExx"), so Discover also gets indexer results.
        ensureSearchEnv(settings.tmdb_api_key || '')
        let jackettQuery = ''
        if (settings.tmdb_api_key) {
          const found = await httpsGetJson(
            `https://api.themoviedb.org/3/find/${body.imdbId}?external_source=imdb_id&api_key=${settings.tmdb_api_key}`
          )
          // NB: empty arrays are truthy in JS — must check .length before picking
          const mres: any[] = found?.movie_results || []
          const tres: any[] = found?.tv_results || []
          const hit = (mres.length ? mres : tres)[0]
          if (hit) {
            jackettQuery = hit.original_title || hit.original_name || hit.title || hit.name || ''
          }
        }
        if (jackettQuery && body.season && body.episode) {
          jackettQuery += ` S${body.season}E${body.episode}`
        }
        console.log(`[latino] jackettQuery="${jackettQuery}" imdb=${body.imdbId}`)

        const done = new Promise<void>((resolve) => {
          let open = 2
          const finish = () => { if (--open === 0) resolve() }

          const proc = spawnPython('latino-providers.py', args, env)
          let buffer = ''
          const timer = setTimeout(() => { proc.kill('SIGTERM'); finish() }, 45_000)
          proc.stdout?.on('data', (chunk: Buffer) => {
            buffer += chunk.toString('utf-8')
            const lines = buffer.split('\n')
            buffer = lines.pop() || ''
            for (const line of lines) {
              const trimmed = line.trim()
              if (!trimmed) continue
              try { eventBus.emit('latino-search-progress', JSON.parse(trimmed)) } catch { /* skip */ }
            }
          })
          proc.on('close', () => { clearTimeout(timer); finish() })
          proc.on('error', () => { clearTimeout(timer); finish() })

          if (jackettQuery) {
            // Jackett results arrive with engine_* shapes — remap to provider_*
            const jproc = spawnPython('meta-search.py', ['--stream', '--jackett-only', jackettQuery])
            let jbuf = ''
            const jtimer = setTimeout(() => { jproc.kill('SIGTERM'); finish() }, 40_000)
            jproc.stdout?.on('data', (chunk: Buffer) => {
              jbuf += chunk.toString('utf-8')
              const lines = jbuf.split('\n')
              jbuf = lines.pop() || ''
              for (const line of lines) {
                const trimmed = line.trim()
                if (!trimmed) continue
                try {
                  const ev = JSON.parse(trimmed)
                  if (ev.type === 'engine_start') {
                    eventBus.emit('latino-search-progress', { type: 'provider_start', provider: 'Jackett' })
                  } else if (ev.type === 'engine_results') {
                    eventBus.emit('latino-search-progress', { type: 'provider_results', provider: 'Jackett', results: ev.results || [] })
                  }
                } catch { /* skip */ }
              }
            })
            jproc.on('close', () => { clearTimeout(jtimer); finish() })
            jproc.on('error', (err: Error) => { console.error('[latino] jackett spawn error:', err.message); clearTimeout(jtimer); finish() })
          } else {
            finish()
          }
        })

        await done
        return sendJson(res, 200, { success: true })
      }

      // Stremio catalog
      if (api === 'catalog/manifest' && method === 'GET') return sendJson(res, 200, await catalogFetch('/manifest.json'))
      if (api.startsWith('catalog/items/') && method === 'GET') {
        const [, type, id] = api.split('/')
        return sendJson(res, 200, await catalogFetch(`/catalog/${type}/${id}.json`))
      }
      if (api.startsWith('catalog/meta/') && method === 'GET') {
        const [, type, imdbId] = api.split('/')
        return sendJson(res, 200, await catalogFetch(`/meta/${type}/${imdbId}.json`))
      }

      // Auto-update: not applicable in web mode
      if (api.startsWith('update/')) return sendJson(res, 200, { success: false, error: 'Auto-update is not available in web mode' })

      return notFound(res)
    } catch (err: any) {
      console.error('[server] route error:', err)
      return sendJson(res, 500, { success: false, error: err.message || 'Internal error' })
    }
  }

  // Static frontend (dist/)
  let filePath = p === '/' ? '/index.html' : p
  filePath = path.normalize(path.join(DIST_DIR, filePath))
  if (!filePath.startsWith(DIST_DIR)) return send(res, 403, 'text/plain', 'Forbidden')
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) filePath = path.join(DIST_DIR, 'index.html')
  if (!fs.existsSync(filePath)) return notFound(res)
  const ext = path.extname(filePath)
  const mime: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.map': 'application/json',
  }
  send(res, 200, mime[ext] || 'application/octet-stream', fs.readFileSync(filePath))
}

// ── Boot ─────────────────────────────────────────────────
initDB()
try { ensureSearchEnv(getSettings().tmdb_api_key || '') } catch (e: any) { console.error('[server] search env init failed:', e.message) }
try { initMetaSearch() } catch (e: any) { console.error('[server] metasearch init failed:', e.message) }
startWorker(null)
try { startMonitor() } catch (e: any) { console.error('[server] monitor start failed:', e.message) }

const server = http.createServer((req, res) => {
  route(req, res).catch((err) => {
    console.error('[server] unhandled route error:', err)
    try { sendJson(res, 500, { success: false, error: err.message }) } catch { /* already sent */ }
  })
})

server.listen(PORT, HOST, () => {
  console.log(`[server] MediaPilot web server listening on http://${HOST}:${PORT}`)
})

process.on('SIGTERM', () => {
  sseUnsubs.forEach((fn) => fn())
  try { stopMonitor() } catch { /* ignore */ }
  process.exit(0)
})
process.on('SIGINT', () => {
  sseUnsubs.forEach((fn) => fn())
  try { stopMonitor() } catch { /* ignore */ }
  process.exit(0)
})

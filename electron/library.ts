/**
 * Biblioteca (library management): scan the movies/series roots and delete
 * movies, seasons or single episodes RELIABLY.
 *
 * Rules learned from the arr era:
 *  - Deleting on disk alone is fine now that Sonarr/Radarr are gone, but the
 *    monitor must not silently re-grab what the user just deleted: history
 *    rows are KEPT by default (isGrabbed blocks re-downloads) and only
 *    cleared when the caller explicitly asks (forgetHistory).
 *  - Every path is validated to live INSIDE the configured root (no '..',
 *    no absolute escapes, symlinks resolved) before anything is removed.
 *  - Deletion removes the video + its sidecar subtitles, then prunes empty
 *    season/title folders, then asks Jellyfin to refresh its library.
 */
import path from 'path'
import fs from 'fs'
import { getSettings, getDB, type Settings } from './db'

const VIDEO_RE = /\.(mkv|mp4|avi|m4v|mov|wmv|ts|webm)$/i
const SUB_RE = /\.(srt|vtt|ass|ssa|sub)$/i
const SE_RE = /[sS](\d{1,2})[eE](\d{1,2})/
const ALT_SE_RE = /(?:^|[^\d])(\d{1,2})[xX](\d{2})(?:[^\d]|$)/
const YEAR_RE = /\(((?:19|20)\d{2})\)\s*$/
const SEASON_DIR_RE = /^(?:season|temporada)\s*(\d{1,3})$/i

export interface LibraryEpisode {
  file: string
  season: number | null
  episode: number | null
  sizeBytes: number
}
export interface LibrarySeason {
  season: number | null
  label: string
  dir: string
  sizeBytes: number
  episodes: LibraryEpisode[]
  otherFiles: number
}
export interface LibrarySeries {
  title: string
  year: string
  dir: string
  sizeBytes: number
  seasons: LibrarySeason[]
  looseVideos: string[]
  inWatchlist: boolean
  watchlistId: number | null
}
export interface LibraryMovie {
  title: string
  year: string
  dir: string
  sizeBytes: number
  videos: number
  inWatchlist: boolean
  watchlistId: number | null
  poster: string
}
export interface LibrarySnapshot {
  movies: LibraryMovie[]
  series: LibrarySeries[]
  roots: { movies: string; series: string }
  jellyfinConfigured: boolean
  posters: boolean
}

// ── Jellyfin index (para pósters) ─────────────────────────
interface JellyfinItem {
  Id: string
  Name: string
  Type: string
  ImageTags?: Record<string, string>
}

let jfIndexCache: { at: number; map: Map<string, JellyfinItem> } | null = null
const JF_INDEX_TTL_MS = 10 * 60 * 1000

function jfKey(type: string, folderName: string): string {
  const kind = type === 'Series' ? 'series' : 'movie'
  return `${kind}:${folderName.toLowerCase()}`
}

/** Índice de items de Jellyfin (id + tag de póster) por nombre de carpeta. */
async function jellyfinIndex(): Promise<Map<string, JellyfinItem>> {
  const settings = getSettings()
  const url = (settings.jellyfin_url || '').trim().replace(/\/+$/, '')
  const key = (settings.jellyfin_api_key || '').trim()
  if (!url || !key) return new Map()
  if (jfIndexCache && Date.now() - jfIndexCache.at < JF_INDEX_TTL_MS) return jfIndexCache.map
  const map = new Map<string, JellyfinItem>()
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 8_000)
    const res = await fetch(
      `${url}/Items?Recursive=true&IncludeItemTypes=Movie,Series&Fields=Path&api_key=${encodeURIComponent(key)}`,
      { signal: ctrl.signal },
    )
    clearTimeout(timer)
    if (res.ok) {
      const body: any = await res.json().catch(() => null)
      for (const item of body?.Items || []) {
        if (!item?.Id) continue
        const raw = String(item.Path || '').replace(/[/\\]+$/, '')
        const parts = raw.split(/[/\\]/).filter(Boolean)
        const base = parts[parts.length - 1] || ''
        const parent = parts[parts.length - 2] || ''
        // Movies: Jellyfin's Path points at the FILE → the folder is the parent.
        // Series: Path points at the show folder (its basename).
        const isSeries = String(item.Type || '') === 'Series'
        const candidates = isSeries ? [base, parent] : [parent, base]
        for (const name of candidates) {
          if (name && !name.includes('.')) map.set(jfKey(String(item.Type || ''), name), item as JellyfinItem)
        }
      }
      console.log(`[library] índice Jellyfin: ${map.size} items (pósters disponibles)`)
    } else {
      console.warn(`[library] Jellyfin index HTTP ${res.status} — sin pósters`)
    }
  } catch (e: any) {
    console.warn(`[library] Jellyfin index failed: ${e.message} — sin pósters`)
  }
  jfIndexCache = { at: Date.now(), map }
  return map
}

/** Póster (bytes) de un item de la biblioteca, proxied para no exponer la key. */
export async function fetchJellyfinPoster(folderName: string, kind: 'movie' | 'series'): Promise<{ buffer: Buffer; contentType: string } | null> {
  const settings = getSettings()
  const url = (settings.jellyfin_url || '').trim().replace(/\/+$/, '')
  const key = (settings.jellyfin_api_key || '').trim()
  if (!url || !key) return null
  const map = await jellyfinIndex()
  const item = map.get(jfKey(kind === 'series' ? 'Series' : 'Movie', path.basename(folderName)))
  if (!item || !item.ImageTags?.Primary) return null
  try {
    const res = await fetch(`${url}/Items/${item.Id}/Images/Primary?maxHeight=450&quality=90&tag=${encodeURIComponent(item.ImageTags.Primary)}&api_key=${encodeURIComponent(key)}`)
    if (!res.ok) return null
    const buffer = Buffer.from(await res.arrayBuffer())
    return { buffer, contentType: res.headers.get('content-type') || 'image/jpeg' }
  } catch { return null }
}

export function posterUrlFor(kind: 'movie' | 'series', folderName: string, hasPoster: boolean): string {
  if (!hasPoster) return ''
  const f = encodeURIComponent(path.basename(folderName))
  return `/api/library/poster?t=${kind}&f=${f}`
}

function humanSize(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = bytes
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1 }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

function statSafe(p: string): fs.Stats | null {
  try { return fs.statSync(p) } catch { return null }
}

function dirSize(dir: string): { bytes: number; files: number } {
  let bytes = 0
  let files = 0
  const walk = (d: string) => {
    let entries: fs.Dirent[] = []
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const full = path.join(d, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.isFile()) {
        const st = statSafe(full)
        if (st) { bytes += st.size; files += 1 }
      }
    }
  }
  walk(dir)
  return { bytes, files }
}

function parseTitleYear(folderName: string): { title: string; year: string } {
  const m = folderName.match(YEAR_RE)
  if (m) return { title: folderName.replace(YEAR_RE, '').trim(), year: m[1] }
  return { title: folderName, year: '' }
}

function parseEpisode(fileName: string): { season: number | null; episode: number | null } {
  const a = fileName.match(SE_RE)
  if (a) return { season: Number(a[1]), episode: Number(a[2]) }
  const b = fileName.match(ALT_SE_RE)
  if (b) return { season: Number(b[1]), episode: Number(b[2]) }
  return { season: null, episode: null }
}

function watchlistLookup(title: string, year: string): { inWatchlist: boolean; watchlistId: number | null } {
  try {
    const db = getDB()
    const row = db.prepare('SELECT id FROM watchlist WHERE lower(title) = lower(?) LIMIT 1').get(title) as any
    if (row) return { inWatchlist: true, watchlistId: row.id }
    // Try the "Demo2 (ES)"/"Demo2 (EN)" style mismatch: match by year + loose title prefix.
    const rows = db.prepare('SELECT id, title FROM watchlist').all() as any[]
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
    const nt = norm(title)
    for (const r of rows) {
      const nw = norm(String(r.title))
      if (nw && nt && (nw.startsWith(nt) || nt.startsWith(nw))) return { inWatchlist: true, watchlistId: r.id }
    }
  } catch { /* watchlist table may be empty */ }
  return { inWatchlist: false, watchlistId: null }
}

export async function scanLibrary(): Promise<LibrarySnapshot> {
  const settings = getSettings()
  const postering = await jellyfinIndex()
  const roots = {
    movies: (settings.movies_folder || '').trim(),
    series: (settings.series_folder || '').trim(),
  }
  const movies: LibraryMovie[] = []
  const series: LibrarySeries[] = []

  if (roots.movies && statSafe(roots.movies)?.isDirectory()) {
    for (const entry of fs.readdirSync(roots.movies, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const dir = path.join(roots.movies, entry.name)
      const { bytes } = dirSize(dir)
      let videos = 0
      for (const f of fs.readdirSync(dir)) if (VIDEO_RE.test(f)) videos += 1
      const { title, year } = parseTitleYear(entry.name)
      const wl = watchlistLookup(title, year)
      const hasPoster = Boolean(postering.get(jfKey('Movie', entry.name))?.ImageTags?.Primary)
      movies.push({ title, year, dir, sizeBytes: bytes, videos, poster: posterUrlFor('movie', entry.name, hasPoster), ...wl })
    }
    movies.sort((a, b) => a.title.localeCompare(b.title, 'es'))
  }

  if (roots.series && statSafe(roots.series)?.isDirectory()) {
    for (const entry of fs.readdirSync(roots.series, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const dir = path.join(roots.series, entry.name)
      const seasons: LibrarySeason[] = []
      const looseVideos: string[] = []
      for (const sub of fs.readdirSync(dir, { withFileTypes: true })) {
        const subPath = path.join(dir, sub.name)
        if (sub.isDirectory()) {
          const match = sub.name.match(SEASON_DIR_RE)
          const episodes: LibraryEpisode[] = []
          let otherFiles = 0
          let bytes = 0
          for (const f of fs.readdirSync(subPath, { withFileTypes: true })) {
            if (!f.isFile()) continue
            const st = statSafe(path.join(subPath, f.name))
            const size = st?.size || 0
            bytes += size
            if (VIDEO_RE.test(f.name)) {
              const se = parseEpisode(f.name)
              episodes.push({ file: f.name, season: se.season, episode: se.episode, sizeBytes: size })
            } else {
              otherFiles += 1
            }
          }
          episodes.sort((a, b) => (a.episode || 0) - (b.episode || 0))
          seasons.push({
            season: match ? Number(match[1]) : null,
            label: sub.name,
            dir: subPath,
            sizeBytes: bytes,
            episodes,
            otherFiles,
          })
        } else if (sub.isFile() && VIDEO_RE.test(sub.name)) {
          looseVideos.push(sub.name)
        }
      }
      seasons.sort((a, b) => (a.season || 0) - (b.season || 0))
      const { bytes } = dirSize(dir)
      const { title, year } = parseTitleYear(entry.name)
      const wl = watchlistLookup(title, year)
      series.push({ title, year, dir, sizeBytes: bytes, seasons, looseVideos, ...wl })
    }
    series.sort((a, b) => a.title.localeCompare(b.title, 'es'))
  }

  return {
    movies,
    series,
    roots,
    jellyfinConfigured: Boolean((settings.jellyfin_url || '').trim() && (settings.jellyfin_api_key || '').trim()),
    posters: postering.size > 0,
  }
}

// ── Safety ────────────────────────────────────────────────

function assertInsideRoot(root: string, target: string): string {
  if (!root) throw new Error('Root folder is not configured (Settings → Carpetas)')
  const realRoot = fs.realpathSync(root)
  const resolved = path.resolve(target)
  if (resolved === path.resolve(root) || resolved === realRoot) throw new Error('Refusing to delete the root folder itself')
  const realTarget = fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved
  const withSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep
  if (!realTarget.startsWith(withSep)) throw new Error('Refusing to delete outside the configured root folder')
  return realTarget
}

function assertSafeName(name: string): string {
  const clean = String(name || '').trim()
  if (!clean || clean.includes('/') || clean.includes('\\') || clean === '.' || clean === '..') {
    throw new Error('Invalid folder/file name')
  }
  return clean
}

/**
 * Resolve the absolute path to operate on. Accepts EITHER an absolute `dir`
 * inside the root (what the Biblioteca UI sends) OR a folder name to compose
 * (legacy callers/tests). Every resulting path is validated inside the root.
 */
export function resolveTargetPath(
  root: string,
  opts: { dir?: string; title?: string; sub?: string; file?: string },
): string {
  let target = ''
  const dir = (opts.dir || '').trim()
  if (dir) {
    target = assertInsideRoot(root, dir)
  } else {
    const title = assertSafeName(opts.title || '')
    target = assertInsideRoot(root, path.join(root, title))
  }
  if (opts.sub) target = assertInsideRoot(root, path.join(target, assertSafeName(opts.sub)))
  if (opts.file) target = assertInsideRoot(root, path.join(target, assertSafeName(opts.file)))
  return target
}

function removeVideosWithSidecars(dir: string, fileNames: string[]): string[] {
  const removed: string[] = []
  const sidecars: string[] = []
  for (const f of fileNames) {
    const full = path.join(dir, f)
    if (fs.existsSync(full)) { fs.rmSync(full, { force: true }); removed.push(full) }
    const stem = f.replace(/\.[^./\\]+$/, '')
    for (const entry of fs.readdirSync(dir)) {
      if (SUB_RE.test(entry) && entry.startsWith(stem + '.')) {
        sidecars.push(path.join(dir, entry))
      }
    }
  }
  for (const s of sidecars) { try { fs.rmSync(s, { force: true }); removed.push(s) } catch { /* ignore */ } }
  return removed
}

function pruneIfEmpty(dir: string, stopAt: string): string[] {
  const pruned: string[] = []
  const stop = path.resolve(stopAt)
  let current = path.resolve(dir)
  while (current !== stop && current.startsWith(stop + path.sep)) {
    let entries: string[] = []
    try { entries = fs.readdirSync(current) } catch { break }
    if (entries.length > 0) break
    try {
      fs.rmdirSync(current)
      pruned.push(current)
    } catch { break }
    current = path.dirname(current)
  }
  return pruned
}

/** Rows of grab_history that make MediaPilot think this target is already done. */
function forgetHistoryRows(watchlistId: number, opts: { season?: number | null; episode?: number | null; wholeSeries?: boolean }): number {
  const db = getDB()
  try {
    if (opts.wholeSeries) {
      const r = db.prepare('DELETE FROM grab_history WHERE watchlist_id = ?').run(watchlistId)
      try { db.prepare('DELETE FROM monitor_attempts WHERE tmdb_id = (SELECT tmdb_id FROM watchlist WHERE id = ?)').run(watchlistId) } catch { /* table may not exist */ }
      return r.changes
    }
    if (opts.season !== null && opts.season !== undefined && opts.episode === null) {
      return db.prepare('DELETE FROM grab_history WHERE watchlist_id = ? AND season = ?').run(watchlistId, opts.season).changes
    }
    if (opts.season !== null && opts.season !== undefined && opts.episode !== null && opts.episode !== undefined) {
      return db.prepare('DELETE FROM grab_history WHERE watchlist_id = ? AND season = ? AND episode = ?').run(watchlistId, opts.season, opts.episode).changes
    }
    return db.prepare('DELETE FROM grab_history WHERE watchlist_id = ? AND kind = ?').run(watchlistId, 'movie').changes
  } catch (e: any) {
    console.warn(`[library] forgetHistory failed: ${e.message}`)
    return 0
  }
}

export async function jellyfinRefresh(): Promise<{ sent: boolean; error?: string }> {
  const settings: Settings = getSettings()
  const url = (settings.jellyfin_url || '').trim().replace(/\/+$/, '')
  const key = (settings.jellyfin_api_key || '').trim()
  if (!url || !key) return { sent: false, error: 'Jellyfin no configurado (Settings → Jellyfin)' }
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 10_000)
    const res = await fetch(`${url}/Library/Refresh`, { method: 'POST', headers: { 'X-Emby-Token': key }, signal: ctrl.signal })
    clearTimeout(timer)
    if (res.status === 204 || res.ok) {
      console.log('[library] Jellyfin library refresh solicitado')
      return { sent: true }
    }
    return { sent: false, error: `Jellyfin respondió ${res.status}` }
  } catch (e: any) {
    return { sent: false, error: e?.message || 'Jellyfin refresh failed' }
  }
}

export interface DeleteResult {
  ok: boolean
  error?: string
  removedFiles: string[]
  prunedFolders: string[]
  freedBytes: number
  forgottenRows: number
  jellyfin: { sent: boolean; error?: string }
  inWatchlist: boolean
}

function emptyResult(): DeleteResult {
  return { ok: false, removedFiles: [], prunedFolders: [], freedBytes: 0, forgottenRows: 0, jellyfin: { sent: false }, inWatchlist: false }
}

/** Delete a whole movie folder (video + subs + extras). */
export async function deleteMovie(targetPath: string, forgetHistory: boolean): Promise<DeleteResult> {
  const out = emptyResult()
  try {
    const settings = getSettings()
    const target = assertInsideRoot(settings.movies_folder, targetPath)
    const st = statSafe(target)
    if (!st || !st.isDirectory()) throw new Error(`Movie folder not found: ${path.basename(target)}`)
    const name = path.basename(target)
    const { bytes, files } = dirSize(target)
    const wl = watchlistLookup(parseTitleYear(name).title, parseTitleYear(name).year)
    out.inWatchlist = wl.inWatchlist
    fs.rmSync(target, { recursive: true, force: true })
    out.removedFiles.push(`${target} (${files} archivos)`)
    out.freedBytes = bytes
    if (forgetHistory && wl.watchlistId) out.forgottenRows = forgetHistoryRows(wl.watchlistId, { wholeSeries: true })
    out.jellyfin = await jellyfinRefresh()
    out.ok = true
    console.log(`[library] película eliminada: "${name}" — ${files} archivo(s), ${humanSize(bytes)} liberados`)
  } catch (e: any) {
    out.error = e.message
    console.error(`[library] deleteMovie failed: ${e.message}`)
  }
  return out
}

/** Delete one season folder of a series; prunes the series folder if it empties. */
export async function deleteSeason(targetPath: string, forgetHistory: boolean): Promise<DeleteResult> {
  const out = emptyResult()
  try {
    const settings = getSettings()
    const target = assertInsideRoot(settings.series_folder, targetPath)
    const st = statSafe(target)
    if (!st || !st.isDirectory()) throw new Error(`Season folder not found: ${path.basename(target)}`)
    const sub = path.basename(target)
    const seriesDir = path.dirname(target)
    const name = path.basename(seriesDir)
    const { bytes, files } = dirSize(target)
    const seasonMatch = sub.match(SEASON_DIR_RE)
    const seasonNum = seasonMatch ? Number(seasonMatch[1]) : null
    const wl = watchlistLookup(parseTitleYear(name).title, parseTitleYear(name).year)
    out.inWatchlist = wl.inWatchlist
    fs.rmSync(target, { recursive: true, force: true })
    out.removedFiles.push(`${target} (${files} archivos)`)
    out.freedBytes = bytes
    out.prunedFolders.push(...pruneIfEmpty(seriesDir, path.resolve(settings.series_folder)))
    if (forgetHistory && wl.watchlistId && seasonNum !== null) out.forgottenRows = forgetHistoryRows(wl.watchlistId, { season: seasonNum, episode: null })
    out.jellyfin = await jellyfinRefresh()
    out.ok = true
    console.log(`[library] temporada eliminada: "${name}" / ${sub} — ${files} archivo(s), ${humanSize(bytes)} liberados`)
  } catch (e: any) {
    out.error = e.message
    console.error(`[library] deleteSeason failed: ${e.message}`)
  }
  return out
}

/** Delete a single episode file (plus its subtitles); prunes empty folders. */
export async function deleteEpisode(targetPath: string, forgetHistory: boolean): Promise<DeleteResult> {
  const out = emptyResult()
  try {
    const settings = getSettings()
    const target = assertInsideRoot(settings.series_folder, targetPath)
    const st = statSafe(target)
    if (!st || !st.isFile()) throw new Error(`Episode file not found: ${path.basename(target)}`)
    const seasonDir = path.dirname(target)
    const seriesDir = path.dirname(seasonDir)
    const file = path.basename(target)
    const name = path.basename(seriesDir)
    out.freedBytes = st.size
    const removed = removeVideosWithSidecars(seasonDir, [file])
    out.removedFiles.push(...removed.map((r) => r))
    out.prunedFolders.push(...pruneIfEmpty(seasonDir, path.resolve(settings.series_folder)))
    const se = parseEpisode(file)
    const wl = watchlistLookup(parseTitleYear(name).title, parseTitleYear(name).year)
    out.inWatchlist = wl.inWatchlist
    if (forgetHistory && wl.watchlistId && se.season !== null && se.episode !== null) {
      out.forgottenRows = forgetHistoryRows(wl.watchlistId, { season: se.season, episode: se.episode })
    }
    out.jellyfin = await jellyfinRefresh()
    out.ok = true
    console.log(`[library] episodio eliminado: "${name}" / ${path.basename(seasonDir)} / ${file} — ${humanSize(st.size)} liberados`)
  } catch (e: any) {
    out.error = e.message
    console.error(`[library] deleteEpisode failed: ${e.message}`)
  }
  return out
}

/** Delete an entire series folder (all seasons + extras). */
export async function deleteSeries(targetPath: string, forgetHistory: boolean): Promise<DeleteResult> {
  const out = emptyResult()
  try {
    const settings = getSettings()
    const target = assertInsideRoot(settings.series_folder, targetPath)
    const st = statSafe(target)
    if (!st || !st.isDirectory()) throw new Error(`Series folder not found: ${path.basename(target)}`)
    const name = path.basename(target)
    const { bytes, files } = dirSize(target)
    const wl = watchlistLookup(parseTitleYear(name).title, parseTitleYear(name).year)
    out.inWatchlist = wl.inWatchlist
    fs.rmSync(target, { recursive: true, force: true })
    out.removedFiles.push(`${target} (${files} archivos)`)
    out.freedBytes = bytes
    if (forgetHistory && wl.watchlistId) out.forgottenRows = forgetHistoryRows(wl.watchlistId, { wholeSeries: true })
    out.jellyfin = await jellyfinRefresh()
    out.ok = true
    console.log(`[library] serie eliminada: "${name}" — ${files} archivo(s), ${humanSize(bytes)} liberados`)
  } catch (e: any) {
    out.error = e.message
    console.error(`[library] deleteSeries failed: ${e.message}`)
  }
  return out
}

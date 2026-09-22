// grabber.ts — automated grab engine: given a concrete target (movie or a
// single episode), search latino providers first, fall back to English
// (Jackett) per the item's language profile, rank the candidates, then add
// the winner to the debrid service and snapshot the exact destination folder
// on the download row so the worker routes it without re-parsing.
import path from 'path'
import { getSettings, addDownload, getDownloadByTorboxId, updateDownload, deleteDownload, getBadReleaseHashes, getBadReleaseTitles, normalizeReleaseTitle, addBadRelease, type Settings, type DebridService, type LanguageProfile } from './db'
import { recordGrab } from './watchlist'
import { runPythonLines, setupSearchEnv } from './python-run'
import { computeDestination, safeSegment, seriesNameMatches, releaseYear, getAltTitlesCached } from './media-layout'
import { TorboxAPI } from './torbox'
import { RealDebridAPI } from './realdebrid'
import { eventBus } from './event-bus'
import { tmdbDetail } from './tmdb'
import { isVideoName, probeAddedTorrent, type RemoteFile } from './preflight'
import { getAccountStatus, isInCooldown, cooldownFilter, cooldownLabel } from './debrid-status'
import { meetsMinQuality, parseQualitySetting, qualityLabel } from './quality'

export type GrabLanguage = 'latino' | 'english'

/** Cuántos candidatos se validan por fase antes de rendirse (ver preflight). */
const MAX_CANDIDATES_PER_PHASE = 3

export interface GrabTarget {
  watchlist_id: number
  tmdb_id: number
  media_type: 'movie' | 'series'
  imdb_id?: string
  title: string
  original_title?: string
  year?: string
  kind: 'movie' | 'episode'
  season?: number
  episode?: number
  language_profile: LanguageProfile
  /** 'upgrade' = solo fase latino, para reemplazo manual EN → latino. */
  mode?: 'upgrade'
  /**
   * Duración esperada (min). Se usa para validar el release ANTES de bajar el
   * archivo: un episodio/película homónima dura otra cosa (Demo7 2015 =
   * 43 min vs 2024 = 53 min). Si falta, el preflight no bloquea nada.
   */
  runtime_min?: number
  /**
   * Títulos alternativos de TMDB. Los rellena `grab()`/`findLatinoForUpgrade()`
   * antes de puntuar: hay releases que usan el título alternativo
   * ("Special Ops Demo9" para "Demo9") y sin ellos se rechazarían.
   */
  alt_titles?: string[]
}

export interface GrabResultItem {
  title: string
  size: string
  seeders: number
  peers: number
  link: string
  indexer: string
  info_hash: string | null
  latino: boolean
  /** Presente en la caché del debrid (bajada instantánea, sin depender de seeds). */
  cached?: boolean
  /** Bytes del archivo de video real según la caché (mejor dato que el del índice). */
  videoBytes?: number
}

export interface GrabOutcome {
  ok: boolean
  status: 'grabbed' | 'no_source' | 'error' | 'cooldown'
  language?: 'latino' | 'english'
  source?: string
  service?: DebridService
  torbox_id?: string
  title?: string
  error?: string
  latinoResults: number
  englishResults: number
  profile: LanguageProfile
  /** El latino ya está publicado en la web (sólo descarga directa) → no se baja inglés. */
  latinoDdl?: { url: string; ddl: string[] }
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function numSeeders(r: GrabResultItem): number {
  const n = Number(r.seeders)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function hashFromLink(link: string): string | null {
  if (!link) return null
  const m = link.match(/btih:([a-fA-F0-9]{40})/)
  return m ? m[1].toLowerCase() : null
}

/** Normalize a size field ("5.4 GB", "1234567", "2,1GB", "0 B") to bytes. */
export function parseSizeBytes(size: unknown): number | null {
  if (size === null || size === undefined) return null
  if (typeof size === 'number') return Number.isFinite(size) && size >= 0 ? Math.round(size) : null
  const s = String(size).trim().toLowerCase().replace(/\s+/g, '').replace(',', '.')
  if (!s) return null
  const m = s.match(/^(\d+(?:\.\d+)?)(b|bytes?|kb|mb|gb|tb)?$/)
  if (!m) return null
  const val = parseFloat(m[1])
  if (!Number.isFinite(val)) return null
  const unit = m[2]
  if (!unit) {
    const raw = Number(s)
    return Number.isFinite(raw) ? Math.round(raw) : null
  }
  const mult: Record<string, number> = { b: 1, bytes: 1, byte: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 }
  return Math.round(val * (mult[unit] ?? 1))
}

export function exceedsMaxBytes(result: GrabResultItem, maxBytes: number | null): boolean {
  if (!maxBytes) return false
  const bytes = parseSizeBytes(result.size)
  if (bytes === null || bytes <= 0) return false // unknown size — never block on it
  return bytes > maxBytes
}

/** Collect every SxxExx pair mentioned in a release title. */
function epMarkers(title: string): Array<{ s: number; e: number }> {
  const out: Array<{ s: number; e: number }> = []
  const re = /\bs(\d{1,2})\s*e(\d{1,2})\b/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(title))) out.push({ s: parseInt(m[1], 10), e: parseInt(m[2], 10) })
  return out
}

function hasSeasonPackToken(title: string): boolean {
  return /(season|temporada|serie completa|complete series|full season|complete season)\s*\d*|(^|\W)(s\d{1,2})\s*(completa|completo|full|complete)(\W|$)/i.test(title)
}

/** Score a candidate for a specific target. Higher wins; drop below -500. */
function scoreResult(r: GrabResultItem, target: GrabTarget): number {
  const t = (r.title || '').trim()
  if (!t) return -1000
  const hash = r.info_hash || hashFromLink(r.link)
  if (!hash) return -900 // cannot add to debrid without an infohash/magnet

  let score = 0
  const lower = t.toLowerCase()

  if (target.kind === 'episode') {
    const markers = epMarkers(t)
    if (markers.length === 0) {
      // A season pack with no SxxExx at all would pull the entire season —
      // never acceptable for a single-episode grab (user policy: no backfill).
      return -800
    }
    const exact = markers.some((x) => x.s === target.season && x.e === target.episode)
    if (!exact) return -800
    const others = markers.filter((x) => !(x.s === target.season && x.e === target.episode))
    if (others.length === 0) score += 120 // single-episode release — ideal
    else if (others.every((x) => x.s === target.season && Math.abs(x.e - target.episode!) <= 2)) score += 40 // small range incl. ours
    else score -= 200 // wide/other episodes
    if (hasSeasonPackToken(t)) score -= 150
    if (/(repack|proper|real\s|v2\b)/i.test(lower)) score += 25
    // Preferencia de calidad (igual que en películas): mejor imagen primero.
    if (/(1080p|1080)/i.test(lower)) score += 60
    else if (/(2160p|4k\b|uhd)/i.test(lower)) score += 80
    else if (/(720p)/i.test(lower)) score += 30
    // ¿Es de la serie que buscamos? "Demo7 S02E03 720p WEBRip x264-MATTER"
    // (serie Dark, 2017) aparecía en la búsqueda de "Demo7" porque el
    // grupo del release parece parte del título. Los proveedores latino se
    // buscan por IMDB id, así que ahí solo se penaliza (nombres localizados).
    if (!seriesNameMatches(t, [target.title, target.original_title], target.alt_titles || [])) {
      if (!r.latino) return -750
      score -= 250
    } else if (target.year) {
      // Homónimas (Demo7 2015 vs 2024): los grupos incluyen el año de
      // estreno justo para distinguirlas — si viene, tiene que coincidir.
      const y = releaseYear(t)
      if (y === parseInt(String(target.year), 10)) score += 50
      else if (y) score -= 250
    }
  } else {
    // movie
    const yearMatch = t.match(/\b(19|20)\d{2}\b/)
    if (yearMatch && target.year) {
      if (yearMatch[0] === target.year) score += 40
      else score -= 120
    }
    if (/(camrip|cam\b|telesync|ts\b|hdcam|screener|telecine)/i.test(lower)) score -= 400
    if (/(1080p|1080)/i.test(lower)) score += 60
    else if (/(2160p|4k\b|uhd)/i.test(lower)) score += 80
    else if (/(720p)/i.test(lower)) score += 30
    if (/(web-?dl|bluray|remux|webrip)/i.test(lower)) score += 20
    if (/(repack|proper)/i.test(lower)) score += 20
  }

  // Language-specific penalties happen at the phase level, not here.
  // Seeders are the final tiebreak applied by the caller.
  // Reject releases whose title suggests non-EN/non-ES audio (cyrillic, CJK,
  // arabic scripts) — those are dubbed tracks, never what a grab wants.
  if (/[\u0400-\u04FF\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF\u0600-\u06FF]/.test(lower)) score -= 350
  // Ya está en la caché del debrid: se puede bajar al instante y no depende de
  // seeds (los releases latino suelen tener 0). Es un plus, no un requisito.
  if (r.cached) score += 25
  return score
}

export function chooseBest(results: GrabResultItem[], target: GrabTarget): GrabResultItem | null {
  let best: GrabResultItem | null = null
  let bestScore = -Infinity
  for (const r of results) {
    const s = scoreResult(r, target)
    if (s < -500) continue
    if (s > bestScore || (s === bestScore && numSeeders(r) > numSeeders(best!))) {
      best = r
      bestScore = s
    }
  }
  return best
}

function dedupeResults(results: GrabResultItem[]): GrabResultItem[] {
  const seen = new Map<string, GrabResultItem>()
  for (const r of results) {
    const key = (r.info_hash || hashFromLink(r.link) || r.link || '').toLowerCase()
    if (!key) continue
    const prev = seen.get(key)
    if (!prev || numSeeders(r) > numSeeders(prev)) seen.set(key, r)
  }
  return [...seen.values()]
}

/** Candidatos ordenados por puntuación (los inválidos quedan fuera). */
function rankCandidates(results: GrabResultItem[], target: GrabTarget): GrabResultItem[] {
  return results
    .map((r) => ({ r, score: scoreResult(r, target) }))
    .filter((x) => x.score >= -500)
    .sort((a, b) => (b.score - a.score) || (numSeeders(b.r) - numSeeders(a.r)))
    .map((x) => x.r)
}

/**
 * Valida los candidatos contra la caché de TorBox (una sola llamada, cero
 * tráfico de descarga):
 *  - descarta los torrents que NO traen ningún video (falsos rellenos de
 *    .zipx/.rar/.exe/.url, típicos de algunos grupos en los indexers) y los
 *    manda a la lista negra: antes se añadían, se esperaba la descarga y sólo
 *    al final se descubría que no había episodio.
 *  - marca los que ya están en caché y el tamaño REAL de su video.
 * Si la caché no se puede consultar, devuelve los resultados intactos.
 */
async function annotateWithCache(settings: Settings, results: GrabResultItem[]): Promise<GrabResultItem[]> {
  if (results.length === 0) return results
  if (!serviceOrder(settings).includes('torbox')) return results
  const hashes = [...new Set(results.map((r) => String(r.info_hash || '').toLowerCase()).filter((h) => /^[a-f0-9]{40}$/.test(h)))]
  if (hashes.length === 0) return results
  const tb = new TorboxAPI(settings.torbox_token)
  const byHash = new Map<string, any>()
  for (let i = 0; i < hashes.length; i += 40) {
    const chunk = hashes.slice(i, i + 40)
    try {
      const res = await tb.checkCached(chunk)
      for (const item of (Array.isArray(res?.data) ? res.data : [])) {
        const h = String(item?.hash || '').toLowerCase()
        if (h) byHash.set(h, item)
      }
    } catch (e: any) {
      console.warn(`[grab] caché no consultable (${e.message}) — preflight de caché omitido`)
      return results
    }
  }
  const out: GrabResultItem[] = []
  let junk = 0
  for (const r of results) {
    const h = String(r.info_hash || '').toLowerCase()
    const info = h ? byHash.get(h) : undefined
    if (!info) { out.push(r); continue }
    const files: RemoteFile[] = (info.files || []).map((f: any) => ({
      id: Number(f?.id),
      name: String(f?.name || ''),
      size: Number(f?.size) || 0,
    }))
    const videos = files.filter((f) => isVideoName(f.name))
    if (files.length > 0 && videos.length === 0) {
      junk += 1
      addBadRelease(h, 'torrent sin archivo de video (falso: sólo .zipx/.rar/.exe/.url)', r.title)
      console.log(`[grab] ✗ descartado antes de añadirlo (sólo archivos no-video): ${r.title} [${r.indexer}]`)
      continue
    }
    const video = videos.length ? videos.reduce((a, b) => (b.size > a.size ? b : a), videos[0]) : null
    out.push({ ...r, cached: true, videoBytes: video ? video.size : undefined })
  }
  if (junk > 0) console.log(`[grab] ${junk} release(s) sin video descartados por la caché`)
  return out
}

/**
 * Preflight del release YA añadido al debrid, antes de que el worker baje un
 * solo byte: ¿trae video? ¿su duración corresponde al episodio/película? Un
 * "no" aquí evita la descarga completa del archivo y el borrado posterior.
 * Ante cualquier duda (sin runtime, sin enlace, contenedor sin duración en la
 * cabecera) devuelve ok=true: nunca bloquea por falta de datos.
 */
async function preflightAdded(
  settings: Settings,
  service: DebridService,
  torrentId: string,
  target: GrabTarget,
): Promise<{ ok: boolean; reason?: string; durationMin?: number | null; inconclusive?: boolean }> {
  const expected = Number(target.runtime_min || 0) || null
  const kind: 'movie' | 'episode' = target.kind === 'movie' ? 'movie' : 'episode'
  try {
    if (service === 'torbox') {
      const tb = new TorboxAPI(settings.torbox_token)
      return await probeAddedTorrent({
        kind,
        expectedMin: expected,
        getFiles: async () => {
          const info = await tb.getTorrentInfo(torrentId)
          const data = info?.data
          const raw = Array.isArray(data) ? data[0] : data
          return (raw?.files || []).map((f: any) => ({
            id: Number(f?.id),
            name: String(f?.name || ''),
            size: Number(f?.size) || 0,
          }))
        },
        getLink: async (fileId) => {
          const link = await tb.getDownloadLink(torrentId, fileId)
          return link && link.success !== false && typeof link.data === 'string' ? link.data : null
        },
      })
    }
    // Real-Debrid: mismo sondeo usando unrestrict sobre el enlace del archivo.
    const rd = new RealDebridAPI(settings.realdebrid_token)
    let links: string[] = []
    return await probeAddedTorrent({
      kind,
      expectedMin: expected,
      getFiles: async () => {
        const info = await rd.getTorrentInfo(torrentId)
        const data = info?.data || {}
        links = Array.isArray(data.links) ? data.links : []
        return (data.files || []).map((f: any, idx: number) => ({
          id: Number(f?.id ?? idx + 1),
          name: String(f?.path || f?.name || '').replace(/^\//, ''),
          size: Number(f?.bytes) || 0,
        }))
      },
      getLink: async (fileId) => {
        const idx = Number(fileId) - 1
        const raw = links[idx] || (links.length === 1 ? links[0] : null)
        if (!raw) return null
        const un = await rd.unrestrictLink(raw)
        return un && un.success !== false && typeof un.data?.download === 'string' ? un.data.download : null
      },
    })
  } catch (e: any) {
    console.warn(`[grab] preflight no concluyente (${e.message})`)
    return { ok: true, inconclusive: true }
  }
}

/** Descarta un candidato ya añadido: borra el torrent remoto y la fila local. */
async function abortAddedCandidate(settings: Settings, service: DebridService, torrentId: string, wasNew: boolean): Promise<void> {
  try {
    if (wasNew) {
      if (service === 'torbox') await new TorboxAPI(settings.torbox_token).controlTorrent(torrentId, 'delete')
      else await new RealDebridAPI(settings.realdebrid_token).deleteTorrent(torrentId)
    }
  } catch (e: any) {
    console.warn(`[grab] no se pudo borrar el torrent rechazado en ${service}: ${e.message}`)
  }
  try {
    deleteDownload(torrentId)
    eventBus.emit('downloads-updated')
  } catch { /* ignore */ }
}

/** Estado de la web de Cinecalidad: ¿el latino ya está publicado? */
export interface LatinoSiteCheck {
  provider: string
  published: boolean | null
  has_magnet: boolean
  ddl: string[]
  url: string
}

/** Latino providers by IMDB id — mirrors the Discover-tab flow. */
async function searchLatino(
  target: GrabTarget,
  apiKey: string,
): Promise<{ items: GrabResultItem[]; site: LatinoSiteCheck | null }> {
  const args = ['--stream', target.imdb_id || '', target.media_type]
  if (target.kind === 'episode' && target.season && target.episode) {
    args.push(String(target.season), String(target.episode))
  }
  const env: Record<string, string> = {}
  if (apiKey) env.TMDB_API_KEY = apiKey
  const startedAt = Date.now()
  const events = await runPythonLines('latino-providers.py', args, env, 75_000)
  const providerCounts = new Map<string, number>()
  let site: LatinoSiteCheck | null = null
  for (const ev of events) {
    if (ev && ev.type === 'provider_results' && Array.isArray(ev.results)) {
      providerCounts.set(String(ev.provider || '?'), (providerCounts.get(String(ev.provider || '?')) || 0) + ev.results.length)
    }
    if (ev && ev.site && typeof ev.site === 'object') {
      site = {
        provider: String(ev.provider || 'web'),
        published: ev.site.published === true ? true : ev.site.published === false ? false : null,
        has_magnet: Boolean(ev.site.has_magnet),
        ddl: Array.isArray(ev.site.ddl) ? ev.site.ddl.map(String) : [],
        url: String(ev.site.url || ''),
      }
    }
  }
  const counts = [...providerCounts.entries()].map(([p, n]) => `${p}: ${n}`).join(' · ') || 'sin eventos'
  const who = target.kind === 'episode' && target.season && target.episode
    ? `${target.title} S${pad2(target.season)}E${pad2(target.episode)}`
    : `${target.title} (${target.year || '?'})`
  const siteNote = site ? ` · web: ${site.published === true ? (site.has_magnet ? 'publicado (con torrent)' : `publicado sólo DDL${site.ddl.length ? ` (${site.ddl.slice(0, 3).join('/')})` : ''}`) : 'sin publicar'}` : ''
  console.debug(`[grab] latino ▸ ${who}: ${counts}${siteNote} (${((Date.now() - startedAt) / 1000).toFixed(1)}s)`)
  const out: GrabResultItem[] = []
  for (const ev of events) {
    if (ev && ev.type === 'provider_results' && Array.isArray(ev.results)) {
      for (const r of ev.results) {
        out.push({
          title: r.title || '',
          size: r.size || '0 B',
          seeders: Number(r.seeders) || 0,
          peers: Number(r.peers) || 0,
          link: r.link || '',
          indexer: r.indexer || ev.provider || 'latino',
          info_hash: r.info_hash || hashFromLink(r.link),
          latino: true,
        })
      }
    }
  }
  return { items: dedupeResults(out), site }
}

/** English fallback via Jackett (meta-search.py --jackett-only). */
async function searchEnglish(target: GrabTarget): Promise<GrabResultItem[]> {
  const base = (target.original_title || target.title || '').trim()
  if (!base) return []
  let query = base
  if (target.kind === 'movie') {
    if (target.year) query = `${base} ${target.year}`
  } else if (target.season && target.episode) {
    query = `${base} S${pad2(target.season)}E${pad2(target.episode)}`
  }
  const startedAt = Date.now()
  const events = await runPythonLines('meta-search.py', ['--stream', '--jackett-only', query], {}, 70_000)
  console.debug(`[grab] jackett ▸ "${query}": ${events.length} eventos (${((Date.now() - startedAt) / 1000).toFixed(1)}s)`)
  const out: GrabResultItem[] = []
  for (const ev of events) {
    if (ev && ev.type === 'engine_results' && Array.isArray(ev.results)) {
      for (const r of ev.results) {
        out.push({
          title: r.title || '',
          size: r.size || '0 B',
          seeders: Number(r.seeders) || 0,
          peers: Number(r.peers) || 0,
          link: r.link || '',
          indexer: r.indexer || ev.engine || 'Jackett',
          info_hash: r.info_hash || hashFromLink(r.link),
          latino: false,
        })
      }
    }
  }
  return dedupeResults(out)
}

/**
 * Búsqueda SOLO latino para el escáner de reemplazo manual EN → latino.
 * Respeta el tope de tamaño por tipo; devuelve el mejor candidato o null.
 */
export async function findLatinoForUpgrade(target: GrabTarget): Promise<GrabResultItem | null> {
  const settings = getSettings()
  const apiKey = settings.tmdb_api_key || ''
  setupSearchEnv(settings)
  let imdbId = target.imdb_id || ''
  if (!imdbId && apiKey) {
    try {
      const detail = await tmdbDetail(target.tmdb_id, target.media_type)
      imdbId = detail?.imdb_id || ''
    } catch { /* no key or network */ }
  }
  if (!imdbId) return null
  if (!target.alt_titles || target.alt_titles.length === 0) {
    try { target.alt_titles = await getAltTitlesCached(target.tmdb_id, target.media_type) } catch { /* se puntúa sin ellos */ }
  }
  const capGb = target.kind === 'movie' ? settings.max_movie_size_gb : settings.max_series_size_gb
  const maxBytes = capGb > 0 ? capGb * 1024 ** 3 : null
  let results: GrabResultItem[] = []
  try {
    results = (await searchLatino({ ...target, imdb_id: imdbId }, apiKey)).items
  } catch (e: any) {
    console.warn(`[grab] upgrade scan error "${target.title}": ${e.message}`)
    return null
  }
  if (maxBytes && results.some((r) => exceedsMaxBytes(r, maxBytes))) {
    results = results.filter((r) => !exceedsMaxBytes(r, maxBytes))
  }
  // Misma validación de caché que en el grab: no ofrecer como "versión latina
  // disponible" un torrent que en realidad no trae ningún video.
  results = await annotateWithCache(settings, results)
  return rankCandidates(results, target)[0] || null
}

function serviceOrder(settings: Settings): DebridService[] {
  const prefs: DebridService[] = []
  const preferred: DebridService = settings.automation_service === 'realdebrid' ? 'realdebrid' : 'torbox'
  const alt: DebridService = preferred === 'torbox' ? 'realdebrid' : 'torbox'
  if (preferred === 'torbox' ? settings.torbox_token : settings.realdebrid_token) prefs.push(preferred)
  if (settings.automation_failover && prefs.length === 0) {
    if (alt === 'torbox' ? settings.torbox_token : settings.realdebrid_token) prefs.push(alt)
  } else if (settings.automation_failover) {
    if (alt === 'torbox' ? settings.torbox_token : settings.realdebrid_token) prefs.push(alt)
  }
  return prefs
}

async function addToService(
  settings: Settings,
  service: DebridService,
  result: GrabResultItem,
  type: 'movie' | 'series',
  destFolder: string,
  opts: { runtimeMin?: number | null; deferred?: boolean } = {},
): Promise<{ ok: boolean; torboxId?: string; error?: string; wasNew?: boolean }> {
  const hash = result.info_hash || hashFromLink(result.link)
  const isMagnet = Boolean(hash && /^magnet:/.test(result.link)) || Boolean(hash && !/^https?:/i.test(result.link) && result.link.startsWith('magnet'))
  const url = result.link || (hash ? `magnet:?xt=urn:btih:${hash}` : '')
  // `deferred`: la fila nace en local_status 'preflight' para que el worker no
  // empiece a bajar hasta que el preflight (video/duración) la libere. Sin eso,
  // un tick del worker podía lanzar la descarga del archivo equivocado antes de
  // validarlo.
  const extra: Record<string, unknown> = {}
  if (opts.runtimeMin && Number.isFinite(Number(opts.runtimeMin))) extra.expected_runtime_min = Number(opts.runtimeMin)
  if (opts.deferred) extra.local_status = 'preflight'
  try {
    if (service === 'torbox') {
      const tb = new TorboxAPI(settings.torbox_token)
      const res = hash && (isMagnet || !/^https?:\/\//i.test(result.link))
        ? await tb.addMagnet(url)
        : await tb.addTorrentFromUrl(result.link)
      if (!res || res.success === false) return { ok: false, error: res?.detail || res?.error || 'TorBox add failed' }
      const { id } = TorboxAPI.torrentIdentity(res.data)
      if (!id) return { ok: false, error: 'TorBox did not return a torrent id' }
      const existing = getDownloadByTorboxId(id)
      if (existing) updateDownload(id, { name: result.title.slice(0, 300), service: 'torbox', type, dest_folder: destFolder, ...extra })
      else addDownload({ torbox_id: id, name: result.title.slice(0, 300), status: 'pending', progress: 0, service: 'torbox', type, dest_folder: destFolder, ...extra })
      eventBus.emit('downloads-updated')
      return { ok: true, torboxId: id, wasNew: !existing }
    }
    const rd = new RealDebridAPI(settings.realdebrid_token)
    const res = hash && (isMagnet || !/^https?:\/\//i.test(result.link))
      ? await rd.addMagnet(url)
      : await rd.addTorrentFromUrl(result.link)
    if (!res || res.success === false) return { ok: false, error: res?.error || 'Real-Debrid add failed' }
    const { id } = RealDebridAPI.torrentIdentity(res.data)
    if (!id) return { ok: false, error: 'Real-Debrid did not return a torrent id' }
    const existing = getDownloadByTorboxId(id)
    if (existing) updateDownload(id, { name: result.title.slice(0, 300), service: 'realdebrid', type, dest_folder: destFolder, ...extra })
    else addDownload({ torbox_id: id, name: result.title.slice(0, 300), status: 'waiting_files_selection', progress: 0, service: 'realdebrid', type, dest_folder: destFolder, ...extra })
    eventBus.emit('downloads-updated')
    return { ok: true, torboxId: id, wasNew: !existing }
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) }
  }
}

async function computeDestFolder(settings: Settings, target: GrabTarget): Promise<string | null> {
  try {
    let releaseName = target.title
    if (target.kind === 'episode' && target.season && target.episode) {
      releaseName = `${target.title} S${pad2(target.season)}E${pad2(target.episode)}`
    } else if (target.year) {
      releaseName = `${target.title} (${target.year})`
    }
    const type: 'movie' | 'series' = target.kind === 'movie' ? 'movie' : 'series'
    const { root, folder } = await computeDestination(settings, releaseName, type, {
      tmdbId: target.tmdb_id,
      extraTitles: [target.title, target.original_title].filter(Boolean) as string[],
      year: Number(target.year) || undefined,
    })
    if (!root) return null
    return path.join(root, ...folder.split('/').map(safeSegment))
  } catch (e: any) {
    console.error(`[grab] destination failed for "${target.title}": ${e.message}`)
    return null
  }
}

/**
 * Grab one concrete target (movie or single episode) for a watchlist item.
 * Language order comes from the item's profile:
 *   latino_first  → latino, then english
 *   latino_only   → latino only
 *   english_first → english, then latino
 */
export async function grab(target: GrabTarget): Promise<GrabOutcome> {
  const base: GrabOutcome = {
    ok: false,
    status: 'no_source',
    latinoResults: 0,
    englishResults: 0,
    profile: target.language_profile,
  }
  const settings = getSettings()
  const services = serviceOrder(settings)
  if (services.length === 0) {
    base.status = 'error'
    base.error = 'No debrid account configured (TorBox/Real-Debrid token missing)'
    return base
  }
  const apiKey = settings.tmdb_api_key || ''
  setupSearchEnv(settings)

  // IMDB id is mandatory for latino providers — resolve it lazily if missing.
  let imdbId = target.imdb_id || ''
  if (!imdbId && apiKey) {
    try {
      const detail = await tmdbDetail(target.tmdb_id, target.media_type)
      imdbId = detail?.imdb_id || ''
    } catch { /* no key or network */ }
  }
  // Títulos alternativos (TMDB) antes de puntuar: hay releases con el título
  // alternativo ("Special Ops Demo9") que si no se rechazarían por nombre.
  if (!target.alt_titles || target.alt_titles.length === 0) {
    try { target.alt_titles = await getAltTitlesCached(target.tmdb_id, target.media_type) } catch { /* se puntúa sin ellos */ }
  }
  const targetWithImdb = { ...target, imdb_id: imdbId }

  const destFolder = await computeDestFolder(settings, target)
  if (!destFolder) {
    base.status = 'error'
    base.error = 'Destination folder not configured (set movies/series folders in Settings)'
    return base
  }
  // Topes de tamaño por tipo: 0 = sin límite. Solo aplican a grabs automáticos.
  const capGb = target.kind === 'movie' ? settings.max_movie_size_gb : settings.max_series_size_gb
  const maxBytes = capGb > 0 ? capGb * 1024 ** 3 : null

  const phaseOrder: Array<'latino' | 'english'> =
    target.mode === 'upgrade' ? ['latino']
      : target.language_profile === 'latino_only' ? ['latino']
        : target.language_profile === 'english_first' ? ['english', 'latino']
          : ['latino', 'english']

  // Estado de la web de Cinecalidad para esta búsqueda latina (ver searchLatino).
  let latinoSite: LatinoSiteCheck | null = null
  let latinoSiteOnlyDdl = false

  // Cooldown del debrid (spec B10): en cooldown sólo entran releases que el
  // debrid ya tiene cacheados. Se lee una vez por grab (cacheado 10 min).
  const account = await getAccountStatus({ token: settings.automation_service === 'torbox' ? settings.torbox_token : undefined })
  const inCooldown = isInCooldown(account)
  if (inCooldown) {
    console.log(`[TorBox] cuenta en cooldown hasta ${cooldownLabel(account)} — sólo se pueden añadir releases ya cacheados`)
  }
  let cooldownHit = false

  for (const phase of phaseOrder) {
    if (phase === 'latino' && !imdbId) continue
    if (phase === 'english' && !process.env.JACKETT_API_KEY) {
      console.warn('[grab] English phase skipped — no Jackett API key available')
      continue
    }
    // Sin torrent latino pero con el episodio YA publicado en la web de
    // Cinecalidad (sólo descarga directa): el latino existe, así que no se baja
    // el inglés. Se deja el objetivo en backoff para reintentar y avisar.
    if (phase === 'english' && latinoSiteOnlyDdl && target.language_profile !== 'english_first') {
      const ddl = latinoSite!.ddl.slice(0, 3).join(', ')
      console.log(`[grab] latino publicado en la web sólo como descarga directa${ddl ? ` (${ddl})` : ''} — se omite el inglés y se reintenta más tarde: ${latinoSite!.url || 'sin url'}`)
      base.status = 'no_source'
      base.error = 'Latino ya publicado en Cinecalidad (sólo descarga directa) — esperando versión torrent'
      base.latinoDdl = { url: latinoSite!.url, ddl: latinoSite!.ddl }
      try {
        eventBus.emit('latino-ddl-pending', {
          title: target.title,
          media_type: target.media_type,
          season: target.season ?? null,
          episode: target.episode ?? null,
          url: latinoSite!.url,
          ddl: latinoSite!.ddl,
        })
      } catch { /* el aviso no puede romper el grab */ }
      return base
    }
    let results: GrabResultItem[] = []
    try {
      if (phase === 'latino') {
        const latino = await searchLatino(targetWithImdb, apiKey)
        results = latino.items
        latinoSite = latino.site
        latinoSiteOnlyDdl = Boolean(latino.site && latino.site.published === true && !latino.site.has_magnet)
      } else {
        results = await searchEnglish(target)
      }
    } catch (e: any) {
      console.error(`[grab] ${phase} search error for "${target.title}": ${e.message}`)
      continue
    }
    // Lista negra: releases ya descartados (p. ej. el episodio de OTRA serie con
    // el mismo título, detectado por duración al descargar). Compara por hash
    // y, si no hay hash, por título normalizado del release.
    const badHashes = getBadReleaseHashes()
    const badTitles = getBadReleaseTitles()
    if (results.length > 0 && (badHashes.size > 0 || badTitles.size > 0)) {
      const before = results.length
      results = results.filter((r) => {
        const hash = String(r.info_hash || '').toLowerCase()
        if (hash && badHashes.has(hash)) return false
        const norm = normalizeReleaseTitle(String(r.title || ''))
        if (norm && badTitles.has(norm)) return false
        return true
      })
      if (results.length !== before) {
        console.log(`[grab] ${phase}: ${before - results.length} resultado(s) descartados por lista negra`)
      }
    }
    // Preflight de caché: descarta lo que no trae video y marca lo cacheado.
    results = await annotateWithCache(settings, results)
    if (results.length === 0) continue
    if (phase === 'latino') base.latinoResults = results.length
    else base.englishResults = results.length

    // Tope de tamaño por tipo (configurable): descarta releases gigantes; si
    // TODAS exceden el tope, la fase se omite y se reintenta con backoff.
    if (maxBytes && results.some((r) => exceedsMaxBytes(r, maxBytes))) {
      const kept = results.filter((r) => !exceedsMaxBytes(r, maxBytes))
      if (kept.length === 0) {
        console.log(`[grab] ${phase}: todas las releases superan el tope de ${capGb} GB (${target.kind === 'movie' ? 'película' : 'serie'}) — omitidas ("${target.title}")`)
        continue
      }
      results = kept
    }

    const type: 'movie' | 'series' = target.kind === 'movie' ? 'movie' : 'series'
    // Calidad mínima (spec B11): el usuario fijó 1080p; 720p y menores no se
    // bajan. Sin resolución en el nombre no se descarta (no bloquear por falta
    // de datos). Los añadidos a mano los elige el usuario y no pasan por aquí.
    const minQuality = parseQualitySetting(settings.min_video_quality)
    if (minQuality > 0) {
      const below = results.filter((r) => !meetsMinQuality(String(r.title || ''), minQuality))
      if (below.length > 0) {
        results = results.filter((r) => meetsMinQuality(String(r.title || ''), minQuality))
        console.debug(`[grab] ${phase}: ${below.length} release(s) por debajo de ${qualityLabel(minQuality)} descartados ("${target.title}")`)
        if (results.length === 0) continue
      }
    }
    let candidates = rankCandidates(results, target).slice(0, MAX_CANDIDATES_PER_PHASE)
    if (candidates.length === 0) {
      console.debug(`[grab] ${phase}: ${results.length} resultado(s) pero ninguno válido para el objetivo`)
      continue
    }
    // En cooldown sólo se prueban los cacheados; los demás fallarían en el debrid
    // y ALARGAN el cooldown (medido: 03:59 → 08:03 UTC en la cuenta real).
    if (inCooldown) {
      const { usable, skipped } = cooldownFilter(candidates, true)
      if (skipped.length > 0) {
        console.debug(`[grab] ${phase}: ${skipped.length} candidato(s) no cacheados omitidos — debrid en cooldown`)
        cooldownHit = true
      }
      candidates = usable
      if (candidates.length === 0) continue
    }
    console.log(`[grab] ${phase}: ${candidates.length} candidato(s) a validar — primero: ${candidates[0].title} (${candidates[0].size}) [${candidates[0].indexer}]${candidates[0].cached ? ' (en caché)' : ''}`)

    // Se prueban los candidatos en orden: si uno se añade pero el preflight lo
    // rechaza (sin video, duración de otra serie), se descarta, se manda a la
    // lista negra y se pasa al siguiente EN LA MISMA PASADA — sin esperar al
    // reintento con backoff del monitor.
    for (const candidate of candidates) {
      let addedVia: DebridService | null = null
      let addedTorboxId = ''
      for (const svc of services) {
        const added = await addToService(settings, svc, candidate, type, destFolder, {
          runtimeMin: target.runtime_min,
          deferred: true,
        })
        if (!added.ok || !added.torboxId) {
          base.status = 'error'
          base.error = added.error || `Failed to add via ${svc}`
          continue
        }
        const check = await preflightAdded(settings, svc, added.torboxId, target)
        if (!check.ok) {
          const reason = String(check.reason || 'release descartado en la validación previa')
          console.warn(`[grab] ✗ ${candidate.title} [${candidate.indexer}]: ${reason}`)
          if (candidate.info_hash || candidate.title) addBadRelease(candidate.info_hash || '', reason, candidate.title)
          await abortAddedCandidate(settings, svc, added.torboxId, added.wasNew !== false)
          base.status = 'no_source'
          base.error = reason
          continue
        }
        // Validado: se libera la fila para que el worker descargue.
        try {
          updateDownload(added.torboxId, { local_status: 'pending' })
          eventBus.emit('downloads-updated')
        } catch { /* la fila se libera igualmente en el siguiente arranque */ }
        if (check.inconclusive) {
          console.debug(`[grab] preflight de "${candidate.title}": sin datos para validar la duración (no bloquea)`)
        } else if (check.durationMin) {
          console.log(`[grab] ✓ preflight OK — ${check.durationMin.toFixed(1)} min (esperado ${Number(target.runtime_min).toFixed(1)} min): ${candidate.title}`)
        }
        addedVia = svc
        addedTorboxId = String(added.torboxId)
        break
      }
      if (!addedVia) continue
      base.ok = true
      base.status = 'grabbed'
      base.language = phase === 'latino' ? 'latino' : 'english'
      base.source = candidate.indexer || (phase === 'latino' ? 'latino' : 'jackett')
      base.service = addedVia
      base.torbox_id = addedTorboxId
      base.title = candidate.title.slice(0, 300)
      try {
        recordGrab({
          watchlist_id: target.watchlist_id,
          tmdb_id: target.tmdb_id,
          media_type: target.media_type,
          season: target.kind === 'episode' ? target.season ?? null : null,
          episode: target.kind === 'episode' ? target.episode ?? null : null,
          kind: target.kind === 'movie' ? 'movie' : 'episode',
          title: candidate.title,
          language: phase === 'latino' ? 'latino' : 'english',
          source: candidate.indexer || '',
          status: 'grabbed',
          torbox_id: addedTorboxId,
          info_hash: candidate.info_hash || hashFromLink(candidate.link) || '',
          dest_folder: destFolder,
        })
      } catch (e: any) {
        console.error('[grab] history write failed:', e.message)
      }
      console.log(`[grab] ✓ ${target.media_type} "${target.title}"${target.kind === 'episode' ? ` S${target.season}E${target.episode}` : ''} → ${phase} (${candidate.indexer}) via ${addedVia} → ${destFolder}`)
      return base
    }
  }
  // Cooldown del debrid (spec B10): si lo único que había eran releases no
  // cacheados, el objetivo no es "sin fuente" — está diferido. El monitor usa ese
  // estado para NO gastar intento/backoff (cada intento alarga el cooldown).
  if (cooldownHit) {
    base.status = 'cooldown'
    base.error = `debrid en cooldown (${cooldownLabel(account)}) y sin releases cacheados`
  }
  return base
}

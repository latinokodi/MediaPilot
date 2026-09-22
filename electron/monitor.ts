// monitor.ts — Sonarr/Radarr-style automation loop for the watchlist.
//
// Semantics (matching how Sonarr/Radarr actually work):
//  - The TMDB air/release DATE decides when a target becomes WANTED.
//    Nothing is searched before it is wanted.
//  - When a target becomes wanted the monitor attempts it once right away
//    (next tick after the date passes), then only retries on a decaying
//    backoff schedule (attempts.ts: 1h → 2h → 4h → 8h → 12h → daily),
//    persisted across restarts. Ticks are cheap dispatchers, not blanket
//    per-episode searches every cycle.
//  - A target stops being wanted once grabbed or the item is removed.
import { getSettings, updateSettings, countPipelineDownloads, type WatchlistItem, type BackfillScope } from './db'
import { listWatchlist, updateWatchlistItem, isGrabbed, getWatchlistItem, englishGrabbedRows, markReplacePending, latestGrabFor } from './watchlist'
import { getAttempt, attemptsForTitle, recordAttempt, deleteAttempt, shouldDeferAttempt, nextAttemptAfterFailure, type MonitorAttempt } from './attempts'
import { posterBackfillPatch } from './posters'
import { grab, findLatinoForUpgrade, type GrabTarget, type GrabOutcome } from './grabber'
import { tmdbDetail, tmdbSeason } from './tmdb'
import { setupSearchEnv } from './python-run'
import { eventBus } from './event-bus'
import { healLibrary, type HealResult } from './library-heal'
import { reconcileDebrid, reconcileDue } from './debrid-reconcile'
import { getAccountStatus, isInCooldown, cooldownLabel } from './debrid-status'
import { jellyfinRefresh } from './library'

export interface MonitorStatus {
  enabled: boolean
  intervalMinutes: number
  running: boolean
  lastRun: string | null
  lastSummary: { processed: number; grabbed: number; waiting: number; deferred: number; errors: number } | null
  /** Descargas en cola o en curso y tope configurado. */
  queueDepth: number
  maxConcurrent: number
}

let tickTimer: NodeJS.Timeout | null = null
let backfillTimer: NodeJS.Timeout | null = null
let reconcileTimer: NodeJS.Timeout | null = null
let running = false
let backfillBusy = false
let lastRun: string | null = null
let lastSummary: MonitorStatus['lastSummary'] = null

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

function isoDateOf(isoOrDate: string): string {
  return String(isoOrDate || '').slice(0, 10)
}

function fmtNext(season?: number, episode?: number, airDate?: string): string {
  if (!season || !episode) return ''
  const s = String(season).padStart(2, '0')
  const e = String(episode).padStart(2, '0')
  return `S${s}E${e}${airDate ? ` — ${isoDateOf(airDate)}` : ''}`
}

export function getMonitorStatus(): MonitorStatus {
  const s = getSettings()
  return {
    enabled: Boolean(s.monitor_enabled),
    intervalMinutes: Number(s.monitor_interval_minutes) || 30,
    running,
    lastRun,
    lastSummary,
    queueDepth: countPipelineDownloads(),
    maxConcurrent: Math.max(1, Number(s.max_concurrent_downloads) || 3),
  }
}

function log(...args: any[]): void {
  console.log(`[Monitor]`, ...args)
}

interface DueTarget {
  kind: 'movie' | 'episode'
  season?: number
  episode?: number
  // true = already in the attempts table (backoff state exists, retry path)
  tracked?: boolean
  /** Duración esperada (min) según TMDB — la usa el preflight del release. */
  runtime?: number
  /** Fecha de emisión (YYYY-MM-DD): decide el orden de la cola. */
  air_date?: string
}

/**
 * Duración "de la serie" cuando TMDB no la trae por episodio (habitual en el
 * capítulo recién emitido): mediana de `episode_run_time`. Sin esto un episodio
 * de otra serie homónima de 43 min pasaba sin ser detectado.
 */
function seriesFallbackRuntime(detail: any): number | undefined {
  const list = (detail?.episode_run_time || []).map((n: any) => Number(n)).filter((n: number) => Number.isFinite(n) && n > 0)
  if (list.length === 0) return undefined
  const sorted = [...list].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

// Backfill scopes (Sonarr-style "what to download when I add this series").
const MAX_TARGETS_PER_TICK = 5 // big backfills spread across ticks, politely
const SEASON_SCAN_BUDGET = 6 // max TMDB season fetches per series per tick
/** Por encima de esto se rota una ventana de temporadas en vez de escanearlas todas. */
const MAX_SEASONS_SCANNED = 20
const scanCursor = new Map<number, number>() // rotation cursor for 'all' scope

/**
 * Lista de episodios de una temporada, cacheada. La cola de backfill recorre
 * las temporadas cada pocos segundos; sin caché serían decenas de llamadas a
 * TMDB por minuto. La lista de episodios ya emitidos no cambia, así que un TTL
 * corto basta (y el tick normal sigue viendo los recién emitidos).
 */
const seasonCache = new Map<string, { at: number; data: any }>()
const SEASON_CACHE_TTL_MS = 10 * 60 * 1000

async function tmdbSeasonCached(tmdbId: number, seasonNumber: number): Promise<any> {
  const key = `${tmdbId}:${seasonNumber}`
  const hit = seasonCache.get(key)
  if (hit && Date.now() - hit.at < SEASON_CACHE_TTL_MS) return hit.data
  const data = await tmdbSeason(tmdbId, seasonNumber)
  seasonCache.set(key, { at: Date.now(), data })
  return data
}

/**
 * Episodes of ONE season that are wanted under the item's backfill scope.
 * Rules (aired-only; future handled by later ticks):
 *   new          → air_date >= item.added_at (no backfill)
 *   last_episode → the single most recently aired episode of the current
 *                  season, plus everything airing from the add date onward
 *   last_season  → every aired episode of the current season
 *   first_season → every aired episode of season 1
 *   all          → every aired episode of every season
 */
async function seasonWantedEpisodes(
  item: WatchlistItem,
  seasonNumber: number,
  scope: BackfillScope,
  currentSeason: number,
): Promise<DueTarget[]> {
  const today = todayIso()
  const addedDate = isoDateOf(item.added_at)
  const epList = await tmdbSeasonCached(item.tmdb_id, seasonNumber)
  const episodes: any[] = epList?.episodes || []

  let latestAired: string | null = null
  if (scope === 'last_episode' && seasonNumber === currentSeason) {
    for (const ep of episodes) {
      const airDate = isoDateOf(ep?.air_date || '')
      if (airDate && airDate <= today && (!latestAired || airDate > latestAired)) latestAired = airDate
    }
  }

  const out: DueTarget[] = []
  for (const ep of episodes) {
    const airDate = isoDateOf(ep?.air_date || '')
    if (!airDate || airDate > today) continue // unaired or no date
    const epNum = Number(ep?.episode_number)
    if (!epNum) continue
    const postAdd = airDate >= addedDate

    let allowed = false
    if (scope === 'new') allowed = postAdd
    else if (scope === 'last_episode') allowed = postAdd || airDate === latestAired
    else if (scope === 'last_season') allowed = postAdd || seasonNumber === currentSeason
    else if (scope === 'first_season') allowed = postAdd || seasonNumber === 1
    else allowed = true // 'all'
    if (!allowed) continue

    if (isGrabbed(item.tmdb_id, 'series', seasonNumber, epNum)) continue
    out.push({
      kind: 'episode',
      season: seasonNumber,
      episode: epNum,
      tracked: Boolean(getAttempt(item.tmdb_id, 'series', seasonNumber, epNum)),
      runtime: Number(ep?.runtime) > 0 ? Number(ep.runtime) : undefined,
      air_date: airDate,
    })
  }
  return out
}

/** One grab attempt for a concrete wanted target, with backoff bookkeeping. */
async function attemptTarget(item: WatchlistItem, detail: any, target: DueTarget, opts: { force?: boolean } = {}): Promise<'grabbed' | 'waiting' | 'error'> {
  const isMovie = target.kind === 'movie'
  const season = isMovie ? null : (target.season ?? null)
  const episode = isMovie ? null : (target.episode ?? null)

  const profile = item.language_profile
  const attemptNumber = (getAttempt(item.tmdb_id, item.media_type, season, episode)?.attempts || 0) + 1
  const label = isMovie
    ? `"${item.title}"`
    : `"${item.title}" S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`
  log(`→ intento ${attemptNumber} — ${label} (perfil: ${profile})`)

  const targetForGrab: GrabTarget = {
    watchlist_id: item.id,
    tmdb_id: item.tmdb_id,
    media_type: item.media_type,
    imdb_id: item.imdb_id || detail?.imdb_id || undefined,
    title: detail?.original_title || item.title,
    year: detail?.year || undefined,
    kind: isMovie ? 'movie' : 'episode',
    season: season ?? undefined,
    episode: episode ?? undefined,
    language_profile: profile,
    // Duración esperada: sin esto no hay forma barata de saber que un release
    // es de otra serie/película homónima. El episodio recién emitido suele no
    // traer runtime en TMDB → se cae a la duración típica de la serie.
    runtime_min: isMovie
      ? (Number(detail?.runtime) > 0 ? Number(detail.runtime) : undefined)
      : (Number(target.runtime) > 0 ? Number(target.runtime) : seriesFallbackRuntime(detail)),
  }

  let outcome: GrabOutcome
  try {
    outcome = await grab(targetForGrab)
  } catch (e: any) {
    outcome = { ok: false, status: 'error', error: e?.message || String(e), latinoResults: 0, englishResults: 0, profile }
  }

  if (outcome.status === 'grabbed') {
    deleteAttempt(item.tmdb_id, item.media_type, season, episode)
    log(`✓ ${label} → ${outcome.language} (${outcome.source}) [${outcome.service}]`)
    return 'grabbed'
  }

  // Debrid en cooldown (spec B10): NO es falta de fuente ni un fallo del
  // episodio. No se consume intento (sin backoff) y se avisa una vez por ventana:
  // martillear durante el cooldown lo ALARGA (medido: 03:59 → 08:03 UTC).
  if (outcome.status === 'cooldown') {
    logCoolDownOnce(item, outcome.error)
    return 'waiting'
  }

  // Missed (no source) or failed — schedule the next attempt with backoff.
  // Una comprobación manual (force) que falla NO consume intento ni toca la
  // ventana: la fila queda como estaba (spec B18, regla 2).
  const delayMin = nextAttemptAfterFailure(Boolean(opts.force), attemptNumber)
  if (delayMin === undefined) {
    log(`⌕ ${label} comprobación manual: sin fuente ahora mismo — no consume intento (la ventana de reintento sigue igual)`)
  } else {
    recordAttempt(item.tmdb_id, item.media_type, season, episode, isMovie ? 'movie' : 'episode', profile, delayMin)
  }
  const retryText = delayMin === undefined ? 'sin cambiar la ventana de reintento' : `reintento en ${delayMin} min`
  // El latino ya está publicado en la web (sólo descarga directa): NO es una
  // falta de fuente, es una espera deliberada a que salga el torrent latino.
  if (outcome.latinoDdl) {
    const ddl = (outcome.latinoDdl.ddl || []).slice(0, 3).join(', ')
    log(`⏳ ${label} latino ya publicado en Cinecalidad${ddl ? ` (${ddl})` : ''} — sólo descarga directa, no se baja inglés; ${retryText}`)
    return 'waiting'
  }
  if (outcome.status === 'error') {
    log(`✗ ${label} error: ${outcome.error} — ${retryText}`)
    return 'error'
  }
  if (attemptNumber === 1) {
    log(`— ${label} sin fuente latino/EN todavía — ${retryText}`)
  } else {
    console.debug(`[Monitor] ${label}: aún sin fuente (intento ${attemptNumber}) — ${retryText}`)
  }
  return 'waiting'
}

/**
 * Aviso de cooldown, una vez por ventana (no por episodio): el log se llenaba de
 * "no return a torrent id" episodio tras episodio sin decir la causa real.
 */
let lastCooldownLog = 0
function logCoolDownOnce(item: WatchlistItem, error?: string): void {
  const now = Date.now()
  if (now - lastCooldownLog < 10 * 60_000) return
  lastCooldownLog = now
  log(`⏸ debrid en cooldown — "${item.title}" y el resto quedan en espera sin gastar reintentos (${error || 'sólo entran releases cacheados'})`)
}

async function refreshNextEpisode(item: WatchlistItem, detail: any): Promise<void> {
  try {
    if (item.media_type !== 'series') return
    const nex = detail?.next_episode_to_air
    if (nex?.season_number && nex?.episode_number) {
      updateWatchlistItem(item.id, { next_episode: fmtNext(nex.season_number, nex.episode_number, nex.air_date) })
    }
  } catch { /* cosmetic only */ }
}

const DETAIL_TTL_MS = 12 * 60 * 60 * 1000
const detailCache = new Map<number, { at: number; detail: any }>()

async function fetchDetailCached(item: WatchlistItem): Promise<any | null> {
  const cached = detailCache.get(item.tmdb_id)
  if (cached && Date.now() - cached.at < DETAIL_TTL_MS) return cached.detail
  try {
    const detail = await tmdbDetail(item.tmdb_id, item.media_type)
    if (detail) {
      detailCache.set(item.tmdb_id, { at: Date.now(), detail })
      return detail
    }
  } catch (e: any) {
    log(`detail fetch error for "${item.title}": ${e.message}`)
  }
  return cached?.detail ?? null
}

async function checkItem(
  item: WatchlistItem,
  opts: { force?: boolean } = {},
): Promise<{ grabbed: number; waiting: number; deferred: number; errors: number }> {
  const res = { grabbed: 0, waiting: 0, deferred: 0, errors: 0 }
  const detail = await fetchDetailCached(item)
  if (!detail) {
    res.errors += 1
    updateWatchlistItem(item.id, { last_checked: new Date().toISOString() })
    return res
  }
  if (!item.imdb_id && detail.imdb_id) updateWatchlistItem(item.id, { imdb_id: detail.imdb_id })
  // Póster/fondo: si faltan, se rellenan con lo que trae TMDB (spec B20, regla 3).
  // Nunca pisa lo que ya había.
  const posterPatch = posterBackfillPatch(item, detail)
  if (Object.keys(posterPatch).length) updateWatchlistItem(item.id, posterPatch)
  await refreshNextEpisode(item, detail)

  if (item.media_type === 'movie') {
    const movieTargets: DueTarget[] = []
    const trackedMovie = getAttempt(item.tmdb_id, 'movie', null, null)
    if (trackedMovie) {
      movieTargets.push({ kind: 'movie', tracked: true })
    } else {
      const releaseDate = isoDateOf(detail?.release_date || '')
      const status = detail?.status || ''
      if (releaseDate && releaseDate <= todayIso() && !/cancelled|rumored/i.test(status) && !isGrabbed(item.tmdb_id, 'movie', null, null)) {
        movieTargets.push({ kind: 'movie', runtime: Number(detail?.runtime) > 0 ? Number(detail.runtime) : undefined }) // wanted right now — first attempt
      }
    }
    const movieState = movieTargets.length
      ? (movieTargets[0].tracked ? 'reintento (backoff)' : 'estrenada — intento inmediato')
      : isGrabbed(item.tmdb_id, 'movie', null, null)
        ? 'ya descargada'
        : 'futura / no disponible'
    console.debug(`[Monitor] "${item.title}" (película) — ${movieState}`)
    for (const t of movieTargets) {
      if (t.tracked) {
        const att = getAttempt(item.tmdb_id, 'movie', null, null)
        if (!att) continue // row vanished — nothing to retry
        if (shouldDeferAttempt(att, new Date().toISOString(), opts.force)) {
          res.deferred += 1
          continue
        }
        if (isGrabbed(item.tmdb_id, 'movie', null, null)) {
          deleteAttempt(item.tmdb_id, 'movie', null, null)
          continue
        }
      }
      const state = await attemptTarget(item, detail, t, { force: opts.force })
      if (state === 'grabbed') res.grabbed += 1
      else if (state === 'error') res.errors += 1
      else res.waiting += 1
    }
    // Idle (not wanted yet) items simply contribute nothing to the summary.
    updateWatchlistItem(item.id, { last_checked: new Date().toISOString() })
    return res
  }

  // series — wanted episodes depend on the per-title backfill scope.
  const { targets, seasonTag, scope } = await collectSeriesTargets(item, detail)
  // El tick normal se queda con un puñado de objetivos (no busca en cada
  // vuelta por toda la serie); los ya emitidos los va sacando la cola de
  // backfill, que solo está limitada por las descargas simultáneas.
  const tickTargets = targets.slice(0, MAX_TARGETS_PER_TICK)
  const targetNames = tickTargets
    .map((t) => (t.kind === 'movie' ? 'película' : `${t.tracked ? '*' : ''}S${String(t.season).padStart(2, '0')}E${String(t.episode).padStart(2, '0')}`))
    .join(', ')
  if (tickTargets.length > 0) {
    console.debug(`[Monitor] "${item.title}" [${seasonTag} · alcance ${scope}] → ${tickTargets.length} objetivo(s): ${targetNames}`)
  } else {
    console.debug(`[Monitor] "${item.title}" [${seasonTag} · alcance ${scope}] — sin objetivos (idle)`)
  }
  await attemptTargets(item, detail, tickTargets, res, { force: opts.force })
  // Idle series (nothing wanted under its scope) contribute nothing.
  updateWatchlistItem(item.id, { last_checked: new Date().toISOString() })
  return res
}

/**
 * Episodios ya emitidos que corresponden a una serie bajo su alcance de
 * backfill, ordenados (más nuevos primero). Sin recorte: el llamador decide
 * cuántos intenta.
 */
async function collectSeriesTargets(
  item: WatchlistItem,
  detail: any,
): Promise<{ targets: DueTarget[]; seasonTag: string; scope: BackfillScope }> {
  const scope: BackfillScope = item.backfill || 'new'
  const airedSeasons: any[] = (detail?.seasons || [])
    .filter((s: any) => Number(s.season_number) > 0)
    .filter((s: any) => !s.air_date || isoDateOf(s.air_date) <= todayIso())
  const fresh: DueTarget[] = []

  if (airedSeasons.length > 0) {
    const byNumDesc = (a: any, b: any) => Number(b.season_number) - Number(a.season_number)
    const currentNum = Number([...airedSeasons].sort(byNumDesc)[0].season_number)

    // Which seasons may hold wanted episodes under this scope?
    let seasonNumbers: number[] = [currentNum]
    if (scope === 'first_season') {
      seasonNumbers = Array.from(new Set([1, currentNum]))
    } else if (scope === 'all') {
      const allNums = airedSeasons.map((s: any) => Number(s.season_number)).sort((a, b) => a - b)
      if (allNums.length > MAX_SEASONS_SCANNED) {
        // Series muy largas: se rota una ventana para no pedir 30 temporadas a
        // TMDB en cada vuelta.
        const cursor = scanCursor.get(item.tmdb_id) || 0
        const window = allNums.slice(cursor, cursor + SEASON_SCAN_BUDGET)
        if (window.length < SEASON_SCAN_BUDGET) window.push(...allNums.slice(0, SEASON_SCAN_BUDGET - window.length))
        scanCursor.set(item.tmdb_id, (cursor + SEASON_SCAN_BUDGET) % allNums.length)
        seasonNumbers = Array.from(new Set([currentNum, ...window]))
      } else {
        // Se escanean TODAS (la lista va cacheada 10 min): así el backfill baja
        // las temporadas en orden, desde la primera, sin saltarse ninguna.
        seasonNumbers = allNums
      }
    }
    // 'new' | 'last_episode' | 'last_season' → [currentNum] only.

    for (const sn of seasonNumbers) {
      fresh.push(...(await seasonWantedEpisodes(item, sn, scope, currentNum)))
    }
  }

  // Tracked rows from any season always keep their backoff retry schedule,
  // even when the season is outside this tick's scan window.
  for (const a of attemptsForTitle(item.tmdb_id)) {
    if (a.kind !== 'episode' || a.season === null || a.episode === null) continue
    const already = fresh.some((c) => c.season === a.season && c.episode === a.episode)
    if (!already) fresh.push({ kind: 'episode', season: a.season, episode: a.episode, tracked: true })
  }

  // Orden de la cola: lo recién emitido primero (lo más nuevo antes, para no
  // perder el capítulo de esta semana) y el backfill EN ORDEN ascendente desde
  // S01E01 — así se puede empezar a ver la serie desde el principio mientras el
  // resto se descarga. La decisión vive en orderTargetsForQueue() para poder
  // probarla sin arrancar el servicio (spec/features/queue-order.feature).
  const addedDate = isoDateOf(item.added_at)
  const ordered = orderTargetsForQueue(fresh, addedDate)
  const seasonTag = airedSeasons.length > 0 ? `S${Number([...airedSeasons].sort((a: any, b: any) => Number(b.season_number) - Number(a.season_number))[0].season_number)}` : '—'
  return { targets: ordered, seasonTag, scope }
}

/** Objetivo concreto de la cola (lo mismo que DueTarget, exportado para el spec). */
export type QueueTarget = DueTarget

/**
 * Orden de la cola de descarga:
 *   1) lo recién emitido (fecha >= fecha en que se añadió el título), lo más
 *      nuevo primero — el capítulo de esta semana no espera al backfill;
 *   2) el resto EN ORDEN ascendente (S01E01 → S01E02 → …), sin saltos.
 * Los reintentos atrasados no traen fecha, así que van al grupo 2 y respetan
 * el orden.
 */
export function orderTargetsForQueue<T extends QueueTarget>(targets: T[], addedDate: string): T[] {
  const isRecent = (t: QueueTarget): boolean => Boolean(t.air_date && t.air_date >= addedDate)
  return [...targets].sort((a, b) => {
    const aNew = isRecent(a)
    const bNew = isRecent(b)
    if (aNew !== bNew) return aNew ? -1 : 1
    if (aNew) return ((b.season ?? 0) - (a.season ?? 0)) || ((b.episode ?? 0) - (a.episode ?? 0))
    return ((a.season ?? 0) - (b.season ?? 0)) || ((a.episode ?? 0) - (b.episode ?? 0))
  })
}

/** Objetivos que se están intentando ahora mismo (evita duplicados tick/cola). */
const inFlightTargets = new Set<string>()

/**
 * Intenta una lista de objetivos. Respeta el backoff y el estado real en disco
 * (`isGrabbed`) y no repite un objetivo que ya esté en vuelo (el tick y la cola
 * de backfill corren a la vez). Con `continuous` se corta cuando la cola de
 * descargas está llena: el único límite es la concurrencia.
 */
async function attemptTargets(
  item: WatchlistItem,
  detail: any,
  targets: DueTarget[],
  res: { grabbed: number; waiting: number; deferred: number; errors: number },
  opts: { continuous?: boolean; force?: boolean } = {},
): Promise<void> {
  const maxConcurrent = Math.max(1, Number(getSettings().max_concurrent_downloads) || 3)
  for (const t of targets) {
    const key = `${item.tmdb_id}:${item.media_type}:${t.season ?? ''}:${t.episode ?? ''}`
    if (inFlightTargets.has(key)) continue
    // El otro camino (tick ↔ cola) puede haberlo grabado hace un momento.
    if (isGrabbed(item.tmdb_id, item.media_type, t.season ?? null, t.episode ?? null)) continue
    if (opts.continuous) {
      const depth = countPipelineDownloads()
      if (depth >= maxConcurrent) {
        console.debug(`[Backfill] "${item.title}" en pausa — ${depth}/${maxConcurrent} descargas en la cola`)
        break
      }
    }
    if (t.tracked) {
      const att = getAttempt(item.tmdb_id, item.media_type, t.season ?? null, t.episode ?? null)
      if (shouldDeferAttempt(att, new Date().toISOString(), opts.force)) {
        res.deferred += 1
        continue
      }
      // Episode got grabbed out-of-band (manual download)? Drop the row.
      if (isGrabbed(item.tmdb_id, item.media_type, t.season ?? null, t.episode ?? null)) {
        deleteAttempt(item.tmdb_id, item.media_type, t.season ?? null, t.episode ?? null)
        continue
      }
    }
    inFlightTargets.add(key)
    try {
      const state = await attemptTarget(item, detail, t, { force: opts.force })
      if (state === 'grabbed') res.grabbed += 1
      else if (state === 'error') res.errors += 1
      else res.waiting += 1
    } finally {
      inFlightTargets.delete(key)
    }
  }
}

// ── Autoconsolidación de carpetas duplicadas ────────────────────────────────
let lastHeal = 0
const HEAL_INTERVAL_MS = 30 * 60 * 1000

/**
 * Repara carpetas paralelas del mismo título (p. ej. porque TMDB cambió el
 * título: "Demo9 (ES)" → "Demo9 (EN)") antes de seguir grabando: si no, el
 * episodio nuevo cae en la carpeta duplicada y la biblioteca se parte en dos.
 * Corre como mucho cada 30 min (o forzado) y solo refresca Jellyfin si movió
 * algo.
 */
export async function healLibraryFolders(force = false): Promise<HealResult | null> {
  const settings = getSettings()
  if (!force && Date.now() - lastHeal < HEAL_INTERVAL_MS) return null
  lastHeal = Date.now()
  try {
    const result = healLibrary(settings.movies_folder || '', settings.series_folder || '')
    for (const g of [...result.movies, ...result.series]) {
      if (g.moved.length > 0) {
        const origen = g.merged.length > 0 ? ` de ${g.merged.map((m) => `"${m}"`).join(', ')}` : ''
        log(`biblioteca: "${g.keep}" — ${g.moved.length} archivo(s) recolocados${origen}`)
        for (const m of g.moved) console.debug(`[Heal] ${m.from}${pathSep()}${m.file} → ${m.to}`)
      }
      if (g.pruned.length > 0) console.log(`[Heal] carpetas vacías eliminadas: ${g.pruned.join(', ')}`)
      for (const s of g.skipped) {
        if (!/sin contenido/.test(s.reason)) console.warn(`[Heal] sin tocar ${s.file}: ${s.reason}`)
      }
    }
    if (result.changed) {
      const jf = await jellyfinRefresh()
      log(`biblioteca consolidada — Jellyfin ${jf.sent ? 'refrescado' : `sin refrescar (${jf.error || 'sin configurar'})`}`)
    }
    return result
  } catch (e: any) {
    console.warn(`[Heal] no se pudo consolidar la biblioteca: ${e.message}`)
    return null
  }
}

function pathSep(): string {
  return process.platform === 'win32' ? '\\' : '/'
}

export async function runMonitorTick(force = false): Promise<MonitorStatus['lastSummary']> {
  const settings = getSettings()
  if (!force && !settings.monitor_enabled) {
    log('disabled — skipping tick')
    return lastSummary
  }
  if (running) {
    log('already running — skipping')
    return lastSummary
  }
  running = true
  const summary = { processed: 0, grabbed: 0, waiting: 0, deferred: 0, errors: 0 }
  try {
    setupSearchEnv(settings)
    // Antes de buscar nada: si la biblioteca tiene carpetas duplicadas del
    // mismo título, se consolidan para que lo nuevo caiga en la carpeta buena.
    await healLibraryFolders()
    const items = listWatchlist().filter((i) => i.monitored)
    log(`tick start — ${items.length} monitored item(s)`)
    for (const item of items) {
      summary.processed += 1
      try {
        const res = await checkItem(item)
        summary.grabbed += res.grabbed
        summary.waiting += res.waiting
        summary.deferred += res.deferred
        summary.errors += res.errors
      } catch (e: any) {
        summary.errors += 1
        log(`item "${item.title}" failed: ${e.message}`)
      }
      await new Promise((r) => setTimeout(r, 800))
    }
    const iso = new Date().toISOString()
    lastRun = iso
    updateSettings({ last_monitor_run: iso })
    lastSummary = summary
    log(`tick done — processed=${summary.processed} grabbed=${summary.grabbed} waiting=${summary.waiting} deferred=${summary.deferred} errors=${summary.errors}`)
    eventBus.emit('monitor-updated', { ...getMonitorStatus(), lastSummary: summary })
  } catch (e: any) {
    summary.errors += 1
    log(`tick crashed: ${e.message}`)
  } finally {
    running = false
  }
  // El tick deja hueco en la cola: que la cola de backfill lo aproveche ya.
  runBackfillTick().catch(() => { /* la próxima vuelta lo reintenta */ })
  return lastSummary
}

/** Background-safe kick (fire and forget, never blocks the HTTP response). */
export function kickMonitor(force = false): void {
  runMonitorTick(force).catch((e) => log(`background tick error: ${e.message}`))
}

/** Force a single item through the monitor right now (background). */
export function forceCheckItem(itemId: number): boolean {
  const item = getWatchlistItem(itemId)
  if (!item) return false
  const run = async () => {
    if (running) return
    running = true
    try {
      log(`force check — "${item.title}"`)
      const res = await checkItem(item, { force: true })
      log(`force check done — ${item.title}: grabbed=${res.grabbed} waiting=${res.waiting} errors=${res.errors}${res.deferred ? ` diferidos=${res.deferred}` : ''}`)
      updateSettings({ last_monitor_run: new Date().toISOString() })
      eventBus.emit('monitor-updated', { ...getMonitorStatus(), lastSummary })
    } finally {
      running = false
    }
  }
  run().catch((e) => log(`force check error: ${e.message}`))
  return true
}

// ── Cola de backfill continuo ───────────────────────────────────────────────
// Los episodios YA emitidos no esperan al tick (30 min): se van encolando en
// cadena y el ÚNICO límite es el número de descargas simultáneas
// (settings.max_concurrent_downloads, 3 por defecto). Antes el tick intentaba 5
// por vuelta y el resto esperaba media hora, así que bajar la serie completa de
// Demo (~180 capítulos) costaba ~20 h.
const BACKFILL_INTERVAL_MS = 15_000
let lastQueueLog = 0
/** Última búsqueda de backfill hecha estando el debrid en cooldown (ritmo lento). */
let lastCooldownBackfill = 0
/** ¿Queda algún episodio ya emitido sin descargar? (para el resumen) */
async function pendingBackfillCount(items: WatchlistItem[]): Promise<number> {
  let total = 0
  for (const item of items) {
    if (item.media_type !== 'series') continue
    const detail = await fetchDetailCached(item)
    if (!detail) continue
    const { targets } = await collectSeriesTargets(item, detail)
    total += targets.filter((t) => !isGrabbed(item.tmdb_id, 'series', t.season ?? null, t.episode ?? null)).length
  }
  return total
}

/**
 * Una vuelta de la cola: recorre los títulos monitorizados y encola episodios
 * ya emitidos mientras haya hueco (cola < max_concurrent_downloads). No aplica
 * esperas por intervalo: lo que no cabe se queda para la vuelta siguiente, que
 * llega en segundos.
 */
export async function runBackfillTick(): Promise<{ grabbed: number; waiting: number; errors: number; queue: number }> {
  const summary = { grabbed: 0, waiting: 0, errors: 0, queue: 0 }
  const settings = getSettings()
  if (!settings.monitor_enabled) {
    summary.queue = countPipelineDownloads()
    return summary
  }
  // No se bloquea mientras el tick está en curso: `attemptTargets` ya evita
  // repetir un objetivo en vuelo y el tick puede tardar minutos con muchos
  // títulos (bloquear aquí dejaba la cola vacía entre tandas).
  if (backfillBusy) {
    summary.queue = countPipelineDownloads()
    return summary
  }
  backfillBusy = true
  try {
    // Cooldown del debrid (spec B10): buscar en cada ventana de 15 s no sirve de
    // nada mientras dure (sólo entrarían releases cacheados, y de esos se encarga
    // la reconciliación). Se baja el ritmo a una búsqueda cada 10 min y sin gastar
    // reintentos. Medido: martillear alargó el cooldown de 03:59 a 08:03 UTC.
    const account = await getAccountStatus({ token: settings.automation_service === 'torbox' ? settings.torbox_token : undefined })
    if (isInCooldown(account)) {
      summary.queue = countPipelineDownloads()
      if (Date.now() - lastCooldownBackfill > 10 * 60_000) {
        lastCooldownBackfill = Date.now()
        console.debug(`[Backfill] debrid en cooldown hasta ${cooldownLabel(account)} — se buscan sólo releases cacheados, con ritmo lento`)
      } else {
        return summary
      }
    }
    const maxConcurrent = Math.max(1, Number(settings.max_concurrent_downloads) || 3)
    let depth = countPipelineDownloads()
    if (depth >= maxConcurrent) {
      summary.queue = depth
      if (Date.now() - lastQueueLog > 60_000) {
        lastQueueLog = Date.now()
        console.debug(`[Backfill] cola llena — ${depth}/${maxConcurrent} descargas en curso; nada nuevo que encolar`)
      }
      return summary
    }
    const items = listWatchlist().filter((i) => i.monitored && i.media_type === 'series')
    for (const item of items) {
      if (depth >= maxConcurrent) break
      const detail = await fetchDetailCached(item)
      if (!detail) continue
      const { targets } = await collectSeriesTargets(item, detail)
      const pending = targets.filter((t) => !isGrabbed(item.tmdb_id, 'series', t.season ?? null, t.episode ?? null))
      if (pending.length === 0) continue
      const res = { grabbed: 0, waiting: 0, deferred: 0, errors: 0 }
      await attemptTargets(item, detail, pending, res, { continuous: true })
      summary.grabbed += res.grabbed
      summary.waiting += res.waiting
      summary.errors += res.errors
      depth = countPipelineDownloads()
    }
    summary.queue = depth
    if (summary.grabbed > 0) {
      log(`cola: ${summary.grabbed} episodio(s) encolado(s) — ${depth}/${maxConcurrent} en curso`)
    } else if (summary.waiting > 0 || summary.errors > 0) {
      console.debug(`[Backfill] sin cambios — ${summary.waiting} sin fuente, ${summary.errors} con error (${depth}/${maxConcurrent} en curso)`)
    }
    if (depth === 0 && summary.grabbed === 0) {
      const rest = await pendingBackfillCount(items)
      if (rest > 0) console.debug(`[Backfill] ${rest} episodio(s) pendientes, todos en tiempo de espera`)
    }
  } catch (e: any) {
    console.warn(`[Backfill] vuelta fallida: ${e.message}`)
  } finally {
    backfillBusy = false
  }
  return summary
}

export function startBackfillLoop(): void {
  if (backfillTimer) clearInterval(backfillTimer)
  backfillTimer = setInterval(() => {
    runBackfillTick().catch((e) => console.warn(`[Backfill] ${e.message}`))
  }, BACKFILL_INTERVAL_MS)
}

export function stopBackfillLoop(): void {
  if (backfillTimer) {
    clearInterval(backfillTimer)
    backfillTimer = null
  }
}

export function startMonitor(): void {
  stopMonitor()
  const settings = getSettings()
  const minutes = Math.max(5, Number(settings.monitor_interval_minutes) || 30)
  log(`starting — interval ${minutes} min (enabled=${Boolean(settings.monitor_enabled)})`)
  if (settings.monitor_enabled) {
    setTimeout(() => kickMonitor(), 8_000)
    startBackfillLoop()
  }
  // Reconciliación con el debrid (spec B9): al arrancar y cada 15 min, aparte del
  // intervalo del tick. Adopta lo que el debrid ya tiene listo (p. ej. en cooldown
  // es lo único que se puede bajar) y que la app no bajaba por no tener fila.
  setTimeout(() => { void reconcileDebrid().catch((e) => console.debug('[Reconcile] falló:', e?.message || e)) }, 30_000)
  startReconcileLoop()
  tickTimer = setInterval(() => {
    const s = getSettings()
    if (s.monitor_interval_minutes !== minutes) {
      startMonitor() // settings changed — restart the loop with the new interval
      return
    }
    if (s.monitor_enabled) kickMonitor()
  }, minutes * 60 * 1000)
}

export function stopMonitor(): void {
  if (tickTimer) {
    clearInterval(tickTimer)
    tickTimer = null
  }
  if (reconcileTimer) {
    clearInterval(reconcileTimer)
    reconcileTimer = null
  }
  stopBackfillLoop()
}

/**
 * Reconciliación periódica con el debrid (spec B9). El chequeo corre cada 3 min
 * pero sólo actúa cuando pasaron los 15 min: sin el freno, cada tick golpearía la
 * API del debrid (la lista de TorBox tarda ~30 s).
 */
export function startReconcileLoop(): void {
  if (reconcileTimer) clearInterval(reconcileTimer)
  reconcileTimer = setInterval(() => {
    if (!getSettings().monitor_enabled) return
    if (!reconcileDue(15)) return
    void reconcileDebrid().catch((e) => console.debug('[Reconcile] falló:', e?.message || e))
  }, 3 * 60_000)
}

export function getMonitorLastSummary(): MonitorStatus['lastSummary'] {
  return lastSummary
}

// ── Calendario de descargas programadas ──────────────────

export interface CalendarEvent {
  date: string
  itemId: number
  title: string
  tmdb_id: number
  media_type: 'movie' | 'series'
  kind: 'episode' | 'movie'
  season: number | null
  episode: number | null
  episode_name: string
  poster: string
  language_profile: string
  scope: string
  grabbed: boolean
}

export interface CalendarPayload {
  events: CalendarEvent[]
  days: number
  generated_at: string
  window: { from: string; to: string }
}

let calendarCache: { at: number; days: number; payload: CalendarPayload } | null = null
const CALENDAR_TTL_MS = 30 * 60 * 1000

function addDaysIso(base: string, days: number): string {
  const d = new Date(`${base}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/**
 * Descargas programadas: episodios (temporada actual y siguiente) y películas
 * con fecha de estreno dentro de la ventana. Marca las ya descargadas.
 */
export async function getCalendar(days = 60, force = false): Promise<CalendarPayload> {
  if (!force && calendarCache && calendarCache.days === days && Date.now() - calendarCache.at < CALENDAR_TTL_MS) {
    return calendarCache.payload
  }
  const today = todayIso()
  const to = addDaysIso(today, days)
  const items = listWatchlist().filter((i) => i.monitored)
  const events: CalendarEvent[] = []

  const processItem = async (item: WatchlistItem) => {
    const detail = await fetchDetailCached(item)
    if (!detail) return
    const poster = item.poster || detail?.poster || ''

    if (item.media_type === 'movie') {
      const rel = isoDateOf(detail?.release_date || '')
      if (!rel || rel < today || rel > to) return
      events.push({
        date: rel, itemId: item.id, title: item.title, tmdb_id: item.tmdb_id,
        media_type: 'movie', kind: 'movie', season: null, episode: null, episode_name: '',
        poster, language_profile: item.language_profile, scope: '',
        grabbed: isGrabbed(item.tmdb_id, 'movie', null, null),
      })
      return
    }

    const seasons: any[] = (detail?.seasons || []).filter((s: any) => Number(s.season_number) > 0)
    if (seasons.length === 0) return
    const aired = seasons.filter((s: any) => !s.air_date || isoDateOf(s.air_date) <= today)
    const currentNum = aired.length
      ? Math.max(...aired.map((s: any) => Number(s.season_number)))
      : Math.min(...seasons.map((s: any) => Number(s.season_number)))

    for (const sn of new Set<number>([currentNum, currentNum + 1])) {
      if (!seasons.some((s: any) => Number(s.season_number) === sn)) continue
      let season: any = null
      try { season = await tmdbSeason(item.tmdb_id, sn) } catch { continue }
      for (const ep of season?.episodes || []) {
        const date = isoDateOf(ep?.air_date || '')
        if (!date || date < today || date > to) continue
        const epNum = Number(ep.episode_number)
        events.push({
          date, itemId: item.id, title: item.title, tmdb_id: item.tmdb_id,
          media_type: 'series', kind: 'episode', season: sn, episode: epNum,
          episode_name: ep.name || '', poster, language_profile: item.language_profile,
          scope: item.backfill || 'new',
          grabbed: isGrabbed(item.tmdb_id, 'series', sn, epNum),
        })
      }
    }
  }

  // Pool pequeño: cada título cuesta 1-2 llamadas a TMDB.
  const queue = [...items]
  const workers = Array.from({ length: Math.min(3, Math.max(1, queue.length)) }, async () => {
    while (queue.length > 0) {
      const it = queue.shift()
      if (it) await processItem(it)
    }
  })
  await Promise.all(workers)

  events.sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title))
  const payload: CalendarPayload = { events, days, generated_at: new Date().toISOString(), window: { from: today, to } }
  calendarCache = { at: Date.now(), days, payload }
  console.log(`[calendar] ${events.length} descarga(s) programada(s) entre ${today} y ${to}`)
  return payload
}

// Keep the detail cache bounded.
setInterval(() => {
  if (detailCache.size > 200) detailCache.clear()
}, 60 * 60 * 1000).unref?.()

// ── Escáner manual de reemplazo EN → latino ──────────────
// El usuario prefiere decidir: Verificar busca de nuevo y, si hay versión
// latina de algo ya descargado EN, el programa le PREGUNTA antes de
// reemplazar. El monitor NUNCA hace upgrades solo.

export interface UpgradeOffer {
  season: number | null
  episode: number | null
  kind: 'movie' | 'episode'
  release: string
  size: string
  indexer: string
  current: string // título EN actual (history)
}

interface ScanState {
  state: 'idle' | 'scanning' | 'done'
  hadEnglish: boolean
  offers: UpgradeOffer[]
  startedAt: string
  finishedAt?: string
}

const upgradeScans = new Map<number, ScanState>()

export function getUpgradeScan(itemId: number): ScanState {
  return upgradeScans.get(itemId) || { state: 'idle', hadEnglish: false, offers: [], startedAt: '' }
}

export function startUpgradeScan(itemId: number): boolean {
  const current = getUpgradeScan(itemId)
  if (current.state === 'scanning') return true
  const item = getWatchlistItem(itemId)
  if (!item) return false
  upgradeScans.set(itemId, { state: 'scanning', hadEnglish: false, offers: [], startedAt: new Date().toISOString() })
  runUpgradeScan(item).catch((e) => console.error('[upgrade] scan error:', e.message))
  return true
}

async function runUpgradeScan(item: WatchlistItem): Promise<void> {
  const rows = englishGrabbedRows(item.id, 4)
  const state = upgradeScans.get(item.id)!
  state.hadEnglish = rows.length > 0
  if (rows.length === 0) {
    state.state = 'done'
    state.finishedAt = new Date().toISOString()
    return
  }
  const detail = await fetchDetailCached(item)
  for (const row of rows) {
    const target: GrabTarget = {
      watchlist_id: item.id,
      tmdb_id: item.tmdb_id,
      media_type: item.media_type,
      imdb_id: item.imdb_id || detail?.imdb_id || undefined,
      title: detail?.original_title || item.title,
      year: detail?.year || item.year || undefined,
      kind: row.kind === 'movie' ? 'movie' : 'episode',
      season: row.season ?? undefined,
      episode: row.episode ?? undefined,
      language_profile: 'latino_only',
      mode: 'upgrade',
      runtime_min: row.kind === 'movie'
        ? (Number(detail?.runtime) > 0 ? Number(detail.runtime) : undefined)
        : seriesFallbackRuntime(detail),
    }
    const best = await findLatinoForUpgrade(target)
    const st = upgradeScans.get(item.id)!
    if (best) {
      st.offers.push({
        season: row.season,
        episode: row.episode,
        kind: row.kind === 'movie' ? 'movie' : 'episode',
        release: best.title,
        size: best.size,
        indexer: best.indexer,
        current: row.title || 'descarga EN',
      })
    }
  }
  const st = upgradeScans.get(item.id)!
  st.state = 'done'
  st.finishedAt = new Date().toISOString()
  console.log(`[upgrade] "${item.title}": ${st.hadEnglish ? `escaneo terminado — ${st.offers.length} versión(es) latina(s) disponible(s)` : 'sin descargas EN que reemplazar'}`)
}

export interface UpgradeResult {
  ok: boolean
  error?: string
  grabbed?: boolean
}

export async function applyUpgrade(itemId: number, season: number | null, episode: number | null): Promise<UpgradeResult> {
  const item = getWatchlistItem(itemId)
  if (!item) return { ok: false, error: 'Watchlist item not found' }
  const isMovie = season === null || season === undefined
  const detail = await fetchDetailCached(item)
  const target: GrabTarget = {
    watchlist_id: item.id,
    tmdb_id: item.tmdb_id,
    media_type: item.media_type,
    imdb_id: item.imdb_id || detail?.imdb_id || undefined,
    title: detail?.original_title || item.title,
    year: detail?.year || item.year || undefined,
    kind: isMovie ? 'movie' : 'episode',
    season: isMovie ? undefined : (season as number),
    episode: isMovie ? undefined : (episode as number),
    language_profile: 'latino_only',
    mode: 'upgrade',
    runtime_min: isMovie
      ? (Number(detail?.runtime) > 0 ? Number(detail.runtime) : undefined)
      : seriesFallbackRuntime(detail),
  }
  const outcome = await grab(target)
  if (outcome.status !== 'grabbed') {
    const why = outcome.status === 'no_source'
      ? 'No hay versión latina todavía — reintenta más tarde'
      : outcome.error || 'Fallo desconocido'
    return { ok: false, error: why }
  }
  // Marca la(s) fila(s) EN antigua(s) como reemplazo pendiente; el worker
  // borra el archivo EN cuando el latino termine de descargarse local.
  const fresh = latestGrabFor(item.tmdb_id, item.media_type, isMovie ? null : (season as number), isMovie ? null : (episode as number))
  if (fresh && fresh.id) {
    try {
      markReplacePending(item.tmdb_id, item.media_type, isMovie ? null : (season as number), isMovie ? null : (episode as number), fresh.id)
    } catch (e: any) {
      console.error('[upgrade] markReplacePending failed:', e.message)
    }
  }
  // Quita de las ofertas lo ya resuelto.
  const st = upgradeScans.get(item.id)
  if (st) {
    st.offers = st.offers.filter((o) => o.season !== (isMovie ? null : season) || o.episode !== (isMovie ? null : episode))
    if (st.offers.length === 0) st.state = 'done'
  }
  console.log(`[upgrade] ✓ "${item.title}"${isMovie ? '' : ` S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`} → latino (${outcome.source}) — EN será reemplazado al completar`)
  return { ok: true, grabbed: true }
}

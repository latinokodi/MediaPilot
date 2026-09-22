// debrid-reconcile.ts — adopta lo que el debrid ya tiene (ver spec B9).
//
// La app y el debrid se desincronizan: filas borradas a mano, reinicios,
// añadidos desde otro cliente. Quedan torrents YA LISTOS en la cuenta que la app
// no baja porque no tiene fila — y con el debrid en cooldown son lo ÚNICO que se
// puede bajar. La decisión vive en planReconcile() (función pura, probada en
// spec/features/debrid-reconcile.feature); aquí abajo se ejecuta contra TorBox.
import fs from 'fs'
import path from 'path'
import { addDownload, countPipelineDownloads, getDB, getSettings, getMediaFolder } from './db'
import { TorboxAPI } from './torbox'
import { parseReleaseName, seriesNameMatches, getAltTitlesCached, computeDestination } from './media-layout'
import { qualityFromName, parseQualitySetting } from './quality'
import { isGrabbed, listWatchlist } from './watchlist'
import { eventBus } from './event-bus'

export interface DebridTorrent {
  id: number
  name: string
  state: string
  sizeBytes: number
  hash?: string
}

export interface WatchedTitle {
  tmdbId: number
  mediaType: 'series' | 'movie'
  titles: string[]
  year?: number
}

export interface ReconcileContext {
  watched: WatchedTitle[]
  knownTorrentIds: number[]
  isOnDisk: (tmdbId: number, mediaType: 'series' | 'movie', season: number | null, episode: number | null) => boolean
  maxSizeGb: (mediaType: 'series' | 'movie') => number
  /** Cuántos episodios de esa temporada hay ya en disco (null = no se pudo comprobar). */
  seasonOnDisk?: (tmdbId: number, season: number) => number | null
  /** Calidad mínima aceptable (0 = cualquiera). */
  minQuality?: number
}

export interface ReconcileDecision {
  torrentId: number
  name: string
  tmdbId: number
  mediaType: 'series' | 'movie'
  season?: number
  episode?: number
  /** Pack de temporada completa (sin episodio): llena toda la temporada de golpe. */
  pack?: boolean
  /** El debrid ya lo tiene listo (se puede bajar ya). */
  ready: boolean
  sizeGb: number
}

export interface ReconcilePlan {
  adopt: ReconcileDecision[]
  skip: Array<{ torrentId: number; name: string; reason: string }>
}

/** Estados en los que el debrid ya tiene el contenido listo para bajar. */
const READY_STATES = ['cached', 'completed', 'uploading', 'paused']
/** Estados en los que el debrid aún lo está bajando (se adopta, llegará). */
const IN_PROGRESS_STATES = ['downloading', 'metadl', 'compressing', 'extracting']
const EPISODE_RE = /\bS(\d{1,2})\s*E(\d{1,3})\b/i
const SEASON_ONLY_RE = /\bS\d{1,2}\b/i

/**
 * Decide qué torrents del debrid se adoptan. Nunca bloquea por dudas: si algo no
 * está claro se descarta con un motivo legible, y el resumen lo registra.
 */
export function planReconcile(torrents: DebridTorrent[], ctx: ReconcileContext): ReconcilePlan {
  const known = new Set(ctx.knownTorrentIds.map((n) => Number(n)))
  const adopt: ReconcileDecision[] = []
  const skip: Array<{ torrentId: number; name: string; reason: string }> = []
  const descartar = (t: DebridTorrent, reason: string) => skip.push({ torrentId: t.id, name: t.name, reason })

  for (const t of torrents) {
    if (!t || !t.id) continue
    const state = String(t.state || '').toLowerCase()
    const sizeGb = t.sizeBytes > 0 ? t.sizeBytes / 1024 ** 3 : 0
    const ready = READY_STATES.includes(state)

    if (known.has(Number(t.id))) { descartar(t, 'ya tiene fila local'); continue }
    if (!ready && !IN_PROGRESS_STATES.includes(state)) {
      descartar(t, `estado "${state}" sin contenido todavía`)
      continue
    }

    const ep = EPISODE_RE.exec(t.name)
    if (ep) {
      const season = Number(ep[1])
      const episode = Number(ep[2])
      const series = ctx.watched.find((w) => w.mediaType === 'series' && seriesNameMatches(t.name, w.titles, []))
      if (!series) { descartar(t, 'título no monitorizado'); continue }
      const cap = ctx.maxSizeGb('series')
      if (cap > 0 && sizeGb > cap) { descartar(t, `supera el tope (${sizeGb.toFixed(2)} GB > ${cap} GB)`); continue }
      if (ctx.isOnDisk(series.tmdbId, 'series', season, episode)) { descartar(t, 'ya está en la biblioteca'); continue }
      adopt.push({ torrentId: t.id, name: t.name, tmdbId: series.tmdbId, mediaType: 'series', season, episode, ready, sizeGb })
      continue
    }

    // Sin marcador de episodio: pack de temporada de una serie monitorizada, o película.
    const seriesHit = ctx.watched.find((w) => w.mediaType === 'series' && seriesNameMatches(t.name, w.titles, []))
    if (seriesHit) {
      // Pack de temporada: se adopta SÓLO si la temporada está entera vacía (así no
      // puede duplicar nada) y el pack cumple la calidad mínima y el tope de tamaño.
      // Es la vía para llenar temporadas completas cuando el debrid ya lo tiene
      // cacheado y los releases sueltos están muertos (swarm sin seeds).
      const seasonOnly = /\bS(\d{1,2})\b/i.exec(t.name) || /\b(?:season|temporada)[\s._-]*(\d{1,2})\b/i.exec(t.name)
      const season = seasonOnly ? Number(seasonOnly[1]) : 0
      if (!season) { descartar(t, 'pack/colección de serie (sin temporada)'); continue }
      const minQ = Number(ctx.minQuality || 0)
      if (minQ > 0 && qualityFromName(t.name) > 0 && qualityFromName(t.name) < minQ) {
        descartar(t, `pack por debajo de la calidad mínima (${qualityFromName(t.name)}p < ${minQ}p)`)
        continue
      }
      const cap = ctx.maxSizeGb('series')
      if (cap > 0 && sizeGb > cap) { descartar(t, `supera el tope (${sizeGb.toFixed(2)} GB > ${cap} GB)`); continue }
      const onDisk = ctx.seasonOnDisk ? ctx.seasonOnDisk(seriesHit.tmdbId, season) : null
      if (onDisk === null) {
        descartar(t, 'pack de temporada (no se pudo comprobar la temporada — no se adopta)')
        continue
      }
      if (onDisk > 0) { descartar(t, `pack de temporada (S${String(season).padStart(2, '0')} ya tiene ${onDisk} episodio(s) — se bajan sueltos)`); continue }
      adopt.push({ torrentId: t.id, name: t.name, tmdbId: seriesHit.tmdbId, mediaType: 'series', season, pack: true, ready, sizeGb })
      continue
    }
    const movie = ctx.watched.find((w) => w.mediaType === 'movie' && seriesNameMatches(t.name, w.titles, []))
    if (!movie) { descartar(t, 'título no monitorizado'); continue }
    const capMovie = ctx.maxSizeGb('movie')
    if (capMovie > 0 && sizeGb > capMovie) { descartar(t, `supera el tope (${sizeGb.toFixed(2)} GB > ${capMovie} GB)`); continue }
    if (ctx.isOnDisk(movie.tmdbId, 'movie', null, null)) { descartar(t, 'ya está en la biblioteca'); continue }
    adopt.push({ torrentId: t.id, name: t.name, tmdbId: movie.tmdbId, mediaType: 'movie', ready, sizeGb })
  }

  // Lo listo primero (se baja ya, incluso con el debrid en cooldown); dentro de
  // cada grupo, en orden ascendente de temporada/episodio.
  adopt.sort((a, b) => {
    if (a.ready !== b.ready) return a.ready ? -1 : 1
    return ((a.season ?? 0) - (b.season ?? 0)) || ((a.episode ?? 0) - (b.episode ?? 0))
  })

  return { adopt, skip }
}

export interface ReconcileResult {
  ok: boolean
  reason?: string
  adopted: number
  skipped: number
  plan: ReconcilePlan
}

const lastReconcile = { at: 0 }

/**
 * Carpeta destino de lo adoptado. Se calcula desde el TÍTULO EMPAREJADO (tmdb id
 * y año del título monitorizado), nunca desde el nombre del torrent: hay releases
 * cuyo nombre es un simple fichero en minúsculas ("demo.s07e20.1080p.web.h264-x.mkv")
 * y de ahí salía una carpeta fantasma ("demo s07e20 web successfulcrab mkv/Season 1")
 * con el episodio dentro. Lo destapó spec/features/debrid-reconcile.feature.
 */
export async function adoptionDestination(
  settings: { destination_folder: string; movies_folder: string; series_folder: string; tmdb_api_key: string },
  decision: ReconcileDecision,
  watched: WatchedTitle,
): Promise<{ root: string; folder: string; season: number | undefined }> {
  return computeDestination(settings, decision.name, decision.mediaType === 'movie' ? 'movie' : 'series', {
    tmdbId: watched.tmdbId,
    year: watched.year,
  })
}

/** ¿Toca reconciliar otra vez? (evita golpear la API del debrid cada tick). */
export function reconcileDue(intervalMinutes = 15): boolean {
  return Date.now() - lastReconcile.at > intervalMinutes * 60_000
}

/**
 * Lee la lista del debrid, decide qué adoptar y crea las filas locales. El worker
 * las baja respetando `max_concurrent_downloads`.
 */
export async function reconcileDebrid(opts: { limit?: number; dry?: boolean } = {}): Promise<ReconcileResult> {
  const settings = getSettings()
  if (settings.automation_service !== 'torbox' || !settings.torbox_token) {
    return { ok: false, reason: 'debrid no configurado para TorBox', adopted: 0, skipped: 0, plan: { adopt: [], skip: [] } }
  }

  const tb = new TorboxAPI(settings.torbox_token)
  const res = await tb.getTorrents()
  const list: any[] = Array.isArray(res?.data) ? res.data : []
  const torrents: DebridTorrent[] = list
    .map((t) => ({
      id: Number(t.torrent_id ?? t.id ?? 0),
      name: String(t.name || ''),
      state: String(t.download_state || t.status || '').toLowerCase(),
      sizeBytes: Number(t.size || 0),
      hash: t.hash,
    }))
    .filter((t) => t.id > 0)

  // Títulos monitorizados con TODOS sus nombres (título, original y alternativos):
  // un pack llegado con el título localizado también debe reconocerse.
  const watched: WatchedTitle[] = []
  for (const item of listWatchlist()) {
    const titles = [item.title, (item as any).original_title].filter(Boolean) as string[]
    try { titles.push(...(await getAltTitlesCached(item.tmdb_id, item.media_type))) } catch { /* se decide sin ellos */ }
    watched.push({
      tmdbId: item.tmdb_id,
      mediaType: item.media_type === 'movie' ? 'movie' : 'series',
      titles,
      year: (item as any).year,
    })
  }

  const knownTorrentIds = (getDB().prepare('SELECT torbox_id FROM downloads').all() as any[])
    .map((r) => Number(r.torbox_id))
    .filter((n) => n > 0)

  const plan = planReconcile(torrents, {
    watched,
    knownTorrentIds,
    isOnDisk: (tmdbId, mediaType, season, episode) => isGrabbed(tmdbId, mediaType, season, episode),
    maxSizeGb: (mediaType) =>
      mediaType === 'movie' ? Number(settings.max_movie_size_gb) || 0 : Number(settings.max_series_size_gb) || 0,
    minQuality: parseQualitySetting(settings.min_video_quality),
    // Cuántos episodios de esa temporada hay ya en disco: un pack sólo se adopta
    // si la temporada está VACÍA (así no puede duplicar nada). null = no se pudo
    // comprobar → no se adopta (mejor no tocar que arriesgar duplicados).
    seasonOnDisk: (tmdbId, season) => {
      try {
        const folder = getMediaFolder(tmdbId, 'series')
        const root = String(settings.series_folder || '')
        if (!folder || !root) return null
        const base = path.join(root, folder)
        if (!fs.existsSync(base)) return 0
        let count = 0
        for (const entry of fs.readdirSync(base)) {
          if (!/^season[\s._-]*0*\d+$/i.test(entry)) continue
          const dir = path.join(base, entry)
          if (!fs.statSync(dir).isDirectory()) continue
          for (const f of fs.readdirSync(dir)) {
            if (!/\.(mkv|mp4|avi|m4v|ts|webm)$/i.test(f)) continue
            const m = /\bS(\d{1,2})\s*[Ee]\d{1,3}\b/i.exec(f)
            if (m && Number(m[1]) === season) count += 1
          }
        }
        return count
      } catch {
        return null
      }
    },
  })

  // Margen: no adoptar más de lo que se podría procesar; el tope real de
  // descargas simultáneas lo aplica el worker.
  const room = Math.max(0, Number(settings.max_concurrent_downloads) || 3)
  const limit = Math.max(1, Math.min(opts.limit ?? 20, room * 5))
  let adopted = 0
  for (const d of plan.adopt.slice(0, limit)) {
    if (opts.dry) { adopted++; continue }
    try {
      // La carpeta se decide aquí, con el título del objetivo: el worker usa
      // dest_folder tal cual y no tiene que adivinar nada del nombre del torrent.
      const watchedTitle = watched.find((w) => w.tmdbId === d.tmdbId)
      const dest = watchedTitle ? await adoptionDestination(settings, d, watchedTitle) : null
      addDownload({
        torbox_id: String(d.torrentId),
        name: d.name.slice(0, 300),
        status: 'pending',
        progress: 0,
        local_status: 'pending',
        service: 'torbox',
        type: d.mediaType,
        dest_folder: dest ? `${dest.root}/${dest.folder}` : null,
      } as any)
      adopted++
    } catch (e: any) {
      console.warn('[Reconcile] no se pudo adoptar', d.name, e?.message || e)
    }
  }

  lastReconcile.at = Date.now()
  const ready = plan.adopt.filter((d) => d.ready).length
  console.log(
    `[Reconcile]${opts.dry ? ' (simulación)' : ''} ${torrents.length} torrent(s) en el debrid → ${adopted} adoptado(s)` +
    `${adopted < plan.adopt.length ? ` (de ${plan.adopt.length} posibles)` : ''}` +
    ` · ${ready} ya listo(s) en el debrid · ${plan.skip.length} descartado(s)`,
  )
  for (const s of plan.skip.slice(0, 8)) {
    console.debug(`[Reconcile] descartado: ${s.name.slice(0, 70)} — ${s.reason}`)
  }
  if (plan.skip.length > 8) console.debug(`[Reconcile] …y ${plan.skip.length - 8} descarte(s) más`)

  if (adopted > 0) eventBus.emit('downloads-updated')
  return { ok: true, adopted, skipped: plan.skip.length, plan }
}

/** Cuántas descargas hay ahora mismo en el pipeline (para el resumen de la API). */
export function pipelineDepth(): number {
  try { return countPipelineDownloads() } catch { return 0 }
}

// Definiciones de pasos: cada paso llama a las funciones REALES de la app
// (integración, sin dobles de las funciones de dominio).
import fs from 'fs'
import path from 'path'
import os from 'os'
import {
  seriesNameMatches,
  computeDestination,
  parseReleaseName,
  type ParsedRelease,
} from '../../electron/media-layout'
import { durationMatches, durationToleranceMin } from '../../electron/preflight'
import { meetsMinQuality, parseQualitySetting, type VideoQuality } from '../../electron/quality'
import { healLibrary } from '../../electron/library-heal'
import { orderTargetsForQueue, type QueueTarget } from '../../electron/monitor'
import {
  planReconcile,
  adoptionDestination,
  type DebridTorrent,
  type ReconcilePlan,
  type WatchedTitle,
} from '../../electron/debrid-reconcile'
import {
  isInCooldown,
  cooldownFilter,
  isStaleTorrent,
  type AccountStatus,
} from '../../electron/debrid-status'
import { episodeFromFileName, reorderedAudioIndexes } from '../../electron/postprocess'
import { shouldDeferAttempt, nextAttemptAfterFailure } from '../../electron/attempts'
import { normalizePosterUrl, posterBackfillPatch } from '../../electron/posters'
import {
  normalizeLanguageProfile,
  addWatchlistItem,
  updateWatchlistItem,
  listWatchlist,
  removeWatchlistItem,
} from '../../electron/watchlist'
import { getSettings, updateSettings } from '../../electron/db'
import { isBenignUpdateError } from '../../electron/updater'

export interface World {
  titles?: string[]
  altTitles?: string[]
  namingResult?: boolean
  expectedMin?: number
  kind?: 'movie' | 'episode'
  actualMin?: number
  durationOk?: boolean
  addedAt?: string
  targets?: QueueTarget[]
  ordered?: string[]
  root?: string
  moviesRoot?: string
  seriesRoot?: string
  heal?: ReturnType<typeof healLibrary>
  dest?: { root: string; folder: string }
  watched?: WatchedTitle[]
  torrents?: DebridTorrent[]
  knownIds?: number[]
  onDisk?: Set<string>
  caps?: { series: number; movie: number }
  plan?: ReconcilePlan
  account?: AccountStatus
  now?: number
  candidates?: Array<{ title: string; cached?: boolean }>
  usable?: Array<{ title: string; cached?: boolean }>
  inCooldown?: boolean
  parsed?: ParsedRelease
  minQuality?: VideoQuality
  qualityOk?: boolean
  fileEpisode?: { season: number; episode: number } | null
  audioStreams?: Array<{ index: number; language?: string }>
  audioOrder?: string
  torrentState?: string
  torrentAge?: number
  staleLimit?: number
  staleRelease?: boolean
  seasonCounts?: Record<string, number>
  pendingAttempt?: { next_attempt: string; attempts: number }
  deferred?: boolean
  nextDelay?: number
  defaultProfile?: string
  normalizedProfile?: string
  prevDefaultProfile?: string
  testItemId?: number
  posterUrl?: string
  posterItem?: { poster?: string | null; backdrop?: string | null }
  posterDetail?: any
  posterPatch?: { poster?: string; backdrop?: string }
  updateError?: string
  esperadoLeve?: boolean
  ajusteGuardado?: { clave: string; valor: any }
  resultadoAjustes?: { ok: boolean; applied: number; ignored: string[] }
}

export interface StepRun {
  world: World
  scenarioName: string
  rows: string[][]
}

type StepFn = (run: StepRun, ...args: string[]) => void | Promise<void>

export const stepDefs: Array<{ pattern: RegExp; fn: StepFn }> = [
  // ── B1 · nombres de release ─────────────────────────────────────────────
  {
    pattern: /^los títulos del objetivo son "([^"]*)"$/,
    fn: ({ world }, list) => { world.titles = list.split(';').map((s) => s.trim()).filter(Boolean) },
  },
  {
    pattern: /^los títulos alternativos son "([^"]*)"$/,
    fn: ({ world }, list) => { world.altTitles = list.split(';').map((s) => s.trim()).filter(Boolean) },
  },
  {
    pattern: /^evalúo el release "([^"]*)"$/,
    fn: ({ world }, release) => {
      world.namingResult = seriesNameMatches(release, world.titles || [], world.altTitles || [])
    },
  },
  {
    pattern: /^el release se "(acepta|rechaza)"$/,
    fn: ({ world }, expected) => {
      if (world.namingResult === undefined) throw new Error('no se evaluó ningún release antes')
      const want = expected === 'acepta'
      if (world.namingResult !== want) {
        throw new Error(`se esperaba que ${want ? 'aceptara' : 'rechazara'} el release y ${world.namingResult ? 'lo aceptó' : 'lo rechazó'}`)
      }
    },
  },
  {
    pattern: /^la app no bloquea por falta de datos$/,
    fn: ({ world }) => {
      if (world.namingResult !== true) throw new Error('un release sin título reconocible debe aceptarse (no se juzga)')
    },
  },

  // ── B2 · duración ──────────────────────────────────────────────────────
  {
    pattern: /^la duración esperada es "([^"]*)" minutos para un "(episodio|película)"$/,
    fn: ({ world }, min, kind) => {
      world.expectedMin = Number(min) || 0
      world.kind = kind === 'episodio' ? 'episode' : 'movie'
    },
  },
  {
    pattern: /^la duración real del video es "([^"]*)" minutos$/,
    fn: ({ world }, min) => {
      world.actualMin = Number(min)
      world.durationOk = durationMatches(Number(world.expectedMin) || 0, world.actualMin, world.kind || 'episode')
    },
  },
  {
    pattern: /^la duración "(acepta|rechaza)"$/,
    fn: ({ world }, expected) => {
      if (world.durationOk === undefined) throw new Error('no se comparó ninguna duración antes')
      const want = expected === 'acepta'
      if (world.durationOk !== want) {
        const tol = durationToleranceMin(Number(world.expectedMin) || 0, world.kind || 'episode')
        throw new Error(`esperado ${world.expectedMin} min, real ${world.actualMin} min (tolerancia ±${tol.toFixed(1)}) → ${world.durationOk ? 'aceptó' : 'rechazó'}`)
      }
    },
  },
  {
    pattern: /^el preflight es "inconcluso"$/,
    fn: ({ world }) => {
      if (!world.expectedMin && world.durationOk !== true) {
        throw new Error('sin duración esperada el preflight debe dejar pasar (inconcluso)')
      }
    },
  },

  // ── B3 · orden de la cola ──────────────────────────────────────────────
  {
    pattern: /^una serie añadida el "([^"]*)" con estos episodios ya emitidos$/,
    fn: ({ world, rows }, date) => {
      world.addedAt = date
      world.targets = rows.map((r) => ({
        kind: 'episode' as const,
        season: Number(r[0]),
        episode: Number(r[1]),
        air_date: r[2] && r[2] !== '—' && r[2] !== '' ? r[2] : undefined,
      }))
    },
  },
  {
    pattern: /^ordeno la cola de descarga$/,
    fn: ({ world }) => {
      const ordered = orderTargetsForQueue(world.targets || [], world.addedAt || '1970-01-01')
      world.ordered = ordered.map((t) => `S${String(t.season).padStart(2, '0')}E${String(t.episode).padStart(2, '0')}`)
    },
  },
  {
    pattern: /^el primer objetivo es "([^"]*)"$/,
    fn: ({ world }, expected) => {
      const first = (world.ordered || [])[0]
      if (first !== expected) throw new Error(`el primero fue ${first}, se esperaba ${expected}`)
    },
  },
  {
    pattern: /^el orden de la cola es "([^"]*)"$/,
    fn: ({ world }, expected) => {
      const got = (world.ordered || []).join(', ')
      const want = expected.split(',').map((s) => s.trim()).filter(Boolean).join(', ')
      if (got !== want) throw new Error(`orden obtenido: ${got}\n            esperado:      ${want}`)
    },
  },

  // ── B5/B8 · biblioteca temporal ────────────────────────────────────────
  {
    pattern: /^una biblioteca temporal$/,
    fn: ({ world }) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-spec-'))
      world.root = root
      world.moviesRoot = path.join(root, 'movies')
      world.seriesRoot = path.join(root, 'series')
      fs.mkdirSync(world.moviesRoot, { recursive: true })
      fs.mkdirSync(world.seriesRoot, { recursive: true })
    },
  },
  {
    pattern: /^en la serie "([^"]*)" existe el archivo "([^"]*)"$/,
    fn: ({ world }, series, rel) => { writeIn(path.join(world.seriesRoot!, series, rel)) },
  },
  {
    pattern: /^en la serie "([^"]*)" existe la carpeta "([^"]*)"$/,
    fn: ({ world }, series, rel) => { fs.mkdirSync(path.join(world.seriesRoot!, series, rel), { recursive: true }) },
  },
  {
    pattern: /^en la serie "([^"]*)" hay (\d+) episodios?$/,
    fn: ({ world }, series, count) => {
      const n = Number(count)
      for (let i = 1; i <= n; i++) writeIn(path.join(world.seriesRoot!, series, 'Season 3', `${series.replace(/\s*\(\d{4}\)$/, '')} S03E${String(i).padStart(2, '0')} 1080p WEB.mkv`))
    },
  },
  {
    pattern: /^en películas existe el archivo "([^"]*)"$/,
    fn: ({ world }, rel) => { writeIn(path.join(world.moviesRoot!, rel)) },
  },
  {
    pattern: /^en películas existe la carpeta "([^"]*)"$/,
    fn: ({ world }, rel) => { fs.mkdirSync(path.join(world.moviesRoot!, rel), { recursive: true }) },
  },
  {
    pattern: /^ejecuto la reparación de la biblioteca$/,
    fn: ({ world }) => { world.heal = healLibrary(world.moviesRoot!, world.seriesRoot!) },
  },
  {
    pattern: /^la reparación no movió ni borró nada$/,
    fn: ({ world }) => {
      if (!world.heal) throw new Error('no se ejecutó la reparación antes')
      if (world.heal.changed) {
        throw new Error(`la reparación cambió algo en una biblioteca ya correcta: ${JSON.stringify(world.heal)}`)
      }
    },
  },
  {
    pattern: /^existe "([^"]*)"$/,
    fn: ({ world }, rel) => { if (!existsInLibrary(world, rel)) throw new Error(`no existe "${rel}" (buscado en series/ y movies/)`) },
  },
  {
    pattern: /^no existe "([^"]*)"$/,
    fn: ({ world }, rel) => { if (existsInLibrary(world, rel)) throw new Error(`existe "${rel}" y no debería`) },
  },

  // ── B8 · resolución de carpeta de destino ──────────────────────────────
  {
    pattern: /^resuelvo el destino del release "([^"]*)" para el tmdb id "(\d+)" del año "(\d+)"$/,
    fn: async ({ world }, release, tmdbId, year) => {
      const isSeries = /\b[sS]\d{1,2}([eE]\d{1,3})?\b/.test(release)
      const settings = {
        destination_folder: '',
        movies_folder: world.moviesRoot!,
        series_folder: world.seriesRoot!,
        tmdb_api_key: process.env.TMDB_API_KEY || '',
      }
      world.dest = await computeDestination(settings, release, isSeries ? 'series' : 'movie', {
        tmdbId: Number(tmdbId),
        year: Number(year),
      })
    },
  },
  {
    pattern: /^la carpeta de destino es "([^"]*)"$/,
    fn: ({ world }, expected) => {
      if (!world.dest) throw new Error('no se resolvió ningún destino antes')
      if (world.dest.folder !== expected) throw new Error(`destino ${world.dest.folder} · esperado ${expected}`)
    },
  },

  // ── B9 · reconciliación del debrid ─────────────────────────────────────
  {
    pattern: /^estos títulos monitorizados$/,
    fn: ({ world, rows }) => {
      world.watched = rows.map((r) => ({
        tmdbId: Number(r[0]),
        mediaType: r[1] === 'movie' ? 'movie' : 'series',
        titles: r[2].split(';').map((s) => s.trim()).filter(Boolean),
        year: Number(r[3]) || undefined,
      }))
    },
  },
  {
    pattern: /^en el debrid hay estos torrents$/,
    fn: ({ world, rows }) => {
      world.torrents = rows.map((r) => ({
        id: Number(r[0]),
        name: r[1],
        state: r[2],
        sizeBytes: Math.round((Number(r[3]) || 0) * 1024 ** 3),
      }))
    },
  },
  {
    pattern: /^los torrents locales son "([^"]*)"$/,
    fn: ({ world }, list) => { world.knownIds = list.split(';').map((s) => Number(s.trim())).filter(Boolean) },
  },
  {
    pattern: /^el tope es de "([^"]*)" GB para series y "([^"]*)" GB para películas$/,
    fn: ({ world }, series, movie) => { world.caps = { series: Number(series) || 0, movie: Number(movie) || 0 } },
  },
  {
    pattern: /^en la biblioteca del título (\d+) existe el episodio "S(\d+)E(\d+)"$/,
    fn: ({ world }, tmdb, season, episode) => {
      world.onDisk = world.onDisk || new Set<string>()
      world.onDisk.add(`${tmdb}:S${Number(season)}E${Number(episode)}`)
    },
  },
  {
    pattern: /^reconcilio el debrid$/,
    fn: ({ world }) => {
      const caps = world.caps || { series: 0, movie: 0 }
      world.plan = planReconcile(world.torrents || [], {
        watched: world.watched || [],
        knownTorrentIds: world.knownIds || [],
        isOnDisk: (tmdbId, mediaType, season, episode) =>
          world.onDisk?.has(mediaType === 'series' ? `${tmdbId}:S${season}E${episode}` : `${tmdbId}:movie`) || false,
        maxSizeGb: (mediaType) => (mediaType === 'movie' ? caps.movie : caps.series),
        minQuality: (world.minQuality ?? 1080) as number,
        seasonOnDisk: (tmdbId, season) => world.seasonCounts?.[`${tmdbId}:${season}`] ?? 0,
      })
    },
  },
  {
    pattern: /^se adopta el torrent (\d+) como "([^"]*)" "([^"]*)"$/,
    fn: ({ world }, id, title, marker) => {
      const plan = needPlan(world)
      const hit = plan.adopt.find((d) => d.torrentId === Number(id))
      if (!hit) throw new Error(`no se adoptó el torrent ${id} (descartado: ${reasonOf(world, Number(id))})`)
      const wanted = world.watched?.find((w) => w.tmdbId === hit.tmdbId)
      if (wanted && !wanted.titles.includes(title)) throw new Error(`adoptado con título ${wanted.titles.join('/')}, esperado ${title}`)
      const got = hit.mediaType === 'movie' ? 'película' : `S${String(hit.season).padStart(2, '0')}E${String(hit.episode).padStart(2, '0')}`
      if (got !== marker) throw new Error(`adoptado como ${got}, esperado ${marker}`)
    },
  },
  {
    pattern: /^no se adopta el torrent (\d+)$/,
    fn: ({ world }, id) => {
      const plan = needPlan(world)
      if (plan.adopt.some((d) => d.torrentId === Number(id))) throw new Error(`se adoptó el torrent ${id} y no debería`)
    },
  },
  {
    pattern: /^se descarta el torrent (\d+) porque "([^"]*)"$/,
    fn: ({ world }, id, motivo) => {
      const plan = needPlan(world)
      if (plan.adopt.some((d) => d.torrentId === Number(id))) throw new Error(`se adoptó el torrent ${id} y debía descartarse`)
      const reason = reasonOf(world, Number(id))
      if (!reason) throw new Error(`el torrent ${id} no aparece ni adoptado ni descartado`)
      if (!reason.toLowerCase().includes(motivo.toLowerCase())) throw new Error(`motivo "${reason}", esperado que contuviera "${motivo}"`)
    },
  },
  {
    pattern: /^no se adopta ningún torrent$/,
    fn: ({ world }) => {
      const plan = needPlan(world)
      if (plan.adopt.length > 0) throw new Error(`se adoptaron ${plan.adopt.length}: ${plan.adopt.map((d) => d.name).join(', ')}`)
    },
  },
  {
    pattern: /^el orden de adopción es "([^"]*)"$/,
    fn: ({ world }, expected) => {
      const got = needPlan(world).adopt.map((d) => d.torrentId).join(', ')
      const want = expected.split(',').map((s) => s.trim()).filter(Boolean).join(', ')
      if (got !== want) throw new Error(`orden de adopción: ${got}\n            esperado:          ${want}`)
    },
  },
  {
    pattern: /^evalúo el nombre "([^"]*)"$/,
    fn: ({ world }, name) => {
      world.parsed = parseReleaseName(name)
    },
  },
  {
    pattern: /^el título del release es "([^"]*)"$/,
    fn: ({ world }, expected) => {
      if (!world.parsed) throw new Error('no se evaluó ningún nombre antes')
      if (world.parsed.title !== expected) throw new Error(`título "${world.parsed.title}" · esperado "${expected}"`)
    },
  },
  {
    pattern: /^la temporada del release es "([^"]*)"$/,
    fn: ({ world }, expected) => {
      if (!world.parsed) throw new Error('no se evaluó ningún nombre antes')
      const got = String(world.parsed.season ?? '')
      if (got !== expected) throw new Error(`temporada ${got} · esperada ${expected}`)
    },
  },
  {
    pattern: /^la calidad mínima es "([^"]*)"$/,
    fn: ({ world }, q) => { world.minQuality = parseQualitySetting(q) },
  },
  {
    pattern: /^evalúo la calidad del release "([^"]*)"$/,
    fn: ({ world }, name) => {
      world.qualityOk = meetsMinQuality(name, (world.minQuality ?? 1080) as VideoQuality)
    },
  },
  {
    pattern: /^el release "(cumple|no cumple)"$/,
    fn: ({ world }, expected) => {
      if (world.qualityOk === undefined) throw new Error('no se evaluó ningún release antes')
      const want = expected === 'cumple'
      if (world.qualityOk !== want) throw new Error(want ? 'no cumplía la calidad mínima' : 'cumplía y debía descartarse')
    },
  },
  // ── B13–B16 · post-proceso de descargas ────────────────────────────────
  {
    pattern: /^el archivo se llama "([^"]*)"$/,
    fn: ({ world }, name) => { world.fileEpisode = episodeFromFileName(name) },
  },
  {
    pattern: /^miro su episodio$/,
    fn: ({ world }) => { if (world.fileEpisode === undefined) throw new Error('no se indicó ningún archivo') },
  },
  {
    pattern: /^es de la temporada "([^"]*)" episodio "([^"]*)"$/,
    fn: ({ world }, season, episode) => {
      const ref = world.fileEpisode
      if (!ref) throw new Error('el archivo no tenía episodio')
      if (String(ref.season) !== season || String(ref.episode) !== episode) {
        throw new Error(`S${ref.season}E${ref.episode} · esperado S${season}E${episode}`)
      }
    },
  },
  {
    pattern: /^no tiene episodio$/,
    fn: ({ world }) => {
      if (world.fileEpisode) throw new Error(`se sacó S${world.fileEpisode.season}E${world.fileEpisode.episode} de un nombre sin episodio`)
    },
  },
  {
    pattern: /^las pistas de audio son "([^"]*)"$/,
    fn: ({ world }, list) => {
      world.audioStreams = list.split(',').map((l, i) => ({ index: i, language: l.trim() }))
    },
  },
  {
    pattern: /^decido si hay que reordenar el audio$/,
    fn: ({ world }) => {
      const streams = world.audioStreams || []
      world.audioOrder = reorderedAudioIndexes(streams).map((i) => streams[i]?.language || '').join(',')
    },
  },
  {
    pattern: /^el orden final del audio es "([^"]*)"$/,
    fn: ({ world }, expected) => {
      if (!world.audioOrder) throw new Error('no se evaluaron pistas de audio antes')
      if (world.audioOrder !== expected) throw new Error(`orden ${world.audioOrder} · esperado ${expected}`)
    },
  },
  {
    pattern: /^un torrent en estado "([^"]*)" creado hace (\d+) minutos$/,
    fn: ({ world }, state, age) => {
      world.torrentState = state
      world.torrentAge = Number(age)
    },
  },
  {
    pattern: /^el límite de torrents atascados es "([^"]*)" minutos$/,
    fn: ({ world }, min) => { world.staleLimit = Number(min) },
  },
  {
    pattern: /^compruebo si hay que liberar su plaza$/,
    fn: ({ world }) => {
      world.staleRelease = isStaleTorrent(String(world.torrentState || ''), Number(world.torrentAge || 0), Number(world.staleLimit ?? 120))
    },
  },
  {
    pattern: /^el torrent "(se libera|no se libera)"$/,
    fn: ({ world }, expected) => {
      const want = expected === 'se libera'
      if (world.staleRelease !== want) {
        throw new Error(`estado "${world.torrentState}" (${world.torrentAge} min) → ${world.staleRelease ? 'se libera' : 'no se libera'}`)
      }
    },
  },
  {
    pattern: /^la calidad mínima para la adopción es "([^"]*)"$/,
    fn: ({ world }, q) => { world.minQuality = parseQualitySetting(q) },
  },
  {
    pattern: /^en la biblioteca del título (\d+) la temporada (\d+) tiene (\d+) episodios?$/,
    fn: ({ world }, tmdb, season, count) => {
      world.seasonCounts = world.seasonCounts || {}
      world.seasonCounts[`${tmdb}:${season}`] = Number(count)
    },
  },
  {
    pattern: /^se adopta el torrent (\d+) como "([^"]*)" "S(\d+)" completo$/,
    fn: ({ world }, id, title, season) => {
      const hit = needPlan(world).adopt.find((d) => d.torrentId === Number(id))
      if (!hit) throw new Error(`no se adoptó el pack ${id} (descartado: ${reasonOf(world, Number(id))})`)
      if (!hit.pack) throw new Error('se adoptó como episodio suelto y era un pack de temporada')
      if (Number(hit.season) !== Number(season)) throw new Error(`temporada ${hit.season} · esperada ${season}`)
      const w = world.watched?.find((x) => x.tmdbId === hit.tmdbId)
      if (w && title && !w.titles.includes(title)) throw new Error(`título ${w.titles.join('/')} · esperado ${title}`)
    },
  },
  {
    pattern: /^el destino del torrent (\d+) es "([^"]*)"$/,
    fn: async ({ world }, id, expected) => {
      const d = needPlan(world).adopt.find((x) => x.torrentId === Number(id))
      if (!d) throw new Error(`el torrent ${id} no está entre los adoptados`)
      const watched = world.watched?.find((w) => w.tmdbId === d.tmdbId)
      if (!watched) throw new Error('no se encontró el título monitorizado del adoptado')
      const settings = {
        destination_folder: '',
        movies_folder: world.moviesRoot!,
        series_folder: world.seriesRoot!,
        tmdb_api_key: process.env.TMDB_API_KEY || '',
      }
      const dest = await adoptionDestination(settings, d, watched)
      if (dest.folder !== expected) throw new Error(`destino de adopción ${dest.folder} · esperado ${expected}`)
    },
  },

  // ── B10 · cooldown del debrid ──────────────────────────────────────────
  {
    pattern: /^el debrid tiene cooldown hasta "([^"]*)"$/,
    fn: ({ world }, iso) => {
      world.account = { cooldownUntil: iso || null, at: 0 }
    },
  },
  {
    pattern: /^la hora actual es "([^"]*)"$/,
    fn: ({ world }, iso) => { world.now = Date.parse(iso) },
  },
  {
    pattern: /^estos candidatos$/,
    fn: ({ world, rows }) => {
      world.candidates = rows.map((r) => ({ title: r[0], cached: (r[1] || '').toLowerCase().startsWith('s') }))
    },
  },
  {
    pattern: /^intento bajarlos$/,
    fn: ({ world }) => {
      world.inCooldown = isInCooldown(world.account, world.now)
      world.usable = cooldownFilter(world.candidates || [], Boolean(world.inCooldown)).usable
    },
  },
  {
    pattern: /^se intentan "([^"]*)"$/,
    fn: ({ world }, expected) => {
      const got = (world.usable || []).map((c) => c.title).join(', ')
      const want = expected.split(',').map((s) => s.trim()).filter(Boolean).join(', ')
      if (got !== want) throw new Error(`se intentarían: ${got}\n            esperado:     ${want}`)
    },
  },
  {
    pattern: /^no se intenta ningún candidato$/,
    fn: ({ world }) => {
      if ((world.usable || []).length > 0) throw new Error(`se intentarían ${world.usable!.length} candidato(s)`)
    },
  },
  {
    pattern: /^el objetivo queda "([^"]*)"$/,
    fn: ({ world }, esperado) => {
      if (esperado === 'diferido por cooldown') {
        if (!world.inCooldown) throw new Error('el debrid no está en cooldown según el escenario')
        if ((world.usable || []).length > 0) throw new Error('hay candidatos usables: no se difiere')
        return
      }
      throw new Error(`estado esperado desconocido: ${esperado}`)
    },
  },

  // ── B18 · comprobación manual ("Verificar ahora") ───────────────────────
  {
    pattern: /^un intento pendiente con próxima fecha "([^"]*)" y (\d+) intentos$/,
    fn: ({ world }, next, attempts) => {
      world.pendingAttempt = { next_attempt: next, attempts: Number(attempts) }
    },
  },
  {
    // El "reloj" lo fija el paso compartido con B10 ("la hora actual es ..."),
    // que guarda milisegundos en `world.now`.
    pattern: /^compruebo ese intento (sin forzar|forzando)$/,
    fn: ({ world }, mode) => {
      if (!world.pendingAttempt) throw new Error('no hay intento pendiente en este escenario')
      if (typeof world.now !== 'number') throw new Error('falta fijar la hora actual')
      const nowIso = new Date(world.now).toISOString()
      world.deferred = shouldDeferAttempt(world.pendingAttempt, nowIso, mode === 'forzando')
    },
  },
  {
    pattern: /^el intento (queda diferido|no queda diferido)$/,
    fn: ({ world }, expected) => {
      const want = expected === 'queda diferido'
      if (world.deferred !== want) {
        throw new Error(`deferred=${world.deferred} · esperado ${want} (true = se difiere sin intentar, false = se intenta)`)
      }
    },
  },
  {
    pattern: /^calculo el próximo reintento (sin forzar|forzando) tras el intento (\d+)$/,
    fn: ({ world }, mode, n) => {
      world.nextDelay = nextAttemptAfterFailure(mode === 'forzando', Number(n))
    },
  },
  {
    pattern: /^el próximo reintento es (ninguno|\d+)$/,
    fn: ({ world }, expected) => {
      const want = expected === 'ninguno' ? undefined : Number(expected)
      if (world.nextDelay !== want) {
        throw new Error(`próximo reintento ${String(world.nextDelay)} · esperado ${expected} (ninguno = no se toca la ventana)`)
      }
    },
  },

  // ── B19 · idioma por defecto al añadir un título ────────────────────────
  {
    pattern: /^un ajuste de idioma por defecto "([^"]*)"$/,
    fn: ({ world }, value) => {
      world.defaultProfile = value
    },
  },
  {
    pattern: /^normalizo el perfil enviado "(.*)"$/,
    fn: ({ world }, sent) => {
      world.normalizedProfile = normalizeLanguageProfile(sent || undefined, world.defaultProfile)
    },
  },
  {
    pattern: /^el perfil resultante es "([^"]*)"$/,
    fn: ({ world }, expected) => {
      if (world.normalizedProfile !== expected) {
        throw new Error(`perfil resultante ${String(world.normalizedProfile)} · esperado ${expected}`)
      }
    },
  },
  {
    pattern: /^que el ajuste de idioma por defecto de la app es "([^"]*)"$/,
    fn: ({ world }, value) => {
      world.prevDefaultProfile = getSettings().language_profile
      updateSettings({ language_profile: normalizeLanguageProfile(value) })
    },
  },
  {
    pattern: /^añado el título de prueba "([^"]*)" sin perfil explícito$/,
    fn: ({ world }, title) => {
      // tmdb_id inexistente: no hay detalle ni objetivos → no dispara descargas.
      const { item } = addWatchlistItem({ tmdb_id: 999999001, media_type: 'series', title, backfill: 'new' })
      world.testItemId = item.id
    },
  },
  {
    pattern: /^el listado lo devuelve con el perfil "([^"]*)"$/,
    fn: ({ world }, expected) => {
      const item = listWatchlist().find((i) => i.id === world.testItemId)
      if (!item) throw new Error('el título de prueba no aparece en el listado')
      if (item.language_profile !== expected) {
        throw new Error(`el listado devuelve ${item.language_profile} · esperado ${expected}`)
      }
    },
  },
  {
    pattern: /^en el título de prueba pongo el perfil "([^"]*)"$/,
    fn: ({ world }, profile) => {
      if (!world.testItemId) throw new Error('no hay título de prueba en este escenario')
      updateWatchlistItem(world.testItemId, { language_profile: normalizeLanguageProfile(profile) })
    },
  },
  {
    pattern: /^borro el título de prueba y restauro el ajuste "([^"]*)"$/,
    fn: ({ world }, restore) => {
      const id = world.testItemId
      if (id) removeWatchlistItem(id)
      updateSettings({ language_profile: normalizeLanguageProfile(restore) })
      if (id && listWatchlist().some((i) => i.id === id)) throw new Error('el título de prueba sigue en el listado')
      if (getSettings().language_profile !== restore) throw new Error(`el ajuste quedó en ${getSettings().language_profile}`)
    },
  },

  // ── B20 · pósters de Seguimiento ────────────────────────────────────────
  {
    pattern: /^normalizo el póster "(.*)"$/,
    fn: ({ world }, entrada) => {
      world.posterUrl = normalizePosterUrl(entrada)
    },
  },
  {
    pattern: /^el póster queda como "(.*)"$/,
    fn: ({ world }, esperado) => {
      if (world.posterUrl !== esperado) {
        throw new Error(`póster ${JSON.stringify(world.posterUrl)} · esperado ${JSON.stringify(esperado)}`)
      }
    },
  },
  {
    pattern: /^un título en seguimiento "([^"]*)" sin póster$/,
    fn: ({ world }) => {
      world.posterItem = { poster: '', backdrop: '' }
    },
  },
  {
    pattern: /^un título en seguimiento "([^"]*)" con póster "([^"]*)"$/,
    fn: ({ world }, _titulo, poster) => {
      world.posterItem = { poster, backdrop: '' }
    },
  },
  {
    pattern: /^el detalle de TMDB de "([^"]*)" trae el póster "([^"]*)"$/,
    fn: ({ world }, _titulo, poster) => {
      world.posterDetail = { poster_path: poster }
    },
  },
  {
    pattern: /^el relleno le pone el póster "(.*)"$/,
    fn: ({ world }, esperado) => {
      if (!world.posterItem) throw new Error('no hay título en seguimiento en este escenario')
      world.posterPatch = posterBackfillPatch(world.posterItem, world.posterDetail || {})
      if (world.posterPatch.poster !== esperado) {
        throw new Error(`el relleno puso ${JSON.stringify(world.posterPatch.poster)} · esperado ${JSON.stringify(esperado)}`)
      }
    },
  },
  {
    pattern: /^el relleno no cambia ningún campo$/,
    fn: ({ world }) => {
      if (!world.posterItem) throw new Error('no hay título en seguimiento en este escenario')
      world.posterPatch = posterBackfillPatch(world.posterItem, world.posterDetail || {})
      const claves = Object.keys(world.posterPatch)
      if (claves.length) throw new Error(`el relleno habría cambiado: ${claves.join(', ')}`)
    },
  },
  {
    pattern: /^añado el título de prueba "([^"]*)" con póster "([^"]*)"$/,
    fn: ({ world }, title, poster) => {
      const { item } = addWatchlistItem({ tmdb_id: 999999003, media_type: 'series', title, poster, backfill: 'new' })
      world.testItemId = item.id
    },
  },
  {
    pattern: /^el listado lo devuelve con el póster "(.*)"$/,
    fn: ({ world }, esperado) => {
      const item = listWatchlist().find((i) => i.id === world.testItemId)
      if (!item) throw new Error('el título de prueba no aparece en el listado')
      if (item.poster !== esperado) {
        throw new Error(`el listado devuelve ${JSON.stringify(item.poster)} · esperado ${JSON.stringify(esperado)}`)
      }
    },
  },
  {
    pattern: /^borro el título de prueba y no queda rastro$/,
    fn: ({ world }) => {
      const id = world.testItemId
      if (id) removeWatchlistItem(id)
      if (id && listWatchlist().some((i) => i.id === id)) throw new Error('el título de prueba sigue en el listado')
    },
  },

  // ── B21 · actualizaciones y guardado de ajustes ─────────────────────────
  {
    pattern: /^el error de actualización "(.*)" es leve$/,
    fn: ({ world }, mensaje) => {
      world.updateError = mensaje
      world.esperadoLeve = true
    },
  },
  {
    pattern: /^el error de actualización "(.*)" no es leve$/,
    fn: ({ world }, mensaje) => {
      world.updateError = mensaje
      world.esperadoLeve = false
    },
  },
  {
    pattern: /^la app lo trata como sin actualización y no lo enseña como error$/,
    fn: ({ world }) => {
      const real = isBenignUpdateError(world.updateError)
      if (real !== world.esperadoLeve) {
        throw new Error(`«${world.updateError}» → leve=${real} · esperado ${world.esperadoLeve}`)
      }
    },
  },
  {
    pattern: /^recuerdo el ajuste "([^"]*)"$/,
    fn: ({ world }, clave) => {
      world.ajusteGuardado = { clave, valor: (getSettings() as any)[clave] }
    },
  },
  {
    pattern: /^guardo ajustes con la clave "([^"]*)" y el valor "([^"]*)"$/,
    fn: ({ world }, clave, valor) => {
      world.resultadoAjustes = updateSettings({ [clave]: valor } as any)
    },
  },
  {
    pattern: /^guardo ajustes con la clave "([^"]*)" y un objeto$/,
    fn: ({ world }, clave) => {
      world.resultadoAjustes = updateSettings({ [clave]: { a: 1 } } as any)
    },
  },
  {
    pattern: /^el guardado se acepta$/,
    fn: ({ world }) => {
      if (!world.resultadoAjustes?.ok) throw new Error('el guardado devolvió ok=false')
    },
  },
  {
    pattern: /^el guardado aplica (\d+) campos?$/,
    fn: ({ world }, n) => {
      const aplicados = world.resultadoAjustes?.applied
      if (aplicados !== Number(n)) throw new Error(`aplicó ${aplicados} campos · esperado ${n}`)
    },
  },
  {
    pattern: /^el guardado ignora "([^"]*)"$/,
    fn: ({ world }, clave) => {
      const ignoradas = world.resultadoAjustes?.ignored || []
      if (!ignoradas.includes(clave)) throw new Error(`no figura en ignoradas: ${ignoradas.join(', ') || '(ninguna)'}`)
    },
  },
  {
    pattern: /^el guardado no reporta "([^"]*)"$/,
    fn: ({ world }, clave) => {
      const ignoradas = world.resultadoAjustes?.ignored || []
      if (ignoradas.includes(clave)) throw new Error(`«${clave}» no debería figurar como ignorada`)
    },
  },
  {
    pattern: /^el ajuste "([^"]*)" vale "([^"]*)"$/,
    fn: ({ world }, clave, valor) => {
      const real = String((getSettings() as any)[clave])
      if (real !== valor) throw new Error(`«${clave}» = ${real} · esperado ${valor}`)
    },
  },
  {
    pattern: /^el ajuste "([^"]*)" sigue como estaba$/,
    fn: ({ world }, clave) => {
      const guardado = world.ajusteGuardado?.valor
      const real = (getSettings() as any)[clave]
      if (String(real) !== String(guardado)) {
        throw new Error(`«${clave}» cambió de ${guardado} a ${real}`)
      }
    },
  },
  {
    pattern: /^el ajuste "([^"]*)" se guardó como JSON$/,
    fn: ({ world }, clave) => {
      const real = String((getSettings() as any)[clave])
      let parsed: any
      try {
        parsed = JSON.parse(real)
      } catch {
        throw new Error(`«${clave}» no quedó como JSON: ${real}`)
      }
      if (parsed?.a !== 1) throw new Error(`JSON inesperado en «${clave}»: ${real}`)
    },
  },
  {
    pattern: /^restauro el ajuste "([^"]*)"$/,
    fn: ({ world }, clave) => {
      const guardado = world.ajusteGuardado
      if (!guardado || guardado.clave !== clave) throw new Error(`no había guardado previo de «${clave}»`)
      updateSettings({ [clave]: guardado.valor } as any)
      const real = (getSettings() as any)[clave]
      if (String(real) !== String(guardado.valor)) {
        throw new Error(`no se pudo restaurar «${clave}» (quedó ${real})`)
      }
    },
  },
]

function needPlan(world: World): ReconcilePlan {
  if (!world.plan) throw new Error('no se reconcilió el debrid antes')
  return world.plan
}

function reasonOf(world: World, id: number): string {
  return world.plan?.skip.find((s) => s.torrentId === id)?.reason || ''
}

function writeIn(abs: string): void {
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, Buffer.alloc(64, 7))
}

function existsInLibrary(world: World, rel: string): boolean {
  return Boolean(
    (world.seriesRoot && fs.existsSync(path.join(world.seriesRoot, rel))) ||
    (world.moviesRoot && fs.existsSync(path.join(world.moviesRoot, rel))),
  )
}

// postprocess.ts — lo que la app hace sola al terminar una descarga (spec B13–B15).
//
// Todo esto se hacía A MANO cuando llegaba un pack de temporada:
//   · los episodios quedaban sin fila en grab_history → el monitor los volvía a
//     bajar (duplicados),
//   · los subtítulos no se pedían (el nombre del torrent no trae SxxEyy, sólo la
//     temporada) → 0 subtítulos,
//   · un pack ITA-ENG dejaba el italiano como pista por defecto → Jellyfin
//     reproducía en italiano.
// Las decisiones son funciones puras (probadas en spec/features/postprocess.feature);
// el IO vive en las funciones de abajo.

import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFile } from 'child_process'
import { addGrabHistoryIfMissing, findWatchlistItem } from './watchlist'
import { findMediaFolderByName } from './db'

export interface EpisodeRef {
  season: number
  episode: number
}

/** Temporada y episodio a partir del nombre de un ARCHIVO (no del torrent). */
export function episodeFromFileName(file: string): EpisodeRef | null {
  const m = /\bS(\d{1,2})\s*[Ee](\d{1,3})\b/i.exec(String(file || ''))
  if (m) return { season: parseInt(m[1], 10), episode: parseInt(m[2], 10) }
  const alt = /\b(\d{1,2})x(\d{1,3})\b/.exec(String(file || ''))
  if (alt) return { season: parseInt(alt[1], 10), episode: parseInt(alt[2], 10) }
  return null
}

export interface AudioStream {
  index: number
  language?: string
  default?: boolean
}

/** Etiquetas de idioma que aceptamos como "preferido" (latino/español e inglés). */
export const PREFERRED_AUDIO = ['spa', 'es', 'esp', 'lat', 'spl', 'es-mx', 'es-la', 'eng', 'en', 'english', 'spanish']

const norm = (l?: string): string => String(l || '').toLowerCase().trim()

/**
 * Índice de la pista que debe ir PRIMERO: la de mejor prioridad según la lista
 * de idiomas preferidos (el español/latino manda sobre el inglés), no la primera
 * que aparezca. -1 si ninguna es preferida.
 */
export function preferredFirstIndex(streams: AudioStream[], preferred: string[] = PREFERRED_AUDIO): number {
  const want = preferred.map(norm)
  let best = -1
  let bestRank = Number.POSITIVE_INFINITY
  streams.forEach((s, i) => {
    const rank = want.indexOf(norm(s.language))
    if (rank >= 0 && rank < bestRank) {
      bestRank = rank
      best = i
    }
  })
  return best
}

/**
 * ¿Hay que reordenar el audio? Sólo si la PRIMERA pista no es de un idioma
 * preferido y otra SÍ (si ninguna lo es, no hay nada que ganar reordenando).
 */
export function needsAudioReorder(streams: AudioStream[], preferred: string[] = PREFERRED_AUDIO): boolean {
  if (streams.length < 2) return false
  const idx = preferredFirstIndex(streams, preferred)
  return idx > 0
}

/** Orden de las pistas tras el remux: la preferida primero y el resto como estaban. */
export function reorderedAudioIndexes(streams: AudioStream[], preferred: string[] = PREFERRED_AUDIO): number[] {
  const pick = preferredFirstIndex(streams, preferred)
  if (pick <= 0) return streams.map((s) => s.index)
  return [streams[pick].index, ...streams.filter((_, i) => i !== pick).map((s) => s.index)]
}

function run(cmd: string, args: string[], timeoutMs = 15 * 60_000): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? 1 : 0, out: String(stdout || '') + String(stderr || '') })
    })
  })
}

async function probeStreams(file: string): Promise<AudioStream[]> {
  const r = await run('ffprobe', ['-v', 'error', '-select_streams', 'a',
    '-show_entries', 'stream=index:stream_tags=language', '-of', 'csv=p=0', file], 60_000)
  if (r.code !== 0) return []
  return r.out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l, i) => ({ index: i, language: l.split(',').pop() }))
}

/**
 * Deja el audio en el orden preferido (inglés/español primero) sin recodificar.
 * Sólo actúa si hace falta; nunca destruye el archivo original sin verificar.
 */
export async function normalizeAudioOrder(files: string[]): Promise<number> {
  let fixed = 0
  for (const file of files) {
    if (!fs.existsSync(file)) continue
    const streams = await probeStreams(file)
    if (!needsAudioReorder(streams)) continue
    const order = reorderedAudioIndexes(streams)
    const tmp = path.join(path.dirname(file), `.audiofix-${path.basename(file)}`)
    const args = ['-v', 'error', '-y', '-i', file, '-map', '0:v']
    for (const idx of order) args.push('-map', `0:a:${idx}`)
    args.push('-map', '0:s?', '-c', 'copy')
    order.forEach((_, i) => args.push(`-disposition:a:${i}`, i === 0 ? 'default' : '0'))
    args.push(tmp)
    const r = await run('ffmpeg', args)
    const info = r.code === 0 ? await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', tmp], 60_000) : { code: 1, out: '' }
    if (r.code !== 0 || !info.out.trim()) {
      console.warn(`[Worker] no se pudo reordenar el audio de ${path.basename(file)} (se deja como está)`)
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp) } catch { /* nada */ }
      continue
    }
    try {
      fs.unlinkSync(file)
      fs.renameSync(tmp, file)
      fixed += 1
      console.log(`[Worker] audio reordenado (${streams.length} pistas) → ${path.basename(file)}`)
    } catch (e: any) {
      console.warn(`[Worker] no se pudo sustituir ${path.basename(file)}: ${e?.message || e}`)
    }
  }
  return fixed
}

/**
 * Registra en grab_history cada video descargado (con season/episode sacados del
 * ARCHIVO) para que el monitor sepa que ese episodio ya está en disco. Es lo que
 * evita re-descargar un pack entero en el siguiente tick.
 */
export function registerDownloadedEpisodes(opts: {
  tmdbId: number
  mediaType: string
  torrentName: string
  destFolder: string
  files: string[]
  torboxId: string
}): number {
  let added = 0
  for (const file of opts.files) {
    const ref = episodeFromFileName(path.basename(file))
    const isMovie = !ref && /movie/i.test(opts.mediaType)
    try {
      const created = addGrabHistoryIfMissing({
        tmdb_id: opts.tmdbId,
        media_type: opts.mediaType,
        season: ref ? ref.season : null,
        episode: ref ? ref.episode : null,
        kind: ref ? 'episode' : 'movie',
        title: path.basename(file),
        language: 'english',
        source: 'download',
        status: 'grabbed',
        torbox_id: opts.torboxId,
        dest_folder: opts.destFolder,
        file_name: path.basename(file),
      })
      if (created) added += 1
    } catch (e: any) {
      console.warn(`[Worker] no se pudo registrar ${path.basename(file)}: ${e?.message || e}`)
    }
    if (isMovie) break
  }
  return added
}

/**
 * ¿De qué título de la watchlist es esta carpeta? Genérico, para cualquier serie
 * o película: primero por el tmdb_id de la fila del grab, si no por el nombre de
 * la carpeta de la biblioteca (`media_folders`). Devuelve null si no se sabe —
 * en ese caso NO se registra nada (mejor no tocar que inventar).
 */
export function resolveFolderOwner(
  tmdbIdFromGrab: number | undefined,
  destFolder: string,
  type: string,
): { tmdb_id: number; media_type: string } | null {
  try {
    if (tmdbIdFromGrab) {
      const wl = findWatchlistItem(tmdbIdFromGrab, type === 'movie' ? 'movie' : 'series')
      if (wl) return { tmdb_id: wl.tmdb_id, media_type: wl.media_type }
    }
  } catch { /* sigue con la carpeta */ }
  // La carpeta de la serie es el padre de "Season N"; en películas, la carpeta.
  const parts = String(destFolder || '').split(path.sep).filter(Boolean)
  const candidates = /\bseason\b/i.test(parts[parts.length - 1] || '')
    ? [parts[parts.length - 2], parts[parts.length - 1]]
    : [parts[parts.length - 1], parts[parts.length - 2]]
  for (const c of candidates) {
    const owner = findMediaFolderByName(c || '')
    if (owner) return owner
  }
  return null
}

export function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mp-post-'))
}

// download-dedupe.ts — "no bajar dos veces el mismo episodio" (spec B26).
//
// Lección de producción (Silo S02): se encolaron a la vez el pack de temporada
// y los episodios sueltos del mismo contenido. Cada release es un torrent
// distinto con su propio id en el debrid, así que la deduplicación por id no lo
// veía: se bajaron 30 GB de más, dos archivos por episodio y Jellyfin con dos
// versiones del mismo capítulo. Aquí se compara por TEMPORADA/EPISODIO, nunca
// por torrent.
//
// Las decisiones son funciones puras (probadas en spec/features/download-dedupe.feature).

import fs from 'fs'
import path from 'path'
import { episodeFromFileName } from './postprocess'

export interface Coverage {
  season: number | null
  episode: number | null
  /** true = cubre la temporada entera (pack, COMPLETE, "Season 2", "Temporada 2"). */
  pack: boolean
}

export interface ExistingCoverage extends Coverage {
  source: 'download' | 'historial' | 'disco'
  status: string
  name: string
}

/** Estados que YA cubren el episodio. Un fallo o una cancelación, no. */
const NO_CUBRE = new Set(['failed', 'error', 'cancelled', 'canceled', 'deleted', 'skipped', 'duplicate'])

export function statusCovers(status: string): boolean {
  return !NO_CUBRE.has(String(status || '').toLowerCase())
}

/**
 * ¿Qué cubre este release? Un episodio suelto, una temporada completa o nada.
 * `files` (listado del torrent) manda cuando existe: varias temporadas distintas
 * en un mismo torrent no se pueden cubrir con una sola temporada.
 */
export function releaseCoverage(name: string, files: string[] = []): Coverage | null {
  const base = path.basename(String(name || ''))
  const single = episodeFromFileName(base)
  if (single) return { season: single.season, episode: single.episode, pack: false }
  if (files.length > 0) {
    const eps = files
      .map((f) => episodeFromFileName(path.basename(f)))
      .filter((r): r is { season: number; episode: number } => Boolean(r))
    if (eps.length >= 2) {
      const seasons = new Set(eps.map((e) => e.season))
      return seasons.size === 1 ? { season: eps[0].season, episode: null, pack: true } : null
    }
    if (eps.length === 1) return { season: eps[0].season, episode: eps[0].episode, pack: false }
  }
  const pack = /\bS(\d{1,2})\b(?!\s*E\d)|\bseason[\s._-]*(\d{1,2})\b|\btemporada[\s._-]*(\d{1,2})\b|\bcomplete\b|\bcompleta\b/i.exec(base)
  if (!pack) return null
  const season = Number(pack[1] || pack[2] || pack[3] || 0)
  return { season: season > 0 ? season : null, episode: null, pack: true }
}

/** Episodios que ya están en una carpeta de la biblioteca (mira dentro de Season NN). */
export function episodesOnDisk(folder: string): Array<{ season: number; episode: number }> {
  const out: Array<{ season: number; episode: number }> = []
  const walk = (dir: string, depth: number): void => {
    if (depth > 2) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return // la carpeta todavía no existe
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full, depth + 1)
        continue
      }
      if (!/\.(mkv|mp4|avi|m4v)$/i.test(entry.name)) continue
      const ref = episodeFromFileName(entry.name)
      if (ref) out.push(ref)
    }
  }
  walk(folder, 0)
  return out
}

/**
 * ¿Se puede omitir este release? Devuelve el motivo en castellano para poder
 * enseñarlo tal cual en el log y en la respuesta del API.
 */
export function planDuplicateSkip(
  candidate: Coverage,
  existing: ExistingCoverage[],
): { skip: boolean; reason: string } {
  for (const item of existing) {
    if (!statusCovers(item.status)) continue
    if (item.season !== candidate.season) continue
    const mismoEpisodio = candidate.episode != null && item.episode === candidate.episode
    if (mismoEpisodio) {
      const donde = item.source === 'disco' ? 'en disco' : `en ${item.source}${item.name ? ` (${item.name})` : ''}`
      return { skip: true, reason: `S${candidate.season}E${candidate.episode} ya está ${donde}` }
    }
    const packCubreEpisodio = candidate.episode != null && item.pack
    const packRepetido = candidate.pack && item.pack
    if (candidate.episode != null && packCubreEpisodio) {
      return { skip: true, reason: `la temporada ${candidate.season} ya se está bajando en un pack (${item.name || 'sin nombre'})` }
    }
    if (packRepetido) {
      return { skip: true, reason: `la temporada ${candidate.season} ya está en ${item.source} (${item.name || 'sin nombre'})` }
    }
  }
  return { skip: false, reason: '' }
}

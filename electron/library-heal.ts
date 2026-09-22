// library-heal.ts — autoconsolidación de la biblioteca.
//
// Cuando TMDB cambia el título de un título ("Demo9 (ES)" → "Demo9 (EN)",
// "El tigre y el dragón" → "Tigre y dragón") el motor de descargas creaba una
// carpeta PARALELA: la vieja con casi todo el contenido y la nueva recibiendo lo
// nuevo. Jellyfin lo mostraba como dos series/películas iguales y el disco se
// partía en dos.
//
// computeDestination() ya no crea ese duplicado (empareja títulos por tokens,
// ignorando artículos y cambios de título), y este módulo repara los que ya
// existen: mueve los videos de la carpeta huérfana a la de verdad, poda las
// carpetas vacías y deja la fila de media_folders apuntando a la buena.
//
// Reglas de seguridad (nunca se pierde nada):
//  - Solo se fusionan carpetas que el comparador considera EL MISMO título
//    (mismos tokens o subconjunto, con el año igual cuando ambos lo traen).
//  - Nunca se sobrescribe un archivo: si el destino ya tiene ese episodio
//    (mismo marcador SxxEyy en series, mismo nombre de archivo), el archivo se
//    queda donde está y se avisa en el resumen.
//  - Si hay dudas (una carpeta sin ningún video, títulos ambiguos) no se toca
//    nada: se informa para revisarlo a mano.

import fs from 'fs'
import path from 'path'
import { sameTitleFolder, safeSegment, resolveSeasonFolder, parseReleaseName } from './media-layout'
import { getMediaFolder, setMediaFolder, getDB } from './db'

const VIDEO_RE = /\.(mkv|mp4|avi|m4v|mov|wmv|ts|webm)$/i
const SIDE_RE = /\.(srt|vtt|ass|ssa|sub)$/i
const EP_RE = /(?:^|[^a-z0-9])s0*(\d{1,2})e0*(\d{1,3})(?:[^0-9]|$)/i

export interface HealMove {
  from: string
  to: string
  file: string
}

export interface HealGroup {
  keep: string
  merged: string[]
  moved: HealMove[]
  skipped: Array<{ file: string; reason: string }>
  pruned: string[]
}

export interface HealResult {
  movies: HealGroup[]
  series: HealGroup[]
  changed: boolean
}

function listDirs(root: string): string[] {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
  } catch { return [] }
}

function listFiles(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name)
  } catch { return [] }
}

/** Videos de una carpeta de título (recursivo por temporadas en series). */
function mediaFiles(root: string, folder: string, kind: 'movie' | 'series'): Array<{ rel: string; abs: string }> {
  const base = path.join(root, folder)
  const out: Array<{ rel: string; abs: string }> = []
  if (kind === 'movie') {
    for (const f of listFiles(base)) {
      if (VIDEO_RE.test(f) || SIDE_RE.test(f)) out.push({ rel: f, abs: path.join(base, f) })
    }
    return out
  }
  for (const season of listDirs(base)) {
    for (const f of listFiles(path.join(base, season))) {
      if (VIDEO_RE.test(f) || SIDE_RE.test(f)) out.push({ rel: path.join(season, f), abs: path.join(base, season, f) })
    }
  }
  return out
}

function episodeMarker(name: string): string {
  const m = EP_RE.exec(name)
  return m ? `s${Number(m[1])}e${Number(m[2])}` : ''
}

/**
 * Consolida las carpetas de un root que representan el mismo título.
 * `kind` decide si se buscan temporadas dentro de cada carpeta.
 */
export function healRoot(root: string, kind: 'movie' | 'series', preferred: string[] = []): HealGroup[] {
  const dirs = listDirs(root)
  const groups: HealGroup[] = []
  const used = new Set<string>()

  for (const dir of dirs) {
    if (used.has(dir)) continue
    // Miembros del grupo: carpetas que son el mismo título que `dir`.
    const members = dirs.filter((d) => !used.has(d) && (d === dir || sameTitleFolder(d, dir)))
    if (members.length < 2) continue
    members.forEach((m) => used.add(m))

    const withMedia = members
      .map((m) => ({ name: m, files: mediaFiles(root, m, kind) }))
      .filter((m) => m.files.length > 0)
    if (withMedia.length < 2) {
      // Una de las dos está vacía: no hay nada que fusionar (probablemente la
      // carpeta recién creada). Se deja como está y se informa.
      const empty = members.filter((m) => !withMedia.some((w) => w.name === m))
      if (empty.length > 0 && withMedia.length === 1) {
        groups.push({
          keep: withMedia[0].name,
          merged: empty,
          moved: [],
          skipped: empty.map((e) => ({ file: e, reason: 'carpeta sin contenido (no hace falta fusionar)' })),
          pruned: [],
        })
      }
      continue
    }

    // La carpeta "de verdad" = la que la app tiene memorizada en media_folders
    // (es la que ya usa Jellyfin y la que el usuario reconoce). Si ninguna está
    // memorizada, gana la que más videos tiene — nunca la recién creada por un
    // cambio de título, que es justo la que trae menos contenido.
    const remembered = new Set(preferred)
    withMedia.sort((a, b) => {
      const ap = remembered.has(a.name) ? 1 : 0
      const bp = remembered.has(b.name) ? 1 : 0
      if (ap !== bp) return bp - ap
      return b.files.length - a.files.length
    })
    const keep = withMedia[0]
    const group: HealGroup = { keep: keep.name, merged: [], moved: [], skipped: [], pruned: [] }

    // Índices del destino para no sobrescribir nada.
    const keepNames = new Set(keep.files.map((f) => path.basename(f.rel)))
    const keepEpisodes = new Set(keep.files.filter((f) => !SIDE_RE.test(f.rel)).map((f) => episodeMarker(f.rel)).filter(Boolean))
    const keepStems = new Set(keep.files.map((f) => path.basename(f.rel).replace(/\.[^./\\]+$/, '')))
    const keepSeasonFor = (season: string): string => {
      const seriesDir = path.join(root, keep.name)
      const wanted = Number((season.match(/\d+/) || ['0'])[0]) || 0
      return wanted ? resolveSeasonFolder(seriesDir, wanted) : safeSegment(season)
    }

    for (const stray of withMedia.slice(1)) {
      group.merged.push(stray.name)
      // Primero los videos (deciden qué episodios llegan) y después sus
      // subtítulos: un .srt debe acompañar a su video aunque el marcador SxxEyy
      // ya esté presente porque lo acabamos de mover nosotros.
      const ordered = [...stray.files].sort((a, b) => {
        const av = SIDE_RE.test(a.rel) ? 1 : 0
        const bv = SIDE_RE.test(b.rel) ? 1 : 0
        return av - bv
      })
      const stemsMoved = new Set<string>()
      const markersMoved = new Set<string>()
      for (const file of ordered) {
        const base = path.basename(file.rel)
        const isSide = SIDE_RE.test(base)
        const stem = base.replace(/\.[^./\\]+$/, '')
        const ownMarker = episodeMarker(base)
        const marker = isSide ? '' : ownMarker
        let relOut: string
        if (kind === 'movie') {
          relOut = base
        } else {
          const seasonPart = path.dirname(file.rel)
          relOut = path.join(keepSeasonFor(seasonPart), base)
        }
        const destAbs = path.join(root, keep.name, relOut)
        const dupExact = fs.existsSync(destAbs) || keepNames.has(base)
        if (dupExact) {
          group.skipped.push({ file: file.rel, reason: `ya existe en "${keep.name}"` })
          continue
        }
        // Subtítulo: acompaña a su video. El nombre del .srt no lleva el mismo
        // "stem" que el video (lleva idioma: <video>.spa.srt), así que se
        // empareja por el marcador SxxEyy del episodio.
        if (isSide) {
          const matchesMoved = ownMarker && markersMoved.has(ownMarker)
          const matchesKeepVideo = ownMarker ? keepEpisodes.has(ownMarker) : keepStems.has(stem)
          const matchesMovedStem = stemsMoved.has(stem)
          if (!matchesMoved && !matchesMovedStem && !matchesKeepVideo) {
            group.skipped.push({ file: file.rel, reason: 'subtítulo sin video correspondiente en el destino' })
            continue
          }
          if (!matchesMoved && !matchesMovedStem && matchesKeepVideo) {
            // Ya hay un video de ese episodio en el destino (duplicado): su
            // subtítulo no hace falta.
            group.skipped.push({ file: file.rel, reason: `el episodio ya está en "${keep.name}"` })
            continue
          }
        }
        // Video: no se mueve si el destino ya tiene ESE episodio.
        if (marker && keepEpisodes.has(marker)) {
          group.skipped.push({ file: file.rel, reason: `ya existe en "${keep.name}"` })
          continue
        }
        try {
          fs.mkdirSync(path.dirname(destAbs), { recursive: true })
          fs.renameSync(file.abs, destAbs)
          group.moved.push({ from: stray.name, to: keep.name, file: file.rel })
          keepNames.add(base)
          if (marker) keepEpisodes.add(marker)
          if (!isSide) stemsMoved.add(stem)
          if (!isSide && ownMarker) markersMoved.add(ownMarker)
          keepStems.add(stem)
        } catch (e: any) {
          // Distinto sistema de archivos u otro error: se intenta copiar+borrar.
          try {
            fs.copyFileSync(file.abs, destAbs)
            fs.rmSync(file.abs, { force: true })
            group.moved.push({ from: stray.name, to: keep.name, file: file.rel })
            if (marker) keepEpisodes.add(marker)
            if (!isSide) stemsMoved.add(stem)
            if (!isSide && ownMarker) markersMoved.add(ownMarker)
            keepStems.add(stem)
          } catch (e2: any) {
            group.skipped.push({ file: file.rel, reason: e2?.message || e?.message || 'error al mover' })
          }
        }
      }
    }

    // Podar lo que quedó vacío (carpetas de temporada y la carpeta huérfana).
    for (const stray of group.merged) {
      const strayDir = path.join(root, stray)
      for (const season of listDirs(strayDir)) {
        const seasonDir = path.join(strayDir, season)
        if (listFiles(seasonDir).length === 0) {
          try { fs.rmdirSync(seasonDir); group.pruned.push(path.join(stray, season)) } catch { /* ignore */ }
        }
      }
      if (listFiles(strayDir).length === 0 && listDirs(strayDir).length === 0) {
        try { fs.rmdirSync(strayDir); group.pruned.push(stray) } catch { /* ignore */ }
      }
    }
    groups.push(group)
  }

  return groups
}

/**
 * Repara media_folders: si la fila de un tmdb_id apunta a la carpeta que ya no
 * existe (o a la huérfana), se reescribe con la carpeta que se conservó.
 */
export function repairMediaFolders(root: string, kind: 'movie' | 'series', groups: HealGroup[]): string[] {
  const fixed: string[] = []
  const dirs = new Set(listDirs(root))
  const ids = new Set<number>()
  try {
    const { getDB } = require('./db') as typeof import('./db')
    for (const row of getDB().prepare('SELECT tmdb_id, folder FROM media_folders WHERE media_type = ?').all(kind) as any[]) {
      ids.add(Number(row.tmdb_id))
    }
  } catch { return fixed }
  for (const tmdbId of ids) {
    const current = getMediaFolder(tmdbId, kind)
    if (!current) continue
    if (dirs.has(current)) continue // sigue existiendo: nada que reparar
    // Buscar a qué carpeta se fusionó.
    for (const g of groups) {
      if (g.merged.includes(current) && dirs.has(g.keep)) {
        setMediaFolder(tmdbId, kind, g.keep)
        fixed.push(`${current} → ${g.keep}`)
        break
      }
    }
  }
  return fixed
}

/**
 * Recoloca lo que NO está donde Jellyfin lo espera, dentro de una carpeta de
 * serie (regla: `<serie>/Season N/<video>`):
 *  - videos sueltos en la raíz de la serie → a su temporada (según SxxEyy del
 *    nombre; sin marcador, a Season 1 si la serie no tiene temporadas).
 *  - subcarpetas dentro de una carpeta de temporada (el worker aplana, pero un
 *    torrent con carpeta interna o un copiado a mano las deja) → sus archivos
 *    suben a la temporada y la subcarpeta se poda.
 *  - carpetas de temporada vacías → se borran.
 * Nunca sobrescribe: si el destino ya tiene ese nombre o ese episodio, se deja
 * como está y se informa.
 */
export function enforceSeriesLayout(root: string): HealGroup[] {
  const fixes: HealGroup[] = []
  for (const series of listDirs(root)) {
    const seriesDir = path.join(root, series)
    const fix = emptyGroup(series)
    let entries: fs.Dirent[] = []
    try { entries = fs.readdirSync(seriesDir, { withFileTypes: true }) } catch { entries = [] }
    const seasonDirs = entries
      .filter((e) => e.isDirectory() && /^(?:season|temporada|t)\s*0*\d{1,3}$/i.test(e.name))
      .map((e) => e.name)
    const looseVideos = entries.filter((e) => e.isFile() && VIDEO_RE.test(e.name)).map((e) => e.name)

    for (const file of looseVideos) {
      const m = EP_RE.exec(file)
      const seasonNum = m ? Number(m[1]) : (seasonDirs.length === 0 ? 1 : 0)
      if (!seasonNum) {
        fix.skipped.push({ file, reason: 'sin SxxEyy en el nombre y la serie ya tiene temporadas — sin mover' })
        continue
      }
      const target = resolveSeasonFolder(seriesDir, seasonNum)
      const destDir = path.join(seriesDir, target)
      const dest = path.join(destDir, file)
      if (fs.existsSync(dest)) {
        fix.skipped.push({ file, reason: `ya existe en ${target}` })
        continue
      }
      moveInto(series, path.join(seriesDir, file), destDir, target, fix)
    }

    // Subcarpetas dentro de una temporada: subir sus archivos y podar.
    for (const season of seasonDirs) {
      const seasonDir = path.join(seriesDir, season)
      for (const sub of listDirs(seasonDir)) {
        const subDir = path.join(seasonDir, sub)
        for (const f of listFiles(subDir).filter((n) => VIDEO_RE.test(n) || SIDE_RE.test(n))) {
          const dest = path.join(seasonDir, f)
          if (fs.existsSync(dest)) {
            fix.skipped.push({ file: `${season}/${sub}/${f}`, reason: `ya existe en ${season}` })
            continue
          }
          moveInto(`${season}/${sub}`, path.join(subDir, f), seasonDir, season, fix)
        }
        if (listFiles(subDir).length === 0) {
          try { fs.rmdirSync(subDir); fix.pruned.push(path.join(season, sub)) } catch { /* no vacía */ }
        }
      }
      if (listFiles(seasonDir).length === 0 && listDirs(seasonDir).length === 0) {
        try { fs.rmdirSync(seasonDir); fix.pruned.push(season) } catch { /* ignore */ }
      }
    }
    if (fix.moved.length > 0 || fix.pruned.length > 0 || fix.skipped.length > 0) fixes.push(fix)
  }
  return fixes
}

function emptyGroup(name: string): HealGroup {
  return { keep: name, merged: [], moved: [], skipped: [], pruned: [] }
}

/** Mueve un archivo (rename y, si falla, copia+borrado) y lo registra. */
function moveInto(fromLabel: string, from: string, destDir: string, toLabel: string, fix: HealGroup): void {
  const dest = path.join(destDir, path.basename(from))
  try {
    fs.mkdirSync(destDir, { recursive: true })
    fs.renameSync(from, dest)
  } catch {
    try {
      fs.copyFileSync(from, dest)
      fs.rmSync(from, { force: true })
    } catch (e: any) {
      fix.skipped.push({ file: fromLabel, reason: `no se pudo mover (${e?.message || 'error'})` })
      return
    }
  }
  fix.moved.push({ from: fromLabel, to: toLabel, file: path.basename(from) })
}

/**
 * Recoloca lo que NO está donde Jellyfin lo espera en el árbol de películas
 * (`<Película (Año)>/<video>`): subcarpetas dentro de una carpeta de película
 * (sus archivos suben; el video anidado no se ve) y videos sueltos en la raíz
 * de películas (cada uno a su carpeta "Título (Año)").
 */
export function enforceMovieLayout(root: string): HealGroup[] {
  const fixes: HealGroup[] = []
  for (const entry of listDirs(root)) {
    const dir = path.join(root, entry)
    const fix = emptyGroup(entry)
    for (const sub of listDirs(dir)) {
      const subDir = path.join(dir, sub)
      for (const f of listFiles(subDir).filter((n) => VIDEO_RE.test(n) || SIDE_RE.test(n))) {
        if (fs.existsSync(path.join(dir, f))) {
          fix.skipped.push({ file: `${sub}/${f}`, reason: `ya existe en ${entry}` })
          continue
        }
        moveInto(`${entry}/${sub}`, path.join(subDir, f), dir, entry, fix)
      }
      if (listFiles(subDir).length === 0) {
        try { fs.rmdirSync(subDir); fix.pruned.push(path.join(entry, sub)) } catch { /* ignore */ }
      }
    }
    if (fix.moved.length > 0 || fix.pruned.length > 0 || fix.skipped.length > 0) fixes.push(fix)
  }
  // Videos sueltos en la raíz de películas: cada uno a su carpeta "Título (Año)".
  for (const f of listFiles(root).filter((n) => VIDEO_RE.test(n))) {
    const parsed = parseReleaseName(f)
    const folder = safeSegment(parsed.year ? `${parsed.title} (${parsed.year})` : parsed.title)
    const targetDir = path.join(root, folder)
    if (fs.existsSync(path.join(targetDir, f))) continue
    const fix = emptyGroup(folder)
    moveInto('(raíz)', path.join(root, f), targetDir, folder, fix)
    fixes.push(fix)
  }
  return fixes
}

/**
 * Consolida películas y series y deja la estructura como la espera Jellyfin.
 * Devuelve el resumen; el llamador decide si refrescar Jellyfin (changed=true).
 */
export function healLibrary(moviesRoot: string, seriesRoot: string): HealResult {
  // Carpetas que la app ya tiene memorizadas: son las canónicas al consolidar.
  const rememberedFolders = (kind: 'movie' | 'series'): string[] => {
    try {
      return (getDB().prepare('SELECT folder FROM media_folders WHERE media_type = ?').all(kind) as any[]).map((r) => r.folder)
    } catch {
      return []
    }
  }
  const movies = moviesRoot ? [...healRoot(moviesRoot, 'movie', rememberedFolders('movie')), ...enforceMovieLayout(moviesRoot)] : []
  const series = seriesRoot ? [...healRoot(seriesRoot, 'series', rememberedFolders('series')), ...enforceSeriesLayout(seriesRoot)] : []
  const fixedMovies = moviesRoot ? repairMediaFolders(moviesRoot, 'movie', movies) : []
  const fixedSeries = seriesRoot ? repairMediaFolders(seriesRoot, 'series', series) : []
  const changed = [...movies, ...series].some((g) => g.moved.length > 0 || g.pruned.length > 0) || fixedMovies.length > 0 || fixedSeries.length > 0
  return { movies, series, changed }
}

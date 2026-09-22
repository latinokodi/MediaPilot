// Pragmatic media-layout helpers: turn a release name into Jellyfin-friendly
// destination folders, radarr/sonarr style (movie: <Title (Year)>/,
// series: <Title (Year)>/Season NN/), keeping the original file names.
// TMDB lookup is best-effort — falls back to the parsed release title.

import fs from 'fs'
import path from 'path'
import https from 'https'
import { getMediaFolder, setMediaFolder } from './db'
import { tmdbAltTitles } from './tmdb'

export interface ParsedRelease {
  title: string
  year?: number
  season?: number
}

const TAG_RE = new RegExp(
  [
    '1080p', '720p', '2160p', '4k', '480p', '576p', 'hdtv', 'webrip', 'web-dl',
    'webdl', 'bluray', 'blu-ray', 'brrip', 'h264', 'h265', 'x264', 'x265',
    'hevc', 'avc', 'aac', 'ac3', 'dts', 'ddp5', 'ddp5.1', 'dd5', 'dd5.1',
    'atmos', 'truehd', 'amzn', 'atvp', 'nf', 'hbo', 'amazon', 'itunes', 'vff',
    'vostfr', 'multi', 'dual', 'lat', 'latino', 'spanish', 'english',
    'extreme', 'weeds', 'cakes', 'megusta', 'ethel', 'grace', 'ntb', 'tgx',
    'rarbg', 'eztv', 'rartv', 'ion10', 'glhf', 'rmteam', 'playweb', 'ditr',
    'skst', 'dkv', 'dirt', 'msd', 'xvid', 'proper', 'repack', 'remux', 'internal',
    'imax', 'muxed', 'opus', 'flac', 'aac2', '2.0', '5.1', '7.1',
  ].join('|'),
  'gi',
)

const SEASON_EP_RE = /\bS(\d{1,2})[Ee](\d{1,3})\b/i
const YEAR_RE = /\b(19\d{2}|20\d{2})\b/
const PAREN_YEAR_RE = /[\[\(]?\s*(19\d{2}|20\d{2})\s*[\]\)]?/
/**
 * Dónde termina el TÍTULO de un release: en el primer marcador de temporada
 * (`S01E01`, `S01`, `1x05`), año o etiqueta de calidad. Sin esto, un nombre como
 * `Demo.S01.DLMux.1080p.x264.AC3.ITA-ENG.Sub.ENG.by.quintrix` producía el "título"
 * entero y la biblioteca se llenaba de carpetas fantasma
 * (`Demo DLMux ITA ENG Sub ENG by quintrix/Season 1`).
 */
const RELEASE_CUT_RE = /\bS\d{1,2}\s*E\d{1,3}\b|\bS\d{1,2}\b|\b\d{1,2}x\d{1,3}\b|\b(19|20)\d{2}\b|\b(1080p|720p|2160p|480p|576p|4k|uhd|web-?dl|webrip|hdtv|bluray|blu-ray|brrip|x264|x265|h\.?264|h\.?265|hevc|av1|amzn|dsnp|atvp|nf|itunes|divx|xvid|dvdrip)\b/i

function cleanToken(token: string): string {
  return token
    .replace(/[._\-\[\](){}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function parseReleaseName(name: string): ParsedRelease {
  const raw = name || ''
  let season: number | undefined
  let year: number | undefined

  const seMatch = SEASON_EP_RE.exec(raw)
  if (seMatch) season = parseInt(seMatch[1], 10)
  if (season === undefined) {
    // Pack de temporada sin episodio ("Demo.S01.COMPLETE...", "Season 2 1080p"):
    // sin esto la temporada quedaba vacía y el destino acababa en "Season 1".
    const pack = /\bS(\d{1,2})\b/.exec(raw) || /\b(?:season|temporada)[\s._-]*(\d{1,2})\b/i.exec(raw)
    if (pack) season = parseInt(pack[1], 10)
  }

  const yearMatch = YEAR_RE.exec(raw)
  if (yearMatch) year = parseInt(yearMatch[1], 10)

  // Title = everything before the first season/episode marker, year or quality
  // tag (mismo corte que releaseSeriesName: si no, las etiquetas que siguen a la
  // temporada — "DLMux.ITA-ENG.Sub.ENG.by.quintrix" — acababan dentro del título).
  const cutIdx = raw.search(RELEASE_CUT_RE)
  let titlePart = cutIdx > 0 ? raw.slice(0, cutIdx) : raw

  // Drop year-in-parens ("Movie (2021)") from the title part.
  titlePart = titlePart.replace(PAREN_YEAR_RE, ' ')

  // Tokenize, strip release tags and common noise.
  const tokens = titlePart
    .split(/[._\-\[\](){} ]+/)
    .map(cleanToken)
    .filter((t) => t.length > 0)

  const stop = new Set([
    'the', 'a', 'an', 'and', 'of', 'for', 'with', 'in', 'on', 'at', 'by',
  ])
  const titleTokens: string[] = []
  for (const t of tokens) {
    if (t.length <= 2 && !stop.has(t)) continue
    if (TAG_RE.test(t) || t.replace(/\d+$/, '').length <= 1) continue
    titleTokens.push(t)
  }

  const title = titleTokens.join(' ') || cleanToken(raw).slice(0, 60) || 'Unknown'
  return { title, year, season }
}

function tmdbGet(url: string): Promise<any> {
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
    req.setTimeout(6000, () => {
      req.destroy()
      resolve(null)
    })
  })
}

/**
 * Best-effort TMDB lookup: canonical title + year for a parsed release title.
 * Returns null when no API key / no match, so callers fall back to the parser.
 */
export async function tmdbResolve(
  parsed: ParsedRelease,
  type: 'movie' | 'series',
  apiKey: string,
): Promise<{ title: string; original?: string; id?: number; year?: number } | null> {
  if (!apiKey) return null
  const kind = type === 'movie' ? 'movie' : 'tv'
  const q = encodeURIComponent(parsed.title)
  const data = await tmdbGet(
    `https://api.themoviedb.org/3/search/${kind}?api_key=${encodeURIComponent(apiKey)}&query=${q}&language=es-ES&include_adult=false`,
  )
  if (!data || !Array.isArray(data.results) || data.results.length === 0) return null
  const first = data.results[0]
  const title = first.title || first.name || parsed.title
  const original = first.original_title || first.original_name || undefined
  const year = first.release_date || first.first_air_date
  return {
    title,
    original,
    id: Number(first.id) || undefined,
    year: year ? parseInt(String(year).slice(0, 4), 10) || undefined : undefined,
  }
}

/** Normaliza un nombre para comparar carpetas (acentos, mayúsculas y puntuación). */
function normalizeName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
}

/** Año de 4 dígitos entre paréntesis (o suelto) de un nombre de carpeta. */
function yearOfFolderName(value: string): number {
  const m = String(value || '').match(/\b(19|20)\d{2}\b/)
  return m ? parseInt(m[0], 10) : 0
}

const LEADING_ARTICLES = new Set(['el', 'la', 'los', 'las', 'un', 'una', 'the', 'a', 'an'])

/** Tokens del título de una carpeta: sin acentos/puntuación/año y sin artículos. */
function looseTokens(value: string): string[] {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0 && !LEADING_ARTICLES.has(t) && !/^(19|20)\d{2}$/.test(t))
}

/**
 * ¿Dos nombres de carpeta son el MISMO título? El título que publica TMDB
 * cambia con el tiempo ("Demo9 (ES)" -> "Demo9 (EN)", "El tigre y el dragón"
 * -> "Tigre y dragón") y comparar solo por igualdad de cadena creaba carpetas
 * paralelas para la misma serie/película (la biblioteca se partía en dos y
 * Jellyfin mostraba el título duplicado). Reglas:
 *   - años distintos (ambos presentes) ⇒ NO son el mismo título (homónimas:
 *     Demo7 2015 vs 2024).
 *   - mismos tokens (ignorando artículos y orden) ⇒ sí.
 *   - un título es subconjunto del otro ("Demo9" ⊂ "Demo9") ⇒ sí,
 *     pero solo si ambos traen año (sin año, el riesgo de fusionar dos cosas
 *     distintas es mayor que el de una carpeta duplicada).
 */
function sameShowFolderName(a: string, b: string): boolean {
  const ya = yearOfFolderName(a)
  const yb = yearOfFolderName(b)
  if (ya && yb && ya !== yb) return false
  const sa = [...new Set(looseTokens(a))]
  const sb = [...new Set(looseTokens(b))]
  if (sa.length === 0 || sb.length === 0) return false
  const [small, big] = sa.length <= sb.length ? [sa, sb] : [sb, sa]
  const covered = small.filter((t) => big.includes(t)).length
  if (covered !== small.length) return false
  if (small.length === big.length) return true
  return Boolean(ya && yb)
}

/**
 * ¿Estos dos nombres de carpeta son el mismo título? Además del año y los
 * tokens, acepta la comparación normalizada (acentos/puntuación) para casos
 * como "Demo3" vs "Star Trek_ Demo3".
 */
export function sameTitleFolder(a: string, b: string): boolean {
  const na = normalizeName(a)
  const nb = normalizeName(b)
  if (na && nb && na === nb) return true
  return sameShowFolderName(a, b)
}

/** Nº de videos dentro de una carpeta de título (para elegir la "de verdad"). */
function folderMediaCount(root: string, folderName: string, kind: 'movie' | 'series'): number {
  const dir = path.join(root, folderName)
  const countIn = (d: string): number => {
    try {
      return fs.readdirSync(d, { withFileTypes: true })
        .filter((e) => e.isFile() && /\.(mkv|mp4|avi|m4v|mov|wmv|ts|webm)$/i.test(e.name)).length
    } catch { return 0 }
  }
  try {
    if (kind === 'movie') return countIn(dir)
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .reduce((acc, e) => acc + countIn(path.join(dir, e.name)), 0)
  } catch { return 0 }
}

/**
 * Nivel de coincidencia con los candidatos:
 *   2 = es el MISMO título (igual, igual salvo acentos/puntuación o mismos
 *       tokens con el año compatible)
 *   1 = un título es subconjunto del otro con el año presente ("Demo9" ⊂
 *       "Demo9")
 *   0 = no corresponde
 * El nivel decide antes que nada; el número de archivos solo desempata entre
 * carpetas del MISMO título (así la carpeta huérfana deja de recibir contenido
 * aunque su nombre sea el que TMDB publica hoy).
 */
function folderMatchLevel(dirName: string, candidates: string[], year?: number): number {
  let best = 0
  for (const raw of candidates) {
    const cand = safeSegment(String(raw || '').trim())
    if (!cand) continue
    const withYear = year && !yearOfFolderName(cand) ? `${cand} (${year})` : cand
    if (dirName.toLowerCase() === cand.toLowerCase()) { best = Math.max(best, 2); continue }
    if (year && dirName.toLowerCase() === safeSegment(`${cand} (${year})`).toLowerCase()) { best = Math.max(best, 2); continue }
    if (normalizeName(dirName) === normalizeName(withYear) || normalizeName(dirName) === normalizeName(cand)) { best = Math.max(best, 2); continue }
    if (!sameShowFolderName(dirName, withYear)) continue
    // Subconjunto ("Demo9" ⊂ "Demo9"): solo vale con años.
    const small = Math.min(new Set(looseTokens(dirName)).size, new Set(looseTokens(withYear)).size)
    const big = Math.max(new Set(looseTokens(dirName)).size, new Set(looseTokens(withYear)).size)
    best = Math.max(best, small === big ? 2 : 1)
  }
  return best
}

/**
 * Qué tan literal es la coincidencia (desempate final dentro del mismo nivel):
 * 100 = "Título (Año)" exacto · 95 = nombre exacto · 90 = igual salvo
 * acentos/puntuación · 70 = mismos tokens (artículos aparte).
 */
function folderExactness(dirName: string, candidates: string[], year?: number): number {
  let best = 0
  for (const raw of candidates) {
    const cand = safeSegment(String(raw || '').trim())
    if (!cand) continue
    const withYear = year && !yearOfFolderName(cand) ? `${cand} (${year})` : cand
    if (year && dirName.toLowerCase() === safeSegment(`${cand} (${year})`).toLowerCase()) best = Math.max(best, 100)
    if (dirName.toLowerCase() === cand.toLowerCase()) best = Math.max(best, 95)
    if (normalizeName(dirName) === normalizeName(withYear) || normalizeName(dirName) === normalizeName(cand)) best = Math.max(best, 90)
    if (sameShowFolderName(dirName, withYear)) best = Math.max(best, 70)
  }
  return best
}

/**
 * Busca la carpeta de título EXISTENTE que corresponde a cualquiera de los
 * candidatos. Nunca crea una carpeta nueva si el título ya vive en la
 * biblioteca, y cuando hay varias candidatas (una carpeta duplicada por un
 * cambio de título) se queda con la que más episodios/películas tiene — la de
 * verdad — para que el duplicado deje de recibir contenido.
 */
function findExistingTitleFolder(root: string, candidates: string[], year?: number, kind: 'movie' | 'series' = 'movie'): string | null {
  let dirs: string[] = []
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
  } catch { return null }
  const uniq = [...new Set(candidates.map((c) => String(c || '').trim()).filter(Boolean))]
  if (uniq.length === 0) return null
  const scored = dirs
    .map((d) => ({ name: d, level: folderMatchLevel(d, uniq, year), exact: folderExactness(d, uniq, year), media: 0 }))
    .filter((x) => x.level > 0)
  if (scored.length === 0) return null
  // Empates por nivel se resuelven por contenido real en disco.
  for (const s of scored) s.media = folderMediaCount(root, s.name, kind)
  scored.sort((a, b) => {
    if (b.level !== a.level) return b.level - a.level
    if (b.media !== a.media) return b.media - a.media
    return b.exact - a.exact
  })
  return scored[0].name
}

/** Reutiliza la carpeta de temporada existente (Season 4 == Season 04). */
export function resolveSeasonFolder(seriesDir: string, season: number): string {
  let dirs: string[] = []
  try {
    dirs = fs.readdirSync(seriesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch { return `Season ${season}` }
  const parseNum = (name: string): number | null => {
    const m = name.match(/^(?:season|temporada|t)\s*0*(\d{1,3})$/i)
    return m ? Number(m[1]) : null
  }
  const same = dirs.find((d) => parseNum(d) === season)
  if (same) return same
  if (dirs.length === 0) return `Season ${season}`
  // Mimic the padding style already used by this show's other seasons.
  const padded = dirs.find((d) => /^(?:season|temporada)\s+0\d/i.test(d))
  if (padded) {
    const word = padded.replace(/\s*0?\d+$/i, '').trim()
    return `${word} ${String(season).padStart(2, '0')}`
  }
  const unpadded = dirs.find((d) => /^(?:season|temporada)\s+\d/i.test(d))
  const word = unpadded ? unpadded.replace(/\s*\d+$/i, '').trim() : 'Season'
  return `${word} ${season}`
}

/**
 * Reuse an existing directory whose name only differs in case.
 * ext4 is case-sensitive but SMB/Windows/Jellyfin are not, so a change in the
 * TMDB localized title casing ("La Captura" -> "La captura") would otherwise
 * fork one movie into two folders that look identical to the user.
 * Compares against the sanitized segment because that is what lands on disk
 * (worker.ts maps every segment through safeSegment before joining).
 */
function reuseExistingSegment(parentDir: string, segment: string): string {
  const target = safeSegment(segment).toLowerCase()
  try {
    for (const entry of fs.readdirSync(parentDir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.toLowerCase() === target) return entry.name
    }
  } catch {
    // parent dir not created yet or unreadable -> keep the computed segment
  }
  return segment
}

/**
 * Compute the per-download destination root + relative folder for a release.
 * movie  -> <movies_root>/<Title (Year)>/
 * series -> <series_root>/<Title (Year)>/Season NN/
 * Falls back to the legacy `destination_folder` when the per-type root is unset.
 */
export async function computeDestination(
  settings: { destination_folder: string; movies_folder: string; series_folder: string; tmdb_api_key: string },
  torrentName: string,
  type: 'movie' | 'series' | '',
  opts: { tmdbId?: number; extraTitles?: string[]; titleOverride?: string; year?: number } = {},
): Promise<{ root: string; folder: string; season: number | undefined }> {
  const kind = type === 'series' ? 'series' : 'movie'
  const parsed = parseReleaseName(torrentName)

  let meta: { title: string; original?: string; id?: number; year?: number } | null = null
  try {
    meta = await tmdbResolve(parsed, kind, settings.tmdb_api_key)
  } catch {
    meta = null
  }

  const tmdbId = opts.tmdbId || meta?.id
  // El año del objetivo manda. El de la búsqueda por nombre solo se acepta si
  // resolvió al MISMO título: en homónimas ("Demo7" 2015/2024) la
  // búsqueda puede devolver la otra y arrastrar los episodios a su carpeta.
  const metaYearFiable = meta?.year && (!tmdbId || !meta?.id || meta.id === tmdbId) ? meta.year : undefined
  const year = opts.year || metaYearFiable || parsed.year

  const root =
    kind === 'series'
      ? settings.series_folder || settings.destination_folder
      : settings.movies_folder || settings.destination_folder

  if (!root) {
    throw new Error('No destination folder configured (set movies/series folders in Settings)')
  }

  const saved = tmdbId ? getMediaFolder(tmdbId, kind) : ''

  // 2) Candidatos: título localizado (es-ES), título original, títulos extra
  //    que vengan del caller (release/watchers), la carpeta ya memorizada y, si
  //    hace falta, títulos alternativos de TMDB (ES/MX/US…). La búsqueda es
  //    tolerante (artículos, orden, cambios de título) y, si hay dos carpetas
  //    del mismo título, se queda con la que más contenido tiene — nunca se
  //    crea una carpeta nueva si el título ya vive en la biblioteca.
  const candidates = [
    ...(saved ? [saved] : []),
    ...(opts.titleOverride ? [opts.titleOverride] : []),
    ...(opts.extraTitles || []),
    meta?.title,
    meta?.original,
    parsed.title,
  ].filter(Boolean) as string[]

  let titleFolder = findExistingTitleFolder(root, candidates, year, kind)
  if (!titleFolder && tmdbId) {
    const alts = await tmdbAltTitles(tmdbId, kind)
    if (alts.length) titleFolder = findExistingTitleFolder(root, [...alts, ...candidates], year, kind)
  }
  if (!titleFolder) {
    const base = candidates.filter((c) => c !== saved)[0] || parsed.title || torrentName
    titleFolder = safeSegment(year ? `${base} (${year})` : base)
  }
  // La carpeta elegida (aunque viniera memorizada con otro nombre) queda
  // memorizada: si el título de TMDB cambió, la fila se corrige sola.
  return finish(root, titleFolder, kind, parsed, tmdbId, titleFolder)
}

/** Resuelve la temporada y memoriza la carpeta elegida para el título. */
function finish(
  root: string,
  titleFolder: string,
  kind: 'movie' | 'series',
  parsed: ParsedRelease,
  tmdbId: number | undefined,
  remember?: string,
): { root: string; folder: string; season: number | undefined } {
  if (tmdbId && remember) setMediaFolder(tmdbId, kind, remember)
  if (kind === 'series') {
    const season = parsed.season ?? 1
    const seriesDir = path.join(root, safeSegment(titleFolder))
    const seasonFolder = resolveSeasonFolder(seriesDir, season)
    return { root, folder: `${titleFolder}/${seasonFolder}`, season }
  }
  return { root, folder: titleFolder, season: undefined }
}

/** Sanitize a path segment for filesystem use (safe chars only). */
export function safeSegment(value: string): string {
  return (
    value
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
      .trim()
      .replace(/^\.+/, '')
      .replace(/\.+$/, '') || 'Unknown'
  )
}

// ─── Desambiguación de series homónimas ─────────────────────────────────────
// "Demo7 S02E03 720p WEBRip x264-MATTER" (serie Dark, 2017) entraba en la
// búsqueda de "Demo7 S02E03" porque el grupo del release ("-MATTER")
// parece parte del título. Comparar el nombre del release contra el título
// objetivo es la única señal fiable ANTES de descargar.

const NAME_STOPWORDS = new Set([
  'the', 'and', 'of', 'a', 'an', 'los', 'las', 'el', 'la', 'de', 'del', 'y', 'e', 'o', 'u',
])

/** Nombre → tokens alfanuméricos en minúsculas, sin acentos ni stopwords. */
function normTokens(value: string): string[] {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0 && !NAME_STOPWORDS.has(t))
}

/**
 * Parte "serie" de un nombre de release: lo anterior a SxxEyy, al año o a la
 * primera etiqueta de calidad, sin corchetes de tracker ni paréntesis.
 */
export function releaseSeriesName(name: string): string {
  let s = String(name || '').replace(/\.(mkv|mp4|avi|m4v|mov|ts|webm)$/i, '')
  s = s.replace(/\[[^\]]*\]/g, ' ').replace(/\([^)]*\)/g, ' ')
  const cut = s.search(RELEASE_CUT_RE)
  // El nombre del release empieza por la etiqueta (no hay título que comparar):
  // no se juzga, para no descartar por falta de datos.
  return cut >= 0 ? s.slice(0, cut) : s
}

/**
 * ¿El nombre del release corresponde a alguno de los títulos del objetivo?
 * El título tiene que ser EL título (no una parte): antes bastaba con que
 * apareciera como subcadena y entraban "Standoff.The.Demo.Power.and.Paranoia"
 * (docuserie), "Demo International" y "Demo True" (spin-offs) en una búsqueda de
 * "Demo". Se acepta:
 *   - el mismo título, comparando los tokens pegados (tolera "Demo4" vs
 *     "Demo4" y mayúsculas/acentos/puntuación/artículos),
 *   - que el release use solo la parte FINAL del título (franquicia omitida:
 *     "Demo3" para "Demo3"),
 *   - un TÍTULO ALTERNATIVO de TMDB ("Special Ops Demo9" para "Demo9",
 *     "El tigre y el dragón" para "Tigre y dragón") — llegan en `altTitles`.
 * Devuelve true cuando no se puede juzgar (nombre vacío) — nunca bloquea por
 * falta de datos.
 */
export function seriesNameMatches(
  releaseName: string,
  candidates: Array<string | undefined | null>,
  altTitles: string[] = [],
): boolean {
  const series = normTokens(releaseSeriesName(releaseName))
  if (series.length === 0) return true
  const cands = [...candidates, ...altTitles]
    .filter((c): c is string => Boolean(c && String(c).trim()))
    .map((c) => normTokens(String(c)))
    .filter((t) => t.length > 0)
  if (cands.length === 0) return true

  const flat = (tokens: string[]): string => tokens.join('')
  /** ¿El release usa solo la parte FINAL del título? ("Demo3") */
  const isTailOfTitle = (tokens: string[]): boolean => {
    if (series.length < 2 || series.length >= tokens.length) return false
    const offset = tokens.length - series.length
    return series.every((t, i) => tokens[offset + i] === t)
  }

  const seriesFlat = flat(series)
  for (const tokens of cands) {
    if (flat(tokens) === seriesFlat) return true
    if (isTailOfTitle(tokens)) return true
  }
  return false
}

/** Año de 4 dígitos del nombre del release (0 si no trae). */
export function releaseYear(name: string): number {
  const m = String(name || '').match(/\b(19|20)\d{2}\b/)
  return m ? parseInt(m[0], 10) : 0
}

const altTitlesCache = new Map<string, { at: number; titles: string[] }>()
const ALT_TITLES_TTL_MS = 6 * 60 * 60 * 1000

/**
 * Títulos alternativos de TMDB (ES/MX/US…) con caché en memoria. Los usa el
 * validador de nombres del grabber y del worker: sin ellos, un release que usa
 * el título alternativo ("Special Ops Demo9" para "Demo9") se rechazaría.
 */
export async function getAltTitlesCached(tmdbId: number, kind: 'movie' | 'series'): Promise<string[]> {
  if (!tmdbId) return []
  const key = `${kind}:${tmdbId}`
  const hit = altTitlesCache.get(key)
  if (hit && Date.now() - hit.at < ALT_TITLES_TTL_MS) return hit.titles
  try {
    const titles = await tmdbAltTitles(tmdbId, kind)
    altTitlesCache.set(key, { at: Date.now(), titles })
    return titles
  } catch {
    return hit?.titles || []
  }
}

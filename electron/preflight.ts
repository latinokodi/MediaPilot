// preflight.ts — validación BARATA de un release ANTES de bajar los datos.
//
// Dos comprobaciones que evitan descargar (y ensuciar la biblioteca con) un
// release que no sirve:
//
//  1) ¿El torrent trae algún archivo de video? Los "torrents" falsos
//     (.zipx/.rar/.exe/.url, típicos de NTb/FLUX/CAKES en algunos indexers) se
//     detectan ya en la lista de archivos de la caché de TorBox, sin añadir nada.
//  2) ¿La duración del video corresponde al episodio/película objetivo? Es la
//     señal que delata al episodio de OTRA serie homónima (Demo7 2015 de
//     43 min colándose en el S02E04 de Demo7 2024 de 53 min). La duración
//     vive en el encabezado del contenedor, así que basta un Range request de
//     unos MB contra el CDN del debrid + ffprobe: no se baja el archivo entero.
//
// Nada de esto bloquea por falta de datos: si no se puede comprobar (torrent no
// cacheado, contenedor sin duración en la cabecera, sin runtime en TMDB) se
// devuelve "inconcluso" y la descarga sigue adelante — el nombre del release se
// sigue validando después, en worker.verifyDownloadedGrab().

import fs from 'fs'
import os from 'os'
import path from 'path'
import https from 'https'
import http from 'http'
import { spawnSync } from 'child_process'

export const VIDEO_EXT_RE = /\.(mkv|mp4|avi|m4v|mov|wmv|ts|webm)$/i

export interface RemoteFile {
  id: number
  name: string
  size: number
  mimetype?: string
}

export interface CachedTorrentInfo {
  hash: string
  name: string
  size: number
  files: RemoteFile[]
}

/** ¿El nombre de archivo tiene extensión de video? */
export function isVideoName(name: unknown): boolean {
  return VIDEO_EXT_RE.test(String(name || ''))
}

/** Archivo de video más grande de una lista (el episodio/película real). */
export function largestVideoFile(files: RemoteFile[]): RemoteFile | null {
  const vids = (files || []).filter((f) => isVideoName(f?.name))
  if (vids.length === 0) return null
  return vids.reduce((a, b) => (Number(b.size) || 0) > (Number(a.size) || 0) ? b : a)
}

/**
 * Tolerancia de duración aceptada. Estrecha en episodios (donde el homónimo
 * suele durar claramente menos) y algo más laxa en películas (montajes,
 * versiones extendidas).
 */
export function durationToleranceMin(expectedMin: number, kind: 'movie' | 'episode'): number {
  const base = Math.max(0, Number(expectedMin) || 0)
  return kind === 'episode' ? Math.max(4, base * 0.10) : Math.max(8, base * 0.15)
}

/** ¿La duración real encaja con la esperada? */
export function durationMatches(expectedMin: number, actualMin: number, kind: 'movie' | 'episode'): boolean {
  if (!expectedMin || !actualMin) return true
  return Math.abs(actualMin - expectedMin) <= durationToleranceMin(expectedMin, kind)
}

/** Descarga los primeros `maxBytes` del recurso (Range request). */
function fetchHead(url: string, maxBytes: number, timeoutMs = 20_000): Promise<Buffer | null> {
  return new Promise((resolve) => {
    let settled = false
    const done = (value: Buffer | null) => {
      if (!settled) { settled = true; resolve(value) }
    }
    let mod: typeof https | typeof http
    try { mod = new URL(url).protocol === 'http:' ? http : https } catch { return done(null) }
    const req = mod.get(url, { headers: { Range: `bytes=0-${Math.max(0, maxBytes - 1)}`, 'User-Agent': 'TorDownloader-PRO/1.0' } }, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        res.resume()
        return done(null)
      }
      const chunks: Buffer[] = []
      let total = 0
      res.on('data', (c: Buffer) => {
        chunks.push(c)
        total += c.length
        if (total >= maxBytes) {
          // El servidor ignoró el Range (200) y seguiría enviando el archivo
          // entero — cortamos aquí y destruimos la conexión.
          res.destroy()
          done(Buffer.concat(chunks).subarray(0, maxBytes))
        }
      })
      res.on('end', () => done(Buffer.concat(chunks)))
      res.on('error', () => done(chunks.length ? Buffer.concat(chunks) : null))
    })
    req.on('error', () => done(null))
    req.setTimeout(timeoutMs, () => { req.destroy(); done(null) })
  })
}

let ffprobePath: string | null | undefined

function ffprobeBin(): string | null {
  if (ffprobePath !== undefined) return ffprobePath
  const probe = spawnSync('sh', ['-c', 'command -v ffprobe || true'], { encoding: 'utf8' })
  const found = (probe.stdout || '').trim()
  ffprobePath = found || null
  if (!ffprobePath) console.warn('[Preflight] ffprobe no disponible — no se puede comprobar la duración')
  return ffprobePath
}

/**
 * Duración (minutos) leyendo solo la cabecera del contenedor. Devuelve null si
 * no se puede determinar (p. ej. mkv sin Duration en la cabecera).
 */
export async function probeRemoteDurationMinutes(url: string, sizes = [4, 32]): Promise<number | null> {
  const bin = ffprobeBin()
  if (!bin || !url) return null
  for (const mb of sizes) {
    const head = await fetchHead(url, mb * 1024 * 1024)
    if (!head || head.length === 0) continue
    const tmp = path.join(os.tmpdir(), `preflight-${process.pid}-${Date.now()}-${mb}.part`)
    try {
      fs.writeFileSync(tmp, head)
      const out = spawnSync(
        bin,
        ['-v', 'error', '-probesize', '64M', '-analyzeduration', '64M', '-show_entries', 'format=duration', '-of', 'csv=p=0', tmp],
        { encoding: 'utf8', timeout: 30_000 },
      )
      const seconds = parseFloat((out.stdout || '').trim())
      if (Number.isFinite(seconds) && seconds > 0) return seconds / 60
    } catch { /* siguiente tamaño */ } finally {
      try { fs.rmSync(tmp, { force: true }) } catch { /* ignore */ }
    }
  }
  return null
}

/**
 * Comprueba un torrent YA AÑADIDO al debrid: ¿tiene video? y, si se conoce la
 * duración esperada, ¿coincide? Solo se puede hacer cuando el torrent está
 * cacheado/completado (si no, no hay enlace que sondear).
 */
export async function probeAddedTorrent(opts: {
  getFiles: () => Promise<RemoteFile[]>
  getLink: (fileId: string) => Promise<string | null>
  expectedMin?: number | null
  kind: 'movie' | 'episode'
  attempts?: number
}): Promise<{ ok: boolean; reason?: string; durationMin?: number | null; inconclusive?: boolean; videoName?: string }> {
  const attempts = Math.max(1, opts.attempts ?? 3)
  let files: RemoteFile[] = []
  for (let i = 0; i < attempts; i++) {
    try {
      files = (await opts.getFiles()) || []
    } catch { files = [] }
    if (files.length > 0) break
    await new Promise((r) => setTimeout(r, 2500))
  }
  const video = largestVideoFile(files)
  if (files.length > 0 && !video) {
    return { ok: false, reason: 'el torrent no trae ningún archivo de video (empaquetado .zipx/.rar o falso)' }
  }
  if (!video) return { ok: true, inconclusive: true }

  if (!opts.expectedMin || !Number.isFinite(Number(opts.expectedMin))) {
    return { ok: true, inconclusive: true, videoName: video.name }
  }

  let durationMin: number | null = null
  for (let i = 0; i < attempts; i++) {
    let link: string | null = null
    try { link = await opts.getLink(String(video.id)) } catch { link = null }
    if (link) {
      durationMin = await probeRemoteDurationMinutes(link)
      if (durationMin) break
    }
    await new Promise((r) => setTimeout(r, 2500))
  }
  if (!durationMin) return { ok: true, inconclusive: true, videoName: video.name }

  const expected = Number(opts.expectedMin)
  const tol = durationToleranceMin(expected, opts.kind)
  if (Math.abs(durationMin - expected) > tol) {
    return {
      ok: false,
      durationMin,
      videoName: video.name,
      reason: `el video dura ${durationMin.toFixed(1)} min y el ${opts.kind === 'movie' ? 'película' : 'episodio'} esperado ${expected.toFixed(1)} min (±${tol.toFixed(1)}) — probablemente sea de otra serie/película homónima`,
    }
  }
  return { ok: true, durationMin, videoName: video.name }
}

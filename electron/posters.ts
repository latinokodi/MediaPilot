// posters.ts — URLs de póster y fondo de TMDB (spec B20).
//
// El frontend pinta `<img src={item.poster}>` tal cual, sin componer nada: si lo
// que hay guardado es una ruta relativa ("/abc.jpg"), el navegador la pide al
// propio MediaPilot y recibe un 404 → hueco en la parrilla de Seguimiento.
// Aquí se normaliza al guardar y se decide qué rellenar cuando falta.

const TMDB_IMAGE = 'https://image.tmdb.org/t/p'

/** Tamaños usados: w342 para la parrilla, w780 para los fondos. */
export const POSTER_SIZE = 'w342'
export const BACKDROP_SIZE = 'w780'

/**
 * Deja el póster como URL absoluta de TMDB. Acepta rutas relativas ("/abc.jpg"),
 * URLs ya absolutas (las devuelve intactas) y vacío (se queda vacío: la UI pone
 * su hueco).
 */
export function normalizePosterUrl(v: unknown, size: string = POSTER_SIZE): string {
  const s = String(v ?? '').trim()
  if (!s) return ''
  if (/^https?:\/\//i.test(s)) return s
  return `${TMDB_IMAGE}/${size}/${s.replace(/^\/+/, '')}`
}

export interface PosterSource {
  poster?: string | null
  backdrop?: string | null
}

/**
 * Campos que hay que rellenar desde el detalle de TMDB. Sólo devuelve los que
 * FALTAN: un póster ya guardado no se toca (el usuario puede haber elegido uno,
 * y TMDB cambia los suyos con el tiempo).
 */
export function posterBackfillPatch(
  item: PosterSource,
  detail: any,
): { poster?: string; backdrop?: string } {
  const out: { poster?: string; backdrop?: string } = {}
  if (!String(item?.poster || '').trim()) {
    const p = normalizePosterUrl(detail?.poster_path ?? detail?.poster, POSTER_SIZE)
    if (p) out.poster = p
  }
  if (!String(item?.backdrop || '').trim()) {
    const b = normalizePosterUrl(detail?.backdrop_path ?? detail?.backdrop, BACKDROP_SIZE)
    if (b) out.backdrop = b
  }
  return out
}

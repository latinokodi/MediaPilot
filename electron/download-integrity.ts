/**
 * Comprobaciones de las descargas locales que el worker hace por su cuenta:
 * cuándo un archivo cuenta como completo y en qué estados hay que reanudar al
 * arrancar. Viven aquí, puras y sin dependencias, para poder probarlas sin
 * levantar el servicio (spec/features/local-download-integrity.feature).
 */

/**
 * ¿El tamaño descargado cuadra con el esperado?
 *
 * No se exige igualdad exacta: el tamaño que anuncia el torrent y el que sirve
 * el CDN pueden diferir en unos KB por distinto empaquetado. Con la comparación
 * estricta, una descarga correcta se marcaba "Failed to verify", el worker
 * reintentaba el torrent entero y el episodio no entraba nunca — así se quedó
 * fuera el pack de *La ley de Alicia*. La tolerancia es el mayor de 2 MB o el
 * 0,1% del tamaño esperado.
 */
export function sizeWithinTolerance(actualBytes: number, expectedBytes: number): boolean {
  if (expectedBytes <= 0) return true
  const diff = Math.abs(actualBytes - expectedBytes)
  const tolerancia = Math.max(2_000_000, Math.floor(expectedBytes * 0.001))
  return diff <= tolerancia
}

/** Estados locales que el arranque del worker debe volver a poner en cola. */
export function shouldResumeLocalStatus(localStatus: string | null | undefined): boolean {
  const s = String(localStatus || '').toLowerCase()
  if (!s) return false
  if (s.startsWith('downloading')) return true
  if (s === 'pending' || s === 'queued') return true
  // Un 'failed' por cuelgue del CDN o tamaño no verificado no es culpa del
  // release: si el debrid ya tiene el archivo, hay que reintentar.
  if (s.startsWith('failed')) {
    return /verify|timeout|stalled|ECONN|socket|abort/i.test(s)
  }
  return false
}

/**
 * ¿Hay que abortar la descarga por falta de datos nuevos?
 *
 * El CDN deja de enviar sin cerrar el socket y axios no tiene timeout de
 * inactividad: la fila se queda a 0 MB/s y la plaza de descarga no se libera,
 * así que el resto de la cola nunca arranca.
 */
export function isStalled(lastActivityMs: number, nowMs: number, timeoutMs = 120_000): boolean {
  if (!Number.isFinite(lastActivityMs) || lastActivityMs <= 0) return false
  return nowMs - lastActivityMs > timeoutMs
}

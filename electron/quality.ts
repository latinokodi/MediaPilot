// quality.ts — calidad de vídeo de un release (spec B11: mínimo aceptable).
//
// El usuario fijó el mínimo en 1080p: las copias 720p y menores no se bajan
// automáticamente. La regla es de RESOLUCIÓN (1080p/720p/2160p...), no de fuente
// (HDTV/WEBDL/BDRip dan igual). Si el nombre no dice resolución, no se bloquea:
// no se descarta por falta de datos.

export type VideoQuality = 2160 | 1080 | 720 | 480 | 0

/** Códigos de calidad habituales en los nombres de release. */
export function qualityFromName(name: string): VideoQuality {
  const s = String(name || '')
  if (/\b(2160p|4k|uhd)\b/i.test(s)) return 2160
  if (/\b1080p\b/i.test(s)) return 1080
  if (/\b720p\b/i.test(s)) return 720
  if (/\b(480p|576p|360p|sd)\b/i.test(s)) return 480
  return 0
}

/** ¿Cumple el mínimo? Sin resolución en el nombre no se descarta (0 = sin dato). */
export function meetsMinQuality(name: string, min: VideoQuality): boolean {
  const q = qualityFromName(name)
  if (q === 0) return true
  if (min === 0) return true
  return q >= min
}

/** '1080p' → 1080, tolerante con basura. */
export function parseQualitySetting(value: string | number | undefined): VideoQuality {
  if (typeof value === 'number') return (value as VideoQuality) || 0
  const s = String(value ?? '').trim().toLowerCase()
  if (s === 'any' || s === 'cualquiera' || s === '0') return 0
  const q = qualityFromName(s.endsWith('p') ? s : `${s}p`)
  return q || 1080
}

export function qualityLabel(q: VideoQuality): string {
  return q === 0 ? 'cualquiera' : `${q}p`
}

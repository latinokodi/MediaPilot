// debrid-status.ts — estado de la cuenta en el debrid (spec B10: cooldown).
//
// TorBox entra en cooldown cuando se le exige de más: durante el cooldown sólo
// acepta torrents que YA tiene en caché y `createtorrent` falla para el resto.
// Medido en la cuenta real: los reintentos durante el cooldown lo ALARGAN, así
// que la app tiene que (a) detectarlo, (b) intentar sólo lo cacheado y (c) no
// gastar el backoff del episodio mientras dure.
//
// La parte de decisión (isInCooldown / cooldownFilter) es pura y está probada en
// spec/features/cooldown.feature; la lectura de la cuenta va cacheada 10 min
// porque `/user/me` es barato pero no para llamarlo por cada episodio.

import { TorboxAPI } from './torbox'

export interface AccountStatus {
  /** ISO de cuándo termina el cooldown, o null si no hay. */
  cooldownUntil: string | null
  plan?: number
  /** Momento (ms) en que se leyó. */
  at: number
  error?: string
}

const STATUS_TTL_MS = 10 * 60_000
let cached: AccountStatus | null = null

/** ¿La cuenta está en cooldown ahora mismo? */
export function isInCooldown(status: AccountStatus | null | undefined, now: number = Date.now()): boolean {
  if (!status?.cooldownUntil) return false
  const until = Date.parse(status.cooldownUntil)
  if (!Number.isFinite(until)) return false
  return until > now
}

/**
 * Qué candidatos se pueden intentar. En cooldown sólo los que el debrid ya tiene
 * en caché (el resto fallaría y alargaría el cooldown); sin cooldown, todos.
 */
export function cooldownFilter<T extends { cached?: boolean }>(
  candidates: T[],
  inCooldown: boolean,
): { usable: T[]; skipped: T[] } {
  if (!inCooldown) return { usable: [...candidates], skipped: [] }
  const usable = candidates.filter((c) => c.cached === true)
  const skipped = candidates.filter((c) => c.cached !== true)
  return { usable, skipped }
}

/** Fecha legible del final del cooldown (para logs y API). */
export function cooldownLabel(status: AccountStatus | null | undefined): string {
  if (!status?.cooldownUntil) return 'sin cooldown'
  const t = Date.parse(status.cooldownUntil)
  if (!Number.isFinite(t)) return 'sin cooldown'
  return new Date(t).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
}

export function forgetAccountStatus(): void {
  cached = null
}

/** Estados sin datos: si el debrid no ha conseguido nada, se libera al llegar al límite. */
const STUCK_NO_DATA = ['checking', 'metadl', 'queued']
/** Estados con transferencia pero posiblemente estancados: se les da 4× el límite. */
const STUCK_SLOW = ['downloading', 'incomplete']

/**
 * ¿Fila atascada? Un torrent que el debrid nunca consigue (swarm muerto) dejaba
 * la fila en 'checking' para siempre y ocupaba una plaza de
 * `max_concurrent_downloads` (visto: dos filas de una serie bloqueando 2/3 y
 * dejando el backfill a un tercio de su capacidad).
 * Los estados con transferencia ('downloading'/'incomplete') son legítimos en
 * descargas grandes, así que sólo se liberan pasados 4× el límite.
 */
export function isStaleTorrent(state: string, ageMinutes: number, limitMinutes: number): boolean {
  if (limitMinutes <= 0) return false
  const s = String(state || '').toLowerCase()
  if (STUCK_NO_DATA.some((x) => s.startsWith(x))) return ageMinutes >= limitMinutes
  if (STUCK_SLOW.some((x) => s.startsWith(x))) return ageMinutes >= limitMinutes * 4
  return false
}

/** Lee el estado de la cuenta (cacheado 10 min). `force` salta la caché. */
export async function getAccountStatus(opts: { token?: string; force?: boolean } = {}): Promise<AccountStatus | null> {
  if (!opts.force && cached && Date.now() - cached.at < STATUS_TTL_MS) return cached
  const token = opts.token
  if (!token) return cached
  try {
    const res = await new TorboxAPI(token).getUserInfo()
    const data = res?.data || {}
    cached = {
      cooldownUntil: data.cooldown_until || null,
      plan: typeof data.plan === 'number' ? data.plan : undefined,
      at: Date.now(),
    }
  } catch (e: any) {
    // No se pudo leer: se conserva lo último conocido (caducado) para no perder
    // la protección del cooldown por un fallo de red.
    if (cached) cached = { ...cached, error: e?.message || String(e) }
  }
  return cached
}

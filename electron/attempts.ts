// attempts.ts — per-target retry/backoff state for the monitor.
//
// Sonarr/Radarr semantics: an air/release DATE decides when a target becomes
// wanted; searches are NOT repeated every cycle forever. Each wanted-but-missed
// target gets a decaying retry schedule (immediate, then 1h→2h→4h→8h→12h→
// daily), persisted across restarts. A row exists only while a target is
// wanted and not yet grabbed; it is deleted on grab or when the watchlist
// item is removed.
import { getDB, type LanguageProfile } from './db'

export interface MonitorAttempt {
  tmdb_id: number
  media_type: 'movie' | 'series'
  season: number | null
  episode: number | null
  kind: 'movie' | 'episode'
  first_due: string
  last_attempt: string
  attempts: number
  next_attempt: string
  language_profile: LanguageProfile
}

/**
 * Minutes to wait AFTER the n-th attempt (1-based) before trying again.
 * attempt 1 → 60 min, 2 → 120, 3 → 240, 4 → 480 (8h), 5 → 720 (12h),
 * 6+ → 1440 (daily). Attempt #0 (the first, on the air date) is immediate.
 */
export function nextDelayMinutes(attemptNumber: number): number {
  if (attemptNumber <= 0) return 0
  const steps = [60, 120, 240, 480, 720, 1440]
  return steps[Math.min(attemptNumber, steps.length) - 1] ?? 1440
}

/**
 * ¿Hay que esperar antes de intentar este objetivo? (spec B18)
 *
 * Con `force` (comprobación manual, "Verificar ahora") nunca se difiere: el
 * botón existe para desatascar a mano un capítulo que está en su ventana de
 * reintento. Antes, un forzado devolvía `deferred:1` sin intentar nada y el
 * episodio parecía muerto.
 */
export function shouldDeferAttempt(
  att: { next_attempt?: string | null } | null | undefined,
  nowIso: string,
  force = false,
): boolean {
  if (force) return false
  const next = att?.next_attempt
  if (!next) return false
  return next > nowIso
}

/**
 * Minutos hasta el próximo reintento tras un fallo (spec B18). `undefined`
 * significa NO programar reintento: una comprobación manual que falla no consume
 * intento ni alarga la espera — la fila de `monitor_attempts` queda como estaba,
 * así que un clic de más no puede empujar el episodio a mañana.
 */
export function nextAttemptAfterFailure(force: boolean, attemptNumber: number): number | undefined {
  return force ? undefined : nextDelayMinutes(attemptNumber)
}

function iso(): string {
  return new Date().toISOString()
}

export function getAttempt(tmdbId: number, mediaType: string, season: number | null, episode: number | null): MonitorAttempt | undefined {
  const db = getDB()
  const row = db.prepare(
    `SELECT * FROM monitor_attempts WHERE tmdb_id = ? AND media_type = ? AND season IS ? AND episode IS ?`,
  ).get(tmdbId, mediaType, season ?? null, episode ?? null) as any
  return row as MonitorAttempt | undefined
}

/** All attempt rows for one watchlist item (any season). */
export function attemptsForTitle(tmdbId: number): MonitorAttempt[] {
  const db = getDB()
  return db.prepare('SELECT * FROM monitor_attempts WHERE tmdb_id = ?').all(tmdbId) as MonitorAttempt[]
}

/** Attempt rows whose backoff window has elapsed (next_attempt empty or <= now). */
export function listDueAttempts(): MonitorAttempt[] {
  const db = getDB()
  const now = iso()
  return db.prepare('SELECT * FROM monitor_attempts WHERE next_attempt = \'\' OR next_attempt <= ?').all(now) as MonitorAttempt[]
}

export function recordAttempt(
  tmdbId: number,
  mediaType: 'movie' | 'series',
  season: number | null,
  episode: number | null,
  kind: 'movie' | 'episode',
  languageProfile: LanguageProfile,
  nextAttemptMinutes: number,
): void {
  const db = getDB()
  const now = iso()
  const existing = getAttempt(tmdbId, mediaType, season, episode)
  if (existing) {
    const attempts = (existing.attempts || 0) + 1
    const next = new Date(Date.now() + nextAttemptMinutes * 60_000).toISOString()
    db.prepare(
      `UPDATE monitor_attempts SET last_attempt = ?, attempts = ?, next_attempt = ?, language_profile = ?,
       first_due = COALESCE(NULLIF(first_due,''), ?)
       WHERE tmdb_id = ? AND media_type = ? AND season IS ? AND episode IS ?`,
    ).run(now, attempts, next, languageProfile, now, tmdbId, mediaType, season ?? null, episode ?? null)
    return
  }
  const next = nextAttemptMinutes > 0 ? new Date(Date.now() + nextAttemptMinutes * 60_000).toISOString() : ''
  db.prepare(
    `INSERT OR REPLACE INTO monitor_attempts
       (tmdb_id, media_type, season, episode, kind, first_due, last_attempt, attempts, next_attempt, language_profile)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(tmdbId, mediaType, season ?? null, episode ?? null, kind, now, now, 1, next, languageProfile)
}

export function deleteAttempt(tmdbId: number, mediaType: string, season: number | null, episode: number | null): void {
  const db = getDB()
  db.prepare('DELETE FROM monitor_attempts WHERE tmdb_id = ? AND media_type = ? AND season IS ? AND episode IS ?')
    .run(tmdbId, mediaType, season ?? null, episode ?? null)
}

export function deleteAttemptsForTmdb(tmdbId: number): void {
  const db = getDB()
  db.prepare('DELETE FROM monitor_attempts WHERE tmdb_id = ?').run(tmdbId)
}

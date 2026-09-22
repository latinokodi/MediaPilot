import Database, { type Database as DatabaseType } from 'better-sqlite3'
import path from 'path'
import os from 'os'
import fs from 'fs'
import { app } from 'electron'

// Web/headless mode: TDP_DATA_DIR env wins; Electron desktop falls back to
// userData; plain Node (server.ts) falls back to ~/.tordownloader-pro.
function resolveDBPath(): string {
  if (process.env.TDP_DATA_DIR) {
    return path.join(process.env.TDP_DATA_DIR, 'tordownloader.db')
  }
  if (typeof app !== 'undefined' && app && typeof app.getPath === 'function') {
    return path.join(app.getPath('userData'), 'tordownloader.db')
  }
  return path.join(os.homedir(), '.tordownloader-pro', 'tordownloader.db')
}

const DB_PATH = resolveDBPath()
let db: Database.Database

export function initDB(): void {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })
  db = new Database(DB_PATH)
  db.pragma('journal_mode = WAL')

  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY,
      torbox_token VARCHAR DEFAULT '',
      realdebrid_token VARCHAR DEFAULT '',
      realdebrid_refresh_token VARCHAR DEFAULT '',
      realdebrid_client_id VARCHAR DEFAULT '',
      realdebrid_client_secret VARCHAR DEFAULT '',
      destination_folder VARCHAR DEFAULT '',
      movies_folder VARCHAR DEFAULT '',
      series_folder VARCHAR DEFAULT '',
      jellyfin_url VARCHAR DEFAULT '',
      jellyfin_api_key VARCHAR DEFAULT '',
      auto_remove_completed BOOLEAN DEFAULT 0,
      tmdb_api_key VARCHAR DEFAULT '',
      last_update_prompt VARCHAR DEFAULT '',
      language_profile VARCHAR DEFAULT 'latino_first',
      monitor_enabled BOOLEAN DEFAULT 1,
      monitor_interval_minutes INTEGER DEFAULT 30,
      automation_service VARCHAR DEFAULT 'torbox',
      automation_failover BOOLEAN DEFAULT 1,
      jackett_url VARCHAR DEFAULT '',
      jackett_api_key VARCHAR DEFAULT '',
      last_monitor_run VARCHAR DEFAULT '',
      max_movie_size_gb INTEGER DEFAULT 0,
      max_series_size_gb INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS downloads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      torbox_id VARCHAR UNIQUE,
      name VARCHAR DEFAULT 'Pending...',
      status VARCHAR DEFAULT 'downloading',
      progress INTEGER DEFAULT 0,
      local_status VARCHAR DEFAULT 'pending',
      local_progress INTEGER DEFAULT 0,
      local_speed INTEGER DEFAULT 0,
      local_eta VARCHAR DEFAULT '',
      local_path VARCHAR,
      service VARCHAR DEFAULT 'torbox',
      type VARCHAR DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS watchlist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tmdb_id INTEGER NOT NULL,
      media_type TEXT NOT NULL CHECK (media_type IN ('movie','series')),
      title TEXT NOT NULL,
      year TEXT DEFAULT '',
      overview TEXT DEFAULT '',
      poster TEXT DEFAULT '',
      backdrop TEXT DEFAULT '',
      imdb_id TEXT DEFAULT '',
      language_profile TEXT DEFAULT 'latino_first',
      backfill TEXT DEFAULT 'new',
      monitored BOOLEAN DEFAULT 1,
      added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_checked VARCHAR DEFAULT '',
      next_episode VARCHAR DEFAULT '',
      UNIQUE(tmdb_id, media_type)
    );

    CREATE TABLE IF NOT EXISTS grab_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      watchlist_id INTEGER NOT NULL,
      tmdb_id INTEGER NOT NULL,
      media_type TEXT NOT NULL,
      season INTEGER,
      episode INTEGER,
      kind TEXT NOT NULL DEFAULT 'episode',
      title TEXT DEFAULT '',
      language TEXT DEFAULT '',
      source TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'grabbed',
      torbox_id VARCHAR DEFAULT '',
      info_hash VARCHAR DEFAULT '',
      error VARCHAR DEFAULT '',
      dest_folder VARCHAR DEFAULT '',
      file_name VARCHAR DEFAULT '',
      grabbed_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_grab_uniq ON grab_history(tmdb_id, media_type, season, episode);
    CREATE INDEX IF NOT EXISTS idx_grab_wl ON grab_history(watchlist_id);

    CREATE TABLE IF NOT EXISTS monitor_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tmdb_id INTEGER NOT NULL,
      media_type TEXT NOT NULL,
      season INTEGER,
      episode INTEGER,
      kind TEXT NOT NULL DEFAULT 'episode',
      first_due VARCHAR DEFAULT '',
      last_attempt VARCHAR DEFAULT '',
      attempts INTEGER DEFAULT 0,
      next_attempt VARCHAR DEFAULT '',
      language_profile VARCHAR DEFAULT 'latino_first',
      UNIQUE(tmdb_id, media_type, season, episode)
    );
  `)

  // Migration: add columns that may not exist in older schema
  const migrations = [
    `ALTER TABLE downloads ADD COLUMN local_eta VARCHAR DEFAULT ''`,
    `ALTER TABLE downloads ADD COLUMN service VARCHAR DEFAULT 'torbox'`,
    `ALTER TABLE settings ADD COLUMN realdebrid_token VARCHAR DEFAULT ''`,
    `ALTER TABLE settings ADD COLUMN realdebrid_refresh_token VARCHAR DEFAULT ''`,
    `ALTER TABLE settings ADD COLUMN realdebrid_client_id VARCHAR DEFAULT ''`,
    `ALTER TABLE settings ADD COLUMN realdebrid_client_secret VARCHAR DEFAULT ''`,
    `ALTER TABLE settings ADD COLUMN tmdb_api_key VARCHAR DEFAULT ''`,
    `ALTER TABLE settings ADD COLUMN last_update_prompt VARCHAR DEFAULT ''`,
    `ALTER TABLE settings ADD COLUMN movies_folder VARCHAR DEFAULT ''`,
    `ALTER TABLE settings ADD COLUMN series_folder VARCHAR DEFAULT ''`,
    `ALTER TABLE settings ADD COLUMN jellyfin_url VARCHAR DEFAULT ''`,
    `ALTER TABLE settings ADD COLUMN jellyfin_api_key VARCHAR DEFAULT ''`,
    `ALTER TABLE downloads ADD COLUMN type VARCHAR DEFAULT ''`,
    `ALTER TABLE settings ADD COLUMN language_profile VARCHAR DEFAULT 'latino_first'`,
    `ALTER TABLE settings ADD COLUMN monitor_enabled BOOLEAN DEFAULT 1`,
    `ALTER TABLE settings ADD COLUMN monitor_interval_minutes INTEGER DEFAULT 30`,
    `ALTER TABLE settings ADD COLUMN automation_service VARCHAR DEFAULT 'torbox'`,
    `ALTER TABLE settings ADD COLUMN automation_failover BOOLEAN DEFAULT 1`,
    `ALTER TABLE settings ADD COLUMN jackett_url VARCHAR DEFAULT ''`,
    `ALTER TABLE settings ADD COLUMN jackett_api_key VARCHAR DEFAULT ''`,
    `ALTER TABLE settings ADD COLUMN last_monitor_run VARCHAR DEFAULT ''`,
    `ALTER TABLE downloads ADD COLUMN dest_folder VARCHAR DEFAULT ''`,
    `ALTER TABLE downloads ADD COLUMN expected_runtime_min REAL DEFAULT NULL`,
    `ALTER TABLE settings ADD COLUMN max_concurrent_downloads INTEGER DEFAULT 3`,
    `ALTER TABLE watchlist ADD COLUMN backfill VARCHAR DEFAULT 'new'`,
    `ALTER TABLE settings ADD COLUMN max_grab_size_gb INTEGER DEFAULT 0`,
    `ALTER TABLE settings ADD COLUMN max_movie_size_gb INTEGER DEFAULT 0`,
    `ALTER TABLE settings ADD COLUMN max_series_size_gb INTEGER DEFAULT 0`,
    `ALTER TABLE settings ADD COLUMN min_video_quality VARCHAR DEFAULT '1080p'`,
    `ALTER TABLE grab_history ADD COLUMN dest_folder VARCHAR DEFAULT ''`,
    `ALTER TABLE grab_history ADD COLUMN file_name VARCHAR DEFAULT ''`,
    `CREATE TABLE IF NOT EXISTS media_folders (
       tmdb_id INTEGER NOT NULL,
       media_type TEXT NOT NULL,
       folder TEXT NOT NULL,
       updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
       PRIMARY KEY (tmdb_id, media_type)
     )`,
    `CREATE TABLE IF NOT EXISTS bad_releases (
       info_hash TEXT PRIMARY KEY,
       title TEXT DEFAULT '',
       reason TEXT DEFAULT '',
       created_at DATETIME DEFAULT CURRENT_TIMESTAMP
     )`,
    `ALTER TABLE bad_releases ADD COLUMN title VARCHAR DEFAULT ''`,
  ]
  for (const sql of migrations) {
    try { db.exec(sql) } catch (_) { /* Column already exists */ }
  }
  
  // Create a default settings row if not exists
  const count = db.prepare('SELECT COUNT(*) as c FROM settings').get() as { c: number };
  if (count.c === 0) {
    db.prepare('INSERT INTO settings (id) VALUES (1)').run();
  }
}

export type DebridService = 'torbox' | 'realdebrid'
export type LanguageProfile = 'latino_first' | 'latino_only' | 'english_first'
export type BackfillScope = 'new' | 'last_episode' | 'last_season' | 'first_season' | 'all'

export interface Settings {
  id: number;
  torbox_token: string;
  realdebrid_token: string;
  realdebrid_refresh_token: string;
  realdebrid_client_id: string;
  realdebrid_client_secret: string;
  destination_folder: string;
  movies_folder: string;
  series_folder: string;
  auto_remove_completed: boolean;
  tmdb_api_key: string;
  last_update_prompt: string;
  language_profile: LanguageProfile;
  monitor_enabled: boolean;
  monitor_interval_minutes: number;
  automation_service: DebridService;
  automation_failover: boolean;
  jackett_url: string;
  jackett_api_key: string;
  last_monitor_run: string;
  max_grab_size_gb: number;
  max_movie_size_gb: number;
  max_series_size_gb: number;
  jellyfin_url: string;
  jellyfin_api_key: string;
  /** Descargas simultáneas máximas (cola de backfill y worker). */
  max_concurrent_downloads: number;
  /** Calidad mínima aceptable de un release automático ('1080p' | '720p' | 'any'). */
  min_video_quality: string;
}

export interface Download {
  id: number;
  torbox_id: string;
  name: string;
  status: string;
  progress: number;
  local_status: string;
  local_progress: number;
  local_speed: number;
  local_eta: string;
  local_path: string | null;
  service: DebridService;
  type: 'movie' | 'series' | '';
  created_at: string;
  dest_folder?: string | null;
  /** Duración esperada del episodio/película (min) — la usa el preflight. */
  expected_runtime_min?: number | null;
}

export interface WatchlistItem {
  id: number;
  tmdb_id: number;
  media_type: 'movie' | 'series';
  title: string;
  year: string;
  overview: string;
  poster: string;
  backdrop: string;
  imdb_id: string;
  language_profile: LanguageProfile;
  backfill: BackfillScope;
  monitored: boolean;
  added_at: string;
  last_checked: string;
  next_episode: string;
}

export interface GrabHistoryRow {
  id: number;
  watchlist_id: number;
  tmdb_id: number;
  media_type: 'movie' | 'series';
  season: number | null;
  episode: number | null;
  kind: string;
  title: string;
  language: string;
  source: string;
  status: string;
  torbox_id: string;
  info_hash: string;
  error: string;
  dest_folder: string;
  file_name: string;
  grabbed_at: string;
}

/** Carpeta de biblioteca elegida para un título (evita duplicados por cambio de título). */
export function getMediaFolder(tmdbId: number, mediaType: string): string {
  try {
    const row = db.prepare('SELECT folder FROM media_folders WHERE tmdb_id = ? AND media_type = ?').get(tmdbId, mediaType) as any
    return row?.folder || ''
  } catch { return '' }
}

/**
 * Busca el dueño de una carpeta de biblioteca por su nombre ("Demo (2018)",
 * "Demo7 (2026)"…). Genérico: lo usa el worker al terminar una descarga
 * para saber de qué título son los episodios y no volver a bajarlos.
 */
export function findMediaFolderByName(name: string): { tmdb_id: number; media_type: string } | null {
  const clean = String(name || '').trim().toLowerCase()
  if (!clean) return null
  try {
    const rows = db.prepare('SELECT tmdb_id, media_type, folder FROM media_folders').all() as any[]
    const hit = rows.find((r) => String(r.folder || '').trim().toLowerCase() === clean)
    return hit ? { tmdb_id: hit.tmdb_id, media_type: hit.media_type } : null
  } catch {
    return null
  }
}

export function setMediaFolder(tmdbId: number, mediaType: string, folder: string): void {
  if (!tmdbId || !folder) return
  try {
    db.prepare(
      `INSERT INTO media_folders (tmdb_id, media_type, folder, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(tmdb_id, media_type) DO UPDATE SET folder = excluded.folder, updated_at = CURRENT_TIMESTAMP`,
    ).run(tmdbId, mediaType, folder)
  } catch { /* table may not exist on very old DBs */ }
}

/** Releases descartados (p. ej. episodio de otra serie con el mismo nombre). */
export function addBadRelease(infoHash: string, reason: string, title = ''): void {
  const hash = String(infoHash || '').toLowerCase()
  try {
    if (hash) {
      db.prepare(
        `INSERT INTO bad_releases (info_hash, title, reason) VALUES (?, ?, ?)
         ON CONFLICT(info_hash) DO UPDATE SET title = excluded.title, reason = excluded.reason`,
      ).run(hash, String(title || '').slice(0, 400), String(reason || '').slice(0, 300))
    } else if (title) {
      // Sin hash disponible: guarda una fila marcadora para bloquear por título.
      db.prepare('INSERT OR IGNORE INTO bad_releases (info_hash, title, reason) VALUES (?, ?, ?)')
        .run(`title:${normalizeReleaseTitle(title)}`, String(title).slice(0, 400), String(reason || '').slice(0, 300))
    }
  } catch { /* table may not exist on very old DBs */ }
}

function normalizeReleaseTitle(title: string): string {
  return String(title || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\.(mkv|mp4|avi|m4v|mov|ts|webm)$/i, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

export function getBadReleaseHashes(): Set<string> {
  try {
    const rows = db.prepare("SELECT info_hash FROM bad_releases WHERE info_hash NOT LIKE 'title:%'").all() as any[]
    return new Set(rows.map((r) => String(r.info_hash)))
  } catch { return new Set() }
}

/** Títulos (normalizados) de releases descartados, para bloquear sin hash. */
export function getBadReleaseTitles(): Set<string> {
  try {
    const rows = db.prepare("SELECT title FROM bad_releases WHERE title != ''").all() as any[]
    return new Set(rows.map((r) => normalizeReleaseTitle(r.title)).filter(Boolean))
  } catch { return new Set() }
}

export { normalizeReleaseTitle }

export function getSettings(): Settings {
  const stmt = db.prepare('SELECT * FROM settings WHERE id = 1');
  const row = stmt.get() as any;
  return {
    ...row,
    auto_remove_completed: Boolean(row.auto_remove_completed),
    monitor_enabled: row.monitor_enabled === undefined ? true : Boolean(row.monitor_enabled),
    automation_failover: row.automation_failover === undefined ? true : Boolean(row.automation_failover),
    monitor_interval_minutes: Number(row.monitor_interval_minutes || 30),
    max_grab_size_gb: Number(row.max_grab_size_gb || 0),
    max_movie_size_gb: Number(row.max_movie_size_gb || 0),
    max_series_size_gb: Number(row.max_series_size_gb || 0),
    language_profile: (row.language_profile as any) || 'latino_first',
    automation_service: (row.automation_service as any) || 'torbox',
  };
}

let settingsColumns: Set<string> | null = null

/** Nombres de las columnas reales de la tabla settings (con caché). */
function settingsColumnSet(): Set<string> {
  if (!settingsColumns) {
    const filas = db.prepare('PRAGMA table_info(settings)').all() as { name: string }[]
    settingsColumns = new Set(filas.map((f) => String(f.name)))
  }
  return settingsColumns
}

/** ¿Qué tipos acepta SQLite? Lo demás se guarda como JSON o se descarta. */
function valorEnlazable(value: unknown): any {
  if (value === undefined || typeof value === 'function') return undefined
  if (value === null) return null
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'string') return value
  if (Buffer.isBuffer(value)) return value
  try {
    return JSON.stringify(value)
  } catch {
    return undefined
  }
}

export interface SettingsWriteResult {
  ok: boolean
  applied: number
  /** Claves que no existen como columna o no se pudieron convertir. */
  ignored: string[]
}

/**
 * Guarda ajustes sin romperse por culpa de lo que llegue.
 *
 * Antes se construía el UPDATE con las claves del objeto recibido tal cual, así
 * que una clave que no fuese columna (o un valor que SQLite no sabe enlazar)
 * hacía saltar la sentencia y **no se guardaba nada**, sin avisar. Ahora sólo
 * se escriben columnas que existen, los tipos se convierten y un fallo se
 * devuelve en lugar de propagarse.
 */
export function updateSettings(settings: Partial<Settings>): SettingsWriteResult {
  const ignoradas: string[] = []
  const fields: string[] = []
  const values: any[] = []

  let columnas: Set<string>
  try {
    columnas = settingsColumnSet()
  } catch (e) {
    console.error('[settings] no se pudo leer el esquema:', (e as Error).message)
    return { ok: false, applied: 0, ignored: Object.keys(settings || {}) }
  }

  for (const [key, value] of Object.entries(settings || {})) {
    if (key === 'id' || !columnas.has(key)) {
      ignoradas.push(key)
      continue
    }
    const v = valorEnlazable(value)
    if (v === undefined) {
      ignoradas.push(key)
      continue
    }
    fields.push(`${key} = ?`)
    values.push(v)
  }

  if (!fields.length) return { ok: true, applied: 0, ignored: ignoradas }

  try {
    db.prepare(`UPDATE settings SET ${fields.join(', ')} WHERE id = 1`).run(...values)
    return { ok: true, applied: fields.length, ignored: ignoradas }
  } catch (e) {
    console.error('[settings] fallo al guardar:', (e as Error).message)
    return { ok: false, applied: 0, ignored: ignoradas }
  }
}

export function getDownloads(): Download[] {
  return db.prepare('SELECT * FROM downloads ORDER BY created_at DESC').all() as Download[];
}

export function getDownloadByTorboxId(torboxId: string): Download | undefined {
  return db.prepare('SELECT * FROM downloads WHERE torbox_id = ?').get(torboxId) as Download | undefined;
}

export function addDownload(data: Partial<Download>): void {
  const keys = Object.keys(data).join(', ');
  const placeholders = Object.keys(data).map(() => '?').join(', ');
  const values = Object.values(data);
  db.prepare(`INSERT OR IGNORE INTO downloads (${keys}) VALUES (${placeholders})`).run(...values);
}

export function updateDownload(torboxId: string, data: Partial<Download>): void {
  const fields: string[] = [];
  const values: any[] = [];
  
  for (const [key, value] of Object.entries(data)) {
    if (key === 'id' || key === 'torbox_id') continue;
    fields.push(`${key} = ?`);
    values.push(value);
  }
  
  if (fields.length > 0) {
    const query = `UPDATE downloads SET ${fields.join(', ')} WHERE torbox_id = ?`;
    values.push(torboxId);
    db.prepare(query).run(...values);
  }
}

export function deleteDownload(torboxId: string): void {
  db.prepare('DELETE FROM downloads WHERE torbox_id = ?').run(torboxId);
}

/**
 * Libera las filas que quedaron en local_status 'preflight': el grab las deja
 * así mientras valida el release (¿tiene video? ¿dura lo esperado?) y las pasa
 * a 'pending' al terminar. Si el proceso se reinicia en medio, la descarga se
 * quedaría parada para siempre — al arrancar se liberan.
 */
export function releaseStalledPreflights(): number {
  try {
    const info = db.prepare("UPDATE downloads SET local_status = 'pending' WHERE local_status = 'preflight'").run()
    return Number((info as any)?.changes) || 0
  } catch { return 0 }
}

/**
 * Descargas que están consumiendo ancho de banda ahora mismo (bajando o
 * esperando el turno del worker). Es el número que limita la concurrencia.
 */
export function countDownloadingFiles(): number {
  try {
    const row = db.prepare(
      `SELECT COUNT(*) AS n FROM downloads
        WHERE local_status LIKE 'Downloading%' OR local_status = 'queued'`,
    ).get() as any
    return Number(row?.n) || 0
  } catch { return 0 }
}

/**
 * Profundidad de la cola: filas ya grabadas que aún no han terminado (en
 * validación, esperando turno o bajando). La cola de backfill mantiene este
 * número por debajo del límite para no acumular grabaciones.
 */
export function countPipelineDownloads(): number {
  try {
    const row = db.prepare(
      `SELECT COUNT(*) AS n FROM downloads
        WHERE local_status IS NULL
           OR local_status = ''
           OR local_status IN ('pending', 'queued', 'preflight')
           OR local_status LIKE 'Downloading%'`,
    ).get() as any
    return Number(row?.n) || 0
  } catch { return 0 }
}

export function getDB(): DatabaseType {
  return db
}

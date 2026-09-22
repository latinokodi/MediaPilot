// ── Settings ──
export interface AppSettings {
  torbox_token?: string
  realdebrid_token?: string
  tmdb_api_key?: string
  destination_folder?: string
  movies_folder?: string
  series_folder?: string
  jellyfin_url?: string
  jellyfin_api_key?: string
  auto_remove_completed?: boolean
  language_profile?: string
  monitor_enabled?: boolean
  monitor_interval_minutes?: number
  max_concurrent_downloads?: number
  max_movie_size_gb?: number
  max_series_size_gb?: number
  automation_service?: string
  automation_failover?: boolean
}

// ── API responses ──
export interface ApiResult {
  success: boolean
  detail?: string
  error?: string
}

// ── Downloads ──
export interface Download {
  id: number
  torbox_id: string
  name: string
  status: string
  progress: number
  seeds?: number
  download_speed?: number
  local_status?: string
  local_progress?: number
  local_speed?: number
  local_eta?: string
  local_path?: string
  service?: string
  type?: 'movie' | 'series' | ''
}

// ── Search ──
export interface SearchProgress {
  type: 'engine_start' | 'engine_results' | 'done'
  engine?: string
  results?: import('../store/searchTabs').SearchResult[]
}

// ── Log ──
export interface LogEntry {
  ts: string
  text: string
  level: string
}

// ── TMDB ──
export interface TMDBItem {
  id: number
  title?: string
  name?: string
  media_type: 'movie' | 'tv'
  poster_path?: string
  vote_average?: number
  overview?: string
  imdb_id?: string
  seasons?: Array<{ season_number: number; name: string; episode_count: number }>
  number_of_seasons?: number
}

export interface TMDBLists {
  movies: Record<string, TMDBItem[]>
  tv: Record<string, TMDBItem[]>
}

export interface TMDBSeason {
  episodes: Array<{ episode_number: number; name: string }>
}

// ── Latino providers ──
export interface LatinoResult {
  title: string
  magnet?: string
  infoHash?: string
  directUrl?: string
  size?: string
  seeders?: number
  provider: string
  quality?: string
}

// ── Stremio catalog ──
export interface CatalogManifest {
  catalogs: Array<{ id: string; name: string; type: string }>
}

export interface CatalogItem {
  id: string
  title?: string
  name?: string
  poster?: string
  media_type?: string
}

export interface CatalogMeta {
  videos?: Array<{ season: number; episode: number; name: string }>
}

// ── Debrid ──

// ── ElectronAPI (full typed contract matching preload.ts) ──
export interface ElectronAPI {
  getSettings: () => Promise<AppSettings>
  setSettings: (settings: Partial<AppSettings>) => Promise<ApiResult>

  searchMetaSearch: (query: string) => Promise<any>
  getDownloads: () => Promise<Download[]>
  addMagnet: (magnet: string, service?: string, type?: 'movie' | 'series') => Promise<ApiResult>
  addTorrentUrl: (url: string, service?: string, type?: 'movie' | 'series') => Promise<ApiResult>
  controlTorrent: (torrentId: string, operation: string) => Promise<ApiResult>
  cancelDownload: (torrentId: string) => Promise<ApiResult>

  selectFolder: () => Promise<string | null>

  authStart: () => Promise<any>
  authPoll: (deviceCode: string) => Promise<any>
  getUserInfo: () => Promise<any>
  testMetaSearch: () => Promise<any>

  rdAuthStart: () => Promise<any>
  rdAuthPoll: (deviceCode: string) => Promise<any>
  rdUserInfo: () => Promise<any>
  rdTraffic: () => Promise<any>
  rdSelectFiles: (torrentId: string) => Promise<any>

  onDownloadsUpdated: (callback: () => void) => () => void
  onLog: (callback: (entry: LogEntry) => void) => () => void
  getLogs: () => Promise<LogEntry[]>
  getVersion: () => Promise<string>
  openFolder: (folderPath: string) => Promise<{ success: boolean; error: string | null }>
  clearCompleted: () => Promise<ApiResult>

  onSearchProgress: (callback: (progress: SearchProgress) => void) => () => void
  onSearchError: (callback: (error: string) => void) => () => void

  checkPlugins: () => Promise<any>
  updatePlugins: () => Promise<any>

  tmdbLists: () => Promise<TMDBLists>
  tmdbDetail: (tmdbId: number, mediaType: string) => Promise<TMDBItem>
  tmdbSeason: (tmdbId: number, seasonNumber: number) => Promise<TMDBSeason>
  tmdbSearch: (query: string) => Promise<TMDBLists>
  tmdbValidate: (apiKey: string) => Promise<{ success: boolean; error?: string }>

  latinoSearch: (imdbId: string, mediaType: string, season?: string, episode?: string) => Promise<LatinoResult[]>
  onLatinoSearchProgress: (callback: (progress: any) => void) => () => void

  /** El latino ya está publicado en la web (sólo descarga directa) — aviso. */
  onLatinoDdlPending?: (callback: (info: {
    title?: string
    media_type?: string
    season?: number | null
    episode?: number | null
    url?: string
    ddl?: string[]
  }) => void) => () => void

  catalogManifest: () => Promise<CatalogManifest>
  catalogItems: (type: string, id: string) => Promise<CatalogItem[]>
  catalogMeta: (type: string, imdbId: string) => Promise<CatalogMeta>

  checkForUpdates: () => Promise<any>
  downloadUpdate: () => Promise<any>
  installUpdate: () => Promise<any>
  dismissUpdate: () => Promise<any>
  onUpdateAvailable: (callback: (version: string) => void) => () => void
  onUpdateNotAvailable: (callback: () => void) => () => void
  onUpdateDownloadProgress: (callback: (percent: number) => void) => () => void
  onUpdateDownloaded: (callback: () => void) => () => void
  onUpdateError: (callback: (message: string) => void) => () => void
}

// ── Helper: typed access to ElectronAPI ──
export function getElectronAPI(): ElectronAPI | undefined {
  const native = (window as unknown as { electronAPI?: ElectronAPI }).electronAPI
  if (native) return native
  return webAPI
}

// ─────────────────────────────────────────────────────────────
// Web (headless) mode shim — implements the same ElectronAPI
// contract over HTTP + SSE so the UI works unchanged in a browser.
// ─────────────────────────────────────────────────────────────
async function webFetch<T = any>(path: string, method = 'GET', body?: any): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (res.status === 404) return { success: false, error: 'Not found' } as unknown as T
  return (await res.json().catch(() => ({}))) as T
}

let _es: EventSource | null = null
function ensureEventSource(): EventSource {
  if (_es) return _es
  _es = new EventSource('/api/events')
  _es.onerror = () => {
    // transient reconnect is handled by the browser EventSource
  }
  return _es
}
function subscribe<T = any>(event: string, cb: (data: T) => void): () => void {
  const es = ensureEventSource()
  const handler = (e: MessageEvent) => {
    let data: any = {}
    try {
      data = e.data ? JSON.parse(e.data) : {}
    } catch {
      data = { raw: e.data }
    }
    cb(data as T)
  }
  es.addEventListener(event, handler)
  return () => es.removeEventListener(event, handler)
}

const noopUnsub = () => undefined

export const webAPI: ElectronAPI = {
  getSettings: () => webFetch('/api/settings'),
  setSettings: (settings) => webFetch('/api/settings', 'POST', settings),

  searchMetaSearch: (query) => webFetch('/api/search', 'POST', { query }),
  getDownloads: () => webFetch('/api/downloads'),
  addMagnet: (magnet, service, type) => webFetch('/api/downloads/add', 'POST', { magnet, service: service || 'torbox', type }),
  addTorrentUrl: (url, service, type) => webFetch('/api/downloads/add-torrent-url', 'POST', { url, service: service || 'torbox', type }),
  controlTorrent: (torrentId, operation) =>
    operation.toLowerCase() === 'delete'
      ? webFetch(`/api/downloads/${torrentId}`, 'DELETE')
      : Promise.resolve({ success: false, error: 'Operation not available in web mode' }),
  cancelDownload: (torrentId) => webFetch(`/api/downloads/cancel/${torrentId}`, 'POST'),

  selectFolder: () => webFetch('/api/select-folder', 'POST').then(() => null),

  authStart: () => webFetch('/api/auth/start', 'POST'),
  authPoll: (deviceCode) => webFetch(`/api/auth/poll/${deviceCode}`, 'POST'),
  getUserInfo: () => webFetch('/api/auth/user'),
  testMetaSearch: () => webFetch('/api/settings/test-metasearch', 'POST'),

  rdAuthStart: () => webFetch('/api/rd/auth/start', 'POST'),
  rdAuthPoll: (deviceCode) => webFetch(`/api/rd/auth/poll/${deviceCode}`, 'POST'),
  rdUserInfo: () => webFetch('/api/rd/user'),
  rdTraffic: () => webFetch('/api/rd/traffic'),
  rdSelectFiles: (torrentId) => webFetch('/api/rd/select-files', 'POST', { torrentId }),

  onDownloadsUpdated: (cb) => subscribe('downloads-updated', () => cb()),
  onLog: (cb) => subscribe('app-log', cb),
  getLogs: () => webFetch('/api/logs'),
  getVersion: () => webFetch('/api/version'),
  openFolder: () => Promise.resolve({ success: true, error: null }),
  clearCompleted: () => webFetch('/api/downloads/clear-completed', 'POST'),

  onSearchProgress: (cb) => subscribe('search-progress', cb),
  onSearchError: (cb) => subscribe('search-error', (e) => cb((e as any).message || String(e))),

  checkPlugins: () => webFetch('/api/plugins/check', 'POST'),
  updatePlugins: () => webFetch('/api/plugins/update', 'POST'),

  tmdbLists: () => webFetch('/api/tmdb/lists'),
  tmdbDetail: (tmdbId, mediaType) => webFetch(`/api/tmdb/detail/${tmdbId}/${mediaType}`),
  tmdbSeason: (tmdbId, seasonNumber) => webFetch(`/api/tmdb/season/${tmdbId}/${seasonNumber}`),
  tmdbSearch: (query) => webFetch(`/api/tmdb/search?q=${encodeURIComponent(query)}`),
  tmdbValidate: (apiKey) => webFetch('/api/tmdb/validate', 'POST', { apiKey }),

  latinoSearch: (imdbId, mediaType, season, episode) =>
    webFetch('/api/latino/search', 'POST', { imdbId, mediaType, season, episode }),
  onLatinoSearchProgress: (cb) => subscribe('latino-search-progress', cb),
  onLatinoDdlPending: (cb) => subscribe('latino-ddl-pending', cb),

  catalogManifest: () => webFetch('/api/catalog/manifest'),
  catalogItems: (type, id) => webFetch(`/api/catalog/items/${type}/${id}`),
  catalogMeta: (type, imdbId) => webFetch(`/api/catalog/meta/${type}/${imdbId}`),

  checkForUpdates: () => Promise.resolve({ success: false, error: 'Auto-update is not available in web mode' }),
  downloadUpdate: () => Promise.resolve({ success: false, error: 'Not available in web mode' }),
  installUpdate: () => Promise.resolve({ success: false, error: 'Not available in web mode' }),
  dismissUpdate: () => Promise.resolve({ success: true }),
  onUpdateAvailable: () => noopUnsub,
  onUpdateNotAvailable: () => noopUnsub,
  onUpdateDownloadProgress: () => noopUnsub,
  onUpdateDownloaded: () => noopUnsub,
  onUpdateError: () => noopUnsub,
}

// Browser mode: expose the shim as window.electronAPI so components that
// read it directly (desktop-style, e.g. SettingsModal VALIDAR button)
// keep working in the headless web UI. In the real Electron app the
// preload has already injected the native API, so this is a no-op.
if (typeof window !== 'undefined' && !(window as any).electronAPI) {
  ;(window as any).electronAPI = webAPI
}

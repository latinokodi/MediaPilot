import { contextBridge, ipcRenderer } from 'electron'

const api = {
  getSettings: (): Promise<any> => ipcRenderer.invoke('get-settings'),
  setSettings: (settings: any): Promise<any> => ipcRenderer.invoke('set-settings', settings),

  searchMetaSearch: (query: string): Promise<any> => ipcRenderer.invoke('search-metasearch', query),

  getDownloads: (): Promise<any[]> => ipcRenderer.invoke('get-downloads'),
  addMagnet: (magnet: string, service?: string): Promise<any> => ipcRenderer.invoke('add-magnet', magnet, service || 'torbox'),
  addTorrentUrl: (url: string, service?: string): Promise<any> => ipcRenderer.invoke('add-torrent-url', url, service || 'torbox'),
  controlTorrent: (torrentId: string, operation: string): Promise<any> => ipcRenderer.invoke('control-torrent', torrentId, operation),
  cancelDownload: (torrentId: string): Promise<any> => ipcRenderer.invoke('cancel-download', torrentId),

  selectFolder: (): Promise<string | null> => ipcRenderer.invoke('select-folder'),

  authStart: (): Promise<any> => ipcRenderer.invoke('auth-start'),
  authPoll: (deviceCode: string): Promise<any> => ipcRenderer.invoke('auth-poll', deviceCode),
  getUserInfo: (): Promise<any> => ipcRenderer.invoke('torbox-user-info'),
  testMetaSearch: (): Promise<any> => ipcRenderer.invoke('test-metasearch'),

  // ── Real-Debrid ──
  rdAuthStart: (): Promise<any> => ipcRenderer.invoke('rd-auth-start'),
  rdAuthPoll: (deviceCode: string): Promise<any> => ipcRenderer.invoke('rd-auth-poll', deviceCode),
  rdUserInfo: (): Promise<any> => ipcRenderer.invoke('rd-user-info'),
  rdTraffic: (): Promise<any> => ipcRenderer.invoke('rd-traffic'),
  rdSelectFiles: (torrentId: string): Promise<any> => ipcRenderer.invoke('rd-select-files', torrentId),

  onDownloadsUpdated: (callback: () => void) => {
    ipcRenderer.on('downloads-updated', callback)
    return () => ipcRenderer.removeAllListeners('downloads-updated')
  },
  onLog: (callback: (entry: { ts: string; text: string; level: string }) => void) => {
    ipcRenderer.on('app-log', (_e, entry) => callback(entry))
    return () => ipcRenderer.removeAllListeners('app-log')
  },
  getLogs: (): Promise<Array<{ ts: string; text: string; level: string }>> =>
    ipcRenderer.invoke('get-logs'),
  getVersion: (): Promise<string> => ipcRenderer.invoke('get-app-version'),
  openFolder: (folderPath: string): Promise<{ success: boolean; error: string | null }> =>
    ipcRenderer.invoke('open-folder', folderPath),
  clearCompleted: (): Promise<any> => ipcRenderer.invoke('clear-completed'),
  onSearchProgress: (callback: (progress: any) => void) => {
    ipcRenderer.on('search-progress', (_e, progress) => callback(progress))
    return () => ipcRenderer.removeAllListeners('search-progress')
  },
  onSearchError: (callback: (error: string) => void) => {
    ipcRenderer.on('search-error', (_e, error) => callback(error))
    return () => ipcRenderer.removeAllListeners('search-error')
  },
  checkPlugins: (): Promise<any> => ipcRenderer.invoke('check-plugins'),
  updatePlugins: (): Promise<any> => ipcRenderer.invoke('update-plugins'),

  // ── TMDB Discover ──
  tmdbLists: (): Promise<any> => ipcRenderer.invoke('tmdb-lists'),
  tmdbDetail: (tmdbId: number, mediaType: string): Promise<any> => ipcRenderer.invoke('tmdb-detail', tmdbId, mediaType),
  tmdbSeason: (tmdbId: number, seasonNumber: number): Promise<any> => ipcRenderer.invoke('tmdb-season', tmdbId, seasonNumber),
  tmdbSearch: (query: string): Promise<any> => ipcRenderer.invoke('tmdb-search', query),
  tmdbValidate: (apiKey: string): Promise<any> => ipcRenderer.invoke('tmdb-validate', apiKey),
  latinoSearch: (imdbId: string, mediaType: string, season?: string, episode?: string): Promise<any> =>
    ipcRenderer.invoke('latino-search', imdbId, mediaType, season, episode),
  onLatinoSearchProgress: (callback: (progress: any) => void) => {
    ipcRenderer.on('latino-search-progress', (_e, progress) => callback(progress))
    return () => ipcRenderer.removeAllListeners('latino-search-progress')
  },

  // ── Stremio Catalog ──
  catalogManifest: (): Promise<any> => ipcRenderer.invoke('catalog-manifest'),
  catalogItems: (type: string, id: string): Promise<any> => ipcRenderer.invoke('catalog-items', type, id),
  catalogMeta: (type: string, imdbId: string): Promise<any> => ipcRenderer.invoke('catalog-meta', type, imdbId),

  // ── Auto-update ──
  checkForUpdates: (): Promise<any> => ipcRenderer.invoke('check-for-updates'),
  downloadUpdate: (): Promise<any> => ipcRenderer.invoke('download-update'),
  installUpdate: (): Promise<any> => ipcRenderer.invoke('install-update'),
  dismissUpdate: (): Promise<any> => ipcRenderer.invoke('dismiss-update'),
  onUpdateAvailable: (callback: (version: string) => void) => {
    ipcRenderer.on('update-available', (_e, version) => callback(version))
    return () => ipcRenderer.removeAllListeners('update-available')
  },
  onUpdateNotAvailable: (callback: () => void) => {
    ipcRenderer.on('update-not-available', callback)
    return () => ipcRenderer.removeAllListeners('update-not-available')
  },
  onUpdateDownloadProgress: (callback: (percent: number) => void) => {
    ipcRenderer.on('update-download-progress', (_e, percent) => callback(percent))
    return () => ipcRenderer.removeAllListeners('update-download-progress')
  },
  onUpdateDownloaded: (callback: () => void) => {
    ipcRenderer.on('update-downloaded', callback)
    return () => ipcRenderer.removeAllListeners('update-downloaded')
  },
  onUpdateError: (callback: (message: string) => void) => {
    ipcRenderer.on('update-error', (_e, message) => callback(message))
    return () => ipcRenderer.removeAllListeners('update-error')
  },
}

contextBridge.exposeInMainWorld('electronAPI', api)

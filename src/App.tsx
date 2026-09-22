import { useState, useCallback, useEffect, useMemo, lazy, Suspense } from 'react'
import { SearchTabsBar } from './components/SearchTabsBar'
import { SearchTab } from './components/SearchTab'
import { DownloadCard } from './components/DownloadCard'
import { Sidebar } from './components/Sidebar'
import { Header } from './components/Header'
import { MagnetBar } from './components/MagnetBar'
import { UpdateDialog } from './components/UpdateDialog'
import { Toast } from './components/Toast'
import { ServiceSelector } from './components/ServiceSelector'
import { useSearchTabsStore } from './store/searchTabs'
import { useT, useTranslateError } from './i18n'
import { useDebridServices } from './hooks/useDebridServices'
import { api } from './hooks/useApi'
import { getElectronAPI } from './types/electron'
import { Search, FolderOpen } from 'lucide-react'

// Lazy-loaded views — not needed on initial render
const SettingsModal = lazy(() => import('./components/SettingsModal').then(m => ({ default: m.SettingsModal })))
const LogPanel = lazy(() => import('./components/LogPanel').then(m => ({ default: m.LogPanel })))
const DiscoverView = lazy(() => import('./components/DiscoverView').then(m => ({ default: m.DiscoverView })))
const WatchlistView = lazy(() => import('./components/WatchlistView').then(m => ({ default: m.WatchlistView })))
const DashboardView = lazy(() => import('./components/DashboardView').then(m => ({ default: m.DashboardView })))
const LibraryView = lazy(() => import('./components/LibraryView').then(m => ({ default: m.LibraryView })))
const CalendarView = lazy(() => import('./components/CalendarView').then(m => ({ default: m.CalendarView })))

const CLOUD_DONE_STATUSES = ['completed', 'cached', 'finished', 'downloaded']

function App() {
  const t = useT()
  const trErr = useTranslateError()
  const { hasTorbox, hasRealdebrid, downloadService, setDownloadService } = useDebridServices()

  // ── UI state ──
  const [query, setQuery] = useState('')
  const [magnetUrl, setMagnetUrl] = useState('')
  const [addingMagnet, setAddingMagnet] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [activeNav, setActiveNav] = useState('dashboard')
  const [navOpen, setNavOpen] = useState(false) // cajón de navegación en móvil
  const [downloads, setDownloads] = useState<any[]>([])
  const [destFolder, setDestFolder] = useState('')

  // ── Toast ──
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null)
  const showToast = useCallback((msg: string, type: 'success' | 'error' = 'success') => setToast({ msg, type }), [])

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 3000)
    return () => clearTimeout(timer)
  }, [toast])

  // Escape cierra el cajón de navegación (móvil)
  useEffect(() => {
    if (!navOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setNavOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navOpen])

  // ── Auto-update ──
  const [updateVersion, setUpdateVersion] = useState<string | null>(null)
  const [updateDownloading, setUpdateDownloading] = useState(false)
  const [updateDownloaded, setUpdateDownloaded] = useState(false)
  const [updatePercent, setUpdatePercent] = useState(0)
  const [appVersion, setAppVersion] = useState('')

  // ── Derived (memoized) ──
  const isServiceAvailable = hasTorbox || hasRealdebrid
  const activeCloud = useMemo(
    () => downloads.filter((d) => !CLOUD_DONE_STATUSES.includes((d.status || '').toLowerCase())).length,
    [downloads]
  )
  const activeLocal = useMemo(
    () => downloads.filter((d) => (d.local_status || '').toLowerCase().startsWith('downloading')).length,
    [downloads]
  )

  const { addTab, setTabResult, setTabError, appendResults, setCurrentEngine, markSearchDone } = useSearchTabsStore()

  // ── Downloads ──
  const refreshDownloads = useCallback(async () => {
    const res = await api<any>('/downloads')
    const dlArray = Array.isArray(res) ? res : res?.data ?? []
    setDownloads(dlArray)
  }, [])

  const handleDeleteDownload = useCallback(async (id: string, _isCompleted: boolean) => {
    try {
      await api(`/downloads/${id}`, 'DELETE')
      await refreshDownloads()
    } catch (err: any) {
      showToast(err.message || t.toasts.failedDelete, 'error')
    }
  }, [refreshDownloads, showToast, t])

  const handleCancelDownload = useCallback(async (id: string) => {
    try {
      await api(`/downloads/cancel/${id}`, 'POST')
      await refreshDownloads()
      showToast(t.toasts.downloadCancelled, 'success')
    } catch (err: any) {
      showToast(err.message || t.toasts.failedCancel, 'error')
    }
  }, [refreshDownloads, showToast, t])

  // ── Magnet submit ──
  const handleMagnetSubmit = useCallback(async () => {
    const raw = magnetUrl.trim()
    if (!raw) return
    if (!isServiceAvailable) { showToast(t.magnetBar.noService, 'error'); return }

    setAddingMagnet(true)
    setMagnetUrl('')

    try {
      let res: any
      if (raw.startsWith('magnet:?')) {
        res = await api<any>('/downloads/add', 'POST', { magnet: raw, service: downloadService })
      } else if (raw.startsWith('http://') || raw.startsWith('https://')) {
        res = await api<any>('/downloads/add-torrent-url', 'POST', { url: raw, service: downloadService })
      } else {
        showToast(t.toasts.invalidInput, 'error')
        setAddingMagnet(false)
        return
      }

      if (res.success) {
        showToast(raw.startsWith('magnet:?') ? t.toasts.magnetAdded : t.toasts.torrentAdded, 'success')
        await refreshDownloads()
      } else {
        showToast(`${t.toasts.error}: ${trErr(res.error || res.detail || t.toasts.unknownError)}`, 'error')
      }
    } catch (err: any) {
      showToast(err.message || t.toasts.failedAdd, 'error')
    } finally {
      setAddingMagnet(false)
    }
  }, [magnetUrl, isServiceAvailable, downloadService, refreshDownloads, showToast, t, trErr])

  // ── Search ──
  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!query.trim()) return
    const tabId = addTab(query)
    const currentQuery = query
    setQuery('')

    try {
      const res = await api<any>('/search', 'POST', { query: currentQuery })
      const store = useSearchTabsStore.getState()
      const tab = store.tabs[tabId]
      if (tab && (!tab.results || tab.results.length === 0)) {
        store.setTabResult(tabId, res.data ?? res.results ?? [])
      } else {
        store.markSearchDone(tabId)
      }
    } catch (err: any) {
      setTabError(tabId, err.message || t.toasts.searchFailed)
    }
  }

  // ── Settings close ──
  const handleSettingsClose = useCallback(async () => {
    setShowSettings(false)
    try {
      const settings: any = await api<any>('/settings')
      if (settings?.destination_folder) setDestFolder(settings.destination_folder)
      const tb = !!settings?.torbox_token
      const rd = !!settings?.realdebrid_token
      if (tb && !rd) setDownloadService('torbox')
      else if (!tb && rd) setDownloadService('realdebrid')
    } catch (_) {}
  }, [setDownloadService])

  // ── Folder open ──
  const handleOpenFolder = useCallback(async () => {
    const ea = getElectronAPI()
    if (!ea?.openFolder) return
    if (!destFolder) { showToast(t.toasts.noDestFolder, 'error'); return }
    const result = await ea.openFolder(destFolder)
    if (!result.success) showToast(`${t.toasts.failedOpenFolder}: ${result.error}`, 'error')
  }, [destFolder, showToast, t])

  // ── Initialization effects ──
  useEffect(() => {
    refreshDownloads().catch(console.error)
    const timer = window.setInterval(() => refreshDownloads().catch(console.error), 12000)

    // Load app version
    const ea = getElectronAPI()
    ea?.getVersion?.().then((v: string) => { if (v) setAppVersion(v) }).catch(() => {})

    // Load destination folder
    api<any>('/settings').then((settings: any) => {
      if (settings?.destination_folder) setDestFolder(settings.destination_folder)
    }).catch(() => {})

    // Downloads listener
    ea?.onDownloadsUpdated?.(() => refreshDownloads().catch(console.error))

    // Search progress listener
    const cleanupSearch = ea?.onSearchProgress?.((progress: any) => {
      const store = useSearchTabsStore.getState()
      const activeTabId = store.activeTabId
      if (!activeTabId) return
      if (progress.type === 'engine_start') store.setCurrentEngine(activeTabId, progress.engine)
      else if (progress.type === 'engine_results' && progress.results?.length > 0) {
        // Tag each result with its engine so the store can keep the Latino engine on top
        store.appendResults(activeTabId, progress.results.map((r: any) => ({ ...r, engine: progress.engine })))
      }
    })

    const cleanupSearchError = ea?.onSearchError?.((error: string) => {
      const store = useSearchTabsStore.getState()
      if (store.activeTabId) store.setTabError(store.activeTabId, error)
    })

    // Aviso: el latino ya está publicado en la web (sólo descarga directa) y el
    // monitor no baja el inglés a propósito — se reintentará hasta que salga el torrent.
    const cleanupDdl = ea?.onLatinoDdlPending?.((info: any) => {
      const ep = info?.season && info?.episode
        ? ` S${String(info.season).padStart(2, '0')}E${String(info.episode).padStart(2, '0')}`
        : ''
      showToast(`${t.toasts.latinoDdlPending}: ${info?.title || ''}${ep}`, 'success')
    })

    // Auto-update listeners
    const cleanupUpdate = [
      ea?.onUpdateAvailable?.((v: string) => setUpdateVersion(v)),
      ea?.onUpdateNotAvailable?.(() => {}),
      ea?.onUpdateDownloadProgress?.((p: number) => setUpdatePercent(Math.round(p))),
      ea?.onUpdateDownloaded?.(() => { setUpdateDownloading(false); setUpdateDownloaded(true) }),
      ea?.onUpdateError?.((msg: string) => { setUpdateDownloading(false); showToast(msg, 'error') }),
    ]

    return () => {
      window.clearInterval(timer)
      cleanupSearch?.()
      cleanupSearchError?.()
      cleanupDdl?.()
      cleanupUpdate.forEach(fn => fn?.())
    }
  }, [refreshDownloads, showToast])

  // ── Update dialog phase ──
  const updatePhase = updateDownloaded ? 'downloaded' as const
    : updateDownloading ? 'downloading' as const
    : updateVersion && !updateDownloading && !updateDownloaded ? 'available' as const
    : null

  return (
    <div className="flex h-[100dvh] w-full bg-bg-deep text-text-main font-display overflow-hidden relative">
      <Sidebar
        activeNav={activeNav}
        onNavChange={setActiveNav}
        onSettingsOpen={() => setShowSettings(true)}
        downloadCount={downloads.length}
        appVersion={appVersion}
        open={navOpen}
        onClose={() => setNavOpen(false)}
      />

      {/* Backdrop del cajón (sólo móvil/tablet) */}
      {navOpen && (
        <div
          className="fixed inset-0 z-30 bg-slate-900/45 backdrop-blur-[2px] lg:hidden"
          onClick={() => setNavOpen(false)}
          aria-hidden="true"
        />
      )}

      <main className="flex-1 flex flex-col relative z-10 h-full overflow-hidden min-w-0">
        <Header activeCloud={activeCloud} activeLocal={activeLocal} onMenuClick={() => setNavOpen(true)} />

        {/* Magnet bar — only on Search tab */}
        <MagnetBar
          value={magnetUrl}
          onChange={setMagnetUrl}
          onSubmit={handleMagnetSubmit}
          adding={addingMagnet}
          service={downloadService}
          onServiceChange={setDownloadService}
          hasTorbox={hasTorbox}
          hasRealdebrid={hasRealdebrid}
          visible={activeNav === 'search'}
        />

        <div className="flex-1 overflow-y-auto overscroll-contain p-3 sm:p-5 lg:p-6 min-w-0">
          {/* ── DASHBOARD (default) ── */}
          {activeNav === 'dashboard' && (
            <div className="h-full flex flex-col space-y-6 animate-fade-in">
              <div className="glass-panel flex-1 overflow-auto p-4">
                <Suspense fallback={<div className="text-text-muted font-mono text-sm p-4">Loading dashboard...</div>}>
                  <DashboardView onNavigate={setActiveNav} showToast={showToast} />
                </Suspense>
              </div>
            </div>
          )}

          {/* ── SEARCH ── */}
          {activeNav === 'search' && (
            <div className="h-full flex flex-col space-y-6 animate-fade-in">
              <form className="flex flex-col sm:flex-row gap-3 sm:gap-4" onSubmit={handleSearch}>
                <input
                  type="text"
                  className="input-field flex-1 min-w-0"
                  placeholder={t.search.placeholder}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <div className="flex gap-3">
                  <button type="submit" className="btn btn-accent flex-1 sm:flex-none">{t.search.initSearch}</button>
                  <ServiceSelector
                    service={downloadService}
                    onChange={setDownloadService}
                    hasTorbox={hasTorbox}
                    hasRealdebrid={hasRealdebrid}
                  />
                </div>
              </form>
              <SearchTabsBar />
              <div className="flex-1 overflow-auto glass-panel p-4">
                <SearchTab onDownloadAdded={refreshDownloads} showToast={showToast} service={downloadService} serviceAvailable={isServiceAvailable} />
              </div>
            </div>
          )}

          {/* ── WATCHLIST (automation) ── */}
          {activeNav === 'watchlist' && (
            <div className="h-full flex flex-col space-y-6 animate-fade-in">
              <div className="glass-panel flex-1 overflow-auto p-4">
                <Suspense fallback={<div className="text-text-muted font-mono text-sm p-4">Loading watchlist...</div>}>
                  <WatchlistView showToast={showToast} onActivity={refreshDownloads} />
                </Suspense>
              </div>
            </div>
          )}

          {/* ── BIBLIOTECA (borrado fiable) ── */}
          {activeNav === 'library' && (
            <div className="h-full flex flex-col space-y-6 animate-fade-in">
              <Suspense fallback={<div className="text-text-muted font-mono text-sm p-4">Loading library...</div>}>
                <LibraryView showToast={showToast} />
              </Suspense>
            </div>
          )}

          {/* ── CALENDARIO (descargas programadas) ── */}
          {activeNav === 'calendar' && (
            <div className="h-full flex flex-col space-y-6 animate-fade-in">
              <Suspense fallback={<div className="text-text-muted font-mono text-sm p-4">Loading calendar...</div>}>
                <CalendarView showToast={showToast} />
              </Suspense>
            </div>
          )}

          {/* ── TRANSFERS ── */}
          {activeNav === 'downloads' && (
            <div className="h-full flex flex-col space-y-6 animate-fade-in">
              <div className="glass-panel flex-1 overflow-auto p-4 space-y-4">
                <div className="flex flex-wrap justify-between items-center gap-2 pb-2 border-b border-border/50">
                  <h3 className="text-sm font-bold text-text-muted uppercase tracking-wider">{t.transfers.activeQueue}</h3>
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={handleOpenFolder}
                      className="btn border border-border text-xs px-3 hover:border-accent hover:text-accent font-mono"
                      disabled={!destFolder}
                      title={destFolder || t.toasts.noDestFolder}
                    >
                      <FolderOpen size={14} className="inline mr-1" />{t.transfers.openDest}
                    </button>
                    <button
                      onClick={async () => {
                        try {
                          await api('/downloads/clear-completed', 'POST')
                          await refreshDownloads()
                          showToast(t.transfers.completedCleared, 'success')
                        } catch (e: any) {
                          showToast(e.message || t.transfers.clearFailed, 'error')
                        }
                      }}
                      className="btn border border-border text-xs px-3 hover:border-danger hover:text-danger"
                    >
                      {t.transfers.clearCompleted}
                    </button>
                  </div>
                </div>
                {downloads.length === 0 && (
                  <div className="h-full flex items-center justify-center text-text-muted font-mono uppercase tracking-widest">
                    {t.transfers.noActive}
                  </div>
                )}
                {downloads.map(dl => (
                  <DownloadCard
                    key={dl.id}
                    download={dl}
                    onDelete={handleDeleteDownload}
                    onCancel={handleCancelDownload}
                  />
                ))}
              </div>
            </div>
          )}

          {/* ── LOGS ── */}
          {activeNav === 'logs' && (
            <div className="h-full flex flex-col space-y-6 animate-fade-in">
              <div className="glass-panel flex-1 overflow-auto p-4">
                <Suspense fallback={<div className="text-text-muted font-mono text-sm p-4">Loading logs...</div>}>
                  <LogPanel />
                </Suspense>
              </div>
            </div>
          )}

          {/* ── DISCOVER ── */}
          {activeNav === 'discover' && (
            <div className="h-full flex flex-col space-y-6 animate-fade-in">
              <div className="glass-panel flex-1 overflow-auto p-4">
                <Suspense fallback={<div className="text-text-muted font-mono text-sm p-4">Loading Discover...</div>}>
                  <DiscoverView
                  onDownloadAdded={refreshDownloads}
                  showToast={showToast}
                  service={downloadService}
                  hasTorbox={hasTorbox}
                  hasRealdebrid={hasRealdebrid}
                />
                </Suspense>
              </div>
            </div>
          )}
        </div>
      </main>

      {showSettings && (
        <Suspense fallback={null}>
          <SettingsModal onClose={handleSettingsClose} showToast={showToast} />
        </Suspense>
      )}

      <UpdateDialog
        phase={updatePhase}
        updateVersion={updateVersion}
        updatePercent={updatePercent}
        onDismiss={() => { setUpdateVersion(null); getElectronAPI()?.dismissUpdate() }}
        onDownload={() => { setUpdateDownloading(true); getElectronAPI()?.downloadUpdate() }}
        onLater={() => { setUpdateDownloaded(false); setUpdateVersion(null) }}
        onRestart={() => { getElectronAPI()?.installUpdate() }}
      />

      <Toast message={toast?.msg ?? ''} type={toast?.type ?? 'success'} visible={toast !== null} />
    </div>
  )
}

export default App

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BookMarked, Plus, Play, Pause, RefreshCw, Trash2, MonitorCheck, Search, X } from 'lucide-react'
import { useT } from '../i18n'
import { http } from '../hooks/http'

interface WatchItem {
  id: number
  tmdb_id: number
  media_type: 'movie' | 'series'
  title: string
  year: string
  overview: string
  poster: string
  backdrop: string
  imdb_id: string
  language_profile: 'latino_first' | 'latino_only' | 'english_first'
  backfill: 'new' | 'last_episode' | 'last_season' | 'first_season' | 'all'
  monitored: boolean
  lastGrab?: {
    kind: string
    media_type: string
    title: string
    season: number | null
    episode: number | null
    language: string
    source: string
    status: string
    grabbed_at: string
  } | null
  added_at: string
  last_checked: string
  next_episode: string
}

interface TmdbHit {
  id: number
  title: string
  media_type: 'movie' | 'tv'
  year: string
  poster: string | null
  overview: string
}

interface MonitorInfo {
  enabled: boolean
  intervalMinutes: number
  running: boolean
  lastRun: string | null
}

const PROFILE_ORDER = ['latino_first', 'latino_only', 'english_first'] as const
const SCOPE_ORDER = ['new', 'last_episode', 'last_season', 'first_season', 'all'] as const

interface UpgradeOffer {
  season: number | null
  episode: number | null
  kind: 'movie' | 'episode'
  release: string
  size: string
  indexer: string
  current: string
}

export function WatchlistView({ showToast, onActivity }: { showToast: (msg: string, type?: 'success' | 'error') => void; onActivity: () => void }) {
  const t = useT()
  const [items, setItems] = useState<WatchItem[]>([])
  const [monitor, setMonitor] = useState<MonitorInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [checkingId, setCheckingId] = useState<number | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [q, setQ] = useState('')
  const [searching, setSearching] = useState(false)
  const [hits, setHits] = useState<TmdbHit[]>([])
  const [pendingProfile, setPendingProfile] = useState('latino_first')
  const [pendingScope, setPendingScope] = useState<'new' | 'last_episode' | 'last_season' | 'first_season' | 'all'>('new')

  const refresh = useCallback(async () => {
    try {
      const [wl, ms] = await Promise.all([http<any>('/api/watchlist'), http<any>('/api/monitor/status')])
      if (wl?.success) setItems((wl.data || []) as WatchItem[])
      if (ms?.success) setMonitor(ms.data as MonitorInfo)
    } catch { /* transient */ }
  }, [])

  useEffect(() => {
    refresh().catch(() => {})
    const timer = window.setInterval(() => refresh().catch(() => {}), 12000)
    return () => window.clearInterval(timer)
  }, [refresh])

  const monitoredCount = useMemo(() => items.filter((i) => i.monitored).length, [items])

  const openAdd = useCallback(async () => {
    setQ('')
    setHits([])
    setSearching(false)
    setShowAdd(true)
    // B19: el desplegable arranca con el idioma por defecto de Ajustes, no con
    // "Latino primero" fijo. Antes, elegir "Solo latino" como predeterminado y
    // añadir desde aquí guardaba latino_first y la lista lo mostraba así.
    try {
      const st = await http<any>('/api/settings')
      // /api/settings devuelve el objeto plano (sin envoltorio success/data).
      const p = st?.language_profile ?? st?.data?.language_profile
      if (p === 'latino_first' || p === 'latino_only' || p === 'english_first') setPendingProfile(p)
    } catch { /* el ajuste es cosmético: el backend aplica el suyo */ }
  }, [])

  // Cerrar el modal de añadir con Escape
  useEffect(() => {
    if (!showAdd) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowAdd(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [showAdd])

  const doSearch = useCallback(async () => {
    if (!q.trim()) return
    setSearching(true)
    setHits([])
    try {
      const res = await http<any>(`/api/tmdb/search?q=${encodeURIComponent(q.trim())}`)
      if (res?.success) {
        const list: TmdbHit[] = ((res.data || []) as any[])
          .filter((x) => x && x.media_type && x.id)
          .map((x) => ({
            id: Number(x.id),
            title: x.title || x.name || '',
            media_type: x.media_type === 'movie' ? 'movie' : 'tv',
            year: x.year ? String(x.year) : '',
            poster: x.poster || null,
            overview: x.overview || '',
          }))
        setHits(list)
        if (list.length === 0) showToast(t.watchlist.noResults, 'error')
      } else {
        showToast(res?.error || t.watchlist.noResults, 'error')
      }
    } catch (e: any) {
      showToast(e?.message || t.watchlist.noResults, 'error')
    } finally {
      setSearching(false)
    }
  }, [q, showToast, t])

  const addItem = useCallback(async (hit: TmdbHit) => {
    setBusy(true)
    try {
      const res = await http<any>('/api/watchlist', 'POST', {
        tmdb_id: hit.id,
        media_type: hit.media_type === 'movie' ? 'movie' : 'series',
        title: hit.title,
        year: hit.year,
        overview: hit.overview,
        poster: hit.poster,
        language_profile: pendingProfile,
        backfill: hit.media_type === 'tv' ? pendingScope : 'new',
      })
      if (res?.success) {
        showToast(res.created ? t.watchlist.addedToast : t.watchlist.alreadyAdded)
        await refresh()
        setShowAdd(false)
        setQ('')
        setHits([])
      } else {
        showToast(res?.error || t.toasts.error, 'error')
      }
    } catch (e: any) {
      showToast(e?.message || t.toasts.error, 'error')
    } finally {
      setBusy(false)
    }
  }, [pendingProfile, refresh, showToast, t])

  const removeItem = useCallback(async (item: WatchItem) => {
    if (!window.confirm(`${t.watchlist.remove} — ${item.title}?`)) return
    try {
      const res = await http<any>(`/api/watchlist/${item.id}`, 'DELETE')
      if (res?.success) {
        showToast(t.watchlist.removedToast)
        await refresh()
      } else showToast(res?.error || t.toasts.error, 'error')
    } catch (e: any) {
      showToast(e?.message || t.toasts.error, 'error')
    }
  }, [refresh, showToast, t])

  const setProfile = useCallback(async (item: WatchItem, profile: string) => {
    try {
      const res = await http<any>(`/api/watchlist/${item.id}`, 'PATCH', { language_profile: profile })
      if (res?.success) await refresh()
      else showToast(res?.error || t.toasts.error, 'error')
    } catch (e: any) {
      showToast(e?.message || t.toasts.error, 'error')
    }
  }, [refresh, showToast, t])

  const setBackfill = useCallback(async (item: WatchItem, backfill: string) => {
    try {
      const res = await http<any>(`/api/watchlist/${item.id}`, 'PATCH', { backfill })
      if (res?.success) await refresh()
      else showToast(res?.error || t.toasts.error, 'error')
    } catch (e: any) {
      showToast(e?.message || t.toasts.error, 'error')
    }
  }, [refresh, showToast, t])

  const toggleMonitored = useCallback(async (item: WatchItem) => {
    try {
      const res = await http<any>(`/api/watchlist/${item.id}`, 'PATCH', { monitored: !item.monitored })
      if (res?.success) await refresh()
      else showToast(res?.error || t.toasts.error, 'error')
    } catch (e: any) {
      showToast(e?.message || t.toasts.error, 'error')
    }
  }, [refresh, showToast, t])

  const checkItem = useCallback(async (id: number) => {
    setCheckingId(id)
    showToast(t.watchlist.checkStarted)
    try {
      const res = await http<any>(`/api/watchlist/${id}/check`, 'POST')
      if (!res?.success) showToast(res?.error || t.toasts.error, 'error')
    } catch (e: any) {
      showToast(e?.message || t.toasts.error, 'error')
    }
    // Re-búsqueda manual de versiones latinas para descargas EN ya hechas:
    // si aparece algo, el programa PREGUNTA (modal) antes de reemplazar.
    window.setTimeout(() => { startUpgradePoll(id).catch(() => {}) }, 800)
    window.setTimeout(() => {
      setCheckingId(null)
      refresh().catch(() => {})
      onActivity()
    }, 4000)
  }, [onActivity, refresh, showToast, t])

  // ── Escáner de reemplazo manual EN → latino ──────────────
  const [upgradeState, setUpgradeState] = useState<{ itemId: number; offers: UpgradeOffer[]; scanning: boolean } | null>(null)
  const ignoredUpgrades = useRef<Set<string>>(new Set())
  const pollTimer = useRef<number | null>(null)

  const clearUpgradePoll = () => {
    if (pollTimer.current) { window.clearTimeout(pollTimer.current); pollTimer.current = null }
  }

  const startUpgradePoll = useCallback(async (id: number) => {
    clearUpgradePoll()
    try {
      await http<any>(`/api/watchlist/${id}/upgrades/scan`, 'POST')
    } catch { return }
    const tryFetch = async (tries: number) => {
      try {
        const res = await http<any>(`/api/watchlist/${id}/upgrades`, 'GET')
        const data = res?.data
        if (!data) return
        if (data.offers?.length > 0) {
          const visible = (data.offers as UpgradeOffer[]).filter((o) => !ignoredUpgrades.current.has(`${id}-${o.season}-${o.episode}`))
          if (visible.length > 0) {
            setUpgradeState({ itemId: id, offers: visible, scanning: false })
            return
          }
        }
        if (data.state === 'done') {
          // Ya está en latino o no hay nada que reemplazar — no molestar.
          return
        }
        if (tries > 0) {
          pollTimer.current = window.setTimeout(() => tryFetch(tries - 1), 3500)
        }
      } catch { /* server restart mid-poll etc. */ }
    }
    pollTimer.current = window.setTimeout(() => tryFetch(12), 1000)
  }, [http])

  const applyUpgrade = useCallback(async (itemId: number, season: number | null, episode: number | null) => {
    try {
      const res = await http<any>(`/api/watchlist/${itemId}/upgrade`, 'POST', { season, episode })
      if (res?.success) {
        showToast(t.watchlist.upgradeQueued)
        setUpgradeState(null)
        window.setTimeout(() => refresh().catch(() => {}), 3000)
      } else {
        showToast(res?.error || t.toasts.error, 'error')
        if (res?.error) setUpgradeState((s) => (s ? { ...s, offers: [] } : s))
      }
    } catch (e: any) {
      showToast(e?.message || t.toasts.error, 'error')
    }
  }, [http, refresh, showToast, t])

  useEffect(() => clearUpgradePoll, [])

  const lastGrabText = useCallback((g: NonNullable<WatchItem['lastGrab']>): string => {
    const lang = g.language === 'latino' ? t.watchlist.langLatino : t.watchlist.langEnglish
    if (g.kind === 'episode' && g.season && g.episode) {
      return `S${String(g.season).padStart(2, '0')}E${String(g.episode).padStart(2, '0')} · ${lang}`
    }
    return lang
  }, [t])

  const runAll = useCallback(async () => {
    setBusy(true)
    try {
      await http<any>('/api/monitor/run', 'POST')
      showToast(t.watchlist.runAllStarted)
    } finally {
      window.setTimeout(() => { setBusy(false); refresh().catch(() => {}) }, 2000)
    }
  }, [refresh, showToast, t])

  const profileLabel = (p: string) =>
    p === 'latino_only' ? t.watchlist.latinoOnly : p === 'english_first' ? t.watchlist.englishFirst : t.watchlist.latinoFirst

  const scopeLabel = (s: string) =>
    s === 'last_episode' ? t.watchlist.scopeLastEp
      : s === 'last_season' ? t.watchlist.scopeLastSeason
        : s === 'first_season' ? t.watchlist.scopeFirstSeason
          : s === 'all' ? t.watchlist.scopeAll
            : t.watchlist.scopeNew

  return (
    <div className="h-full flex flex-col space-y-6 animate-fade-in">
      {/* Automation status bar */}
      <div className="glass-panel p-4 flex flex-wrap items-center gap-x-6 gap-y-3">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0 w-full sm:w-auto">
          <MonitorCheck size={18} className={monitor?.enabled ? 'text-accent' : 'text-text-muted'} />
          <span className="font-mono text-sm uppercase tracking-wider">
            {monitor?.enabled ? t.watchlist.statusEnabled : t.watchlist.statusDisabled}
          </span>
          {monitor && (
            <span className="text-xs text-text-muted font-mono">
              · {t.watchlist.intervalMin.replace('{min}', String(monitor.intervalMinutes))}
            </span>
          )}
        </div>
        <div className="text-xs text-text-muted font-mono">
          {t.watchlist.monitored} <span className="text-accent font-bold">{monitoredCount}</span>
        </div>
        <div className="text-xs text-text-muted font-mono">
          {t.watchlist.lastRun}: {monitor?.lastRun ? new Date(monitor.lastRun).toLocaleTimeString() : t.watchlist.never}
          {monitor?.running ? ` — ${t.watchlist.checking}` : ''}
        </div>
        <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto sm:ml-auto">
          <button className="btn border border-border text-xs px-3 w-full sm:w-auto hover:border-accent hover:text-accent" onClick={runAll} disabled={busy}>
            <RefreshCw size={13} className={`inline mr-1 ${busy ? 'animate-spin' : ''}`} />
            {t.watchlist.checkAll}
          </button>
          <button className="btn btn-accent px-4 w-full sm:w-auto" onClick={openAdd}>
            <Plus size={15} className="inline mr-1" />
            {t.watchlist.add}
          </button>
        </div>
      </div>

      {/* Add title — modal (centrado, sin scroll de página para añadir) */}
      {showAdd && (
        <div
          className="modal-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowAdd(false)
          }}
        >
          <div className="w-full max-w-4xl h-[100dvh] sm:h-[min(88vh,46rem)] overflow-hidden rounded-none sm:rounded-2xl bg-bg-panel border border-border shadow-2xl flex flex-col">
            {/* Header */}
            <div className="px-5 py-3.5 border-b border-border flex items-center justify-between shrink-0">
              <h2 className="font-extrabold text-text-heading flex items-center gap-2">
                <Plus size={17} className="text-accent" /> {t.watchlist.add}
              </h2>
              <button
                className="w-8 h-8 rounded-full flex items-center justify-center text-text-muted hover:bg-bg-input hover:text-text-heading transition-colors"
                title="Cerrar"
                onClick={() => setShowAdd(false)}
              >
                <X size={17} />
              </button>
            </div>

            {/* Search + options (fijos) */}
            <div className="px-4 sm:px-5 pt-4 pb-3 space-y-3 border-b border-border shrink-0">
              <div className="flex flex-col sm:flex-row gap-3">
                <input
                  className="input-field flex-1 min-w-0"
                  placeholder={t.watchlist.searchPlaceholder}
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && doSearch()}
                  autoFocus
                />
                <button className="btn btn-accent px-4" onClick={doSearch} disabled={searching || !q.trim()}>
                  <Search size={14} className="inline mr-1" />
                  {searching ? t.watchlist.searching : t.watchlist.searchBtn}
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-x-6 gap-y-3 text-xs">
                <div className="flex items-center gap-3">
                  <span className="text-text-muted uppercase tracking-wider">{t.watchlist.profile}</span>
                  <select className="input-field w-auto min-w-0 max-w-full py-1 text-xs" value={pendingProfile} onChange={(e) => setPendingProfile(e.target.value)}>
                    {PROFILE_ORDER.map((p) => (
                      <option key={p} value={p}>{profileLabel(p)}</option>
                    ))}
                  </select>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-text-muted uppercase tracking-wider">{t.watchlist.scope}</span>
                  <select className="input-field w-auto min-w-0 max-w-full py-1 text-xs" value={pendingScope} onChange={(e) => setPendingScope(e.target.value as any)} title={t.watchlist.scope}>
                    {SCOPE_ORDER.map((s) => (
                      <option key={s} value={s}>{scopeLabel(s)}</option>
                    ))}
                  </select>
                  <span className="text-[11px] text-text-muted">(series)</span>
                </div>
              </div>
            </div>

            {/* Results (scroll interno del modal únicamente) */}
            <div className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-5 py-4">
              {hits.length === 0 && !searching && (
                <div className="h-full flex flex-col items-center justify-center gap-2 text-text-muted py-10">
                  <BookMarked size={30} strokeWidth={1.3} />
                  <p className="text-sm text-center px-6">{t.watchlist.noResultsHint}</p>
                </div>
              )}
              {hits.length > 0 && (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 gap-4">
                  {hits.map((hit) => (
                    <div key={`${hit.media_type}-${hit.id}`} className="group relative flex flex-col overflow-hidden rounded-xl border border-border bg-bg-card hover:border-accent/60 transition-colors">
                      <div className="relative aspect-[2/3] bg-bg-input overflow-hidden">
                        {hit.poster ? (
                          <img src={hit.poster} alt={hit.title} className="w-full h-full object-cover" loading="lazy" />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-text-muted"><BookMarked size={30} strokeWidth={1.4} /></div>
                        )}
                        <span className="absolute top-2 left-2 text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full bg-bg-deep/85 text-text-main backdrop-blur-sm">
                          {hit.media_type === 'movie' ? t.watchlist.movie : t.watchlist.series}
                        </span>
                        {/* Acción rápida sobre el póster (visible siempre en táctil) */}
                        <button
                          className="actions-overlay absolute left-2 right-2 bottom-2 btn btn-accent text-xs px-2 py-1.5"
                          onClick={() => addItem(hit)}
                          disabled={busy}
                        >
                          <Plus size={13} /> {t.watchlist.addItem}
                        </button>
                      </div>
                      <div className="p-2.5 flex flex-col gap-1 flex-1">
                        <div className="text-[12.5px] font-semibold text-text-heading leading-snug line-clamp-2 min-h-[2.5em]" title={hit.title}>
                          {hit.title}
                        </div>
                        <div className="text-[11px] text-text-muted">{hit.year || '—'}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Watchlist — poster grid (Sonarr-style) */}
      <div className="flex-1 overflow-auto pr-1">
        {items.length === 0 && !showAdd && (
          <div className="h-full flex flex-col items-center justify-center gap-3 text-text-muted">
            <BookMarked size={40} strokeWidth={1.2} />
            <div className="font-mono uppercase tracking-widest text-sm text-center px-8">{t.watchlist.empty}</div>
          </div>
        )}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-4">
          {items.map((item) => (
            <div
              key={item.id}
              className={`group relative flex flex-col overflow-hidden rounded-xl border border-border bg-bg-card hover:border-accent/60 transition-colors ${
                !item.monitored ? 'opacity-70' : ''
              }`}
            >
              {/* Poster */}
              <div className="relative aspect-[2/3] bg-bg-input overflow-hidden">
                {item.poster ? (
                  <img src={item.poster} alt={item.title} className="w-full h-full object-cover" loading="lazy" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-text-muted">
                    <BookMarked size={34} strokeWidth={1.4} />
                  </div>
                )}
                <span className="absolute top-2 left-2 text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full bg-bg-deep/85 text-text-main backdrop-blur-sm">
                  {item.media_type === 'movie' ? t.watchlist.movie : t.watchlist.series}
                </span>
                <span
                  className={`absolute top-2.5 right-2.5 w-2.5 h-2.5 rounded-full border border-white/80 ${item.monitored ? 'bg-success' : 'bg-text-muted'}`}
                  title={item.monitored ? t.watchlist.monitoring : t.watchlist.paused}
                />
                {/* Acciones sobre el póster (visibles siempre en táctil) */}
                <div className="actions-overlay absolute inset-0 bg-black/45 flex items-center justify-center gap-1.5 sm:gap-2.5">
                  <button
                    className="w-[44px] h-[44px] shrink-0 sm:w-9 sm:h-9 rounded-full bg-white text-slate-800 flex items-center justify-center shadow hover:bg-accent hover:text-white transition-colors"
                    title={item.monitored ? t.watchlist.pause : t.watchlist.resume}
                    onClick={() => toggleMonitored(item)}
                  >
                    {item.monitored ? <Pause size={15} /> : <Play size={15} />}
                  </button>
                  <button
                    className="w-[44px] h-[44px] shrink-0 sm:w-9 sm:h-9 rounded-full bg-white text-slate-800 flex items-center justify-center shadow hover:bg-accent hover:text-white transition-colors disabled:opacity-60"
                    title={t.watchlist.checkNow}
                    onClick={() => checkItem(item.id)}
                    disabled={checkingId === item.id}
                  >
                    <RefreshCw size={15} className={checkingId === item.id ? 'animate-spin' : ''} />
                  </button>
                  <button
                    className="w-[44px] h-[44px] shrink-0 sm:w-9 sm:h-9 rounded-full bg-white text-slate-800 flex items-center justify-center shadow hover:bg-danger hover:text-white transition-colors"
                    title={t.watchlist.remove}
                    onClick={() => removeItem(item)}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>

              {/* Body */}
              <div className="p-2.5 flex flex-col gap-1.5 flex-1">
                <div className="text-[13px] font-semibold text-text-heading leading-snug line-clamp-2 min-h-[2.6em]" title={item.title}>
                  {item.title}
                </div>
                <div className="text-[11px] text-text-muted truncate" title={item.media_type === 'series' && item.next_episode ? item.next_episode : item.year || ''}>
                  {item.year || '—'}
                  {item.media_type === 'series' && item.next_episode ? ` · ${item.next_episode}` : ''}
                </div>
                {item.lastGrab && item.lastGrab.status === 'grabbed' && (
                  <div
                    className="text-[11px] text-success truncate flex items-center gap-1"
                    title={`${item.lastGrab.title || item.title} · ${new Date(item.lastGrab.grabbed_at).toLocaleString()}`}
                  >
                    <span className="font-bold">✓</span>
                    <span className="truncate">{lastGrabText(item.lastGrab)}</span>
                  </div>
                )}
                <div className="flex flex-col gap-1 mt-auto min-w-0">
                  <select
                    className="input-field w-full min-w-0 py-1 text-[11px]"
                    value={item.language_profile}
                    onChange={(e) => setProfile(item, e.target.value)}
                    title={t.watchlist.profile}
                  >
                    {PROFILE_ORDER.map((p) => (
                      <option key={p} value={p}>{profileLabel(p)}</option>
                    ))}
                  </select>
                  {item.media_type === 'series' && (
                    <select
                      className="input-field w-full min-w-0 py-1 text-[11px]"
                      value={item.backfill || 'new'}
                      onChange={(e) => setBackfill(item, e.target.value)}
                      title={t.watchlist.scope}
                    >
                      {SCOPE_ORDER.map((s) => (
                        <option key={s} value={s}>{scopeLabel(s)}</option>
                      ))}
                    </select>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Modal de reemplazo manual EN → latino */}
      {upgradeState && upgradeState.offers.length > 0 && (
        <div
          className="modal-overlay"
          onClick={() => { setUpgradeState(null) }}
        >
          <div
            className="glass-panel w-full max-w-lg rounded-2xl p-6 max-h-[85vh] overflow-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4 mb-1">
              <div>
                <h3 className="text-lg font-extrabold text-text-heading tracking-tight">{t.watchlist.upgradeTitle}</h3>
                <p className="text-sm text-text-muted mt-0.5">{t.watchlist.upgradeDesc}</p>
              </div>
              <button
                className="text-text-muted hover:text-danger transition-colors shrink-0"
                onClick={() => setUpgradeState(null)}
              >
                <X size={20} />
              </button>
            </div>
            <div className="mt-4 space-y-3">
              {upgradeState.offers.map((o, i) => (
                <div key={`${o.season}-${o.episode}-${i}`} className="rounded-xl border border-border bg-bg-card p-3.5 flex flex-col gap-2.5">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-bold text-text-heading truncate">
                        {o.kind === 'movie' ? items.find((i) => i.id === upgradeState.itemId)?.title || t.watchlist.movie : `S${String(o.season).padStart(2, '0')}E${String(o.episode).padStart(2, '0')}`}
                      </div>
                      <div className="text-[11px] text-text-muted truncate" title={o.current}>
                        {o.release}
                      </div>
                      <div className="text-[11px] text-text-muted mt-0.5">
                        {o.size} · {o.indexer}
                      </div>
                    </div>
                    <div className="shrink-0 flex flex-col gap-1.5">
                      <button
                        className="btn btn-accent text-xs px-3 py-1.5"
                        onClick={() => applyUpgrade(upgradeState.itemId, o.season, o.episode)}
                      >
                        {t.watchlist.upgradeReplace}
                      </button>
                      <button
                        className="btn border border-border text-xs px-3 py-1.5 hover:border-accent"
                        onClick={() => {
                          ignoredUpgrades.current.add(`${upgradeState.itemId}-${o.season}-${o.episode}`)
                          const rest = upgradeState.offers.filter((x) => x !== o)
                          setUpgradeState(rest.length > 0 ? { ...upgradeState, offers: rest } : null)
                        }}
                      >
                        {t.watchlist.upgradeIgnore}
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-4 text-[11px] text-text-muted">{t.watchlist.upgradeNote}</div>
          </div>
        </div>
      )}
    </div>
  )
}

import { useCallback, useEffect, useMemo, useState } from 'react'
import { BookMarked, MonitorCheck, RadioTower, Languages, Activity, Zap } from 'lucide-react'
import { useT } from '../i18n'
import { http } from '../hooks/http'

interface WatchItem {
  id: number
  media_type: 'movie' | 'series'
  title: string
  poster: string
  language_profile: 'latino_first' | 'latino_only' | 'english_first'
  monitored: boolean
  next_episode: string
}

interface GrabRow {
  id: number
  title: string
  media_type: 'movie' | 'series'
  language: string
  source: string
  season: number | null
  episode: number | null
  grabbed_at: string
}

interface MonitorInfo {
  enabled: boolean
  intervalMinutes: number
  running: boolean
  lastRun: string | null
}

interface AppSettings {
  language_profile: 'latino_first' | 'latino_only' | 'english_first'
  monitor_enabled?: boolean
  monitor_interval_minutes?: number
}

const PROFILE_ORDER = ['latino_first', 'latino_only', 'english_first'] as const

export function DashboardView({ onNavigate, showToast }: { onNavigate: (nav: string) => void; showToast: (msg: string, type?: 'success' | 'error') => void }) {
  const t = useT()
  const [loaded, setLoaded] = useState(false)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [items, setItems] = useState<WatchItem[]>([])
  const [monitor, setMonitor] = useState<MonitorInfo | null>(null)
  const [grabs, setGrabs] = useState<GrabRow[]>([])
  const [activeDownloads, setActiveDownloads] = useState(0)
  const [savingLang, setSavingLang] = useState(false)
  const [checkingAll, setCheckingAll] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const [st, wl, ms, rg, dl] = await Promise.all([
        http<any>('/api/settings'),
        http<any>('/api/watchlist'),
        http<any>('/api/monitor/status'),
        http<any>('/api/watchlist/recent-grabs'),
        http<any>('/api/downloads'),
      ])
      if (st?.language_profile) setSettings(st as AppSettings)
      if (wl?.success) setItems((wl.data || []) as WatchItem[])
      if (ms?.success) setMonitor(ms.data as MonitorInfo)
      if (rg?.success) setGrabs(((rg.data || []) as GrabRow[]).slice(0, 8))
      if (Array.isArray(dl)) {
        const cloudDone = ['completed', 'cached', 'finished', 'downloaded']
        setActiveDownloads(dl.filter((d) => !cloudDone.includes((d.status || '').toLowerCase())).length)
      }
      setLoaded(true)
    } catch { /* transient — retry on next poll */ }
  }, [])

  useEffect(() => {
    refresh().catch(() => {})
    const timer = window.setInterval(() => refresh().catch(() => {}), 15000)
    return () => window.clearInterval(timer)
  }, [refresh])

  const monitored = useMemo(() => items.filter((i) => i.monitored), [items])
  const upcoming = useMemo(() => monitored.filter((i) => i.media_type === 'series' && i.next_episode), [monitored])
  const languageProfile = settings?.language_profile || 'latino_first'

  const profileLabel = (p: string) =>
    p === 'latino_only' ? t.watchlist.latinoOnly : p === 'english_first' ? t.watchlist.englishFirst : t.watchlist.latinoFirst

  const saveLanguage = useCallback(async (profile: string) => {
    setSavingLang(true)
    try {
      const res = await http<any>('/api/settings', 'POST', { language_profile: profile })
      if (res?.success) {
        setSettings((s) => (s ? { ...s, language_profile: profile as any } : s))
        showToast(t.dashboard.saved)
      } else showToast(res?.error || t.toasts.error, 'error')
    } catch (e: any) {
      showToast(e?.message || t.toasts.error, 'error')
    } finally {
      setSavingLang(false)
    }
  }, [showToast, t])

  const checkAll = useCallback(async () => {
    setCheckingAll(true)
    try {
      const res = await http<any>('/api/monitor/run', 'POST')
      if (!res?.success) showToast(res?.error || t.toasts.error, 'error')
      else showToast(t.watchlist.runAllStarted)
    } finally {
      window.setTimeout(() => { setCheckingAll(false); refresh().catch(() => {}) }, 3000)
    }
  }, [refresh, showToast, t])

  const grabTitle = (g: GrabRow) => {
    const ep = g.season && g.episode ? ` S${String(g.season).padStart(2, '0')}E${String(g.episode).padStart(2, '0')}` : ''
    return `${g.title}${ep}`
  }

  return (
    <div className="h-full overflow-auto space-y-6 animate-fade-in pr-1">
      {!loaded && (
        <div className="glass-panel p-3 sm:p-10 text-center font-mono text-text-muted uppercase tracking-widest text-sm">…</div>
      )}
      {loaded && (
        <>
          {/* Stats row */}
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-3 sm:gap-4">
            <StatCard label={t.dashboard.statMonitored} value={monitored.length} accent="text-accent" icon={<BookMarked size={18} />} onClick={() => onNavigate('watchlist')} />
            <StatCard label={t.dashboard.statDownloads} value={activeDownloads} accent="text-accent-hover" icon={<DownloadCloudMini />} onClick={() => onNavigate('downloads')} />
            <StatCard label={t.dashboard.statUpcoming} value={upcoming.length} accent="text-success" icon={<RadioTower size={18} />} onClick={() => onNavigate('watchlist')} />
            <StatCard
              label={monitor?.enabled ? t.watchlist.statusEnabled : t.watchlist.statusDisabled}
              value={monitor?.intervalMinutes ?? '—'}
              accent={monitor?.enabled ? 'text-success' : 'text-danger'}
              icon={<MonitorCheck size={18} />}
              suffix="min"
            />
          </div>

          {items.length === 0 ? (
            /* Empty state — real CTA, no invented content */
            <div className="glass-panel p-6 sm:p-12 flex flex-col items-center gap-4 sm:gap-6 text-center">
              <div className="w-16 h-16 border border-accent/40 text-accent flex items-center justify-center rounded-full">
                <Zap size={26} />
              </div>
              <p className="text-text-muted font-mono uppercase tracking-widest text-sm max-w-xl leading-relaxed">{t.dashboard.emptyCta}</p>
              <button className="btn btn-accent" onClick={() => onNavigate('watchlist')}>
                <BookMarked size={14} /> {t.dashboard.emptyBtn}
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
              {/* Language profile (global default) */}
              <div className="glass-panel p-5 space-y-4">
                <div className="flex items-center gap-2 text-text-muted">
                  <Languages size={15} />
                  <h3 className="font-mono text-xs uppercase tracking-widest">{t.dashboard.globalLanguage}</h3>
                </div>
                <select
                  className="input-field"
                  value={languageProfile}
                  onChange={(e) => saveLanguage(e.target.value)}
                  disabled={savingLang}
                >
                  {PROFILE_ORDER.map((p) => (
                    <option key={p} value={p}>{profileLabel(p)}</option>
                  ))}
                </select>
                <p className="text-[11px] text-text-muted font-mono leading-relaxed">{t.dashboard.globalLanguageHint}</p>
                <div className="pt-2 border-t border-border">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[10px] uppercase tracking-widest text-text-muted">{t.watchlist.lastRun}</span>
                    <span className="font-mono text-xs text-text-main">
                      {monitor?.lastRun ? new Date(monitor.lastRun).toLocaleString() : t.watchlist.never}
                    </span>
                  </div>
                  <button className="w-full btn btn-accent mt-3" onClick={checkAll} disabled={checkingAll}>
                    <MonitorCheck size={13} /> {checkingAll ? t.watchlist.checking : t.watchlist.checkAll}
                  </button>
                </div>
              </div>

              {/* Recent auto-grabs */}
              <div className="glass-panel p-5 xl:col-span-2 space-y-3">
                <div className="flex items-center gap-2 text-text-muted">
                  <Activity size={15} />
                  <h3 className="font-mono text-xs uppercase tracking-widest">{t.dashboard.activity}</h3>
                </div>
                {grabs.length === 0 ? (
                  <div className="py-8 text-center">
                    <p className="text-text-muted font-mono text-xs uppercase tracking-widest leading-relaxed px-6">{t.dashboard.activityNone}</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {grabs.map((g) => (
                      <div key={g.id} className="flex items-center gap-3 border border-border/60 px-3 py-2">
                        <span
                          className={`font-mono text-[9px] font-bold uppercase px-1.5 py-0.5 border ${
                            g.language === 'latino' ? 'text-success border-success/60' : 'text-accent border-accent/60'
                          }`}
                        >
                          {g.language === 'latino' ? 'LAT' : 'EN'}
                        </span>
                        <span className="text-xs font-bold truncate flex-1">{grabTitle(g)}</span>
                        <span className="text-[10px] text-text-muted font-mono truncate max-w-[10rem]">{g.source}</span>
                        <span className="text-[10px] text-text-muted font-mono shrink-0">{new Date(g.grabbed_at).toLocaleTimeString()}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Quick actions */}
          <div className="flex flex-wrap gap-3">
            <QuickAction icon={<SearchMini />} label={t.dashboard.goSearch} onClick={() => onNavigate('search')} />
            <QuickAction icon={<CompassMini />} label={t.dashboard.goDiscover} onClick={() => onNavigate('discover')} />
            <QuickAction icon={<BookMarked size={15} />} label={t.dashboard.goWatchlist} onClick={() => onNavigate('watchlist')} />
          </div>
        </>
      )}
    </div>
  )
}

function StatCard({ label, value, suffix, accent, icon, onClick }: { label: string; value: number | string; suffix?: string; accent: string; icon: React.ReactNode; onClick?: () => void }) {
  return (
    <button className={`glass-panel p-3.5 sm:p-5 text-left hover:border-accent/70 transition-colors ${onClick ? 'cursor-pointer' : 'cursor-default'}`} onClick={onClick}>
      <div className="flex items-center justify-between gap-2 text-text-muted mb-2 sm:mb-3">
        <span className="font-mono text-[10px] uppercase tracking-widest leading-tight min-w-0">{label}</span>
        {icon}
      </div>
      <div className={`text-2xl sm:text-4xl font-black font-mono ${accent}`}>
        {value}
        {suffix && <span className="text-xs font-mono text-text-muted ml-1">{suffix}</span>}
      </div>
    </button>
  )
}

function QuickAction({ icon, label, onClick, accent }: { icon: React.ReactNode; label: string; onClick: () => void; accent?: boolean }) {
  return (
    <button className={`btn ${accent ? 'btn-accent' : 'border border-border hover:border-accent'} text-xs`} onClick={onClick}>
      {icon} {label}
    </button>
  )
}

function DownloadCloudMini() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242" />
      <path d="M12 12v9" /><path d="m8 17 4 4 4-4" />
    </svg>
  )
}
function SearchMini() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
    </svg>
  )
}
function CompassMini() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" /><path d="m16.24 7.76-2.12 6.36-6.36 2.12 2.12-6.36 6.36-2.12z" />
    </svg>
  )
}

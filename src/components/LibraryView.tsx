import { useCallback, useEffect, useMemo, useState } from 'react'
import { Film, Tv, Trash2, Search, ChevronDown, ChevronRight, RefreshCw, X, HardDrive } from 'lucide-react'
import { useT } from '../i18n'
import { http } from '../hooks/http'

interface LibEpisode {
  file: string
  season: number | null
  episode: number | null
  sizeBytes: number
}
interface LibSeason {
  season: number | null
  label: string
  dir: string
  sizeBytes: number
  episodes: LibEpisode[]
  otherFiles: number
}
interface LibSeries {
  title: string
  year: string
  dir: string
  sizeBytes: number
  seasons: LibSeason[]
  looseVideos: string[]
  inWatchlist: boolean
  watchlistId: number | null
}
interface LibMovie {
  title: string
  year: string
  dir: string
  sizeBytes: number
  videos: number
  inWatchlist: boolean
  watchlistId: number | null
  poster: string
}
interface LibSnapshot {
  movies: LibMovie[]
  series: LibSeries[]
  roots: { movies: string; series: string }
  jellyfinConfigured: boolean
  posters: boolean
}

interface PendingDelete {
  type: 'movie' | 'series' | 'season' | 'episode'
  title: string
  dir: string
  season?: string
  file?: string
  label: string
  sizeBytes: number
  files: number
  inWatchlist: boolean
}

function fmtBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = bytes
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1 }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

export function LibraryView({ showToast }: { showToast: (msg: string, type?: 'success' | 'error') => void }) {
  const t = useT()
  const [data, setData] = useState<LibSnapshot | null>(null)
  const [tab, setTab] = useState<'movies' | 'series'>('series')
  const [q, setQ] = useState('')
  const [loading, setLoading] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [pending, setPending] = useState<PendingDelete | null>(null)
  const [forgetHistory, setForgetHistory] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const res = await http<any>('/api/library', 'GET')
      if (res?.success) setData(res.data)
      else if (res?.error) showToast(res.error, 'error')
    } catch (e: any) {
      showToast(e?.message || t.toasts.error, 'error')
    } finally {
      setLoading(false)
    }
  }, [showToast, t])

  useEffect(() => { refresh().catch(() => {}) }, [refresh])

  const toggle = (dir: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(dir)) next.delete(dir)
      else next.add(dir)
      return next
    })
  }

  const norm = (s: string) => s.toLowerCase()
  const movies = useMemo(
    () => (data?.movies || []).filter((m) => !q.trim() || norm(`${m.title} ${m.year}`).includes(norm(q.trim()))),
    [data, q],
  )
  const series = useMemo(
    () => (data?.series || []).filter((s) => !q.trim() || norm(`${s.title} ${s.year}`).includes(norm(q.trim()))),
    [data, q],
  )

  const askDelete = (p: PendingDelete) => {
    setForgetHistory(false)
    setPending(p)
  }

  const confirmDelete = async () => {
    if (!pending) return
    setDeleting(true)
    try {
      const res = await http<any>('/api/library/delete', 'POST', {
        type: pending.type,
        dir: pending.dir,
        title: pending.title,
        season: pending.season,
        file: pending.file,
        forgetHistory,
      })
      if (res?.success) {
        const d = res.data
        showToast(`${t.library.deletedToast} ${fmtBytes(d.freedBytes)}`)
        if (d.jellyfin && !d.jellyfin.sent && d.jellyfin.error) console.log('[library] jellyfin:', d.jellyfin.error)
        setPending(null)
        await refresh()
      } else {
        showToast(res?.error || t.toasts.error, 'error')
      }
    } catch (e: any) {
      showToast(e?.message || t.toasts.error, 'error')
    } finally {
      setDeleting(false)
    }
  }

  const rootsMissing = data && (!data.roots.movies || !data.roots.series)

  return (
    <div className="h-full flex flex-col space-y-5 animate-fade-in">
      {/* Barra superior */}
      <div className="glass-panel p-4 flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="flex items-center gap-2">
          <HardDrive size={18} className="text-accent" />
          <span className="font-mono text-sm uppercase tracking-wider text-text-heading">{t.library.title}</span>
        </div>
        <div className="flex items-center gap-1 rounded-lg bg-bg-input p-1">
          <button
            className={`px-3 py-1.5 max-sm:min-h-[44px] rounded-md text-xs font-semibold transition-colors ${tab === 'series' ? 'bg-accent text-white' : 'text-text-muted hover:text-text-heading'}`}
            onClick={() => setTab('series')}
          >
            <Tv size={13} className="inline mr-1.5" />{t.library.seriesTab} <span className="opacity-70">{data?.series.length ?? 0}</span>
          </button>
          <button
            className={`px-3 py-1.5 max-sm:min-h-[44px] rounded-md text-xs font-semibold transition-colors ${tab === 'movies' ? 'bg-accent text-white' : 'text-text-muted hover:text-text-heading'}`}
            onClick={() => setTab('movies')}
          >
            <Film size={13} className="inline mr-1.5" />{t.library.moviesTab} <span className="opacity-70">{data?.movies.length ?? 0}</span>
          </button>
        </div>
        <div className="flex items-center gap-2 ml-auto">
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted" />
            <input
              className="input-field pl-8 py-1.5 text-xs w-56"
              placeholder={t.library.searchPlaceholder}
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <button
            className="btn border border-border text-xs px-2.5 py-1.5 hover:border-accent"
            onClick={() => refresh()}
            title={t.library.refresh}
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {rootsMissing && (
        <div className="glass-panel p-4 text-sm text-text-muted">
          {t.library.rootsMissing}
        </div>
      )}

      {/* Contenido */}
      <div className="flex-1 overflow-auto pr-1">
        {tab === 'movies' ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-7 gap-4">
            {movies.length === 0 && <div className="col-span-full text-text-muted text-sm py-8 text-center">{t.library.emptyMovies}</div>}
            {movies.map((m) => (
              <div
                key={m.dir}
                className="group relative flex flex-col overflow-hidden rounded-xl border border-border bg-bg-card hover:border-accent/60 transition-colors"
              >
                {/* Póster */}
                <div className="relative aspect-[2/3] bg-bg-input overflow-hidden">
                  <div className="absolute inset-0 flex items-center justify-center text-text-muted">
                    <Film size={34} strokeWidth={1.4} />
                  </div>
                  {m.poster && (
                    <img
                      src={m.poster}
                      alt={m.title}
                      className="relative w-full h-full object-cover"
                      loading="lazy"
                      onError={(e) => { e.currentTarget.style.display = 'none' }}
                    />
                  )}
                  {m.inWatchlist && (
                    <span className="absolute top-2 left-2 text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full bg-bg-deep/85 text-success backdrop-blur-sm">
                      {t.library.inWatchlist}
                    </span>
                  )}
                  {/* Acción: borrar (visible siempre en táctil) */}
                  <div className="actions-overlay absolute inset-0 bg-black/45 flex items-center justify-center">
                    <button
                      className="w-[44px] h-[44px] shrink-0 sm:w-10 sm:h-10 rounded-full bg-white text-slate-800 flex items-center justify-center shadow hover:bg-danger hover:text-white transition-colors"
                      title={t.library.deleteMovie}
                      onClick={() => askDelete({ type: 'movie', dir: m.dir, title: m.title, label: `${m.title} (${m.year || '—'})`, sizeBytes: m.sizeBytes, files: m.videos, inWatchlist: m.inWatchlist })}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
                {/* Datos */}
                <div className="p-2.5 flex flex-col gap-0.5">
                  <div className="text-[13px] font-semibold text-text-heading leading-snug line-clamp-2 min-h-[2.6em]" title={m.title}>
                    {m.title}
                  </div>
                  <div className="text-[11px] text-text-muted truncate">
                    {m.year || '—'} · {m.videos} {t.library.files} · {fmtBytes(m.sizeBytes)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-2">
            {series.length === 0 && <div className="text-text-muted text-sm py-8 text-center">{t.library.emptySeries}</div>}
            {series.map((s) => {
              const isOpen = expanded.has(s.dir)
              return (
                <div key={s.dir} className="rounded-xl border border-border bg-bg-card overflow-hidden">
                  <div className="flex items-center gap-3 p-3">
                    <button className="flex items-center gap-3 flex-1 min-w-0 text-left" onClick={() => toggle(s.dir)}>
                      {isOpen ? <ChevronDown size={16} className="text-text-muted shrink-0" /> : <ChevronRight size={16} className="text-text-muted shrink-0" />}
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-text-heading truncate">{s.title} <span className="text-text-muted font-normal">{s.year ? `· ${s.year}` : ''}</span></div>
                        <div className="text-[11px] text-text-muted">
                          {s.seasons.length} {t.library.seasons} · {fmtBytes(s.sizeBytes)}
                          {s.inWatchlist ? <span className="text-success font-bold ml-2 uppercase text-[10px]">{t.library.inWatchlist}</span> : null}
                        </div>
                      </div>
                    </button>
                    <button
                      className="w-9 h-9 sm:w-7 sm:h-7 rounded-full border border-border text-text-muted flex items-center justify-center hover:bg-danger hover:text-white hover:border-danger transition-colors shrink-0"
                      title={t.library.deleteSeries}
                      onClick={() => askDelete({ type: 'series', dir: s.dir, title: s.title, label: `${s.title} (${t.library.fullSeries})`, sizeBytes: s.sizeBytes, files: s.seasons.reduce((a, x) => a + x.episodes.length + x.otherFiles, 0), inWatchlist: s.inWatchlist })}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>

                  {isOpen && (
                    <div className="border-t border-border/60 divide-y divide-border/40">
                      {s.looseVideos.length > 0 && (
                        <div className="px-4 py-2 text-[11px] text-text-muted">
                          {s.looseVideos.length} {t.library.looseFiles} ({s.looseVideos.join(', ')})
                        </div>
                      )}
                      {s.seasons.map((sea) => (
                        <div key={sea.dir} className="px-4 py-2.5">
                          <div className="flex items-center gap-3">
                            <div className="flex-1 text-[12px] font-semibold text-text-heading">
                              {sea.season !== null ? `${t.library.season} ${String(sea.season).padStart(2, '0')}` : sea.label}
                              <span className="text-text-muted font-normal ml-2">{sea.episodes.length} {t.library.episodes} · {fmtBytes(sea.sizeBytes)}</span>
                            </div>
                            <button
                              className="btn border border-border text-[11px] px-2 py-0.5 hover:border-danger hover:text-danger"
                              onClick={() => askDelete({ type: 'season', dir: s.dir, title: s.title, season: sea.label, label: `${s.title} — ${sea.label}`, sizeBytes: sea.sizeBytes, files: sea.episodes.length + sea.otherFiles, inWatchlist: s.inWatchlist })}
                            >
                              {t.library.deleteSeason}
                            </button>
                          </div>
                          <div className="mt-1.5 space-y-0.5">
                            {sea.episodes.map((ep) => (
                              <div key={ep.file} className="group flex items-center gap-2 text-[11px] text-text-muted hover:text-text-heading">
                                <span className="w-14 shrink-0 tabular-nums">
                                  {ep.season !== null && ep.episode !== null ? `S${String(ep.season).padStart(2, '0')}E${String(ep.episode).padStart(2, '0')}` : '—'}
                                </span>
                                <span className="truncate flex-1" title={ep.file}>{ep.file}</span>
                                <span className="shrink-0 tabular-nums">{fmtBytes(ep.sizeBytes)}</span>
                                <button
                                  className="shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-text-muted hover:bg-danger hover:text-white transition-colors"
                                  title={t.library.deleteEpisode}
                                  onClick={() => askDelete({ type: 'episode', dir: s.dir, title: s.title, season: sea.label, file: ep.file, label: ep.file, sizeBytes: ep.sizeBytes, files: 1, inWatchlist: s.inWatchlist })}
                                >
                                  <Trash2 size={12} />
                                </button>
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Confirmación */}
      {pending && (
        <div className="modal-overlay" onClick={() => !deleting && setPending(null)}>
          <div className="glass-panel w-full max-w-md rounded-2xl p-5 sm:p-6 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-4">
              <h3 className="text-lg font-extrabold text-text-heading tracking-tight">{t.library.confirmTitle}</h3>
              <button className="text-text-muted hover:text-danger transition-colors" onClick={() => !deleting && setPending(null)}>
                <X size={20} />
              </button>
            </div>
            <div className="mt-3 rounded-xl border border-border bg-bg-card p-3.5">
              <div className="text-sm font-bold text-text-heading break-all">{pending.label}</div>
              <div className="text-[11px] text-text-muted mt-1">
                {pending.files} {t.library.files} · {fmtBytes(pending.sizeBytes)}
              </div>
            </div>
            <p className="text-xs text-danger mt-3">{t.library.warning}</p>
            {pending.inWatchlist && (
              <label className="flex items-start gap-2 mt-3 text-xs text-text-muted cursor-pointer">
                <input
                  type="checkbox"
                  className="w-4 h-4 accent-accent mt-0.5"
                  checked={forgetHistory}
                  onChange={(e) => setForgetHistory(e.target.checked)}
                />
                <span>{t.library.forgetHistory}</span>
              </label>
            )}
            <div className="flex justify-end gap-2 mt-5">
              <button className="btn border border-border text-sm px-4 py-2" onClick={() => setPending(null)} disabled={deleting}>
                {t.library.cancel}
              </button>
              <button
                className="btn bg-danger text-white text-sm px-4 py-2 hover:opacity-90 disabled:opacity-60"
                onClick={confirmDelete}
                disabled={deleting}
              >
                {deleting ? t.library.deleting : t.library.confirmDelete}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

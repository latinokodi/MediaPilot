import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CalendarDays, ChevronLeft, ChevronRight, RefreshCw, Clock, CheckCircle2, Globe } from 'lucide-react'
import { useT, useLang } from '../i18n'
import { http } from '../hooks/http'

interface CalendarEvent {
  date: string
  itemId: number
  title: string
  tmdb_id: number
  media_type: 'movie' | 'series'
  kind: 'episode' | 'movie'
  season: number | null
  episode: number | null
  episode_name: string
  poster: string
  language_profile: string
  scope: string
  grabbed: boolean
}

interface CalendarPayload {
  events: CalendarEvent[]
  days: number
  generated_at: string
  window: { from: string; to: string }
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}
function isoOf(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
function formatShort(iso: string, lang: string): string {
  if (!iso) return '—'
  return new Intl.DateTimeFormat(lang === 'es' ? 'es-ES' : 'en-US', { day: 'numeric', month: 'short' }).format(new Date(`${iso}T12:00:00`))
}

export function CalendarView({ showToast }: { showToast: (msg: string, type?: 'success' | 'error') => void }) {
  const t = useT()
  const { lang } = useLang()
  const [data, setData] = useState<CalendarPayload | null>(null)
  const [loading, setLoading] = useState(false)
  const [days, setDays] = useState(60)
  const [cursor, setCursor] = useState(() => new Date())
  const [selected, setSelected] = useState<string>(() => isoOf(new Date()))
  const [checking, setChecking] = useState<number | null>(null)
  const windowToastRef = useRef(false)

  const load = useCallback(async (force = false) => {
    setLoading(true)
    try {
      const res = await http<any>(`/api/calendar?days=${days}${force ? '&refresh=1' : ''}`)
      if (res?.success) {
        setData(res.data)
        if (windowToastRef.current) {
          windowToastRef.current = false
          const d = res.data
          showToast(`${d.events.length} ${t.calendar.pending} · ${formatShort(d.window.from, lang)} → ${formatShort(d.window.to, lang)}`)
        }
      } else if (res?.error) showToast(res.error, 'error')
    } catch (e: any) {
      showToast(e?.message || t.toasts.error, 'error')
    } finally {
      setLoading(false)
    }
  }, [days, showToast, t, lang])

  useEffect(() => { load().catch(() => {}) }, [load])

  const byDate = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>()
    for (const e of data?.events || []) {
      const list = map.get(e.date) || []
      list.push(e)
      map.set(e.date, list)
    }
    return map
  }, [data])

  const todayIso = isoOf(new Date())

  // Matriz del mes (semanas de lunes a domingo)
  const weeks = useMemo(() => {
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1)
    const offset = (first.getDay() + 6) % 7 // lunes = 0
    const start = new Date(first)
    start.setDate(first.getDate() - offset)
    const rows: Date[][] = []
    for (let w = 0; w < 6; w++) {
      const row: Date[] = []
      for (let d = 0; d < 7; d++) {
        const day = new Date(start)
        day.setDate(start.getDate() + w * 7 + d)
        row.push(day)
      }
      rows.push(row)
    }
    return rows
  }, [cursor])

  const weekdays = useMemo(() => {
    const base = new Date(2024, 0, 1) // lunes
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(base)
      d.setDate(base.getDate() + i)
      return new Intl.DateTimeFormat(lang === 'es' ? 'es-ES' : 'en-US', { weekday: 'short' }).format(d).replace('.', '')
    })
  }, [lang])

  const monthLabel = useMemo(() => {
    const s = new Intl.DateTimeFormat(lang === 'es' ? 'es-ES' : 'en-US', { month: 'long', year: 'numeric' }).format(cursor)
    return s.charAt(0).toUpperCase() + s.slice(1)
  }, [cursor, lang])

  const selectedEvents = byDate.get(selected) || []
  const totalEvents = data?.events.length || 0
  const pendingEvents = (data?.events || []).filter((e) => !e.grabbed).length

  const fmtDay = (iso: string) => {
    const s = new Intl.DateTimeFormat(lang === 'es' ? 'es-ES' : 'en-US', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(`${iso}T12:00:00`))
    return s.charAt(0).toUpperCase() + s.slice(1)
  }

  const shortDate = (iso: string) => formatShort(iso, lang)
  const windowFrom = data?.window?.from || ''
  const windowTo = data?.window?.to || ''
  const atToday = cursor.getFullYear() === new Date().getFullYear() && cursor.getMonth() === new Date().getMonth() && selected === todayIso

  const changeWindow = useCallback((d: number) => {
    const summary = (payload: CalendarPayload) =>
      `${payload.events.length} ${t.calendar.pending} · ${formatShort(payload.window.from, lang)} → ${formatShort(payload.window.to, lang)}`
    if (d === days) {
      if (data) showToast(summary(data))
      return
    }
    windowToastRef.current = true
    setDays(d)
  }, [data, days, lang, showToast, t])

  const goToday = useCallback(() => {
    setCursor(new Date())
    setSelected(todayIso)
    if (atToday) showToast(`${(byDate.get(todayIso) || []).length} ${t.calendar.pending} · ${fmtDay(todayIso)}`)
  }, [atToday, byDate, showToast, t, todayIso])

  const checkNow = useCallback(async (itemId: number) => {
    setChecking(itemId)
    showToast(t.watchlist.checkStarted)
    try {
      await http<any>(`/api/watchlist/${itemId}/check`, 'POST')
    } catch (e: any) {
      showToast(e?.message || t.toasts.error, 'error')
    }
    window.setTimeout(() => { setChecking(null); load(true).catch(() => {}) }, 4000)
  }, [load, showToast, t])

  const profileBadge = (p: string) =>
    p === 'english_first' ? 'EN' : p === 'latino_only' ? 'LAT' : 'LAT→EN'

  return (
    <div className="h-full flex flex-col space-y-5 animate-fade-in">
      {/* Barra superior */}
      <div className="glass-panel p-3 sm:p-4 flex flex-wrap items-center gap-x-3 sm:gap-x-4 gap-y-3">
        <div className="flex items-center gap-2 w-full sm:w-auto min-w-0">
          <CalendarDays size={18} className="text-accent shrink-0" />
          <span className="font-mono text-sm uppercase tracking-wider text-text-heading truncate">{t.calendar.title}</span>
        </div>

        <div className="flex items-center gap-1 flex-wrap">
          <button
            className="w-[44px] h-[44px] sm:w-8 sm:h-8 rounded-lg border border-border flex items-center justify-center text-text-muted hover:border-accent hover:text-accent transition-colors shrink-0"
            onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}
            title={t.calendar.prev}
          >
            <ChevronLeft size={16} />
          </button>
          <div className="min-w-[7.5rem] sm:min-w-[10rem] text-center text-sm font-semibold text-text-heading">{monthLabel}</div>
          <button
            className="w-[44px] h-[44px] sm:w-8 sm:h-8 rounded-lg border border-border flex items-center justify-center text-text-muted hover:border-accent hover:text-accent transition-colors shrink-0"
            onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}
            title={t.calendar.next}
          >
            <ChevronRight size={16} />
          </button>
          <button
            className={`btn border text-xs px-2.5 py-1.5 ml-1 transition-colors ${atToday ? 'border-accent text-accent' : 'border-border hover:border-accent'}`}
            onClick={goToday}
          >
            {t.calendar.today}
          </button>
        </div>

        <div className="flex items-center gap-1 rounded-lg bg-bg-input p-1">
          {[30, 60, 90].map((d) => (
            <button
              key={d}
              className={`px-2.5 py-1 max-sm:min-h-[44px] rounded-md text-[11px] font-semibold transition-all active:scale-95 ${
                days === d ? 'bg-accent text-white shadow-sm' : 'text-text-muted hover:text-text-heading hover:bg-bg-card'
              } ${loading && days === d ? 'opacity-70' : ''}`}
              onClick={() => changeWindow(d)}
            >
              {d} {t.calendar.days}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-3 ml-0 sm:ml-auto w-full sm:w-auto flex-wrap text-[11px] text-text-muted">
          <span className="flex items-center gap-1"><Clock size={13} className="text-accent" />{pendingEvents} {t.calendar.pending}</span>
          <span className="flex items-center gap-1"><CheckCircle2 size={13} className="text-success" />{totalEvents - pendingEvents} {t.calendar.downloaded}</span>
          {loading
            ? <span className="animate-pulse text-accent">{t.calendar.updating}</span>
            : <span className="hidden sm:inline" title={t.calendar.window}>{shortDate(windowFrom)} → {shortDate(windowTo)}</span>}
          <button
            className="btn border border-border text-xs px-2.5 py-1.5 hover:border-accent"
            onClick={() => load(true)}
            title={t.calendar.refresh}
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* Calendario */}
      <div className="glass-panel p-2 sm:p-4 flex-1 overflow-auto">
        <div className="grid grid-cols-7 gap-1 mb-1">
          {weekdays.map((w) => (
            <div key={w} className="text-center text-[9px] sm:text-[10px] font-bold uppercase tracking-wider text-text-muted py-1">{w}</div>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-1">
          {weeks.flat().map((day) => {
            const iso = isoOf(day)
            const inMonth = day.getMonth() === cursor.getMonth()
            const evs = byDate.get(iso) || []
            const isToday = iso === todayIso
            const isSel = iso === selected
            const isPast = iso < todayIso
            const outOfWindow = !!windowTo && iso > windowTo
            return (
              <button
                key={iso}
                onClick={() => setSelected(iso)}
                className={`min-h-[92px] sm:min-h-[112px] rounded-lg border p-1 sm:p-1.5 text-left align-top transition-colors ${
                  isSel ? 'border-accent bg-accent/5' : outOfWindow ? 'border-dashed border-border' : 'border-border hover:border-accent/50'
                } ${inMonth ? 'bg-bg-card' : 'bg-bg-input/40 opacity-60'} ${outOfWindow ? 'opacity-45' : ''}`}
              >
                <div className="flex items-center justify-between">
                  <span className={`text-[11px] font-semibold ${isToday ? 'text-white bg-accent rounded-full px-1.5' : isPast ? 'text-text-muted' : 'text-text-heading'}`}>
                    {day.getDate()}
                  </span>
                  {evs.length > 0 && <span className="text-[10px] text-text-muted">{evs.length}</span>}
                </div>
                <div className="mt-1.5 space-y-1.5">
                  {evs.slice(0, 2).map((e, i) => (
                    <div key={`${e.itemId}-${e.season}-${e.episode}-${i}`} className="flex items-center gap-1 sm:gap-1.5 min-w-0" title={`${e.title}${e.kind === 'episode' ? ` S${pad(e.season || 0)}E${pad(e.episode || 0)}` : ''}`}>
                      {e.poster
                        ? <img src={e.poster} alt="" className="w-[26px] h-[39px] rounded-[4px] object-cover shrink-0 ring-1 ring-black/5" loading="lazy" />
                        : <span className="w-[26px] h-[39px] rounded-[4px] bg-bg-input shrink-0" />}
                      <span className={`hidden sm:inline text-[10.5px] leading-tight truncate ${e.grabbed ? 'text-success' : 'text-text-main'}`}>
                        {e.kind === 'movie' ? e.title : `S${pad(e.season || 0)}E${pad(e.episode || 0)}`}
                      </span>
                    </div>
                  ))}
                  {evs.length > 2 && <div className="text-[10px] text-text-muted">+{evs.length - 2} {t.calendar.more}</div>}
                </div>
              </button>
            )
          })}
        </div>
      </div>

      {/* Detalle del día seleccionado */}
      <div className="glass-panel p-4">
        <h3 className="text-xs font-bold text-text-muted tracking-wider mb-3">{fmtDay(selected)}</h3>
        {selectedEvents.length === 0 ? (
          <div className="text-sm text-text-muted py-2">{t.calendar.noEventsDay}</div>
        ) : (
          <div className="space-y-2">
            {selectedEvents.map((e, i) => (
              <div key={`${e.itemId}-${e.season}-${e.episode}-${i}`} className="flex items-center gap-3 rounded-xl border border-border bg-bg-card p-3">
                {e.poster
                  ? <img src={e.poster} alt="" className="w-[52px] h-[78px] rounded-md object-cover shrink-0 ring-1 ring-black/5" loading="lazy" />
                  : <div className="w-[52px] h-[78px] rounded-md bg-bg-input shrink-0" />}
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-text-heading truncate">
                    {e.title}
                    {e.kind === 'episode' && <span className="text-text-muted font-normal"> · S{pad(e.season || 0)}E{pad(e.episode || 0)}</span>}
                  </div>
                  {e.episode_name && <div className="text-[11px] text-text-muted truncate">{e.episode_name}</div>}
                  <div className="flex items-center gap-2 mt-1.5 text-[10px]">
                    <span className="px-1.5 py-0.5 rounded-full bg-bg-input text-text-muted font-bold">{profileBadge(e.language_profile)}</span>
                    {e.kind === 'episode' && e.scope && e.scope !== 'new' && (
                      <span className="px-1.5 py-0.5 rounded-full bg-bg-input text-text-muted">{e.scope}</span>
                    )}
                    {e.grabbed
                      ? <span className="flex items-center gap-1 text-success font-semibold"><CheckCircle2 size={12} />{t.calendar.downloaded}</span>
                      : <span className="flex items-center gap-1 text-accent font-semibold"><Clock size={12} />{isoOf(new Date()) === e.date ? t.calendar.availableToday : t.calendar.scheduled}</span>}
                  </div>
                </div>
                <button
                  className="btn border border-border text-xs px-2.5 py-1.5 hover:border-accent hover:text-accent shrink-0"
                  onClick={() => checkNow(e.itemId)}
                  disabled={checking === e.itemId}
                  title={t.calendar.verifyNow}
                >
                  <Globe size={13} className={checking === e.itemId ? 'animate-spin' : ''} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

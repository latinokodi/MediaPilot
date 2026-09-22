import { useState, useEffect, useRef, useMemo } from 'react'
import { useT } from '../i18n'

interface LogEntry {
  ts: string
  text: string
  level: string
}

type LevelFilter = 'all' | 'normal' | 'errors'

const LEVEL_COLORS: Record<string, string> = {
  info: 'text-text-main',
  debug: 'text-text-muted/70',
  warn: 'text-amber-600',
  error: 'text-danger',
}

/** Color por origen ([Worker]/[Monitor]/[grab]/[py]/[TorBox]…) para escanear rápido. */
function tagClass(text: string): string {
  if (text.startsWith('[Monitor]')) return 'text-accent'
  if (text.startsWith('[grab]')) return 'text-indigo-500'
  if (text.startsWith('[Worker]')) return 'text-success'
  if (text.startsWith('[py]')) return 'text-text-muted'
  if (text.startsWith('[TorBox]')) return 'text-sky-600'
  if (text.startsWith('[RD]')) return 'text-rose-500'
  if (text.startsWith('[Subs]')) return 'text-emerald-600'
  if (text.startsWith('[server]')) return 'text-text-muted'
  return ''
}

const KNOWN_TAGS = ['[Monitor]', '[grab]', '[Worker]', '[py]', '[TorBox]', '[RD]', '[Subs]', '[server]', '[latino]', '[settings]', '[watchlist]']

function splitTag(text: string): { tag: string; rest: string } {
  const found = KNOWN_TAGS.find((k) => text.startsWith(k))
  if (!found) return { tag: '', rest: text }
  return { tag: found, rest: text.slice(found.length).trimStart() }
}

export function LogPanel() {
  const t = useT()
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [filter, setFilter] = useState<LevelFilter>('all')
  const [query, setQuery] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickBottom = useRef(true)

  useEffect(() => {
    const electronAPI = (window as any).electronAPI
    if (!electronAPI) return

    electronAPI.getLogs().then((initial: LogEntry[]) => {
      if (initial?.length) setLogs(initial.slice(-800))
    })

    const unsub = electronAPI.onLog((entry: LogEntry) => {
      setLogs((prev) => {
        const next = [...prev, entry]
        if (next.length > 800) next.shift()
        return next
      })
    })

    return () => { if (unsub) unsub() }
  }, [])

  // Mantener pegado al final solo si ya estaba abajo (no robar el scroll al leer historia).
  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
  }
  useEffect(() => {
    if (stickBottom.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [logs, filter, query])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return logs.filter((e) => {
      if (filter === 'errors' && e.level !== 'error') return false
      if (filter === 'normal' && e.level === 'debug') return false
      if (q && !e.text.toLowerCase().includes(q)) return false
      return true
    })
  }, [logs, filter, query])

  const counts = useMemo(() => {
    const c = { all: logs.length, normal: 0, errors: 0 }
    for (const e of logs) {
      if (e.level === 'error') c.errors += 1
      else if (e.level !== 'debug') c.normal += 1
    }
    return c
  }, [logs])

  const FilterBtn = ({ f, label, n }: { f: LevelFilter; label: string; n: number }) => (
    <button
      className={`px-2.5 py-1 max-sm:min-h-[44px] rounded-md text-[11px] font-semibold transition-colors ${
        filter === f ? 'bg-accent text-white' : 'text-text-muted hover:bg-bg-input hover:text-text-heading'
      }`}
      onClick={() => setFilter(f)}
    >
      {label} <span className={`${filter === f ? 'text-white/80' : 'text-text-muted/60'}`}>{n}</span>
    </button>
  )

  return (
    <div className="flex flex-col h-full">
      {/* Header con filtros */}
      <div className="flex flex-wrap items-center gap-2 pb-2 border-b border-border/50 px-1">
        <h3 className="text-sm font-bold text-text-muted uppercase tracking-wider mr-1">{t.logs.title}</h3>
        <input
          className="input-field w-full sm:w-48 py-1 text-xs"
          placeholder={t.logs.search}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="flex items-center gap-1 ml-auto">
          <FilterBtn f="all" label={t.logs.filterAll} n={counts.all} />
          <FilterBtn f="normal" label={t.logs.filterNormal} n={counts.normal} />
          <FilterBtn f="errors" label={t.logs.filterErrors} n={counts.errors} />
          <button
            className="btn border border-border text-xs px-2 py-1 hover:border-danger hover:text-danger"
            onClick={() => setLogs([])}
          >
            {t.logs.clear}
          </button>
        </div>
      </div>

      {/* Líneas de log */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex-1 overflow-auto mt-2 space-y-px font-mono text-[11px] leading-relaxed bg-bg-input/40 rounded-lg p-2"
      >
        {visible.length === 0 && (
          <div className="text-text-muted opacity-60 pt-6 text-center">{t.logs.empty}</div>
        )}
        {visible.map((entry, i) => {
          const { tag, rest } = splitTag(entry.text)
          return (
            <div key={`${entry.ts}-${i}`} className="flex gap-2 items-baseline break-all">
              <span className="text-text-muted/50 shrink-0 tabular-nums">{entry.ts}</span>
              <span className={`${tagClass(entry.text)} shrink-0 font-bold`}>{tag}</span>
              <span className={LEVEL_COLORS[entry.level] || 'text-text-main'}>{rest}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

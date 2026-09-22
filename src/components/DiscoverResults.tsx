import { useState } from 'react'
import { useDiscoverStore, type DiscoverResult } from '../store/discoverTabs'
import { api } from '../hooks/useApi'

type MediaType = 'movie' | 'series'

// Default media type for a result card, guessed from the release title.
// The user can always flip it per card before clicking download.
function detectType(title: string | null): MediaType {
  const t = (title || '').toLowerCase()
  if (/\bs\d{1,2}\s*e\d{1,2}\b/.test(t)) return 'series' // S01E01
  if (/\bseason\s+\d+\b/.test(t)) return 'series' // "Season 2"
  if (/\b\d{1,2}x\d{1,2}\b/.test(t)) return 'series' // 1x01
  if (/\bcap[íi]tulo\b|\bcap\s*\d+\b/.test(t)) return 'series' // "Cap.305"
  if (/\b(temporada|complete series|serie completa)\b/.test(t)) return 'series'
  return 'movie'
}

function buildMagnetFromHash(infoHash: string, title: string | null): string {
  let magnet = `magnet:?xt=urn:btih:${infoHash}`
  if (title) magnet += `&dn=${encodeURIComponent(title)}`
  return magnet
}

async function handleDownload(
  r: DiscoverResult,
  type: MediaType,
  onAdded: () => void,
  showToast: (msg: string, type?: 'success' | 'error') => void,
  service: string,
) {
  const link = r.link
  const trErr = (msg: string) => {
    if (/infringing.file/i.test(msg)) return 'Eliminado por Copyright'
    return msg
  }

  if (link && link.startsWith('magnet:')) {
    try {
      const res = await api<{ success: boolean; detail?: string }>('/downloads/add', 'POST', {
        magnet: link,
        info_hash: r.info_hash,
        service,
        type,
      })
      if (res.success) { showToast('Descarga agregada', 'success'); onAdded() }
      else { showToast(`Error: ${trErr((res as any).detail || (res as any).error || 'Unknown')}`, 'error') }
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : 'Error al descargar', 'error')
    }
    return
  }

  if (link && link.endsWith('.torrent')) {
    try {
      const res = await api<{ success: boolean; detail?: string }>('/downloads/add-torrent-url', 'POST', { url: link, service, type })
      if (res.success) { showToast('Descarga agregada', 'success'); onAdded() }
      else { showToast(`Error: ${trErr((res as any).detail || (res as any).error || 'Unknown')}`, 'error') }
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : 'Error al descargar', 'error')
    }
    return
  }

  if (r.info_hash) {
    const magnet = buildMagnetFromHash(r.info_hash, r.title)
    try {
      const res = await api<{ success: boolean; detail?: string }>('/downloads/add', 'POST', {
        magnet,
        info_hash: r.info_hash,
        service,
        type,
      })
      if (res.success) { showToast('Descarga agregada', 'success'); onAdded() }
      else { showToast(`Error: ${trErr((res as any).detail || (res as any).error || 'Unknown')}`, 'error') }
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : 'Error al descargar', 'error')
    }
    return
  }

  // Debrid direct URLs
  if (link && link.startsWith('http')) {
    try {
      const res = await api<{ success: boolean; detail?: string }>('/downloads/add-torrent-url', 'POST', { url: link, service, type })
      if (res.success) { showToast('Descarga agregada', 'success'); onAdded() }
      else { showToast(`Error: ${trErr((res as any).detail || (res as any).error || 'Unknown')}`, 'error') }
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : 'Error al descargar', 'error')
    }
    return
  }

  showToast('Sin enlace directo', 'error')
}

function TypeToggle({ value, onChange }: { value: MediaType; onChange: (t: MediaType) => void }) {
  const btn = (label: string, val: MediaType) => (
    <button
      type="button"
      key={val}
      onClick={() => onChange(val)}
      className={`px-2 py-0.5 rounded text-[11px] font-medium border transition-colors whitespace-nowrap ${
        value === val
          ? 'bg-accent/20 border-accent text-accent'
          : 'bg-transparent border-border text-text-dim hover:text-text hover:border-text-dim'
      }`}
      title={val === 'movie' ? 'Save as movie (Jellyfin movies folder)' : 'Save as series (Jellyfin TV folder)'}
    >
      {label}
    </button>
  )
  return (
    <div className="flex gap-1">
      {btn('Movie', 'movie')}
      {btn('Series', 'series')}
    </div>
  )
}

function ProviderBadge({ provider }: { provider?: string }) {
  if (!provider) return null
  const latino = ['TCL', 'Cinecalidad', 'Comet'].includes(provider)
  return (
    <span
      className={`text-[10px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wider shrink-0 ${
        latino ? 'bg-accent/20 text-accent border border-accent/40' : 'bg-bg-deep text-text-muted border border-border'
      }`}
      title={latino ? 'Proveedor latino' : provider}
    >
      {provider}
    </span>
  )
}

interface Props {
  onDownloadAdded: () => void
  showToast: (msg: string, type?: 'success' | 'error') => void
  service: string
  hasTorbox: boolean
  hasRealdebrid: boolean
}

export function DiscoverResults({ onDownloadAdded, showToast, service: defaultService, hasTorbox, hasRealdebrid }: Props) {
  const { providerResults, providerLoading, currentProvider } = useDiscoverStore()
  const [downloadService, setDownloadService] = useState(defaultService || (hasTorbox ? 'torbox' : 'realdebrid'))

  const showServiceSelector = hasTorbox && hasRealdebrid

  if (providerLoading && !providerResults) {
    return (
      <div className="flex items-center gap-3 px-4 py-3 bg-bg-deep border border-accent/30 font-mono uppercase tracking-widest text-sm">
        <div className="w-4 h-4 border-2 border-bg-panel border-t-accent rounded-full animate-spin shrink-0" />
        {currentProvider ? (
          <span className="text-accent">
            Buscando en <span className="text-text-main">"{currentProvider}"</span>...
          </span>
        ) : (
          <span className="text-accent">Buscando resultados...</span>
        )}
      </div>
    )
  }

  if (!providerResults || providerResults.length === 0) {
    if (providerLoading) return null
    return (
      <div className="flex flex-col items-center justify-center text-text-muted font-mono uppercase tracking-widest gap-4 py-12">
        <span className="text-4xl opacity-50">🏜️</span>
        <p className="text-sm">Sin resultados</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {providerLoading && (
        <div className="flex items-center gap-3 px-4 py-2 bg-bg-deep border border-accent/30 font-mono uppercase tracking-widest text-xs">
          <div className="w-3 h-3 border-2 border-bg-panel border-t-accent rounded-full animate-spin shrink-0" />
          <span className="text-accent">
            {currentProvider
              ? `Buscando en "${currentProvider}"...`
              : 'Buscando...'}
          </span>
        </div>
      )}
      {providerResults.map((r, i) => (
        <ResultCard
          key={i}
          r={r}
          onDownloadAdded={onDownloadAdded}
          showToast={showToast}
          service={downloadService}
          showServiceSelector={showServiceSelector}
          onServiceChange={setDownloadService}
        />
      ))}
    </div>
  )
}

function ResultCard({
  r,
  onDownloadAdded,
  showToast,
  service,
  showServiceSelector,
  onServiceChange,
}: {
  r: DiscoverResult
  onDownloadAdded: () => void
  showToast: (msg: string, type?: 'success' | 'error') => void
  service: string
  showServiceSelector: boolean
  onServiceChange: (s: string) => void
}) {
  const [type, setType] = useState<MediaType>(() => detectType(r.title))
  return (
    <div className="glass-panel p-4 flex justify-between items-center transition-colors hover:border-accent">
      <div className="flex-1 overflow-hidden pr-4">
        <div className="font-bold text-text-heading truncate" title={r.title ?? ''}>{r.title}</div>
        <div className="flex gap-3 text-xs font-mono text-text-muted mt-2 uppercase tracking-wide items-center">
          {r.seeders >= 0 && <span className="text-success">S {r.seeders}</span>}
          {r.peers >= 0 && <span className="text-text-main">P {r.peers}</span>}
          <span>{r.size}</span>
          <span className="text-accent truncate">{r.indexer}</span>
          <span className="ml-auto flex items-center gap-2">
            <ProviderBadge provider={r.provider} />
            <TypeToggle value={type} onChange={setType} />
          </span>
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {showServiceSelector && (
          <select
            className="btn border border-border text-[10px] px-2 py-1 bg-bg-deep font-mono text-text-main"
            value={service}
            onChange={(e) => onServiceChange(e.target.value)}
          >
            <option value="torbox">TorBox</option>
            <option value="realdebrid">RD</option>
          </select>
        )}
        <button
          className="btn btn-accent whitespace-nowrap"
          onClick={() => handleDownload(r, type, onDownloadAdded, showToast, service)}
        >
          Descargar
        </button>
      </div>
    </div>
  )
}

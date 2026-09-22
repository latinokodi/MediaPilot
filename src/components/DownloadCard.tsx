import { useT } from '../i18n'
import { memo } from 'react'

interface Download {
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
}

type T = ReturnType<typeof useT>

interface Props {
  download: Download
  onDelete: (torboxId: string, isCompleted: boolean) => void
  onCancel: (torboxId: string) => void
}

function formatSpeed(bytesPerSec: number): string {
  if (!bytesPerSec) return '0 MB/s'
  if (bytesPerSec > 1024 * 1024 * 1024) return `${(bytesPerSec / 1024 / 1024 / 1024).toFixed(2)} GB/s`
  return `${(bytesPerSec / 1024 / 1024).toFixed(2)} MB/s`
}

/** Translate a raw status string (from RD/TorBox API or worker) to a human-readable label */
function translateStatus(value: string | undefined, t: T): string {
  if (!value) return ''
  const lower = value.toLowerCase()

  // Handle "Downloading X/Y..." and "Downloading X/Y (Z%)" worker messages
  const dlMatch = lower.match(/^downloading (\d+)\/(\d+)/)
  if (dlMatch) {
    const current = dlMatch[1]
    const total = dlMatch[2]
    return `${t.downloadCard.phases.downloading} ${current}/${total}`
  }

  // Handle "failed: message" → show translated "Failed" + original message
  if (lower.startsWith('failed')) {
    const msg = value.slice(6).trim()
    return msg ? `${t.downloadCard.phases.failed}: ${msg}` : t.downloadCard.phases.failed
  }

  // Handle "queued" (used by worker as local_status before download starts)
  if (lower === 'queued') return t.downloadCard.phases.queued

  // Look up known status keys in the phases dictionary
  const phases = t.downloadCard.phases as Record<string, string>
  if (phases[lower]) return phases[lower]

  // Fallback: capitalize the raw value
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function currentPhase(dl: Download, t: T) {
  const cloudState = (dl.status || '').toLowerCase()
  const localState = (dl.local_status || 'pending').toLowerCase()
  // RD uses 'downloaded', TorBox uses 'completed'/'cached'/'finished'
  const cloudDone = ['completed', 'cached', 'finished', 'downloaded'].includes(cloudState)
  const localDone = localState === 'completed'
  const localFailed = localState.startsWith('failed')

  if (localDone) return { label: t.downloadCard.complete, progress: 100, color: 'text-success' }
  if (localFailed) return { label: t.downloadCard.localFailed, progress: dl.local_progress ?? 0, color: 'text-danger' }
  if (cloudDone) return { label: translateStatus(dl.local_status, t) || t.downloadCard.pending, progress: dl.local_progress ?? 0, color: 'text-accent' }
  return { label: translateStatus(dl.status, t) || t.downloadCard.pending, progress: dl.progress ?? 0, color: 'text-text-main' }
}

function effectiveSpeed(download: Download): string {
  const cloudState = (download.status || '').toLowerCase()
  const localState = (download.local_status || 'pending').toLowerCase()
  // RD uses 'downloaded', TorBox uses 'completed'/'cached'/'finished'
  const cloudDone = ['completed', 'cached', 'finished', 'downloaded'].includes(cloudState)
  const localActive = localState.startsWith('downloading')

  if (cloudDone && localActive && download.local_speed) {
    return formatSpeed(download.local_speed)
  }
  return formatSpeed(download.download_speed ?? 0)
}

function isActive(download: Download): boolean {
  const cloudState = (download.status || '').toLowerCase()
  const localState = (download.local_status || 'pending').toLowerCase()
  // RD uses 'downloaded', TorBox uses 'completed'/'cached'/'finished'
  if (['completed', 'cached', 'finished', 'downloaded'].includes(cloudState) && localState === 'completed') return false
  if (localState.startsWith('failed')) return false
  return true
}

const DownloadCardComponent = function DownloadCard({ download: dl, onDelete, onCancel }: Props) {
  const t = useT()
  const phase = currentPhase(dl, t)
  const progress = Math.max(0, Math.min(100, Math.round(phase.progress)))
  const isComplete = dl.local_status?.toLowerCase() === 'completed'
  const active = isActive(dl)

  return (
    <article className="glass-panel p-4 relative flex flex-col gap-3 group queue-item">
      <div className="flex justify-between items-start pr-10 sm:pr-8">
        <div className="flex-1 overflow-hidden">
          <h3 className="text-sm font-bold text-text-heading truncate" title={dl.name}>{dl.name}</h3>
          <div className="flex gap-4 text-xs font-mono text-text-muted mt-1">
            <span>{t.downloadCard.seeds} {dl.seeds ?? 0}</span>
            <span>{effectiveSpeed(dl)}</span>
            {dl.local_eta && <span className="text-accent">{t.downloadCard.eta} {dl.local_eta}</span>}
            {dl.service && dl.service !== 'torbox' && (
              <span className="text-accent font-bold">{dl.service}</span>
            )}
          </div>
        </div>
      </div>
      
      {/* Cancel button — always visible for active downloads */}
      {active && (
        <button
          className="btn btn-warning absolute top-3 right-3 !p-1 !h-8 !w-8 text-xs font-bold"
          onClick={() => onCancel(dl.torbox_id)}
          title="Cancel download"
          aria-label="Cancel download"
        >
          ⏹
        </button>
      )}
      
      {/* Delete button — always visible for completed/failed */}
      {!active && (
        <button
          className="btn btn-danger absolute top-3 right-3 !p-1 !h-8 !w-8 text-xs font-bold"
          onClick={() => onDelete(dl.torbox_id, isComplete)}
          title="Remove download"
          aria-label="Remove download"
        >
          X
        </button>
      )}

      <div className="flex justify-between items-center text-xs font-mono font-bold uppercase tracking-widest mt-1">
        <span className={phase.color}>{phase.label}</span>
        <strong className={phase.color}>{progress}%</strong>
      </div>
      
      <div className="w-full h-1 bg-bg-deep border border-border overflow-hidden relative">
        <div className="h-full bg-accent transition-all duration-300" style={{ width: `${progress}%` }} />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs font-mono uppercase bg-bg-deep p-2 border border-border">
        <div>
          <span className="text-text-muted block text-[10px]">{t.downloadCard.cloud}</span>
          <strong className="text-accent">{translateStatus(dl.status, t) || t.downloadCard.pending}</strong>
        </div>
        <div>
          <span className="text-text-muted block text-[10px]">{t.downloadCard.local}</span>
          <strong className="truncate block" title={dl.local_status}>{translateStatus(dl.local_status, t) || t.downloadCard.pending}</strong>
        </div>
      </div>
    </article>
  )
}

export const DownloadCard = memo(DownloadCardComponent)

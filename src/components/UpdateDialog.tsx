import { useT } from '../i18n'

interface UpdateDialogProps {
  phase: 'available' | 'downloading' | 'downloaded' | null
  updateVersion: string | null
  updatePercent: number
  onDismiss: () => void
  onDownload: () => void
  onLater: () => void
  onRestart: () => void
}

export function UpdateDialog({ phase, updateVersion, updatePercent, onDismiss, onDownload, onLater, onRestart }: UpdateDialogProps) {
  const t = useT()

  if (!phase) return null

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-6 animate-fade-in">
      <div className="glass-panel w-full max-w-md bg-bg-panel border border-border shadow-2xl p-8 text-center space-y-6">
        {phase === 'available' && updateVersion && (
          <>
            <h3 className="text-accent font-mono text-sm uppercase tracking-widest">{t.update.available}</h3>
            <p className="text-2xl font-black text-text-heading">v{updateVersion}</p>
            <p className="text-text-muted font-mono text-sm">{t.update.currentVersion}</p>
            <div className="flex gap-4 justify-center">
              <button className="btn border border-border text-text-muted hover:text-text-main" onClick={onDismiss}>
                {t.update.notNow}
              </button>
              <button className="btn btn-accent" onClick={onDownload}>
                {t.update.download}
              </button>
            </div>
          </>
        )}

        {phase === 'downloading' && (
          <>
            <h3 className="text-accent font-mono text-sm uppercase tracking-widest">{t.update.downloading}</h3>
            <div className="w-full bg-bg-deep border border-border h-3">
              <div className="h-full bg-accent transition-all duration-300" style={{ width: `${updatePercent}%` }} />
            </div>
            <p className="text-text-muted font-mono text-sm">{updatePercent}%</p>
          </>
        )}

        {phase === 'downloaded' && (
          <>
            <h3 className="text-success font-mono text-sm uppercase tracking-widest">{t.update.ready}</h3>
            <div className="flex gap-4 justify-center">
              <button className="btn border border-border text-text-muted hover:text-text-main" onClick={onLater}>
                {t.update.later}
              </button>
              <button className="btn btn-accent" onClick={onRestart}>
                {t.update.restartNow}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

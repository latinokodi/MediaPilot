import { Magnet } from 'lucide-react'
import { useT } from '../i18n'
import { ServiceSelector } from './ServiceSelector'

interface MagnetBarProps {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  adding: boolean
  service: 'torbox' | 'realdebrid'
  onServiceChange: (service: 'torbox' | 'realdebrid') => void
  hasTorbox: boolean
  hasRealdebrid: boolean
  visible: boolean
}

export function MagnetBar({ value, onChange, onSubmit, adding, service, onServiceChange, hasTorbox, hasRealdebrid, visible }: MagnetBarProps) {
  const t = useT()
  if (!visible) return null

  const noServiceConfigured = !hasTorbox && !hasRealdebrid

  return (
    <form className="magnet-bar px-3 sm:px-6 py-3 bg-bg-deep border-b border-border flex flex-wrap gap-3 items-center" onSubmit={(e) => { e.preventDefault(); onSubmit() }}>
      <Magnet size={18} className="text-accent shrink-0" />
      <input
        type="text"
        className="input-field flex-1 min-w-0 text-sm font-mono"
        placeholder={t.magnetBar.placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={adding}
      />
      <button
        type="submit"
        className="btn btn-accent whitespace-nowrap font-mono text-xs"
        disabled={adding || !value.trim() || noServiceConfigured}
        title={noServiceConfigured ? t.magnetBar.noService : undefined}
      >
        {adding ? t.magnetBar.adding : t.magnetBar.addLink}
      </button>
      <ServiceSelector
        service={service}
        onChange={onServiceChange}
        hasTorbox={hasTorbox}
        hasRealdebrid={hasRealdebrid}
        disabled={adding}
      />
    </form>
  )
}

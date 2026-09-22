interface ServiceSelectorProps {
  service: 'torbox' | 'realdebrid'
  onChange: (service: 'torbox' | 'realdebrid') => void
  hasTorbox: boolean
  hasRealdebrid: boolean
  disabled?: boolean
}

export function ServiceSelector({ service, onChange, hasTorbox, hasRealdebrid, disabled }: ServiceSelectorProps) {
  if (!hasTorbox || !hasRealdebrid) return null

  return (
    <select
      className="btn border border-border text-xs px-2 bg-bg-deep font-mono text-text-main"
      value={service}
      onChange={(e) => onChange(e.target.value as 'torbox' | 'realdebrid')}
      disabled={disabled}
    >
      <option value="torbox">TorBox</option>
      <option value="realdebrid">Real-Debrid</option>
    </select>
  )
}

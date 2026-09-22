import { memo } from 'react'
import { Menu } from 'lucide-react'
import { useT } from '../i18n'

interface HeaderProps {
  activeCloud: number
  activeLocal: number
  /** Móvil: abre el cajón de navegación (oculto en ≥lg) */
  onMenuClick?: () => void
}

export const Header = memo(function Header({ activeCloud, activeLocal, onMenuClick }: HeaderProps) {
  const t = useT()

  return (
    <header className="border-b border-border px-3 py-3 sm:px-6 sm:py-5 bg-bg-panel flex items-center justify-between gap-3">
      <div className="flex items-center gap-2.5 min-w-0">
        <button
          className="lg:hidden w-[44px] h-[44px] -ml-1 rounded-lg border border-border flex items-center justify-center text-text-main hover:border-accent hover:text-accent transition-colors shrink-0"
          title={t.header.menu}
          aria-label={t.header.menu}
          onClick={onMenuClick}
        >
          <Menu size={19} />
        </button>
        <div className="min-w-0">
          <h1 className="text-[1.1rem] sm:text-[1.4rem] font-extrabold tracking-tight text-text-heading truncate">{t.header.title}</h1>
          <p className="hidden sm:block text-text-muted text-sm mt-0.5">{t.header.subtitle}</p>
        </div>
      </div>
      <div className="flex gap-3 sm:gap-6 text-xs font-semibold text-text-muted shrink-0">
        <div className="text-right">
          <div className="text-accent text-lg sm:text-2xl font-extrabold leading-tight">{activeCloud}</div>
          <div className="text-[10px] sm:text-xs leading-tight">{t.header.cloudActive}</div>
        </div>
        <div className="text-right">
          <div className="text-success text-lg sm:text-2xl font-extrabold leading-tight">{activeLocal}</div>
          <div className="text-[10px] sm:text-xs leading-tight">{t.header.localActive}</div>
        </div>
      </div>
    </header>
  )
})

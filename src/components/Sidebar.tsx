import { memo } from 'react'
import { LayoutDashboard, Search, BookMarked, DownloadCloud, Compass, ScrollText, Settings, Library, CalendarDays, X } from 'lucide-react'
import { useT } from '../i18n'
import { LangToggle } from '../i18n/LangToggle'

interface SidebarProps {
  activeNav: string
  onNavChange: (nav: string) => void
  onSettingsOpen: () => void
  downloadCount: number
  appVersion?: string
  /** Móvil: cajón abierto/cerrado (≥lg siempre visible) */
  open?: boolean
  onClose?: () => void
}

export const Sidebar = memo(function Sidebar({ activeNav, onNavChange, onSettingsOpen, downloadCount, appVersion, open = false, onClose }: SidebarProps) {
  const t = useT()

  // Navegar cierra el cajón en móvil (en escritorio es inocuo)
  const go = (nav: string) => {
    onNavChange(nav)
    onClose?.()
  }

  return (
    <aside
      className={`fixed inset-y-0 left-0 z-40 w-64 max-w-[85vw] border-r border-border bg-bg-panel flex flex-col transition-transform duration-200 ease-out lg:static lg:z-10 lg:translate-x-0 lg:max-w-none lg:transition-none ${
        open ? 'translate-x-0 shadow-2xl lg:shadow-none' : '-translate-x-full'
      }`}
    >
      {/* Brand — MediaPilot */}
      <div className="px-5 py-5 border-b border-border">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-accent flex items-center justify-center text-white shadow-sm shrink-0">
            <span className="translate-x-[0.5px]">▶</span>
          </div>
          <div className="leading-tight flex-1 min-w-0">
            <span className="font-extrabold tracking-tight text-[1.05rem] text-text-heading">Media<span className="text-accent">Pilot</span></span>
            <div className="text-[11px] text-text-muted font-medium">Auto downloader</div>
          </div>
          <button
            className="lg:hidden w-[44px] h-[44px] rounded-lg flex items-center justify-center text-text-muted hover:text-text-heading hover:bg-bg-input transition-colors shrink-0"
            title={t.header.closeMenu}
            aria-label={t.header.closeMenu}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>
        {appVersion && <span className="text-[11px] text-text-muted mt-2 block">v{appVersion}</span>}
      </div>

      {/* Nav items */}
      <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
        <NavItem icon={<LayoutDashboard size={16} />} label={t.nav.dashboard} active={activeNav === 'dashboard'} onClick={() => go('dashboard')} />
        <NavItem icon={<Search size={16} />} label={t.nav.search} active={activeNav === 'search'} onClick={() => go('search')} />
        <NavItem icon={<Compass size={16} />} label={t.nav.discover} active={activeNav === 'discover'} onClick={() => go('discover')} />
        <NavItem icon={<BookMarked size={16} />} label={t.nav.watchlist} active={activeNav === 'watchlist'} onClick={() => go('watchlist')} />
        <NavItem icon={<Library size={16} />} label={t.nav.library} active={activeNav === 'library'} onClick={() => go('library')} />
        <NavItem icon={<CalendarDays size={16} />} label={t.nav.calendar} active={activeNav === 'calendar'} onClick={() => go('calendar')} />
        <NavItem
          icon={<DownloadCloud size={16} />}
          label={t.nav.downloads}
          active={activeNav === 'downloads'}
          onClick={() => go('downloads')}
          badge={downloadCount > 0 ? downloadCount : undefined}
        />
        <NavItem icon={<ScrollText size={16} />} label={t.nav.logs} active={activeNav === 'logs'} onClick={() => go('logs')} />
      </nav>

      {/* Bottom actions */}
      <div className="p-4 border-t border-border space-y-2">
        <LangToggle />
        <button className="w-full btn btn-accent" onClick={onSettingsOpen}>
          <Settings size={14} /> {t.nav.settings}
        </button>
      </div>
    </aside>
  )
})

function NavItem({ icon, label, active, onClick, badge }: { icon: React.ReactNode; label: string; active: boolean; onClick: () => void; badge?: number }) {
  return (
    <button
      className={`w-full text-left px-3.5 py-3 lg:py-2.5 rounded-lg flex items-center gap-2.5 text-[0.85rem] font-semibold transition-colors ${
        active ? 'bg-accent-soft text-accent' : 'text-text-muted hover:text-text-heading hover:bg-white'
      }`}
      onClick={onClick}
    >
      {icon}
      <span className="flex-1">{label}</span>
      {badge !== undefined && (
        <span className="bg-accent text-white px-2 py-0.5 text-[11px] font-bold rounded-full">{badge}</span>
      )}
    </button>
  )
}

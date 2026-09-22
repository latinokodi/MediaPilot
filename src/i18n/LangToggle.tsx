import { useLang } from './index'

export function LangToggle() {
  const { lang, toggleLang } = useLang()

  return (
    <button
      onClick={toggleLang}
      className="btn border border-border text-xs px-2 py-1 font-mono text-text-muted hover:border-accent hover:text-accent transition-colors"
      title={lang === 'es' ? 'Switch to English' : 'Cambiar a Español'}
    >
      {lang === 'es' ? '🇺🇸 EN' : '🇲🇽 ES'}
    </button>
  )
}

import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react'
import en from './en'
import es from './es'

export type Lang = 'en' | 'es'

const translations: Record<Lang, typeof en> = { en, es }
const STORAGE_KEY = 'tordownloader-lang'

interface I18nContextType {
  lang: Lang
  t: typeof en
  setLang: (lang: Lang) => void
  toggleLang: () => void
}

const I18nContext = createContext<I18nContextType>({
  lang: 'es',
  t: es,
  setLang: () => {},
  toggleLang: () => {},
})

function loadLang(): Lang {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'en' || stored === 'es') return stored
  } catch {}
  return 'es' // default to Spanish
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(loadLang)

  const setLang = useCallback((l: Lang) => {
    setLangState(l)
    try { localStorage.setItem(STORAGE_KEY, l) } catch {}
  }, [])

  const toggleLang = useCallback(() => {
    setLang(lang === 'es' ? 'en' : 'es')
  }, [lang, setLang])

  useEffect(() => {
    document.documentElement.lang = lang
  }, [lang])

  return (
    <I18nContext.Provider value={{ lang, t: translations[lang], setLang, toggleLang }}>
      {children}
    </I18nContext.Provider>
  )
}

export function useT() {
  return useContext(I18nContext).t
}

export function useLang() {
  const { lang, setLang, toggleLang } = useContext(I18nContext)
  return { lang, setLang, toggleLang }
}

/** Translate known API error messages (e.g. RD "Infringing file" → "Eliminado por Copyright") */
export function translateError(message: string, lang: Lang): string {
  const lower = message.toLowerCase()
  if (lower.includes('infringing file') || lower.includes('infringing_file')) {
    return lang === 'es' ? 'Eliminado por Copyright' : 'Infringing File'
  }
  return message
}

/** Hook: returns a function that translates error messages using the current language */
export function useTranslateError() {
  const { lang } = useContext(I18nContext)
  return (message: string) => translateError(message, lang)
}

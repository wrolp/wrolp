import React, { createContext, useContext, useEffect, useState, useCallback } from 'react'
import en, { type TranslationKey } from './en'
import zh from './zh'

export type Lang = 'en' | 'zh'

const DICTS: Record<Lang, Partial<Record<TranslationKey, string>>> = { en, zh }

const STORAGE_KEY = 'wrolp-lang'

// Module-level current language so `t()` works outside React (e.g. in plain
// modules) without a hook. React consumers re-render via I18nContext.
let currentLang: Lang = detectInitialLang()
const listeners = new Set<() => void>()

function detectInitialLang(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === 'en' || saved === 'zh') return saved
  } catch {
    /* ignore */
  }
  const nav = (typeof navigator !== 'undefined' && navigator.language) || ''
  return nav.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

export function getLang(): Lang {
  return currentLang
}

export function setLang(lang: Lang): void {
  if (lang === currentLang) return
  currentLang = lang
  try {
    localStorage.setItem(STORAGE_KEY, lang)
  } catch {
    /* ignore */
  }
  document.documentElement.lang = lang
  listeners.forEach((fn) => fn())
}

export const LANG_LABELS: Record<Lang, string> = { en: 'English', zh: '中文' }

type Params = Record<string, string | number>

// Translate a key into the active language, falling back to English then to the
// key itself. Supports `{name}` interpolation from params.
export function t(key: TranslationKey, params?: Params): string {
  const dict = DICTS[currentLang]
  let str = dict[key] ?? en[key] ?? key
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v))
    }
  }
  return str
}

interface I18nContextValue {
  lang: Lang
  setLang: (lang: Lang) => void
  t: (key: TranslationKey, params?: Params) => string
}

const I18nContext = createContext<I18nContextValue | null>(null)

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>(currentLang)

  useEffect(() => {
    const onChange = () => setLangState(currentLang)
    listeners.add(onChange)
    document.documentElement.lang = currentLang
    return () => {
      listeners.delete(onChange)
    }
  }, [])

  const changeLang = useCallback((l: Lang) => setLang(l), [])

  const value: I18nContextValue = {
    lang,
    setLang: changeLang,
    t: (key, params) => t(key, params),
  }

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

// React hook for components that need reactive translation + language state.
export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext)
  if (!ctx) {
    // Safe fallback when used outside a provider (e.g. in tests).
    return { lang: currentLang, setLang, t: (key, params) => t(key, params) }
  }
  return ctx
}

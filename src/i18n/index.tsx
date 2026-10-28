import React, { createContext, useContext, useEffect, useState, useCallback } from 'react'
import en, { type TranslationKey } from './en'
import zh from './zh'

export type Lang = 'en' | 'zh'
/** What the user picked: an exact language, or the OS/webview locale. */
export type LangPref = 'system' | Lang

const DICTS: Record<Lang, Partial<Record<TranslationKey, string>>> = { en, zh }

const STORAGE_KEY = 'wrolp-lang'

function systemLang(): Lang {
  if (typeof navigator === 'undefined') return 'en'
  const tags = navigator.languages?.length ? navigator.languages : [navigator.language]
  return tags.some((tag) => (tag ?? '').toLowerCase().startsWith('zh')) ? 'zh' : 'en'
}

function readPref(): LangPref {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === 'system' || saved === 'en' || saved === 'zh') return saved
  } catch {
    /* ignore */
  }
  return 'system'
}

// Module-level current language so `t()` works outside React (e.g. in plain
// modules) without a hook. React consumers re-render via I18nContext.
let langPref: LangPref = readPref()
let currentLang: Lang = langPref === 'system' ? systemLang() : langPref
const listeners = new Set<() => void>()

export function getLang(): Lang {
  return currentLang
}

export function getLangPref(): LangPref {
  return langPref
}

export function setLang(pref: LangPref): void {
  const previousPref = langPref
  langPref = pref
  try {
    localStorage.setItem(STORAGE_KEY, pref)
  } catch {
    /* ignore */
  }
  const next = pref === 'system' ? systemLang() : pref
  if (next === currentLang && pref === previousPref) return
  currentLang = next
  document.documentElement.lang = next
  listeners.forEach((fn) => fn())
}

/** Re-resolve a `system` preference after the webview locale changes. */
export function refreshSystemLang(): void {
  if (langPref !== 'system') return
  const next = systemLang()
  if (next === currentLang) return
  currentLang = next
  document.documentElement.lang = next
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
  langPref: LangPref
  setLang: (pref: LangPref) => void
  t: (key: TranslationKey, params?: Params) => string
}

const I18nContext = createContext<I18nContextValue | null>(null)

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>(currentLang)
  const [langPref, setPrefState] = useState<LangPref>(getLangPref())

  useEffect(() => {
    const onChange = () => {
      setLangState(currentLang)
      setPrefState(getLangPref())
    }
    listeners.add(onChange)
    document.documentElement.lang = currentLang
    const onSystemLanguage = () => refreshSystemLang()
    window.addEventListener('languagechange', onSystemLanguage)
    return () => {
      listeners.delete(onChange)
      window.removeEventListener('languagechange', onSystemLanguage)
    }
  }, [])

  const changeLang = useCallback((pref: LangPref) => setLang(pref), [])

  const value: I18nContextValue = {
    lang,
    langPref,
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
    return { lang: currentLang, langPref, setLang, t: (key, params) => t(key, params) }
  }
  return ctx
}

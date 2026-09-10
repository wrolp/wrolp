// localStorage-backed store for the terminal output-highlight settings.
// Precedent: `wrolp-maxScrollback` / `wrolp-lang` also live in localStorage —
// no Rust/window.json involvement for display-only preferences.

import { cloneDefaultConfig, sanitizeConfig, type HighlightConfig } from './highlightRules'

const STORAGE_KEY = 'wrolp-terminal-highlight'

type Listener = (cfg: HighlightConfig) => void
const listeners = new Set<Listener>()

function emit(cfg: HighlightConfig): void {
  for (const l of [...listeners]) l(cfg)
}

export const highlightStore = {
  load(): HighlightConfig {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      return raw ? sanitizeConfig(JSON.parse(raw)) : cloneDefaultConfig()
    } catch {
      return cloneDefaultConfig()
    }
  },
  /** Persist, then notify every live terminal + the settings page. */
  save(cfg: HighlightConfig): HighlightConfig {
    const c = sanitizeConfig(cfg)
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(c))
    } catch {
      // Storage full/unavailable — keep running with in-memory settings only.
    }
    emit(c)
    return c
  },
  subscribe(fn: Listener): () => void {
    listeners.add(fn)
    return () => {
      listeners.delete(fn)
    }
  },
}

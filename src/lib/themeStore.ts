// Theme preference store + `<html data-theme>` applier.
//
// Precedent: display-only preferences live in localStorage and never touch
// window.json / Rust (see the header comment of src/lib/highlightStore.ts).
//
// Two independent choices are stored:
//   `wrolp-theme`            -> 'system' | 'dark' | 'light'   (UI theme, default: system)
//   `wrolp-terminal-palette` -> 'follow' | 'dark' | 'light'   (terminal palette, default: follow)
//
// The terminal palette is deliberately decoupled from the UI theme so users can
// keep a dark terminal under a light UI (the common terminal-app preference).
//
// Switching is a single attribute flip on <html>; SCSS reads the tokens emitted by
// `:root` / `html[data-theme='light']` (src/styles/index.scss), so no React
// re-render is needed for CSS. Components that paint outside CSS (xterm, Monaco)
// subscribe to this store and re-apply their own theme.

import { useSyncExternalStore } from 'react'

export type ThemeMode = 'system' | 'dark' | 'light'
/** The theme actually in effect after resolving `system`. */
export type ResolvedTheme = 'dark' | 'light'
export type TerminalPalette = 'follow' | 'dark' | 'light'

const THEME_KEY = 'wrolp-theme'
const PALETTE_KEY = 'wrolp-terminal-palette'
const DARK_MQ = '(prefers-color-scheme: dark)'

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Storage unavailable (private mode / quota) — keep running with in-memory state.
  }
}

function readMode(): ThemeMode {
  const v = read(THEME_KEY)
  return v === 'dark' || v === 'light' || v === 'system' ? v : 'system'
}

function readPalette(): TerminalPalette {
  const v = read(PALETTE_KEY)
  return v === 'dark' || v === 'light' || v === 'follow' ? v : 'follow'
}

function systemPrefersDark(): boolean {
  try {
    return window.matchMedia(DARK_MQ).matches
  } catch {
    // No matchMedia (tests / very old runtime): keep the historical dark default.
    return true
  }
}

function resolve(mode: ThemeMode): ResolvedTheme {
  if (mode === 'system') return systemPrefersDark() ? 'dark' : 'light'
  return mode
}

let mode: ThemeMode = readMode()
let palette: TerminalPalette = readPalette()
let resolved: ResolvedTheme = resolve(mode)

type Snapshot = { mode: ThemeMode; resolved: ResolvedTheme; palette: TerminalPalette }
let snapshot: Snapshot = { mode, resolved, palette }

const listeners = new Set<() => void>()

function emit(): void {
  snapshot = { mode, resolved, palette }
  for (const fn of [...listeners]) fn()
}

function apply(): void {
  const el = document.documentElement
  // Written even for 'dark' (no rule targets it) so the current state is
  // inspectable from devtools and assertable from e2e tests.
  el.dataset.theme = resolved
  // Makes native form controls, the default scrollbar and the WebView backdrop
  // follow the theme instead of staying light-on-light / dark-on-dark.
  el.style.colorScheme = resolved
}

/**
 * Apply the persisted theme and start following the OS setting. Call once, as
 * early as possible (main.tsx, before the first render) so there is no dark
 * flash of an otherwise-light UI.
 */
export function initTheme(): void {
  apply()
  try {
    window.matchMedia(DARK_MQ).addEventListener('change', () => {
      if (mode !== 'system') return
      resolved = resolve(mode)
      apply()
      emit()
    })
  } catch {
    // matchMedia unavailable — a fixed theme still works.
  }
}

export function getThemeMode(): ThemeMode {
  return mode
}

export function getResolvedTheme(): ResolvedTheme {
  return resolved
}

export function getTerminalPalette(): TerminalPalette {
  return palette
}

/** Theme the *terminal* should render in, after applying the palette preference. */
export function getTerminalTheme(): ResolvedTheme {
  return palette === 'follow' ? resolved : palette
}

export function setThemeMode(next: ThemeMode): void {
  if (next === mode) return
  mode = next
  write(THEME_KEY, next)
  resolved = resolve(mode)
  apply()
  emit()
}

export function setTerminalPalette(next: TerminalPalette): void {
  if (next === palette) return
  palette = next
  write(PALETTE_KEY, next)
  emit()
}

/** Subscribe to ANY theme-affecting change (mode, resolved theme, palette). */
export function subscribeTheme(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

function getSnapshot(): Snapshot {
  return snapshot
}

/** React binding for the settings page. */
export function useTheme(): Snapshot & {
  setThemeMode: (m: ThemeMode) => void
  setTerminalPalette: (p: TerminalPalette) => void
} {
  useSyncExternalStore(subscribeTheme, getSnapshot, getSnapshot)
  return {
    mode: snapshot.mode,
    resolved: snapshot.resolved,
    palette: snapshot.palette,
    setThemeMode,
    setTerminalPalette,
  }
}

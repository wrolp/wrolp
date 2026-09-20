// Theme preference store + `<html data-theme>` applier.
//
// Precedent: display-only preferences live in localStorage and never touch
// window.json / Rust (see the header comment of src/lib/highlightStore.ts).
//
// Three independent choices are stored:
//   `wrolp-theme`            -> 'system' | 'dark' | 'light'   (UI theme, default: system)
//   `wrolp-terminal-palette` -> 'follow' | 'dark' | 'light'   (terminal palette, default: follow)
//   `wrolp-accent`           -> 'default' | '#rrggbb'         (UI accent, default: default)
//   `wrolp-density`          -> 'default' | 'compact' | 'comfy'
//
// The terminal palette is deliberately decoupled from the UI theme so users can
// keep a dark terminal under a light UI (the common terminal-app preference).
//
// Switching is a single attribute flip on <html>; SCSS reads the tokens emitted by
// `:root` / `html[data-theme='light']` (src/styles/index.scss), so no React
// re-render is needed for CSS. Components that paint outside CSS (xterm, Monaco)
// subscribe to this store and re-apply their own theme.
//
// A custom accent is the one choice the theme tables cannot express, so it is
// written as inline custom properties overriding `--accent` and its derived
// shades. 'default' removes them and the CSS from _theme.scss applies untouched.

import { useSyncExternalStore } from 'react'
import { accentOverrides } from './themeColors'

export type ThemeMode = 'system' | 'dark' | 'light'
/** The theme actually in effect after resolving `system`. */
export type ResolvedTheme = 'dark' | 'light'
export type TerminalPalette = 'follow' | 'dark' | 'light'
/** `'default'` keeps the theme table's accent; anything else is a `#rrggbb`. */
export type AccentChoice = string
export type Density = 'default' | 'compact' | 'comfy'

const THEME_KEY = 'wrolp-theme'
const PALETTE_KEY = 'wrolp-terminal-palette'
const ACCENT_KEY = 'wrolp-accent'
const DENSITY_KEY = 'wrolp-density'
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

function readAccent(): AccentChoice {
  const v = read(ACCENT_KEY)
  return v && /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : 'default'
}

function readDensity(): Density {
  const v = read(DENSITY_KEY)
  return v === 'compact' || v === 'comfy' ? v : 'default'
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
let accent: AccentChoice = readAccent()
let density: Density = readDensity()
let resolved: ResolvedTheme = resolve(mode)

type Snapshot = {
  mode: ThemeMode
  resolved: ResolvedTheme
  palette: TerminalPalette
  accent: AccentChoice
  density: Density
}
let snapshot: Snapshot = { mode, resolved, palette, accent, density }

const listeners = new Set<() => void>()

function emit(): void {
  snapshot = { mode, resolved, palette, accent, density }
  for (const fn of [...listeners]) fn()
}

/** The `--accent` family keys a custom accent owns; cleared when reverting. */
const ACCENT_PROPS = [
  '--accent',
  '--accent-hover',
  '--accent-l8',
  '--accent-l12',
  '--accent-l14',
  '--accent-soft-40',
  '--text-on-accent',
] as const

function apply(): void {
  const el = document.documentElement
  // Written even for 'dark' (no rule targets it) so the current state is
  // inspectable from devtools and assertable from e2e tests.
  el.dataset.theme = resolved
  // Makes native form controls, the default scrollbar and the WebView backdrop
  // follow the theme instead of staying light-on-light / dark-on-dark.
  el.style.colorScheme = resolved
  el.dataset.density = density
  if (accent === 'default') {
    for (const prop of ACCENT_PROPS) el.style.removeProperty(prop)
  } else {
    // Recomputed per theme, not just per pick: hover and the derived shades lift
    // the accent on dark and press it down on light.
    for (const [prop, value] of Object.entries(accentOverrides(accent, resolved === 'dark'))) {
      el.style.setProperty(prop, value)
    }
  }
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

export function getAccent(): AccentChoice {
  return accent
}

export function getDensity(): Density {
  return density
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

/** `'default'` restores the theme table's accent; anything else must be `#rrggbb`. */
export function setAccent(next: AccentChoice): void {
  const normalized = next === 'default' || /^#[0-9a-fA-F]{6}$/.test(next) ? next : 'default'
  if (normalized === accent) return
  accent = normalized === 'default' ? 'default' : normalized.toLowerCase()
  write(ACCENT_KEY, accent)
  apply()
  emit()
}

export function setDensity(next: Density): void {
  if (next === density) return
  density = next
  write(DENSITY_KEY, next)
  apply()
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
  setAccent: (a: AccentChoice) => void
  setDensity: (d: Density) => void
} {
  useSyncExternalStore(subscribeTheme, getSnapshot, getSnapshot)
  return {
    mode: snapshot.mode,
    resolved: snapshot.resolved,
    palette: snapshot.palette,
    accent: snapshot.accent,
    density: snapshot.density,
    setThemeMode,
    setTerminalPalette,
    setAccent,
    setDensity,
  }
}

// Theme preference store + `<html data-theme>` applier.
//
// Precedent: display-only preferences live in localStorage and never touch
// window.json / Rust (see the header comment of src/lib/highlightStore.ts).
//
// The stored choices, all independent of each other:
//   `wrolp-theme`            -> 'system' | 'dark' | 'light'   (UI theme, default: system)
//   `wrolp-terminal-palette` -> 'follow' | 'dark' | 'light'   (terminal palette, default: follow)
//   `wrolp-accent`           -> 'default' | '#rrggbb'         (UI accent, default: default)
//   `wrolp-density`          -> 'default' | 'compact' | 'comfy'
//   `wrolp-ui-font-size`     -> 11 | … | 15 (half-pixel steps, default: 12.5)
//   `wrolp-motion`           -> 'system' | 'on' | 'off'       (default: system)
//   `wrolp-focus-ring`       -> 'on' | 'off'                  (default: on)
//   `wrolp-status-shapes`    -> 'on' | 'off'                  (default: on)
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
//
// Density / motion / focus ring / status shapes are each one `<html data-*>`
// attribute, read back by `html[data-…]` selectors in src/styles. The UI font size
// joins the accent as an inline custom property (`--fs-ui`) for the same reason:
// the number is the user's, not the table's, and at the default value the property
// is removed rather than restated so `:root` keeps owning it.

import { useSyncExternalStore } from 'react'
import { accentOverrides } from './themeColors'

export type ThemeMode = 'system' | 'dark' | 'light'
/** The theme actually in effect after resolving `system`. */
export type ResolvedTheme = 'dark' | 'light'
export type TerminalPalette = 'follow' | 'dark' | 'light'
/** `'default'` keeps the theme table's accent; anything else is a `#rrggbb`. */
export type AccentChoice = string
export type Density = 'default' | 'compact' | 'comfy'
/** `'system'` leaves the decision to the OS `prefers-reduced-motion`; `'on'`
 *  keeps motion even when the OS asks for reduce; `'off'` removes it regardless. */
export type Motion = 'system' | 'on' | 'off'
/** A plain two-state appearance switch, stored as `'on' | 'off'` (default `'on'`). */
export type SwitchState = 'on' | 'off'

const THEME_KEY = 'wrolp-theme'
const PALETTE_KEY = 'wrolp-terminal-palette'
const ACCENT_KEY = 'wrolp-accent'
const DENSITY_KEY = 'wrolp-density'
const UI_FONT_SIZE_KEY = 'wrolp-ui-font-size'
const MOTION_KEY = 'wrolp-motion'
const FOCUS_RING_KEY = 'wrolp-focus-ring'
const STATUS_SHAPES_KEY = 'wrolp-status-shapes'
const DARK_MQ = '(prefers-color-scheme: dark)'

/**
 * The UI font size knob. `base` is the JS mirror of `ui:` in
 * `src/styles/_layout.scss` — Sass cannot read TypeScript, so the number lives in
 * both places by necessity; move one, move the other. `step` has to allow half
 * pixels or the out-of-box 12.5 is not a representable slider value.
 */
export const UI_FONT_SIZE = { base: 12.5, min: 11, max: 15, step: 0.5 } as const

/**
 * Column widths that belong to a density, in px. Deliberately *not* CSS tokens:
 * the two columns are user-draggable and persisted in `layout.json`, so a
 * `--w-nav` with no inline writer would be a token without a reader. The settings
 * page uses this table to move a column that is still sitting on the other
 * density's default, and leaves any width the user dragged alone.
 */
export const DENSITY_WIDTHS: Record<'compact' | 'comfy', { nav: number; inspector: number }> = {
  compact: { nav: 260, inspector: 308 },
  comfy: { nav: 276, inspector: 344 },
}

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

function readUiFontSize(): number {
  const v = Number(read(UI_FONT_SIZE_KEY))
  return v >= UI_FONT_SIZE.min && v <= UI_FONT_SIZE.max ? v : UI_FONT_SIZE.base
}

function readMotion(): Motion {
  const v = read(MOTION_KEY)
  return v === 'on' || v === 'off' ? v : 'system'
}

// Both switches are on unless something explicitly stored 'off', so a corrupt or
// hand-edited value restores the accessible default instead of silently disabling it.
function readSwitch(key: string): SwitchState {
  return read(key) === 'off' ? 'off' : 'on'
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
let uiFontSize: number = readUiFontSize()
/** What localStorage actually holds. `uiFontSize` is the value on screen, which
 *  `previewUiFontSize` may have moved ahead of this during a slider drag. */
let uiFontSizeSaved = uiFontSize
let motion: Motion = readMotion()
let focusRing: SwitchState = readSwitch(FOCUS_RING_KEY)
let statusShapes: SwitchState = readSwitch(STATUS_SHAPES_KEY)
let resolved: ResolvedTheme = resolve(mode)

type Snapshot = {
  mode: ThemeMode
  resolved: ResolvedTheme
  palette: TerminalPalette
  accent: AccentChoice
  density: Density
  uiFontSize: number
  motion: Motion
  focusRing: SwitchState
  statusShapes: SwitchState
}
let snapshot: Snapshot = {
  mode,
  resolved,
  palette,
  accent,
  density,
  uiFontSize,
  motion,
  focusRing,
  statusShapes,
}

const listeners = new Set<() => void>()

function emit(): void {
  snapshot = {
    mode,
    resolved,
    palette,
    accent,
    density,
    uiFontSize,
    motion,
    focusRing,
    statusShapes,
  }
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
  el.dataset.motion = motion
  el.dataset.focusRing = focusRing
  el.dataset.statusShapes = statusShapes
  // Only the non-default size is written, so `:root` keeps owning the out-of-box
  // value — same discipline as the 'default' accent branch below. It has to be an
  // inline property rather than a token restatement because `--fs-xs … --fs-xl`
  // derive from `--fs-ui` on this very element, and the override wins at
  // computed-value time.
  if (uiFontSize === UI_FONT_SIZE.base) {
    el.style.removeProperty('--fs-ui')
  } else {
    el.style.setProperty('--fs-ui', `${uiFontSize}px`)
  }
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

export function getUiFontSize(): number {
  return uiFontSize
}

/**
 * The persisted size, as opposed to the one on screen. While a slider drag is in
 * flight these differ — the live value is already at the thumb, the saved one is
 * still where the user last committed. The settings registry reads *this*, so an
 * undo entry restores the pre-drag size instead of the size being dragged to.
 */
export function getSavedUiFontSize(): number {
  return uiFontSizeSaved
}

export function getMotion(): Motion {
  return motion
}

export function getFocusRing(): SwitchState {
  return focusRing
}

export function getStatusShapes(): SwitchState {
  return statusShapes
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

function clampUiFontSize(next: number): number {
  const v = Number(next)
  if (!Number.isFinite(v)) return UI_FONT_SIZE.base
  return Math.min(UI_FONT_SIZE.max, Math.max(UI_FONT_SIZE.min, v))
}

/**
 * Move the UI font size on screen without writing or notifying anything. A range
 * input fires on every pixel, and `emit()` reaches the xterm and Monaco painters, so
 * a drag would repaint every terminal in the window once per pixel. The slider calls
 * this while dragging and `commitUiFontSize` when the pointer lifts.
 */
export function previewUiFontSize(next: number): void {
  const value = clampUiFontSize(next)
  if (value === uiFontSize) return
  uiFontSize = value
  apply()
}

/** Persist the size now on screen and notify subscribers once. */
export function commitUiFontSize(): void {
  if (uiFontSize === uiFontSizeSaved) return
  uiFontSizeSaved = uiFontSize
  write(UI_FONT_SIZE_KEY, String(uiFontSize))
  emit()
}

/** Programmatic write — the AI bridge and any caller that has no drag in progress. */
export function setUiFontSize(next: number): void {
  previewUiFontSize(next)
  commitUiFontSize()
}

export function setMotion(next: Motion): void {
  const value = next === 'on' || next === 'off' ? next : 'system'
  if (value === motion) return
  motion = value
  write(MOTION_KEY, value)
  apply()
  emit()
}

/** Anything but an explicit `false` / `'off'` means on — see `readSwitch`. */
function normalizeSwitch(next: SwitchState | boolean): SwitchState {
  return next === false || next === 'off' ? 'off' : 'on'
}

export function setFocusRing(next: SwitchState | boolean): void {
  const value = normalizeSwitch(next)
  if (value === focusRing) return
  focusRing = value
  write(FOCUS_RING_KEY, value)
  apply()
  emit()
}

/**
 * `'off'` reduces the state dots to colour alone. The default is `'on'` because the
 * shape redundancy is the accessibility baseline the redesign set for every
 * `.dot`; this switch exists for the user who finds the silhouettes noisy, not as
 * a way to opt out of colour-blind-safe state.
 */
export function setStatusShapes(next: SwitchState | boolean): void {
  const value = normalizeSwitch(next)
  if (value === statusShapes) return
  statusShapes = value
  write(STATUS_SHAPES_KEY, value)
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
  previewUiFontSize: (px: number) => void
  commitUiFontSize: () => void
  setUiFontSize: (px: number) => void
  setMotion: (m: Motion) => void
  setFocusRing: (s: SwitchState | boolean) => void
  setStatusShapes: (s: SwitchState | boolean) => void
} {
  useSyncExternalStore(subscribeTheme, getSnapshot, getSnapshot)
  return {
    mode: snapshot.mode,
    resolved: snapshot.resolved,
    palette: snapshot.palette,
    accent: snapshot.accent,
    density: snapshot.density,
    uiFontSize: snapshot.uiFontSize,
    motion: snapshot.motion,
    focusRing: snapshot.focusRing,
    statusShapes: snapshot.statusShapes,
    setThemeMode,
    setTerminalPalette,
    setAccent,
    setDensity,
    previewUiFontSize,
    commitUiFontSize,
    setUiFontSize,
    setMotion,
    setFocusRing,
    setStatusShapes,
  }
}

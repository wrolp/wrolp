// App appearance/settings registry — the single source of truth for the
// display-grade settings the AI assistant can READ and CHANGE, plus what the
// settings page and the components consume. See
// task/plans/AI-UI-CONFIG-PLAN.md.
//
// Hard constraints (from the plan):
//  - The registry IS the whitelist: an unknown key is always rejected, so the AI
//    can never reach a credential / vault / data-root / connection field.
//  - localStorage stays the ONLY persistence for these values and the existing
//    key names are preserved verbatim (they are a user-data contract).
//  - Values are validated per kind; invalid input is rejected with a readable
//    error so the model can self-correct.
//  - Every apply() records an undo snapshot in `wrolp-appearance-history`.
//
// Display-only preferences → localStorage, never window.json / Rust (same
// precedent as highlightStore / themeStore / pasteGuard).

import { getLang, setLang, type Lang } from '../i18n'
import {
  getTerminalPalette,
  getThemeMode,
  setTerminalPalette,
  setThemeMode,
  type TerminalPalette,
  type ThemeMode,
} from './themeStore'
import { highlightStore } from './highlightStore'
import {
  applyScheme,
  CATEGORY_ORDER,
  cloneDefaultConfig,
  isBuiltinSchemeId,
  setRuleColor,
  type CategoryKey,
} from './highlightRules'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SettingKind = 'enum' | 'color' | 'number' | 'boolean' | 'string'
export type SettingGroup = 'theme' | 'terminal' | 'highlight' | 'ui'

interface SettingStorage {
  kind: 'localStorage' | 'memory'
  /** localStorage key (kept identical to the legacy key — user-data contract). */
  key?: string
}

export interface SettingDef {
  /** Stable dotted key shared by the AI tool contract and the frontend. */
  key: string
  kind: SettingKind
  /** Allowed values for `enum`. */
  values?: readonly string[]
  min?: number
  max?: number
  group: SettingGroup
  default: unknown
  storage: SettingStorage
  /** Optional custom read/write that bypasses the generic localStorage path
   *  (e.g. routed through themeStore / highlightStore / i18n). */
  read?: () => unknown
  write?: (value: unknown) => void
  /** One-line human/AI-readable description. */
  describe: string
  /** 'confirm' → the tool layer asks the user before applying (plan §3②). */
  risk?: 'safe' | 'confirm'
}

/** What `get_ui_settings` hands back for one key. */
export interface SettingView {
  key: string
  value: unknown
  kind: SettingKind
  values?: readonly string[]
  min?: number
  max?: number
  default: unknown
  description: string
  group: SettingGroup
}

export interface AppearanceSnapshot {
  undoId: string
  ts: number
  source: 'ai' | 'user'
  /** key → the value that was written. */
  changes: Record<string, unknown>
  /** key → the value that was in place before. */
  previous: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Defaults reused elsewhere
// ---------------------------------------------------------------------------

/** Terminal font stack (shared with `Terminal.tsx` so the registry default and
 *  the renderer can never drift). */
export const DEFAULT_TERMINAL_FONT_FAMILY =
  '"WrolpNerdFont", "FiraCode Nerd Font", "Fira Code Nerd Font", "CaskaydiaCove Nerd Font", "CaskaydiaCove NF", "JetBrainsMono Nerd Font", "MesloLGS NF", "Symbols Nerd Font", "Fira Code", "Cascadia Code", Consolas, "Courier New", "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", monospace'

/** New localStorage keys introduced by this registry (stable contract). */
export const TERMINAL_APPEARANCE_KEYS = {
  fontSize: 'wrolp-terminal-font-size',
  fontFamily: 'wrolp-terminal-font-family',
  lineHeight: 'wrolp-terminal-line-height',
  cursorStyle: 'wrolp-terminal-cursor-style',
  cursorBlink: 'wrolp-terminal-cursor-blink',
} as const

export type TerminalCursorStyle = 'block' | 'underline' | 'bar'

/** Terminal font/cursor options read by `Terminal.tsx` (and re-read on change). */
export interface TerminalAppearance {
  fontSize: number
  fontFamily: string
  lineHeight: number
  cursorStyle: TerminalCursorStyle
  cursorBlink: boolean
}

const MAX_STRING_LEN = 200
const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i

const defaultHighlightColors = cloneDefaultConfig().rules.reduce<Record<string, string>>(
  (acc, r) => {
    acc[r.key] = r.color
    return acc
  },
  {},
)

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const DEFS: SettingDef[] = [
  // ---- theme -------------------------------------------------------------
  {
    key: 'theme.mode',
    kind: 'enum',
    values: ['system', 'dark', 'light'],
    group: 'theme',
    default: 'system',
    storage: { kind: 'localStorage', key: 'wrolp-theme' },
    read: () => getThemeMode(),
    write: (v) => setThemeMode(v as ThemeMode),
    describe: 'UI theme mode. "system" follows the OS setting; "dark"/"light" force it.',
  },
  {
    key: 'terminal.palette',
    kind: 'enum',
    values: ['follow', 'dark', 'light'],
    group: 'theme',
    default: 'follow',
    storage: { kind: 'localStorage', key: 'wrolp-terminal-palette' },
    read: () => getTerminalPalette(),
    write: (v) => setTerminalPalette(v as TerminalPalette),
    describe:
      'Terminal colour palette, independent of the UI theme ("follow" tracks the UI theme).',
  },

  // ---- terminal ----------------------------------------------------------
  {
    key: 'terminal.fontSize',
    kind: 'number',
    min: 8,
    max: 32,
    group: 'terminal',
    default: 14,
    storage: { kind: 'localStorage', key: TERMINAL_APPEARANCE_KEYS.fontSize },
    describe: 'Terminal font size in px (8–32).',
  },
  {
    key: 'terminal.fontFamily',
    kind: 'string',
    group: 'terminal',
    default: DEFAULT_TERMINAL_FONT_FAMILY,
    storage: { kind: 'localStorage', key: TERMINAL_APPEARANCE_KEYS.fontFamily },
    describe: 'CSS font-family list for the terminal (max 200 characters).',
  },
  {
    key: 'terminal.lineHeight',
    kind: 'number',
    min: 1,
    max: 2,
    group: 'terminal',
    default: 1,
    storage: { kind: 'localStorage', key: TERMINAL_APPEARANCE_KEYS.lineHeight },
    describe: 'Terminal line-height multiplier (1.0–2.0).',
  },
  {
    key: 'terminal.cursorStyle',
    kind: 'enum',
    values: ['block', 'underline', 'bar'],
    group: 'terminal',
    default: 'block',
    storage: { kind: 'localStorage', key: TERMINAL_APPEARANCE_KEYS.cursorStyle },
    describe: 'Terminal cursor shape.',
  },
  {
    key: 'terminal.cursorBlink',
    kind: 'boolean',
    group: 'terminal',
    default: true,
    storage: { kind: 'localStorage', key: TERMINAL_APPEARANCE_KEYS.cursorBlink },
    describe: 'Whether the terminal cursor blinks.',
  },

  // ---- highlight ---------------------------------------------------------
  {
    key: 'highlight.scheme',
    kind: 'enum',
    values: ['default', 'nord', 'solarized', 'pastel', 'custom'],
    group: 'highlight',
    default: 'default',
    storage: { kind: 'localStorage', key: 'wrolp-terminal-highlight' },
    read: () => highlightStore.load().schemeId,
    write: (v) => {
      const cur = highlightStore.load()
      const id = String(v)
      if (id === 'custom') highlightStore.save({ ...cur, schemeId: 'custom' })
      else if (isBuiltinSchemeId(id)) highlightStore.save(applyScheme(cur, id))
    },
    describe:
      'Colour scheme for terminal output category highlighting (ip/url/error/…).',
  },
  ...CATEGORY_ORDER.map<SettingDef>((key: CategoryKey) => ({
    key: `highlight.color.${key}`,
    kind: 'color',
    group: 'highlight',
    default: defaultHighlightColors[key],
    storage: { kind: 'localStorage', key: 'wrolp-terminal-highlight' },
    read: () => highlightStore.load().rules.find((r) => r.key === key)?.color ?? null,
    write: (v) => highlightStore.save(setRuleColor(highlightStore.load(), key, String(v))),
    describe: `Colour for the "${key}" terminal-highlight category (hex, e.g. #aabbcc). Selecting one switches the scheme to "custom".`,
  })),

  // ---- ui ----------------------------------------------------------------
  {
    key: 'ui.language',
    kind: 'enum',
    values: ['en', 'zh'],
    group: 'ui',
    default: 'en',
    storage: { kind: 'localStorage', key: 'wrolp-lang' },
    read: () => getLang(),
    write: (v) => setLang(v as Lang),
    describe: 'Interface language.',
  },
]

const BY_KEY = new Map(DEFS.map((d) => [d.key, d]))

export function listSettingDefs(): readonly SettingDef[] {
  return DEFS
}

export function getSettingDef(key: string): SettingDef | undefined {
  return BY_KEY.get(key)
}

export const SETTING_GROUPS: readonly SettingGroup[] = ['theme', 'terminal', 'highlight', 'ui']

// ---------------------------------------------------------------------------
// Generic storage
// ---------------------------------------------------------------------------

function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function lsSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // storage unavailable — keep running with the in-memory/library state
  }
}

function encode(def: SettingDef, value: unknown): string {
  if (def.kind === 'boolean') return value ? '1' : '0'
  return String(value)
}

function decode(def: SettingDef, raw: string): unknown {
  if (def.kind === 'number') {
    const n = Number(raw)
    return Number.isFinite(n) ? n : def.default
  }
  if (def.kind === 'boolean') return raw === '1'
  return raw
}

function readValue(def: SettingDef): unknown {
  if (def.read) return def.read()
  if (def.storage.kind === 'memory' || !def.storage.key) return def.default
  const raw = lsGet(def.storage.key)
  return raw === null ? def.default : decode(def, raw)
}

function writeValue(def: SettingDef, value: unknown): void {
  if (def.write) {
    def.write(value)
    return
  }
  if (def.storage.kind === 'memory' || !def.storage.key) return
  lsSet(def.storage.key, encode(def, value))
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

type Validated = { ok: true; value: unknown } | { ok: false; error: string }

/** Validate a raw value against a definition. Never throws. */
export function validateSettingValue(def: SettingDef, raw: unknown): Validated {
  switch (def.kind) {
    case 'enum': {
      if (typeof raw !== 'string') return { ok: false, error: `"${def.key}" must be a string` }
      if (!def.values || !def.values.includes(raw)) {
        return {
          ok: false,
          error: `"${def.key}": invalid value "${raw}" (allowed: ${(def.values ?? []).join(', ')})`,
        }
      }
      return { ok: true, value: raw }
    }
    case 'color': {
      if (typeof raw !== 'string' || !HEX_RE.test(raw)) {
        return { ok: false, error: `"${def.key}": invalid colour "${String(raw)}" (use hex, e.g. #aabbcc)` }
      }
      return { ok: true, value: raw.toLowerCase() }
    }
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(raw)
      if (!Number.isFinite(n)) return { ok: false, error: `"${def.key}" must be a number` }
      if (def.min != null && n < def.min) {
        return { ok: false, error: `"${def.key}": ${n} is below the minimum ${def.min}` }
      }
      if (def.max != null && n > def.max) {
        return { ok: false, error: `"${def.key}": ${n} is above the maximum ${def.max}` }
      }
      return { ok: true, value: n }
    }
    case 'boolean': {
      if (typeof raw !== 'boolean') return { ok: false, error: `"${def.key}" must be true or false` }
      return { ok: true, value: raw }
    }
    case 'string': {
      if (typeof raw !== 'string') return { ok: false, error: `"${def.key}" must be a string` }
      if (raw.length > MAX_STRING_LEN) {
        return { ok: false, error: `"${def.key}": value too long (max ${MAX_STRING_LEN} characters)` }
      }
      return { ok: true, value: raw }
    }
  }
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export function toView(def: SettingDef, value?: unknown): SettingView {
  return {
    key: def.key,
    value: value === undefined ? readValue(def) : value,
    kind: def.kind,
    values: def.values,
    min: def.min,
    max: def.max,
    default: def.default,
    description: def.describe,
    group: def.group,
  }
}

export function readSetting(key: string): SettingView | null {
  const def = BY_KEY.get(key)
  return def ? toView(def) : null
}

/** Read all registered settings (or a validated subset of keys). */
export function readSettings(keys?: unknown): Record<string, SettingView> {
  const defs =
    Array.isArray(keys) && keys.length > 0
      ? (keys.map((k) => BY_KEY.get(String(k))).filter(Boolean) as SettingDef[])
      : DEFS
  const out: Record<string, SettingView> = {}
  for (const def of defs) out[def.key] = toView(def)
  return out
}

/** Terminal appearance bundle consumed by `Terminal.tsx` (single localStorage read path). */
export function getTerminalAppearance(): TerminalAppearance {
  const get = (key: string) => {
    const def = BY_KEY.get(key)!
    return readValue(def)
  }
  return {
    fontSize: Number(get('terminal.fontSize')) || 14,
    fontFamily: String(get('terminal.fontFamily')) || DEFAULT_TERMINAL_FONT_FAMILY,
    lineHeight: Number(get('terminal.lineHeight')) || 1,
    cursorStyle: (get('terminal.cursorStyle') as TerminalCursorStyle) ?? 'block',
    cursorBlink: get('terminal.cursorBlink') !== false,
  }
}

// ---------------------------------------------------------------------------
// Subscribe
// ---------------------------------------------------------------------------

type Listener = () => void
const listeners = new Set<Listener>()

export function subscribeAppSettings(fn: Listener): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

function notify(): void {
  for (const fn of [...listeners]) fn()
}

// ---------------------------------------------------------------------------
// Apply + undo snapshots
// ---------------------------------------------------------------------------

const HISTORY_KEY = 'wrolp-appearance-history'
export const APPEARANCE_HISTORY_MAX = 20

export interface ApplyResult {
  undoId: string
  applied: Record<string, unknown>
  previous: Record<string, unknown>
}

export class SettingError extends Error {}

/** Validate + apply a map of changes, recording one undo snapshot. Throws
 *  `SettingError` (readable) when any key/value is rejected — nothing is applied
 *  in that case (fail-fast, all-or-nothing). */
export function applySettingChanges(
  changes: Record<string, unknown>,
  source: 'ai' | 'user' = 'ai',
): ApplyResult {
  const keys = Object.keys(changes)
  if (keys.length === 0) throw new SettingError('No settings were provided.')
  if (keys.length > 30) throw new SettingError('Too many settings in one change (max 30).')

  const values: Record<string, unknown> = {}
  for (const key of keys) {
    const def = BY_KEY.get(key)
    if (!def) throw new SettingError(`Unknown setting key "${key}".`)
    const res = validateSettingValue(def, changes[key])
    if (!res.ok) throw new SettingError(res.error)
    values[key] = res.value
  }

  const previous: Record<string, unknown> = {}
  for (const key of keys) previous[key] = readValue(BY_KEY.get(key)!)
  for (const key of keys) writeValue(BY_KEY.get(key)!, values[key])
  notify()

  const snapshot: AppearanceSnapshot = {
    undoId: `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    ts: Date.now(),
    source,
    changes: values,
    previous,
  }
  pushHistory(snapshot)
  return { undoId: snapshot.undoId, applied: values, previous }
}

function readHistory(): AppearanceSnapshot[] {
  try {
    const raw = lsGet(HISTORY_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (s): s is AppearanceSnapshot =>
        !!s && typeof s === 'object' && typeof s.undoId === 'string' && !!s.previous,
    )
  } catch {
    return []
  }
}

function writeHistory(list: AppearanceSnapshot[]): void {
  lsSet(HISTORY_KEY, JSON.stringify(list.slice(0, APPEARANCE_HISTORY_MAX)))
}

function pushHistory(snapshot: AppearanceSnapshot): void {
  writeHistory([snapshot, ...readHistory()].slice(0, APPEARANCE_HISTORY_MAX))
}

export function listAppearanceHistory(): AppearanceSnapshot[] {
  return readHistory()
}

/** Undo one snapshot by re-applying its `previous` values (unguarded: these are
 *  known-good values read back from the registry). */
export function undoAppearance(undoId: string): boolean {
  const list = readHistory()
  const snap = list.find((s) => s.undoId === undoId)
  if (!snap) return false
  for (const [key, value] of Object.entries(snap.previous)) {
    const def = BY_KEY.get(key)
    if (!def) continue
    const res = validateSettingValue(def, value)
    if (res.ok) writeValue(def, res.value)
  }
  notify()
  writeHistory(list.filter((s) => s.undoId !== undoId))
  return true
}

export function clearAppearanceHistory(): void {
  writeHistory([])
}

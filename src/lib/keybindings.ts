// Keyboard shortcut registry — the single source of truth for every combination
// key the app binds.
//
// Until now each binding lived in its own `keydown` listener with the combo
// spelled out inline, so there was nothing to rebind and no place to look them
// up. Every listener now asks this table instead, which makes Settings →
// Shortcuts real rather than a read-only cheat sheet, and keeps the hints
// elsewhere (titlebar, tooltips) honest about what the key actually is.
//
// Two rules this module exists to enforce:
//  - A binding matches EXACTLY, modifiers included. `ctrl+b` does not also fire
//    on `ctrl+alt+b`; the old listeners got this by testing `e.altKey` first and
//    returning, which is easy to get wrong when the table is editable.
//  - Keys the shell owns cannot be traded away. Tab / Enter / Space and the
//    signal keys (Ctrl+C, Ctrl+V, …) are rejected outright, because a global
//    listener that consumes them silently breaks interrupt, paste and EOF.
//    Readline's other control keys stay bindable but are reported as a caution.
//
// `ctrl` means Ctrl on Windows/Linux and Cmd on macOS (`ctrlKey || metaKey`),
// matching what the listeners this replaces already did.
//
// Persistence is localStorage only, like the other display-grade preferences
// (themeStore / highlightStore / pasteGuard) — nothing here reaches Rust.

import { t } from '../i18n'
import type { TranslationKey } from '../i18n/en'

export type ShortcutGroup = 'panel' | 'command' | 'terminal' | 'editor' | 'overlay'

export type ShortcutActionId =
  // Interface panels.
  | 'togglePalette'
  | 'toggleSidebar'
  | 'flipSidebarSide'
  | 'toggleBottomPanel'
  | 'flipPanelPosition'
  | 'toggleInspector'
  | 'splitTerminal'
  // Commands.
  | 'toggleCommandList'
  | 'toggleCommandHistory'
  | 'openDualFilePanel'
  // Inside the terminal.
  | 'openCompletionList'
  | 'scrollPageUp'
  | 'scrollPageDown'
  | 'scrollToTop'
  | 'scrollToBottom'
  // The file editor.
  | 'saveFile'
  // Any transient overlay.
  | 'dismissOverlay'

export interface ShortcutDef {
  id: ShortcutActionId
  group: ShortcutGroup
  /** The combo shipped with the app, in serialized form; `null` = unbound. */
  default: string | null
  titleKey: TranslationKey
  descKey: TranslationKey
}

/** A parsed combo. `ctrl` covers Cmd, so there is no separate `meta` field. */
export interface ShortcutBinding {
  key: string
  ctrl: boolean
  alt: boolean
  shift: boolean
}

/** What a keydown looks like to the matcher — native or React events alike. */
export interface KeyEventLike {
  key: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}

export type ShortcutCaution = 'shell' | null

export type ShortcutRejection =
  | { reason: 'modifierMissing' }
  | { reason: 'reservedKey' }
  | { reason: 'conflict'; otherId: ShortcutActionId }

export type ShortcutCheck =
  | { ok: true; caution: ShortcutCaution }
  | { ok: false; error: ShortcutRejection }

export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  'panel',
  'command',
  'terminal',
  'editor',
  'overlay',
]

export const SHORTCUT_DEFS: readonly ShortcutDef[] = [
  {
    id: 'togglePalette',
    group: 'panel',
    default: 'ctrl+k',
    titleKey: 'shortcutTogglePalette',
    descKey: 'shortcutTogglePaletteDesc',
  },
  {
    id: 'toggleSidebar',
    group: 'panel',
    default: 'ctrl+b',
    titleKey: 'shortcutToggleSidebar',
    descKey: 'shortcutToggleSidebarDesc',
  },
  {
    id: 'flipSidebarSide',
    group: 'panel',
    default: 'ctrl+alt+b',
    titleKey: 'shortcutFlipSidebarSide',
    descKey: 'shortcutFlipSidebarSideDesc',
  },
  {
    id: 'toggleBottomPanel',
    group: 'panel',
    default: 'ctrl+j',
    titleKey: 'shortcutToggleBottomPanel',
    descKey: 'shortcutToggleBottomPanelDesc',
  },
  {
    id: 'flipPanelPosition',
    group: 'panel',
    default: 'ctrl+alt+j',
    titleKey: 'shortcutFlipPanelPosition',
    descKey: 'shortcutFlipPanelPositionDesc',
  },
  {
    id: 'toggleInspector',
    group: 'panel',
    default: 'ctrl+alt+i',
    titleKey: 'shortcutToggleInspector',
    descKey: 'shortcutToggleInspectorDesc',
  },
  {
    id: 'splitTerminal',
    group: 'panel',
    default: 'ctrl+\\',
    titleKey: 'shortcutSplitTerminal',
    descKey: 'shortcutSplitTerminalDesc',
  },
  {
    id: 'toggleCommandList',
    group: 'command',
    default: 'ctrl+shift+p',
    titleKey: 'shortcutToggleCommandList',
    descKey: 'shortcutToggleCommandListDesc',
  },
  {
    id: 'toggleCommandHistory',
    group: 'command',
    default: 'ctrl+shift+h',
    titleKey: 'shortcutToggleCommandHistory',
    descKey: 'shortcutToggleCommandHistoryDesc',
  },
  {
    id: 'openDualFilePanel',
    group: 'command',
    default: 'ctrl+shift+f',
    titleKey: 'shortcutOpenDualFilePanel',
    descKey: 'shortcutOpenDualFilePanelDesc',
  },
  {
    id: 'openCompletionList',
    group: 'terminal',
    default: 'alt+/',
    titleKey: 'shortcutOpenCompletionList',
    descKey: 'shortcutOpenCompletionListDesc',
  },
  {
    id: 'scrollPageUp',
    group: 'terminal',
    default: 'shift+pageup',
    titleKey: 'shortcutScrollPageUp',
    descKey: 'shortcutScrollPageUpDesc',
  },
  {
    id: 'scrollPageDown',
    group: 'terminal',
    default: 'shift+pagedown',
    titleKey: 'shortcutScrollPageDown',
    descKey: 'shortcutScrollPageDownDesc',
  },
  {
    id: 'scrollToTop',
    group: 'terminal',
    default: 'shift+home',
    titleKey: 'shortcutScrollToTop',
    descKey: 'shortcutScrollToTopDesc',
  },
  {
    id: 'scrollToBottom',
    group: 'terminal',
    default: 'shift+end',
    titleKey: 'shortcutScrollToBottom',
    descKey: 'shortcutScrollToBottomDesc',
  },
  {
    id: 'saveFile',
    group: 'editor',
    default: 'ctrl+s',
    titleKey: 'shortcutSaveFile',
    descKey: 'shortcutSaveFileDesc',
  },
  {
    id: 'dismissOverlay',
    group: 'overlay',
    default: 'escape',
    titleKey: 'shortcutDismissOverlay',
    descKey: 'shortcutDismissOverlayDesc',
  },
]

const BY_ID = new Map<ShortcutActionId, ShortcutDef>(SHORTCUT_DEFS.map((d) => [d.id, d]))

const STORAGE_KEY = 'wrolp-shortcuts'

const MODIFIER_ORDER = ['ctrl', 'alt', 'shift'] as const

/** `e.key` values that name a key rather than a character. */
const NAMED_KEYS = new Set([
  'escape',
  'enter',
  'tab',
  'backspace',
  'delete',
  'insert',
  'home',
  'end',
  'pageup',
  'pagedown',
  'arrowup',
  'arrowdown',
  'arrowleft',
  'arrowright',
  'f1',
  'f2',
  'f3',
  'f4',
  'f5',
  'f6',
  'f7',
  'f8',
  'f9',
  'f10',
  'f11',
  'f12',
])

/** Pressing these alone is not a binding; they are the modifiers themselves. */
const BARE_MODIFIERS = new Set(['control', 'shift', 'alt', 'meta'])

/**
 * Shift produces a different `e.key` than the cap it is printed on. Map the
 * shifted character back so `Ctrl+Shift+1` binds to `1` and reads as `!` does
 * nothing — without this, every shifted symbol would be unbindable.
 */
const SHIFTED_CHARS: Record<string, string> = {
  ')': '0',
  '!': '1',
  '@': '2',
  '#': '3',
  $: '4',
  '%': '5',
  '^': '6',
  '&': '7',
  '*': '8',
  '(': '9',
  _: '-',
  '+': '=',
  '{': '[',
  '}': ']',
  '|': '\\',
  ':': ';',
  '"': "'",
  '<': ',',
  '>': '.',
  '?': '/',
  '~': '`',
}

/** Keys that belong to the shell or the OS and must never be consumed. */
const RESERVED_KEYS = new Set(['tab', 'enter', 'space', 'backspace', 'delete'])

/** Combos that would take SIGINT, EOF, suspend or the clipboard off the table. */
const RESERVED_COMBOS = new Set([
  'ctrl+c',
  'ctrl+v',
  'ctrl+x',
  'ctrl+z',
  'ctrl+d',
  'ctrl+w',
  'alt+tab',
  'ctrl+shift+escape',
])

/**
 * readline's control keys: bindable, but they stop reaching the shell. Ctrl+B
 * is already in that position by default (cursor left), which is why this is a
 * caution rather than a rejection.
 */
const READLINE_CONTROL_KEYS = new Set(['a', 'b', 'e', 'g', 'k', 'l', 'n', 'p', 'r', 's', 'u', 'y'])

/** Combos with no modifier that are still safe to bind globally. */
const UNMODIFIED_OK = new Set([
  'escape',
  ...Array.from(NAMED_KEYS).filter((k) => k.startsWith('f')),
])

/** `shift+<scroll key>` is how scrollback is moved without stealing the arrow. */
const SHIFT_NAV_KEYS = new Set(['pageup', 'pagedown', 'home', 'end', 'arrowup', 'arrowdown'])

function normalizeKey(rawKey: string, shift: boolean): string | null {
  if (!rawKey) return null
  if (rawKey === ' ') return 'space'
  let key = rawKey.toLowerCase()
  if (BARE_MODIFIERS.has(key)) return null
  if (shift && key.length === 1 && SHIFTED_CHARS[key]) key = SHIFTED_CHARS[key]
  // Multi-char `e.key` values we don't know (media keys, dead keys) can't be
  // written down reliably, so they aren't bindable.
  if (key.length > 1 && !NAMED_KEYS.has(key)) return null
  return key
}

export function bindingFromEvent(e: KeyEventLike): ShortcutBinding | null {
  const key = normalizeKey(e.key, e.shiftKey)
  if (!key) return null
  return { key, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey, shift: e.shiftKey }
}

/** `ctrl+shift+p`, the form localStorage and the conflict check work in. */
export function serializeBinding(b: ShortcutBinding): string {
  const parts: string[] = []
  for (const mod of MODIFIER_ORDER) if (b[mod]) parts.push(mod)
  parts.push(b.key)
  return parts.join('+')
}

export function parseBinding(serialized: string): ShortcutBinding | null {
  const parts = serialized.toLowerCase().split('+')
  const key = parts.pop()
  if (!key) return null
  const seen = new Set(parts)
  if (parts.some((p) => !MODIFIER_ORDER.includes(p as (typeof MODIFIER_ORDER)[number]))) return null
  const normalized = normalizeKey(key, seen.has('shift'))
  // Only the canonical spelling round-trips, otherwise an edit could rewrite
  // a stored combo into a different one.
  if (normalized !== key) return null
  return { key, ctrl: seen.has('ctrl'), alt: seen.has('alt'), shift: seen.has('shift') }
}

export function defaultBindingOf(id: ShortcutActionId): ShortcutBinding | null {
  const raw = BY_ID.get(id)?.default ?? null
  return raw ? parseBinding(raw) : null
}

// ---------------------------------------------------------------------------
// Resolved table + persistence
// ---------------------------------------------------------------------------

/** action → serialized combo, `null` = deliberately unbound. */
let overrides: Partial<Record<ShortcutActionId, string | null>> = loadOverrides()
let resolved = new Map<ShortcutActionId, ShortcutBinding | null>()
let version = 0

function recompute(): void {
  resolved = new Map()
  for (const def of SHORTCUT_DEFS) {
    const raw = def.id in overrides ? overrides[def.id] : def.default
    resolved.set(def.id, raw ? parseBinding(raw) : null)
  }
  version += 1
}

function loadOverrides(): Partial<Record<ShortcutActionId, string | null>> {
  let raw: string | null
  try {
    raw = localStorage.getItem(STORAGE_KEY)
  } catch {
    return {}
  }
  if (!raw) return {}
  const out: Partial<Record<ShortcutActionId, string | null>> = {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      const def = BY_ID.get(id as ShortcutActionId)
      if (!def) continue
      if (value === null) {
        out[def.id] = null
        continue
      }
      if (typeof value === 'string' && parseBinding(value)) out[def.id] = value
    }
  } catch {
    return {}
  }
  return out
}

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides))
  } catch {
    /* private mode / quota — the session still gets the rebound keys */
  }
}

/** Store a change, rebuild the lookup, and tell everyone reading it. */
function commit(): void {
  recompute()
  persist()
  notify()
}

recompute()

const listeners = new Set<() => void>()

function notify(): void {
  listeners.forEach((fn) => fn())
}

export function subscribeShortcuts(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** Bumped on every change so React consumers can re-read the table. */
export function getShortcutsVersion(): number {
  return version
}

export function shortcutDefs(group?: ShortcutGroup): readonly ShortcutDef[] {
  return group ? SHORTCUT_DEFS.filter((d) => d.group === group) : SHORTCUT_DEFS
}

export function bindingOf(id: ShortcutActionId): ShortcutBinding | null {
  return resolved.get(id) ?? null
}

export function serializedOf(id: ShortcutActionId): string | null {
  const b = bindingOf(id)
  return b ? serializeBinding(b) : null
}

export function isOverridden(id: ShortcutActionId): boolean {
  return id in overrides
}

function matches(b: ShortcutBinding, e: KeyEventLike): boolean {
  // Shift is compared on top of the (possibly folded) character: `Ctrl+K` must
  // not also fire on `Ctrl+Shift+K`, and `Shift+PageUp` must not fire on plain
  // PageUp, which is the shell's own key.
  return (
    normalizeKey(e.key, e.shiftKey) === b.key &&
    b.ctrl === (e.ctrlKey || e.metaKey) &&
    b.alt === e.altKey &&
    b.shift === e.shiftKey
  )
}

export function matchShortcut(e: KeyEventLike, id: ShortcutActionId): boolean {
  const b = bindingOf(id)
  return b !== null && matches(b, e)
}

/** Which action this keydown belongs to, or `null`. At most one can match. */
export function actionForEvent(e: KeyEventLike): ShortcutActionId | null {
  const candidate = bindingFromEvent(e)
  if (!candidate) return null
  const serialized = serializeBinding(candidate)
  for (const def of SHORTCUT_DEFS) {
    if (serializedOf(def.id) === serialized) return def.id
  }
  return null
}

/** Is this combo currently bound to anything? (Used to keep local Esc handling honest.) */
export function isDismissKey(e: KeyEventLike): boolean {
  return matchShortcut(e, 'dismissOverlay')
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function cautionFor(b: ShortcutBinding): ShortcutCaution {
  // Ctrl+<letter> is one of readline's editing keys (Ctrl+B moves the cursor
  // left), and Alt+<char> is its META prefix — binding either takes that
  // behaviour away from the shell. Not a reason to refuse, but the user should
  // see it written down.
  if (b.ctrl && READLINE_CONTROL_KEYS.has(b.key)) return 'shell'
  if (b.alt && !b.ctrl && b.key.length === 1) return 'shell'
  return null
}

/**
 * Check a candidate combo for one action. `conflict` names the action that
 * already owns it, so the UI can offer to swap or to just report it.
 */
export function checkBinding(id: ShortcutActionId, b: ShortcutBinding | null): ShortcutCheck {
  if (b === null) return { ok: true, caution: null }
  const serialized = serializeBinding(b)
  if (RESERVED_COMBOS.has(serialized)) return { ok: false, error: { reason: 'reservedKey' } }
  if (RESERVED_KEYS.has(b.key) && !(b.ctrl || b.alt)) {
    return { ok: false, error: { reason: 'reservedKey' } }
  }
  if (!b.ctrl && !b.alt) {
    // No Ctrl/Alt: only a function key, a bare Esc, or Shift+scroll-key is a
    // binding we will accept — anything looser would swallow plain typing.
    const allowed = b.shift ? SHIFT_NAV_KEYS.has(b.key) : UNMODIFIED_OK.has(b.key)
    if (!allowed) return { ok: false, error: { reason: 'modifierMissing' } }
  }
  for (const def of SHORTCUT_DEFS) {
    if (def.id === id) continue
    if (serializedOf(def.id) === serialized)
      return { ok: false, error: { reason: 'conflict', otherId: def.id } }
  }
  return { ok: true, caution: cautionFor(b) }
}

/** Apply a combo, or return why it was refused. */
export function setBinding(id: ShortcutActionId, b: ShortcutBinding | null): ShortcutCheck {
  const check = checkBinding(id, b)
  if (!check.ok) return check
  if (b === null) {
    overrides = { ...overrides, [id]: null }
  } else {
    const serialized = serializeBinding(b)
    // Writing the default back as an override would make the row read as
    // customised when it isn't.
    if (serialized === BY_ID.get(id)?.default) delete overrides[id]
    else overrides = { ...overrides, [id]: serialized }
  }
  commit()
  return check
}

export function resetBinding(id: ShortcutActionId): void {
  delete overrides[id]
  commit()
}

export function resetAllBindings(): void {
  overrides = {}
  commit()
}

/** Combos bound to more than one action — only reachable from a hand-edited file. */
export function findConflicts(): { serialized: string; ids: ShortcutActionId[] }[] {
  const byCombo = new Map<string, ShortcutActionId[]>()
  for (const def of SHORTCUT_DEFS) {
    const serialized = serializedOf(def.id)
    if (!serialized) continue
    const list = byCombo.get(serialized) ?? []
    list.push(def.id)
    byCombo.set(serialized, list)
  }
  return [...byCombo.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([serialized, ids]) => ({ serialized, ids }))
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

const KEY_LABELS: Record<string, string> = {
  escape: 'Esc',
  enter: 'Enter',
  tab: 'Tab',
  space: 'Space',
  backspace: '⌫',
  delete: 'Del',
  insert: 'Ins',
  home: 'Home',
  end: 'End',
  pageup: 'PgUp',
  pagedown: 'PgDn',
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
}

const MOD_NAMES: Record<'ctrl' | 'alt' | 'shift', string> = {
  ctrl: 'Ctrl',
  alt: 'Alt',
  shift: 'Shift',
}

/** `Ctrl+Shift+P` — modifier names stay Latin in both languages. */
export function formatBinding(b: ShortcutBinding | null): string {
  if (!b) return t('shortcutUnbound')
  const parts = MODIFIER_ORDER.filter((mod) => b[mod]).map((mod) => MOD_NAMES[mod])
  parts.push(KEY_LABELS[b.key] ?? (b.key.length === 1 ? b.key.toUpperCase() : b.key))
  return parts.join('+')
}

/** The live combo for an action, formatted — for tooltips next to a button. */
export function shortcutLabel(id: ShortcutActionId): string {
  return formatBinding(bindingOf(id))
}

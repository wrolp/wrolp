import React, { useState, useEffect, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import type {
  CommandOption,
  CommandOptionValue,
  CommandParam,
  CommandParamType,
  CommandSnippetDto,
  ConnectionConfig,
  GlobalVariable,
} from '../types'
import {
  listCommandSnippets,
  saveCommandSnippet,
  deleteCommandSnippet,
  listGlobalVariables,
  saveGlobalVariable,
  deleteGlobalVariable,
} from '../commands'
import { focusTerminal } from './Terminal'
import { Icon } from './Icon'
import { useI18n } from '../i18n'

/**
 * Modal overlay that portals into <body>.
 *
 * The floating command list is positioned with a CSS `transform` (drag/resize
 * offset), which makes it the containing block for `position: fixed`
 * descendants. An overlay rendered inside the panel would therefore be clamped
 * to the small panel box and push tall dialogs (e.g. the fill dialog with many
 * parameters) out of the window. Portaling to <body> keeps the dialog fixed
 * within the app window regardless of the panel's transform.
 */
const ModalOverlay: React.FC<{ children: React.ReactNode }> = ({ children }) =>
  createPortal(
    <div className="modal-overlay cmd-list-modal-overlay">{children}</div>,
    document.body,
  )

// ===== Variable helpers =====

// Match `${name}` where name follows standard identifier rules. Bare `$VAR`
// is intentionally not captured so values the user wants the shell itself to
// expand (e.g. `${PATH}` declared nowhere in the global library) pass through.
const VAR_REGEX = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g
const VAR_NAME_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/

function extractVariables(command: string): string[] {
  const seen = new Set<string>()
  for (const m of command.matchAll(VAR_REGEX)) {
    seen.add(m[1])
  }
  return [...seen]
}

/**
 * Group connections by their optional `group` field, preserving first-seen
 * order. Different groups may hold connections that share a name and/or IP, so
 * the editor's scope picker renders these as `<optgroup>` labels to tell them
 * apart. Ungrouped connections are collected under the empty key.
 */
function groupConnections(
  connections: ConnectionConfig[],
): Array<{ group: string; items: ConnectionConfig[] }> {
  const order: string[] = []
  const map = new Map<string, ConnectionConfig[]>()
  for (const c of connections) {
    const g = c.group ?? ''
    let bucket = map.get(g)
    if (!bucket) {
      bucket = []
      map.set(g, bucket)
      order.push(g)
    }
    bucket.push(c)
  }
  return order.map((g) => ({ group: g, items: map.get(g)! }))
}

/** Replace every occurrence of `${name}` with `value` for the provided values. */
function applyVariables(command: string, values: Record<string, string>): string {
  return command.replace(VAR_REGEX, (match, name: string) =>
    name in values ? values[name] : match,
  )
}

/** Escape a string for use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Remove every `${name}` from `command`, plus the run of horizontal whitespace
 * directly adjacent to it. Only spaces/tabs are touched — newlines and
 * non-whitespace are never consumed. When whitespace exists on BOTH sides,
 * exactly one space is kept (`a ${x} b` -> `a b`); glued cases (`--flag=${x}`
 * -> `--flag=`) simply drop the placeholder.
 */
function removePlaceholder(command: string, name: string): string {
  const re = new RegExp(`([ \\t]*)\\$\\{${escapeRegExp(name)}\\}([ \\t]*)`, 'g')
  return command.replace(re, (_m, before: string, after: string) =>
    before.length > 0 && after.length > 0 ? ' ' : '',
  )
}

function removePlaceholders(command: string, names: string[]): string {
  return names.reduce((acc, n) => removePlaceholder(acc, n), command)
}

/**
 * Remove a literal fragment (option) from `command`. Only matched when it ends
 * on a token boundary (not followed by a non-space char) so `-v` never eats
 * `--verbose`. Multi-token fragments (e.g. `-p 8080:80`) match as a whole.
 */
function removeFragment(command: string, fragment: string): string {
  const re = new RegExp(`[ \\t]*${escapeRegExp(fragment)}(?![^\\t\\n\\r ])`, 'g')
  return command.replace(re, '')
}

/** The value-slot name of an option: the single `${name}` inside its fragment. */
function optionValueName(opt: CommandOption): string | null {
  const names = extractVariables(opt.text)
  return names.length === 1 ? names[0] : null
}

/** The separator an option fragment uses between its flag and its `${...}` slot. */
function optionSeparator(text: string): '=' | ' ' {
  const m = text.match(/(\s*=\s*|\s+)\$\{/)
  return m && /^\s+$/.test(m[1]) ? ' ' : '='
}

/** Rewrite the flag↔slot separator inside an option fragment. */
function withOptionSeparator(text: string, sep: '=' | ' '): string {
  const m = text.match(/(\s*=\s*|\s+)(\$\{)/)
  if (!m || m.index === undefined) return text
  return text.slice(0, m.index) + (sep === '=' ? '=' : ' ') + text.slice(m.index + m[1].length)
}

/** Match a flag as a standalone token (never a prefix of a longer `--flag`). */
function flagTokenRe(flag: string): RegExp {
  return new RegExp(`(?<![A-Za-z0-9_-])${escapeRegExp(flag)}(?![A-Za-z0-9_-])`)
}

/** A valid `${name}` identifier for a newly-created option value slot. */
function deriveSlotName(flag: string, label: string, taken: Set<string>): string {
  const scrub = (s: string) => s.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')
  let base = scrub(label) || scrub(flag) || 'value'
  if (!/^[A-Za-z_]/.test(base)) base = `v_${base}`
  let name = base
  while (taken.has(name)) name = `${name}_`
  return name
}

/**
 * Ensure an option fragment carries a `${...}` value slot once its value type is
 * set. Prefers a slot already present in the command (keeping the separator the
 * command uses); otherwise appends one using `sep` and inserts the composed
 * fragment into the command, so the option is never dropped as an orphan.
 */
function ensureOptionValueSlot(
  command: string,
  text: string,
  sep: '=' | ' ',
  label: string,
  taken: Set<string>,
): { text: string; sep: '=' | ' '; command: string } {
  if (extractVariables(text).length > 0) {
    return { text, sep: optionSeparator(text), command }
  }
  const flag = text.trim()
  if (flag.length === 0) return { text, sep, command }

  const eq = command.match(
    new RegExp(`${escapeRegExp(flag)}\\s*=\\s*\\$\\{([A-Za-z_][A-Za-z0-9_]*)\\}`),
  )
  if (eq) return { text: `${flag}=` + '${' + eq[1] + '}', sep: '=', command }

  const sp = command.match(new RegExp(`${escapeRegExp(flag)}\\s+\\$\\{([A-Za-z_][A-Za-z0-9_]*)\\}`))
  if (sp) return { text: `${flag} ` + '${' + sp[1] + '}', sep: ' ', command }

  const name = deriveSlotName(flag, label, taken)
  const composed = flag + (sep === '=' ? '=' : ' ') + '${' + name + '}'
  return { text: composed, sep, command: command.replace(flagTokenRe(flag), () => composed) }
}

/** Declared params, de-duplicated by name (first wins). */
function resolveParamDefs(s: CommandSnippetDto): CommandParam[] {
  const seen = new Set<string>()
  return (s.params ?? []).filter((p) => (seen.has(p.name) ? false : (seen.add(p.name), true)))
}

/**
 * Apply the fill dialog's checkbox/value state: first drop unchecked fragments
 * and placeholders, then substitute the values of everything still included.
 */
function resolveCommand(
  command: string,
  params: CommandParam[],
  options: CommandOption[],
  pEnabled: Record<string, boolean>,
  pValues: Record<string, string>,
  oEnabled: Record<string, boolean>,
  oValues: Record<string, string>,
): string {
  let cmd = command
  for (const o of options) {
    if (oEnabled[o.id] === false) cmd = removeFragment(cmd, o.text)
  }
  cmd = removePlaceholders(
    cmd,
    params.filter((p) => pEnabled[p.name] === false).map((p) => p.name),
  )
  const subs: Record<string, string> = {}
  for (const p of params) {
    if (pEnabled[p.name] !== false) subs[p.name] = pValues[p.name] ?? p.defaultValue ?? ''
  }
  for (const o of options) {
    if (oEnabled[o.id] === false || !o.value) continue
    const name = optionValueName(o)
    if (name) subs[name] = oValues[o.id] ?? o.value.defaultValue ?? ''
  }
  return applyVariables(cmd, subs)
}

/**
 * Mutually-exclusive options/params: items sharing a non-empty `exclusiveGroup`
 * may have at most one enabled at a time. Toggling `target` on unchecks every
 * other member of its group (options and params alike); toggling off only
 * clears that item, so a group may legitimately end up empty.
 */
function applyExclusiveToggle(
  f: FillState,
  target: { kind: 'param' | 'option'; key: string },
  on: boolean,
): Pick<FillState, 'pEnabled' | 'oEnabled'> {
  const pEnabled = { ...f.pEnabled }
  const oEnabled = { ...f.oEnabled }
  if (target.kind === 'param') pEnabled[target.key] = on
  else oEnabled[target.key] = on

  if (on) {
    const group =
      target.kind === 'param'
        ? f.params.find((p) => p.name === target.key)?.exclusiveGroup
        : f.options.find((o) => o.id === target.key)?.exclusiveGroup
    if (group) {
      for (const p of f.params) {
        if (p.exclusiveGroup === group) {
          pEnabled[p.name] = target.kind === 'param' && p.name === target.key
        }
      }
      for (const o of f.options) {
        if (o.exclusiveGroup === group) {
          oEnabled[o.id] = target.kind === 'option' && o.id === target.key
        }
      }
    }
  }
  return { pEnabled, oEnabled }
}

/**
 * Enforce "at most one enabled per exclusive group" on an initial/default
 * enabled-state map — used when opening the fill dialog and after a reset, so a
 * mis-authored default that enables two members of one group can't leak
 * through. Options are scanned before params (matching the dialog's order); the
 * first enabled member of a group wins, the rest are disabled. Mutates the
 * passed maps in place.
 */
function normalizeExclusive(
  params: CommandParam[],
  options: CommandOption[],
  pEnabled: Record<string, boolean>,
  oEnabled: Record<string, boolean>,
): void {
  const seen = new Set<string>()
  const keepFirst = (group: string | undefined, isOn: boolean): boolean => {
    if (!group || !isOn) return isOn
    if (seen.has(group)) return false
    seen.add(group)
    return true
  }
  for (const o of options) {
    oEnabled[o.id] = keepFirst(o.exclusiveGroup, oEnabled[o.id] !== false)
  }
  for (const p of params) {
    pEnabled[p.name] = keepFirst(p.exclusiveGroup, pEnabled[p.name] !== false)
  }
}

// ===== Item linkage ("enabling A switches B on too") =====

/**
 * Namespaced key of a fill-dialog item (`param:<name>` / `option:<id>`), as
 * stored in `enables`. Namespacing keeps a param name from colliding with an
 * option id.
 */
export function linkKeyOf(kind: 'param' | 'option', key: string): string {
  return `${kind === 'param' ? 'param' : 'option'}:${key}`
}

/** Split a link key back into its kind and plain key. */
function splitLinkKey(link: string): { kind: 'param' | 'option'; key: string } | null {
  const at = link.indexOf(':')
  if (at <= 0) return null
  const ns = link.slice(0, at)
  if (ns !== 'param' && ns !== 'option') return null
  return { kind: ns, key: link.slice(at + 1) }
}

/** The other items an item switches on when enabled (declared order, deduped). */
function linksOf(
  params: CommandParam[],
  options: CommandOption[],
  kind: 'param' | 'option',
  key: string,
): string[] {
  const raw =
    kind === 'param'
      ? params.find((p) => p.name === key)?.enables
      : options.find((o) => o.id === key)?.enables
  return [...new Set((raw ?? []).filter((k) => k.length > 0))]
}

/** Whether a link target still exists among the declared items. */
function linkTargetExists(params: CommandParam[], options: CommandOption[], link: string): boolean {
  const parsed = splitLinkKey(link)
  if (!parsed) return false
  return parsed.kind === 'param'
    ? params.some((p) => p.name === parsed.key)
    : options.some((o) => o.id === parsed.key)
}

/**
 * Turn an item ON together with everything it links to, transitively: a snippet
 * whose flags must be used together must never be sent half-configured. Cycles
 * are tolerated (visited set). Every item switched on this way still obeys the
 * exclusive-group rule — exclusivity wins over linkage, so a linked item that
 * shares a group with an already-enabled item cancels that sibling.
 */
function applyLinkedToggle(
  f: FillState,
  target: { kind: 'param' | 'option'; key: string },
  on: boolean,
): Pick<FillState, 'pEnabled' | 'oEnabled'> {
  // Unchecking never cascades: the user stays in control of every other box.
  if (!on) return applyExclusiveToggle(f, target, on)

  let state = applyExclusiveToggle(f, target, true)
  const visited = new Set<string>([linkKeyOf(target.kind, target.key)])
  const queue = linksOf(f.params, f.options, target.kind, target.key)
  while (queue.length > 0) {
    const link = queue.shift()!
    if (visited.has(link)) continue
    const parsed = splitLinkKey(link)
    if (!parsed || !linkTargetExists(f.params, f.options, link)) continue
    visited.add(link)
    state = applyExclusiveToggle({ ...f, ...state }, parsed, true)
    queue.push(...linksOf(f.params, f.options, parsed.kind, parsed.key))
  }
  return state
}

/**
 * Expand an initial/default enabled-state map through the linkage graph: every
 * already-enabled item switches on the items it links to (transitively). Applied
 * before `normalizeExclusive` when the dialog opens and after a reset, so a
 * default (or a remembered state written before a link was authored) can never
 * produce "A on, B off" for a pair that must travel together. Mutates the maps.
 */
function expandLinks(
  params: CommandParam[],
  options: CommandOption[],
  pEnabled: Record<string, boolean>,
  oEnabled: Record<string, boolean>,
): void {
  const queue: string[] = []
  for (const p of params) if (pEnabled[p.name] !== false) queue.push(linkKeyOf('param', p.name))
  for (const o of options) if (oEnabled[o.id] !== false) queue.push(linkKeyOf('option', o.id))

  const visited = new Set<string>()
  while (queue.length > 0) {
    const link = queue.shift()!
    if (visited.has(link)) continue
    visited.add(link)
    const parsed = splitLinkKey(link)
    if (!parsed) continue
    for (const next of linksOf(params, options, parsed.kind, parsed.key)) {
      const target = splitLinkKey(next)
      if (!target || !linkTargetExists(params, options, next)) continue
      if (target.kind === 'param') pEnabled[target.key] = true
      else oEnabled[target.key] = true
      queue.push(next)
    }
  }
}

/** Display labels of an item's link targets; unknown/dead targets are skipped. */
function linkLabels(
  keys: string[] | undefined,
  params: CommandParam[],
  options: CommandOption[],
): string[] {
  return (keys ?? []).flatMap((k) => {
    const parsed = splitLinkKey(k)
    if (!parsed) return []
    if (parsed.kind === 'param')
      return params.some((p) => p.name === parsed.key) ? [parsed.key] : []
    const o = options.find((x) => x.id === parsed.key)
    return o ? [o.label?.trim() || o.text] : []
  })
}

/** Flag-looking tokens in a command that are not yet declared as options. */
function detectFlagCandidates(command: string, declaredTexts: string[]): string[] {
  const known = new Set(declaredTexts.map((t) => t.trim()))
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of command.split(/\s+/)) {
    const token = raw.trim()
    if (!/^-{1,2}[^\s]+$/.test(token)) continue
    if (known.has(token) || seen.has(token)) continue
    seen.add(token)
    out.push(token)
  }
  return out
}

// ===== Last-selection memory (per snippet, localStorage) =====

interface SnippetMemory {
  pEnabled: Record<string, boolean>
  pValues: Record<string, string>
  oEnabled: Record<string, boolean>
  oValues: Record<string, string>
}

const SNIPPET_STATE_KEY = 'wrolp.cmdSnippetState'

function loadAllSnippetStates(): Record<string, SnippetMemory> {
  try {
    const raw = localStorage.getItem(SNIPPET_STATE_KEY)
    return raw ? (JSON.parse(raw) as Record<string, SnippetMemory>) : {}
  } catch {
    return {}
  }
}

function loadSnippetState(id: string): SnippetMemory | null {
  return loadAllSnippetStates()[id] ?? null
}

function saveSnippetState(id: string, state: SnippetMemory) {
  try {
    const all = loadAllSnippetStates()
    all[id] = state
    localStorage.setItem(SNIPPET_STATE_KEY, JSON.stringify(all))
  } catch {
    /* storage unavailable — ignore */
  }
}

function clearSnippetState(id: string) {
  try {
    const all = loadAllSnippetStates()
    if (id in all) {
      delete all[id]
      localStorage.setItem(SNIPPET_STATE_KEY, JSON.stringify(all))
    }
  } catch {
    /* storage unavailable — ignore */
  }
}

/** Which dimension the list is bucketed by (see `CmdListPrefs.groupMode`). */
type GroupMode = 'connection' | 'custom'

/** Persisted window prefs (position, size, opacity, filter toggles). */
interface CmdListPrefs {
  pos: { x: number; y: number } | null
  size: { w: number; h: number } | null
  opacity: number
  favoriteOnly: boolean
  showHidden: boolean
  /** Show only the active terminal's connection (+ general) commands. */
  activeConnectionOnly: boolean
  /** "By connection" (derived, the original behaviour) or "by group" (labels). */
  groupMode: GroupMode
}

const CMDLIST_PREFS_KEY = 'wrolp.cmdListPrefs'

function defaultPrefs(): CmdListPrefs {
  return {
    pos: null,
    size: null,
    opacity: 1,
    favoriteOnly: false,
    showHidden: false,
    activeConnectionOnly: true,
    groupMode: 'connection',
  }
}

function loadCmdListPrefs(): CmdListPrefs {
  try {
    const raw = localStorage.getItem(CMDLIST_PREFS_KEY)
    if (!raw) return defaultPrefs()
    const parsed = JSON.parse(raw) as Partial<CmdListPrefs>
    return {
      pos: parsed.pos ?? null,
      size: parsed.size ?? null,
      opacity: typeof parsed.opacity === 'number' ? parsed.opacity : 1,
      favoriteOnly: parsed.favoriteOnly ?? false,
      showHidden: parsed.showHidden ?? false,
      activeConnectionOnly: parsed.activeConnectionOnly ?? true,
      groupMode: parsed.groupMode === 'custom' ? 'custom' : 'connection',
    }
  } catch {
    return defaultPrefs()
  }
}

function saveCmdListPrefs(p: CmdListPrefs) {
  try {
    localStorage.setItem(CMDLIST_PREFS_KEY, JSON.stringify(p))
  } catch {
    /* storage unavailable — ignore */
  }
}

// ===== Custom groups: name order (display preference, localStorage) =====

/**
 * Group order lives in its own key rather than inside `CmdListPrefs`: the
 * prefs object's shape is part of the e2e contract (specs seed it directly).
 *
 * Group EXISTENCE is the union of the two sources: the labels actually set on
 * snippets (so a group is never lost even if this list is cleared) and this
 * order list (so an explicitly created, still-empty group can exist).
 */
const CMD_GROUP_ORDER_KEY = 'wrolp.cmdGroupOrder'

function loadGroupOrder(): string[] {
  try {
    const raw = localStorage.getItem(CMD_GROUP_ORDER_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return [
      ...new Set(parsed.filter((n): n is string => typeof n === 'string' && n.trim().length > 0)),
    ]
  } catch {
    return []
  }
}

function saveGroupOrder(names: string[]) {
  try {
    localStorage.setItem(CMD_GROUP_ORDER_KEY, JSON.stringify(names))
  } catch {
    /* storage unavailable — ignore */
  }
}

/** Key of the trailing "ungrouped" bucket in the custom-group view. */
const UNGROUPED_KEY = '__ungrouped__'

/** One rendered section of the command list (either view). */
interface ListedGroup {
  /** Connection id / `g:<name>` / the `__*__` buckets. */
  id: string
  title: string
  items: CommandSnippetDto[]
  /** Custom view only: a group that was created but has no commands yet. */
  empty: boolean
}

interface CommandListPanelProps {
  open: boolean
  onClose: () => void
  /** Active terminal tab, or null when no terminal is active. */
  activeTabId: number | null
  /** Configured connections (for grouping + the editor's scope picker). */
  connections: ConnectionConfig[]
  /** connectionId of the focused terminal pane, or null (no tab / local shell). */
  activeConnectionId: string | null
  /** Send the command text to the terminal WITHOUT executing it (no Enter). */
  onSendToTerminal: (command: string) => void
  /**
   * Bumped by the app once a snippet created OUTSIDE this panel (terminal / AI
   * context menu → "Add to command list") has been persisted, so an
   * already-open panel re-reads the backend list. Opening the panel is not
   * enough on its own: `open` does not change while it stays open.
   */
  reloadKey?: number
}

/** Fill dialog state: resolved defs plus per-item checkbox/value state. */
interface FillState {
  snippet: CommandSnippetDto
  params: CommandParam[]
  options: CommandOption[]
  pEnabled: Record<string, boolean>
  pValues: Record<string, string>
  oEnabled: Record<string, boolean>
  oValues: Record<string, string>
}

/** Editable param row (options are edited as text in the UI). */
interface EditingParam {
  name: string
  type: CommandParamType
  defaultValue: string
  optionsText: string
  description: string
  defaultEnabled: boolean
  /** Name of the mutual-exclusion group this param belongs to ('' = none). */
  exclusiveGroup: string
  /** Link keys (`param:<name>` / `option:<id>`) switched on with this param. */
  enables: string[]
  /** Created automatically from a `${name}` in the command (pruned when the
   *  placeholder disappears). Rows the user added are never auto-removed. */
  auto: boolean
}

/** Editable option row. */
interface EditingOption {
  id: string
  text: string
  label: string
  description: string
  valueType: 'none' | 'text' | 'select'
  optionsText: string
  valueDefault: string
  defaultEnabled: boolean
  /** Name of the mutual-exclusion group this option belongs to ('' = none). */
  exclusiveGroup: string
  /** Link keys (`param:<name>` / `option:<id>`) switched on with this option. */
  enables: string[]
  /** How the flag joins its value: `=` (`--x=v`) or a space (`--x v`). Encoded
   *  into the fragment text, kept here so the checkbox survives a type change. */
  valueSeparator: '=' | ' '
}

function splitList(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\n,]/)
        .map((v) => v.trim())
        .filter(Boolean),
    ),
  ]
}

function toEditingParams(params: CommandParam[]): EditingParam[] {
  return params.map((p) => ({
    name: p.name,
    type: p.type === 'select' ? 'select' : 'text',
    defaultValue: p.defaultValue ?? '',
    optionsText: (p.options ?? []).join(', '),
    description: p.description ?? '',
    defaultEnabled: p.defaultEnabled !== false,
    exclusiveGroup: p.exclusiveGroup ?? '',
    enables: p.enables ?? [],
    auto: false,
  }))
}

function toEditingOptions(options: CommandOption[]): EditingOption[] {
  return options.map((o) => ({
    id: o.id,
    text: o.text,
    label: o.label ?? '',
    description: o.description ?? '',
    valueType: o.value ? (o.value.type === 'select' ? 'select' : 'text') : 'none',
    optionsText: (o.value?.options ?? []).join(', '),
    valueDefault: o.value?.defaultValue ?? '',
    defaultEnabled: o.defaultEnabled !== false,
    exclusiveGroup: o.exclusiveGroup ?? '',
    enables: o.enables ?? [],
    valueSeparator: optionSeparator(o.text),
  }))
}

/**
 * Hover tooltip of a list row: alias / full command / description, one per line
 * (a native `<title>` renders `\n`). The row itself already shows the alias and
 * the (truncated) command, so the tooltip's job is to add the untruncated text
 * and the note — empty parts are dropped so no blank line can appear.
 */
function snippetTooltip(s: CommandSnippetDto): string {
  return [s.alias, s.command, s.description]
    .map((v) => (v ?? '').trim())
    .filter((v) => v.length > 0)
    .join('\n')
}

/**
 * Floating command list (command snippets). Select text in the terminal or the
 * AI chat → "Add to command list"; here click a snippet to drop it into the
 * terminal's input line (unexecuted). Supports favorites-only / show-hidden
 * filters plus per-item right-click actions (favorite, hide, edit, delete).
 *
 * Snippets may embed `${name}` placeholders resolved against a shared global
 * variable library (managed via the "Variables" button in the header). When a
 * referenced variable has no usable value, a fill dialog opens before sending.
 */
export const CommandListPanel: React.FC<CommandListPanelProps> = ({
  open,
  onClose,
  activeTabId,
  connections,
  activeConnectionId,
  onSendToTerminal,
  reloadKey = 0,
}) => {
  const { t } = useI18n()
  const [snippets, setSnippets] = useState<CommandSnippetDto[]>([])
  const [globalVars, setGlobalVars] = useState<GlobalVariable[]>([])
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [favoriteOnly, setFavoriteOnly] = useState(() => loadCmdListPrefs().favoriteOnly)
  const [showHidden, setShowHidden] = useState(() => loadCmdListPrefs().showHidden)
  const [activeConnectionOnly, setActiveConnectionOnly] = useState(
    () => loadCmdListPrefs().activeConnectionOnly,
  )
  // Groups start COLLAPSED — the panel opens as a list of group headers and the
  // user expands what they need. The state is therefore the EXPANDED ids, not
  // the collapsed ones (an empty set = the default). Both sets are cleared again
  // whenever the panel is (re)opened, so the default really is the default.
  // The two views keep separate sets: a connection id could legitimately equal a
  // custom group name.
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  const [expandedCustomGroups, setExpandedCustomGroups] = useState<Set<string>>(new Set())
  const [groupMode, setGroupMode] = useState<GroupMode>(() => loadCmdListPrefs().groupMode)
  const [groupOrder, setGroupOrder] = useState<string[]>(() => loadGroupOrder())
  /** Inline "new group" input row at the end of the custom view. */
  const [newGroupOpen, setNewGroupOpen] = useState(false)
  const [newGroupDraft, setNewGroupDraft] = useState('')
  /** Inline rename of a group header (Enter/blur commits, Esc cancels). */
  const [renamingGroup, setRenamingGroup] = useState<{ name: string; draft: string } | null>(null)
  /** Right-clicked group header (rename / delete). */
  const [groupMenu, setGroupMenu] = useState<{ x: number; y: number; name: string } | null>(null)
  /** Group name typed in the add/edit snippet dialog. */
  const [editingGroupName, setEditingGroupName] = useState('')
  /** Free-form note typed in the add/edit snippet dialog (may be multi-line). */
  const [editingDescription, setEditingDescription] = useState('')
  /** Set while Enter/Esc already resolved a rename, so the follow-up blur
   *  (the input is unmounted by then) does not commit a second time. */
  const renameHandledRef = useRef(false)
  // Drag & drop (custom view only): what is being dragged + the hovered target.
  const dragSnippetRef = useRef<string | null>(null)
  const dragGroupRef = useRef<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; snippet: CommandSnippetDto } | null>(
    null,
  )
  const [editing, setEditing] = useState<CommandSnippetDto | null>(null)
  const [isAdding, setIsAdding] = useState(false)
  const [editingAlias, setEditingAlias] = useState('')
  const [editingCommand, setEditingCommand] = useState('')
  const [editingConnectionId, setEditingConnectionId] = useState('')
  const [editingParams, setEditingParams] = useState<EditingParam[]>([])
  const [editingOptions, setEditingOptions] = useState<EditingOption[]>([])
  const [toast, setToast] = useState<string | null>(null)
  const [showVarManager, setShowVarManager] = useState(false)
  /** Which editor row has its linkage picker expanded (`p<idx>` / `o<idx>`). */
  const [linkPicker, setLinkPicker] = useState<string | null>(null)
  // Snippet awaiting parameter/option values before we can send it.
  const [filling, setFilling] = useState<FillState | null>(null)
  const [fillError, setFillError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try {
      const result = await listCommandSnippets()
      setSnippets(result)
    } catch (e) {
      console.error('Failed to load command snippets:', e)
    }
  }, [])

  const loadVars = useCallback(async () => {
    try {
      const result = await listGlobalVariables()
      setGlobalVars(result)
    } catch (e) {
      console.error('Failed to load global variables:', e)
    }
  }, [])

  useEffect(() => {
    if (open) {
      setLoading(true)
      // Guard against a hung backend IPC: never leave the panel stuck on
      // "loading" forever.
      const guard = setTimeout(() => setLoading(false), 5000)
      Promise.all([reload(), loadVars()]).finally(() => {
        clearTimeout(guard)
        setLoading(false)
      })
      setQuery('')
      setMenu(null)
      setFilling(null)
      // Every open starts from the collapsed default again.
      setExpandedGroups(new Set())
      setExpandedCustomGroups(new Set())
    }
  }, [open, reload, loadVars])

  // Re-read the list when a snippet is created outside the panel (terminal / AI
  // context menu) while it is already open — `open` never changes in that case,
  // so the effect above would not run and the new entry stayed invisible until
  // the panel was closed and re-opened. Deliberately does NOT touch the search
  // box / filters: only the data is refreshed. The panel's own add/edit/delete
  // paths call `reload()` directly.
  const lastReloadKeyRef = useRef(reloadKey)
  useEffect(() => {
    if (lastReloadKeyRef.current === reloadKey) return
    lastReloadKeyRef.current = reloadKey
    if (open) void reload()
  }, [reloadKey, open, reload])

  // Close either context menu (snippet row / group header) on outside click or Escape.
  useEffect(() => {
    if (!menu && !groupMenu) return
    const close = () => {
      setMenu(null)
      setGroupMenu(null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('click', close)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('click', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [menu, groupMenu])

  // Auto-hide toast.
  useEffect(() => {
    if (!toast) return
    const id = setTimeout(() => setToast(null), 2000)
    return () => clearTimeout(id)
  }, [toast])

  // Floating position (drag) + size (resize) + opacity + filters, persisted to
  // localStorage so the panel re-opens where/how the user left it.
  // NOTE: these MUST live above the `if (!open) return null` guard — React
  // requires every hook to run on every render, regardless of `open`.
  const [pos, setPos] = useState<{ x: number; y: number } | null>(() => loadCmdListPrefs().pos)
  const [size, setSize] = useState<{ w: number; h: number } | null>(() => loadCmdListPrefs().size)
  const [panelOpacity, setPanelOpacity] = useState(() => loadCmdListPrefs().opacity)
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(
    null,
  )
  const resizeRef = useRef<{
    startX: number
    startY: number
    origW: number
    origH: number
    origX: number
    origY: number
  } | null>(null)
  // Drag offset for the add/edit dialog modal.
  const [dialogPos, setDialogPos] = useState<{ x: number; y: number } | null>(null)
  const dialogDragRef = useRef<{
    startX: number
    startY: number
    origX: number
    origY: number
  } | null>(null)

  useEffect(() => {
    if (open) {
      dragRef.current = null
      resizeRef.current = null
    }
  }, [open])

  // Persist window prefs whenever they change (also on close since the panel
  // stays mounted and `open` just hides it).
  useEffect(() => {
    saveCmdListPrefs({
      pos,
      size,
      opacity: panelOpacity,
      favoriteOnly,
      showHidden,
      activeConnectionOnly,
      groupMode,
    })
  }, [pos, size, panelOpacity, favoriteOnly, showHidden, activeConnectionOnly, groupMode])

  // Auto-declare a param row for every `${name}` that has no definition yet.
  // Placeholders owned by an option's value slot are skipped. Debounced so a
  // placeholder being typed inside `${}` does not spawn one row per keystroke
  // (`a`, `al`, `alp`, ...); once typing pauses, intermediate rows created by
  // an earlier pass are pruned and only the finished name remains. Rows the
  // user added or edited by hand are never auto-removed.
  useEffect(() => {
    if (!editing) return
    const handle = setTimeout(() => {
      const optionSlots = new Set(editingOptions.flatMap((o) => extractVariables(o.text)))
      const needed = new Set(extractVariables(editingCommand).filter((n) => !optionSlots.has(n)))
      setEditingParams((cur) => {
        const kept = cur.filter((p) => !p.auto || needed.has(p.name))
        const names = new Set(kept.map((p) => p.name))
        const added: EditingParam[] = [...needed]
          .filter((n) => !names.has(n))
          .map((n) => ({
            name: n,
            type: 'text' as CommandParamType,
            defaultValue: '',
            optionsText: '',
            description: '',
            defaultEnabled: true,
            exclusiveGroup: '',
            enables: [],
            auto: true,
          }))
        if (kept.length === cur.length && added.length === 0) return cur
        return [...kept, ...added]
      })
    }, 500)
    return () => clearTimeout(handle)
  }, [editingCommand, editingOptions, editing])

  if (!open) return null

  const filtered = snippets.filter((s) => {
    if (s.hidden && !showHidden) return false
    if (favoriteOnly && !s.favorite) return false
    if (query.length > 0) {
      // The description joins the haystack so a command can be found by what it
      // does ("disk usage") without a matching alias. No tokenising: a phrase
      // split across description lines is not a hit.
      const hay = `${s.command} ${s.alias ?? ''} ${s.description ?? ''}`.toLowerCase()
      if (!hay.includes(query.toLowerCase())) return false
    }
    return true
  })

  // Scope to the active terminal's connection (+ general) when enabled.
  const scoped =
    activeConnectionOnly && activeConnectionId
      ? filtered.filter((s) => !s.connectionId || s.connectionId === activeConnectionId)
      : filtered

  // Every group name that exists: the explicitly created ones (order list, in
  // the user's order) followed by names only seen as snippet labels.
  const knownGroupNames = [
    ...new Set([
      ...groupOrder,
      ...scoped.map((s) => s.groupName ?? '').filter((g) => g.length > 0),
    ]),
  ]

  /**
   * Custom ("by group") bucketing. Filters ran first (`scoped`), so the group
   * view only changes the bucketing dimension — `favoriteOnly` / `showHidden` /
   * `query` / `activeConnectionOnly` keep their meaning, and the latter still
   * filters by CONNECTION while groups label by purpose (the two are orthogonal).
   */
  const buildCustomGroups = (): ListedGroup[] => {
    const groups: ListedGroup[] = knownGroupNames
      .map((name) => {
        const items = scoped.filter((s) => s.groupName === name)
        return { id: `g:${name}`, title: name, items, empty: items.length === 0 }
      })
      // A created-but-empty group is listed only when nothing is searched for,
      // otherwise a query would fill the list with empty headers.
      .filter((g) => g.items.length > 0 || (query.length === 0 && groupOrder.includes(g.title)))
    // "Ungrouped" always sits last, mirroring the connection view's trailing
    // general bucket.
    const ungrouped = scoped.filter((s) => !s.groupName)
    if (ungrouped.length > 0) {
      groups.push({ id: UNGROUPED_KEY, title: t('ungrouped'), items: ungrouped, empty: false })
    }
    return groups
  }

  // Group by connection: configured connections first, then any dangling
  // connection ids (deleted connections), and the general bucket last — most
  // snippets are connection-scoped, so unfiled ones must not push them down.
  // Empty groups are hidden.
  const buildConnectionGroups = (): ListedGroup[] => {
    const groups: ListedGroup[] = []
    const knownConnIds = new Set(connections.map((c) => c.id))
    for (const c of connections) {
      const items = scoped.filter((s) => s.connectionId === c.id)
      // Prefix the group so two connections that share a name (and possibly IP)
      // in different groups are told apart — mirrors the editor's grouped
      // <optgroup> labels.
      if (items.length > 0) {
        groups.push({
          id: c.id,
          title: c.group ? `${c.group} / ${c.name}` : c.name,
          items,
          empty: false,
        })
      }
    }
    const unknownItems = scoped.filter((s) => s.connectionId && !knownConnIds.has(s.connectionId))
    if (unknownItems.length > 0) {
      groups.push({
        id: '__unknown__',
        title: t('snippetGroupUnknown'),
        items: unknownItems,
        empty: false,
      })
    }
    const generalItems = scoped.filter((s) => !s.connectionId)
    if (generalItems.length > 0) {
      groups.push({
        id: '__general__',
        title: t('snippetGroupGeneral'),
        items: generalItems,
        empty: false,
      })
    }
    return groups
  }

  const customView = groupMode === 'custom'
  const groups = customView ? buildCustomGroups() : buildConnectionGroups()

  // A search must SHOW what it matched, so groups render expanded while a query
  // is present; the recorded expand state takes over again once it is cleared.
  const searchActive = query.trim().length > 0

  const isCollapsed = (id: string) =>
    searchActive ? false : !(customView ? expandedCustomGroups : expandedGroups).has(id)

  /** Expand state is per view: the two key spaces must never mix. */
  const toggleGroup = (id: string) => {
    const setter = customView ? setExpandedCustomGroups : setExpandedGroups
    setter((cur) => {
      const next = new Set(cur)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // ===== Custom group operations (all reuse save_command_snippet) =====

  /** Write the order list (deduped); group existence is never stored anywhere. */
  const commitGroupOrder = (names: string[]) => {
    const deduped = [...new Set(names.map((n) => n.trim()).filter((n) => n.length > 0))]
    setGroupOrder(deduped)
    saveGroupOrder(deduped)
  }

  const createGroup = () => {
    const name = newGroupDraft.trim()
    if (name.length === 0) return
    // Same name = same group (labels are the identity) — the list is a name set,
    // so re-creating one would be a no-op. Tell the user instead of closing
    // silently.
    if (knownGroupNames.includes(name)) {
      setToast(t('snippetGroupExists'))
      return
    }
    // Register the label-only groups first, so a new group lands at the END
    // instead of jumping ahead of names the order list had never seen.
    commitGroupOrder([...knownGroupNames, name])
    // It is empty by definition and groups start collapsed — opening it is the
    // only way the user sees the new group (and its "no commands yet" hint).
    setExpandedCustomGroups((cur) => (cur.has(`g:${name}`) ? cur : new Set(cur).add(`g:${name}`)))
    setNewGroupDraft('')
    setNewGroupOpen(false)
  }

  /**
   * Rename = rewrite the label on every member, then move the name in the order
   * list. Renaming onto an existing name MERGES the two groups (labels cannot
   * tell them apart afterwards) — the name keeps its first position.
   */
  const renameGroup = async (oldName: string, rawNew: string) => {
    const next = rawNew.trim()
    setRenamingGroup(null)
    if (next.length === 0 || next === oldName) return
    // Labels are the identity, so renaming onto an existing name MERGES the two
    // groups — say so, otherwise the user thinks something went wrong.
    const merging = knownGroupNames.includes(next)
    const members = snippets.filter((s) => s.groupName === oldName)
    for (const s of members) {
      await saveCommandSnippet({ ...s, groupName: next, updatedAt: new Date().toISOString() })
    }
    commitGroupOrder(groupOrder.map((n) => (n === oldName ? next : n)))
    if (merging) setToast(t('snippetGroupRenameMerge'))
    await reload()
  }

  /** Delete = members fall back to "ungrouped"; the snippets themselves stay. */
  const deleteGroup = async (name: string) => {
    if (!window.confirm(t('snippetGroupDeleteConfirm', { name }))) return
    const members = snippets.filter((s) => s.groupName === name)
    for (const s of members) {
      await saveCommandSnippet({ ...s, groupName: null, updatedAt: new Date().toISOString() })
    }
    commitGroupOrder(groupOrder.filter((n) => n !== name))
    await reload()
  }

  /** Move one snippet into a group (`null` = ungrouped). */
  const moveSnippetToGroup = async (s: CommandSnippetDto, groupName: string | null) => {
    setMenu(null)
    setGroupMenu(null)
    if ((s.groupName ?? null) === groupName) return
    await updateSnippet({ ...s, groupName, updatedAt: new Date().toISOString() })
  }

  /** Drop a dragged group header onto another one (insert before the target). */
  const reorderGroups = (dragged: string, target: string) => {
    if (dragged === target) return
    const next = knownGroupNames.filter((n) => n !== dragged)
    const at = next.indexOf(target)
    if (at < 0) return
    next.splice(at, 0, dragged)
    commitGroupOrder(next)
  }

  /** Highlight a section while a snippet or another header hovers it. */
  const onGroupDragOver = (e: React.DragEvent, groupId: string) => {
    if (!dragSnippetRef.current && !dragGroupRef.current) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (dropTarget !== groupId) setDropTarget(groupId)
  }

  /** A drop lands either a snippet (re-labelled) or a header (re-ordered). */
  const onGroupDrop = (e: React.DragEvent, group: ListedGroup) => {
    e.preventDefault()
    setDropTarget(null)
    const snippetId = dragSnippetRef.current
    if (snippetId) {
      dragSnippetRef.current = null
      const s = snippets.find((x) => x.id === snippetId)
      if (s) void moveSnippetToGroup(s, group.id === UNGROUPED_KEY ? null : group.title)
      // Dropping onto a COLLAPSED group must show the result, otherwise the
      // gesture looks like it did nothing.
      setExpandedCustomGroups((cur) => (cur.has(group.id) ? cur : new Set(cur).add(group.id)))
      return
    }
    const dragged = dragGroupRef.current
    dragGroupRef.current = null
    if (dragged && group.id !== UNGROUPED_KEY) reorderGroups(dragged, group.title)
  }

  const sendNow = (resolved: string) => {
    const tid = activeTabId
    onSendToTerminal(resolved)
    if (tid != null) requestAnimationFrame(() => focusTerminal(tid))
  }

  /**
   * Fill state for a snippet: remembered last-selection over declared defaults.
   * `null` when the snippet declares neither params nor options (legacy flow).
   * `memory` lets a caller reuse one localStorage read across many snippets.
   */
  const buildFillState = (
    s: CommandSnippetDto,
    memory?: Record<string, SnippetMemory>,
  ): FillState | null => {
    const params = resolveParamDefs(s)
    const options = s.options ?? []
    if (params.length === 0 && options.length === 0) return null
    const saved = memory ? (memory[s.id] ?? null) : loadSnippetState(s.id)
    const pEnabled: Record<string, boolean> = {}
    const pValues: Record<string, string> = {}
    for (const p of params) {
      pEnabled[p.name] = saved?.pEnabled[p.name] ?? p.defaultEnabled !== false
      // `||`, not `??`: an EMPTY remembered value counts as "never set". A
      // remembered entry can be stale (written before the param was declared, or
      // before it gained a default), and `??` let that empty string shadow the
      // declared default forever. To drop an item instead of blanking it, the
      // user unchecks it — an empty field always falls back to the default.
      pValues[p.name] = saved?.pValues[p.name] || p.defaultValue || ''
    }
    const oEnabled: Record<string, boolean> = {}
    const oValues: Record<string, string> = {}
    for (const o of options) {
      oEnabled[o.id] = saved?.oEnabled[o.id] ?? o.defaultEnabled !== false
      // Same rule as params: an empty remembered slot value must not suppress
      // the declared one. `--tail=${tail}` declared `200` used to send an empty
      // `--tail=` once a stale empty entry was remembered for it.
      oValues[o.id] = saved?.oValues[o.id] || o.value?.defaultValue || ''
    }
    // Linked items travel together even in the INITIAL state: an enabled default
    // (or a remembered state written before a link was authored) must not leave
    // its partner off. Exclusivity is resolved afterwards — it wins over linkage.
    expandLinks(params, options, pEnabled, oEnabled)
    // A mis-authored default (or stale memory) could enable two members of one
    // exclusive group — collapse to the first.
    normalizeExclusive(params, options, pEnabled, oEnabled)
    return { snippet: s, params, options, pEnabled, pValues, oEnabled, oValues }
  }

  /** True once every enabled param already has a value (nothing left to ask). */
  const fillIsComplete = (f: FillState): boolean =>
    !f.params.some((p) => f.pEnabled[p.name] !== false && !(f.pValues[p.name] ?? '').trim())

  /**
   * The command a snippet would send right now from defaults / remembered
   * values — or `null` when a value is still missing (the fill dialog is then
   * required). Also drives the row's one-click "send directly" button.
   */
  const resolveSilently = (
    s: CommandSnippetDto,
    memory?: Record<string, SnippetMemory>,
  ): string | null => {
    const f = buildFillState(s, memory)
    if (f) {
      if (!fillIsComplete(f)) return null
      return resolveCommand(
        s.command,
        f.params,
        f.options,
        f.pEnabled,
        f.pValues,
        f.oEnabled,
        f.oValues,
      )
    }
    // Legacy: no declared params -> every `${name}` needs a global default.
    const defs = new Map(globalVars.map((v) => [v.name, v]))
    const values: Record<string, string> = {}
    for (const n of extractVariables(s.command)) {
      const dv = defs.get(n)?.defaultValue ?? ''
      if (dv.length === 0) return null
      values[n] = dv
    }
    return applyVariables(s.command, values)
  }

  /** Send a snippet, opening the fill dialog when it has params/options. */
  const send = (s: CommandSnippetDto) => {
    setMenu(null)
    setFillError(null)
    const declared = buildFillState(s)
    if (declared) {
      setFilling(declared)
      return
    }

    // Legacy: no declared params -> global-variable flow (unchanged).
    const names = extractVariables(s.command)
    const defs = new Map(globalVars.map((v) => [v.name, v]))
    const pEnabled: Record<string, boolean> = {}
    const pValues: Record<string, string> = {}
    const ephParams: CommandParam[] = []
    let needsDialog = false
    for (const n of names) {
      const d = defs.get(n)
      const dv = d?.defaultValue ?? ''
      if (!d || dv.length === 0) needsDialog = true
      ephParams.push({
        name: n,
        type: 'text',
        defaultValue: dv,
        options: [],
        description: d?.description,
        defaultEnabled: true,
      })
      pEnabled[n] = true
      pValues[n] = dv
    }
    if (!needsDialog) {
      const values: Record<string, string> = {}
      for (const n of names) values[n] = defs.get(n)?.defaultValue ?? ''
      sendNow(applyVariables(s.command, values))
      return
    }
    setFilling({
      snippet: s,
      params: ephParams,
      options: [],
      pEnabled,
      pValues,
      oEnabled: {},
      oValues: {},
    })
  }

  /**
   * One-click send that skips the fill dialog. Only offered for snippets whose
   * variables already resolve from defaults / remembered values; otherwise it
   * falls back to opening the dialog.
   */
  const sendDirect = (s: CommandSnippetDto) => {
    setMenu(null)
    const resolved = resolveSilently(s)
    if (resolved == null) {
      send(s)
      return
    }
    setFillError(null)
    sendNow(resolved)
  }

  /** Only declared params/options are worth remembering across sends. */
  const isDeclared = (s: CommandSnippetDto) =>
    (s.params?.length ?? 0) > 0 || (s.options?.length ?? 0) > 0

  /** Whether the current fill state matches the declared defaults. */
  const matchesDefaults = (f: FillState): boolean => {
    for (const p of f.params) {
      if ((f.pEnabled[p.name] !== false) !== (p.defaultEnabled !== false)) return false
      if ((f.pValues[p.name] ?? '') !== (p.defaultValue ?? '')) return false
    }
    for (const o of f.options) {
      if ((f.oEnabled[o.id] !== false) !== (o.defaultEnabled !== false)) return false
      if ((f.oValues[o.id] ?? '') !== (o.value?.defaultValue ?? '')) return false
    }
    return true
  }

  /** Persist the last selection (or clear it when everything is at default). */
  const persistFillState = (f: FillState) => {
    if (!isDeclared(f.snippet)) return
    if (matchesDefaults(f)) {
      clearSnippetState(f.snippet.id)
    } else {
      saveSnippetState(f.snippet.id, {
        pEnabled: f.pEnabled,
        pValues: f.pValues,
        oEnabled: f.oEnabled,
        oValues: f.oValues,
      })
    }
  }

  const closeFill = () => {
    if (filling) persistFillState(filling)
    setFillError(null)
    setFilling(null)
  }

  const submitFill = () => {
    if (!filling) return
    const missing = filling.params.find(
      (p) => filling.pEnabled[p.name] !== false && !(filling.pValues[p.name] ?? '').trim(),
    )
    if (missing) {
      setFillError(t('snippetFillVarsRequired', { name: missing.name }))
      return
    }
    const resolved = resolveCommand(
      filling.snippet.command,
      filling.params,
      filling.options,
      filling.pEnabled,
      filling.pValues,
      filling.oEnabled,
      filling.oValues,
    )
    persistFillState(filling)
    setFillError(null)
    setFilling(null)
    sendNow(resolved)
  }

  const updateSnippet = async (s: CommandSnippetDto) => {
    try {
      await saveCommandSnippet(s)
      await reload()
    } catch (e) {
      console.error('Failed to save command snippet:', e)
    }
  }

  const toggleFavorite = async (s: CommandSnippetDto) => {
    await updateSnippet({ ...s, favorite: !s.favorite, updatedAt: new Date().toISOString() })
    setMenu(null)
  }

  const toggleHidden = async (s: CommandSnippetDto) => {
    await updateSnippet({ ...s, hidden: !s.hidden, updatedAt: new Date().toISOString() })
    setMenu(null)
  }

  const startEdit = (s: CommandSnippetDto) => {
    setMenu(null)
    setIsAdding(false)
    setEditing(s)
    setEditingAlias(s.alias ?? '')
    setEditingCommand(s.command)
    setEditingConnectionId(s.connectionId ?? '')
    setEditingGroupName(s.groupName ?? '')
    setEditingDescription(s.description ?? '')
    setEditingParams(toEditingParams(s.params ?? []))
    setEditingOptions(toEditingOptions(s.options ?? []))
    setLinkPicker(null)
  }

  /** Open the dialog in "add new" mode (blank snippet, created on save). */
  const startAdd = () => {
    setMenu(null)
    setIsAdding(true)
    setEditing({} as CommandSnippetDto)
    setEditingAlias('')
    setEditingCommand('')
    // Default the scope to the focused terminal's connection. Falls back to
    // "general" when there is no active terminal, or the active pane isn't a
    // saved connection (e.g. a local shell).
    setEditingConnectionId(
      activeConnectionId && connections.some((c) => c.id === activeConnectionId)
        ? activeConnectionId
        : '',
    )
    // A new command starts ungrouped and without a description; the datalist
    // still offers existing group names.
    setEditingGroupName('')
    setEditingDescription('')
    setEditingParams([])
    setEditingOptions([])
    setLinkPicker(null)
  }

  const closeDialog = () => {
    setEditing(null)
    setIsAdding(false)
    setDialogPos(null)
    setLinkPicker(null)
  }

  const newOptionId = () =>
    `opt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`

  /** Validate the editable rows and freeze them into persisted DTO fields. */
  const buildParamAndOptionDefs = (
    command: string,
  ): { params: CommandParam[]; options: CommandOption[] } | null => {
    const placeholders = extractVariables(command)
    const names = new Set<string>()
    const params: CommandParam[] = []
    for (const p of editingParams) {
      const name = p.name.trim()
      if (name.length === 0) continue
      if (!placeholders.includes(name)) continue // orphan — dropped
      if (!VAR_NAME_REGEX.test(name)) {
        alert(t('snippetParamNameInvalid'))
        return null
      }
      if (names.has(name)) {
        alert(t('snippetParamDuplicate', { name }))
        return null
      }
      const options = p.type === 'select' ? splitList(p.optionsText) : []
      if (p.type === 'select' && options.length === 0) {
        alert(t('snippetParamOptionsRequired'))
        return null
      }
      names.add(name)
      params.push({
        name,
        type: p.type,
        defaultValue: p.defaultValue,
        options,
        description: p.description.trim() || undefined,
        defaultEnabled: p.defaultEnabled,
        exclusiveGroup: p.exclusiveGroup.trim() || undefined,
        enables: p.enables,
      })
    }

    const options: CommandOption[] = []
    const usedIds = new Set<string>()
    for (const o of editingOptions) {
      const text = o.text.trim()
      if (text.length === 0) continue
      if (!command.includes(text)) continue // orphan — dropped
      const slots = extractVariables(text)
      if (slots.length > 1) {
        alert(t('snippetOptionMultiValueSlot'))
        return null
      }
      let value: CommandOptionValue | undefined
      if (o.valueType !== 'none') {
        const slot = slots[0]
        if (!slot) {
          alert(t('snippetOptionValueRequired'))
          return null
        }
        if (names.has(slot)) {
          alert(t('snippetParamDuplicate', { name: slot }))
          return null
        }
        const opts = o.valueType === 'select' ? splitList(o.optionsText) : []
        if (o.valueType === 'select' && opts.length === 0) {
          alert(t('snippetParamOptionsRequired'))
          return null
        }
        names.add(slot)
        value = { type: o.valueType, options: opts, defaultValue: o.valueDefault }
      }
      const id = o.id && !usedIds.has(o.id) ? o.id : newOptionId()
      usedIds.add(id)
      options.push({
        id,
        text,
        label: o.label.trim() || undefined,
        description: o.description.trim() || undefined,
        value,
        defaultEnabled: o.defaultEnabled,
        exclusiveGroup: o.exclusiveGroup.trim() || undefined,
        enables: o.enables,
      })
    }

    // Link targets are keyed (`param:<name>` / `option:<id>`), so pruning must
    // happen AFTER the surviving rows — and their final option ids — are known:
    // a removed row or a renamed parameter must never leave a dangling target.
    const validKeys = new Set<string>([
      ...params.map((p) => linkKeyOf('param', p.name)),
      ...options.map((o) => linkKeyOf('option', o.id)),
    ])
    const pruneLinks = (keys: string[] | undefined) => {
      const kept = [...new Set(keys ?? [])].filter((k) => validKeys.has(k))
      return kept.length > 0 ? kept : undefined
    }
    for (const p of params) p.enables = pruneLinks(p.enables)
    for (const o of options) o.enables = pruneLinks(o.enables)

    return { params, options }
  }

  const saveEdit = async () => {
    const command = editingCommand.trim()
    if (command.length === 0) return
    const defs = buildParamAndOptionDefs(command)
    if (!defs) return
    const now = new Date().toISOString()
    if (isAdding) {
      try {
        await saveCommandSnippet({
          id: `snip-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          command,
          alias: editingAlias.trim() || null,
          favorite: false,
          hidden: false,
          sortOrder: 0,
          connectionId: editingConnectionId || null,
          groupName: editingGroupName.trim() || null,
          description: editingDescription.trim() || null,
          params: defs.params,
          options: defs.options,
          createdAt: now,
          updatedAt: now,
        })
        await reload()
      } catch (e) {
        console.error('Failed to save new command snippet:', e)
      }
    } else if (editing) {
      await updateSnippet({
        ...editing,
        alias: editingAlias.trim() || null,
        command,
        connectionId: editingConnectionId || null,
        groupName: editingGroupName.trim() || null,
        description: editingDescription.trim() || null,
        params: defs.params,
        options: defs.options,
        updatedAt: now,
      })
    }
    closeDialog()
  }

  const remove = async (s: CommandSnippetDto) => {
    if (!window.confirm(t('deleteSnippetConfirm'))) return
    setMenu(null)
    try {
      await deleteCommandSnippet(s.id)
      clearSnippetState(s.id)
      await reload()
    } catch (e) {
      console.error('Failed to delete command snippet:', e)
    }
  }

  const truncate = (text: string, max = 72) => (text.length > max ? text.slice(0, max) + '…' : text)

  const startDrag = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return
    e.preventDefault()
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      origX: pos?.x ?? 0,
      origY: pos?.y ?? 0,
    }
    const onMove = (ev: MouseEvent) => {
      const d = dragRef.current
      if (!d) return
      setPos({ x: d.origX + (ev.clientX - d.startX), y: d.origY + (ev.clientY - d.startY) })
    }
    const onUp = () => {
      dragRef.current = null
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  /** Drag the add/edit dialog by its header. */
  const startDialogDrag = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('span')) return
    e.preventDefault()
    dialogDragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      origX: dialogPos?.x ?? 0,
      origY: dialogPos?.y ?? 0,
    }
    const onMove = (ev: MouseEvent) => {
      const d = dialogDragRef.current
      if (!d) return
      setDialogPos({ x: d.origX + (ev.clientX - d.startX), y: d.origY + (ev.clientY - d.startY) })
    }
    const onUp = () => {
      dialogDragRef.current = null
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  /**
   * 8-way resize. The panel is positioned with `right`/`top` (right edge and
   * top edge are fixed by CSS) plus a translate offset (`pos`). So:
   *   - dragging the E edge widens the panel AND moves it right (pos.x += dx)
   *     so the left edge stays put;
   *   - dragging the W edge just changes width (left edge follows the cursor);
   *   - dragging the S edge grows height (bottom edge follows);
   *   - dragging the N edge shrinks height AND moves it down (top follows).
   */
  type ResizeDir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
  const startResize = (dir: ResizeDir) => (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    resizeRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      origW: size?.w ?? 560,
      origH: size?.h ?? 480,
      origX: pos?.x ?? 0,
      origY: pos?.y ?? 0,
    }
    const onMove = (ev: MouseEvent) => {
      const d = resizeRef.current
      if (!d) return
      const minW = 320
      const minH = 240
      const dx = ev.clientX - d.startX
      const dy = ev.clientY - d.startY
      let w = d.origW
      let h = d.origH
      let x = d.origX
      let y = d.origY
      // Horizontal: E grows width and shifts panel right (left edge fixed);
      // W just changes width (right edge fixed).
      if (dir.includes('e')) {
        w = d.origW + dx
        x = d.origX + dx
      } else if (dir.includes('w')) {
        w = d.origW - dx
      }
      // Vertical: S grows height (top edge fixed); N shrinks height and
      // shifts panel down (bottom edge fixed).
      if (dir.includes('s')) {
        h = d.origH + dy
      } else if (dir.includes('n')) {
        h = d.origH - dy
        y = d.origY + dy
      }
      setSize({ w: Math.max(minW, w), h: Math.max(minH, h) })
      if (x !== d.origX || y !== d.origY) setPos({ x, y })
    }
    const onUp = () => {
      resizeRef.current = null
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  const panelStyle: React.CSSProperties = {
    ...(pos ? { transform: `translate(${pos.x}px, ${pos.y}px)` } : {}),
  }
  const panelSizeStyle: React.CSSProperties = {
    width: size ? `${size.w}px` : undefined,
    height: size ? `${size.h}px` : undefined,
    // Opacity is applied to the background layer (::before) only, so the text
    // and controls stay fully readable.
    ['--cmd-opacity' as string]: panelOpacity,
  }

  /** Badge count: declared params+options, else inferred `${...}` placeholders. */
  const badgeCount = (s: CommandSnippetDto) =>
    (s.params?.length ?? 0) + (s.options?.length ?? 0) || extractVariables(s.command).length

  // ---- Editor helpers ----
  const updateParam = (idx: number, patch: Partial<EditingParam>) =>
    setEditingParams((cur) => cur.map((p, i) => (i === idx ? { ...p, ...patch } : p)))
  const updateOption = (idx: number, patch: Partial<EditingOption>) =>
    setEditingOptions((cur) => cur.map((o, i) => (i === idx ? { ...o, ...patch } : o)))
  /**
   * Change an option's value type. Turning a value on gives the fragment a
   * `${...}` slot — adopting one already in the command when present, else
   * composing a fresh one (with the row's separator) and inserting it into the
   * command so the option is not dropped as an orphan.
   */
  const changeOptionValueType = (idx: number, valueType: EditingOption['valueType']) => {
    const o = editingOptions[idx]
    if (!o) return
    if (valueType === 'none') {
      updateOption(idx, { valueType })
      return
    }
    const taken = new Set<string>([
      ...editingParams.map((p) => p.name.trim()).filter(Boolean),
      ...editingOptions.flatMap((x) => extractVariables(x.text)),
    ])
    const res = ensureOptionValueSlot(editingCommand, o.text, o.valueSeparator, o.label, taken)
    setEditingOptions((cur) =>
      cur.map((x, i) =>
        i === idx ? { ...x, valueType, text: res.text, valueSeparator: res.sep } : x,
      ),
    )
    if (res.command !== editingCommand) setEditingCommand(res.command)
  }

  /** Toggle an option's flag↔value separator, keeping the command in sync. */
  const changeOptionSeparator = (idx: number, sep: '=' | ' ') => {
    const o = editingOptions[idx]
    if (!o) return
    const text = withOptionSeparator(o.text, sep)
    setEditingOptions((cur) =>
      cur.map((x, i) => (i === idx ? { ...x, valueSeparator: sep, text } : x)),
    )
    if (text !== o.text) setEditingCommand((cmd) => cmd.replace(o.text, () => text))
  }

  const addParamRow = () =>
    setEditingParams((cur) => [
      ...cur,
      {
        name: '',
        type: 'text',
        defaultValue: '',
        optionsText: '',
        description: '',
        defaultEnabled: true,
        exclusiveGroup: '',
        enables: [],
        auto: false,
      },
    ])
  const addOptionRow = (text = '') =>
    setEditingOptions((cur) => [
      ...cur,
      {
        id: newOptionId(),
        text,
        label: '',
        description: '',
        valueType: 'none',
        optionsText: '',
        valueDefault: '',
        defaultEnabled: true,
        exclusiveGroup: '',
        enables: [],
        valueSeparator: '=',
      },
    ])

  const editingPlaceholders = extractVariables(editingCommand)
  const orphanParams = new Set(
    editingParams
      .map((p) => p.name.trim())
      .filter((n) => n.length > 0 && !editingPlaceholders.includes(n)),
  )
  const orphanOptions = new Set(
    editingOptions
      .map((o) => o.text.trim())
      .filter((x) => x.length > 0 && !editingCommand.includes(x)),
  )
  const flagCandidates = detectFlagCandidates(
    editingCommand,
    editingOptions.map((o) => o.text),
  )

  // ---- Linkage picker (authoring) ----
  // Every declared row is a possible link target. Keys are namespaced so a param
  // name can never collide with an option id; duplicates keep the first row.
  const linkTargets: Array<{ key: string; label: string }> = []
  const seenTargets = new Set<string>()
  const pushTarget = (key: string, label: string) => {
    if (seenTargets.has(key)) return
    seenTargets.add(key)
    linkTargets.push({ key, label })
  }
  for (const p of editingParams) {
    const name = p.name.trim()
    if (name.length > 0) pushTarget(linkKeyOf('param', name), name)
  }
  for (const o of editingOptions) {
    const label = o.label.trim() || o.text.trim()
    if (label.length > 0) pushTarget(linkKeyOf('option', o.id), label)
  }

  /** Add/remove one link key on an editable row. */
  const setLinks = (keys: string[], link: string, on: boolean) =>
    on ? [...keys, link] : keys.filter((k) => k !== link)
  const toggleParamLink = (idx: number, link: string, on: boolean) =>
    setEditingParams((cur) =>
      cur.map((p, i) => (i === idx ? { ...p, enables: setLinks(p.enables, link, on) } : p)),
    )
  const toggleOptionLink = (idx: number, link: string, on: boolean) =>
    setEditingOptions((cur) =>
      cur.map((o, i) => (i === idx ? { ...o, enables: setLinks(o.enables, link, on) } : o)),
    )

  /** The expanded picker for one row: a checkbox per other declared item. */
  const renderLinkPanel = (
    selfKey: string,
    checked: string[],
    onToggle: (key: string, on: boolean) => void,
  ) => {
    const candidates = linkTargets.filter((c) => c.key !== selfKey)
    if (candidates.length === 0) {
      return (
        <div className="snip-link-panel">
          <span className="snip-link-empty">{t('snippetLinkNone')}</span>
        </div>
      )
    }
    return (
      <div className="snip-link-panel">
        {candidates.map((c) => (
          <label
            key={c.key}
            className={'snip-link-chip' + (checked.includes(c.key) ? ' active' : '')}
            title={c.label}
          >
            <input
              type="checkbox"
              checked={checked.includes(c.key)}
              onChange={(e) => onToggle(c.key, e.target.checked)}
            />
            <span className="snip-link-chip-text">{c.label}</span>
          </label>
        ))}
      </div>
    )
  }

  // One localStorage read, reused for every row's quick-send button.
  const snippetMemory = loadAllSnippetStates()

  return (
    <div className="cmd-list-float" style={panelStyle}>
      <div
        className="cmd-list-panel"
        role="dialog"
        aria-label={t('commandList')}
        style={panelSizeStyle}
      >
        <div className="cmd-list-header" onMouseDown={startDrag}>
          <span className="cmd-list-title">
            <Icon name="terminal" size={14} /> {t('commandList')}
          </span>
          <div className="cmd-list-toggles">
            <label className="cmd-list-toggle" title={t('favoriteOnly')}>
              <input
                type="checkbox"
                checked={favoriteOnly}
                onChange={(e) => setFavoriteOnly(e.target.checked)}
              />
              <Icon name="pin" size={11} />
              <span className="cmd-list-toggle-text">{t('favoriteOnly')}</span>
            </label>
            <label className="cmd-list-toggle" title={t('showHidden')}>
              <input
                type="checkbox"
                checked={showHidden}
                onChange={(e) => setShowHidden(e.target.checked)}
              />
              <Icon name="eye" size={11} />
              <span className="cmd-list-toggle-text">{t('showHidden')}</span>
            </label>
            <label
              className={'cmd-list-toggle' + (activeConnectionId === null ? ' disabled' : '')}
              title={t('snippetFilterActiveConnection')}
            >
              <input
                type="checkbox"
                checked={activeConnectionOnly && activeConnectionId !== null}
                disabled={activeConnectionId === null}
                onChange={(e) => setActiveConnectionOnly(e.target.checked)}
              />
              <span className="cmd-list-toggle-text">{t('snippetFilterActiveConnection')}</span>
            </label>
          </div>
          <div className="cmd-list-header-actions">
            <button
              className="cmd-list-var-btn"
              onClick={() => setShowVarManager(true)}
              title={t('cmdVarManager')}
            >
              <Icon name="link" size={13} />
            </button>
            {/* Creating a group only makes sense in the grouped view — it is
                nothing but a name in the order list until commands join it. */}
            {customView && (
              <button
                className="cmd-list-newgroup-btn"
                aria-expanded={newGroupOpen}
                onClick={() => {
                  setNewGroupOpen((v) => !v)
                  setNewGroupDraft('')
                }}
                title={t('snippetGroupNew')}
              >
                <Icon name="folder" size={13} />
              </button>
            )}
            <button className="cmd-list-add-btn" onClick={startAdd} title={t('addCommand')}>
              <Icon name="plus" size={13} />
            </button>
            <button className="cmd-list-close" onClick={onClose} title={t('close')}>
              <Icon name="x" size={14} />
            </button>
          </div>
        </div>

        <div className="cmd-list-search">
          <Icon name="search" size={12} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('commandListSearch')}
            autoFocus
          />
          <div className="cmd-list-mode-switch">
            <button
              className={'cmd-list-mode-btn' + (customView ? '' : ' active')}
              aria-pressed={!customView}
              title={t('snippetGroupByConnection')}
              onClick={() => setGroupMode('connection')}
            >
              {t('snippetGroupByConnection')}
            </button>
            <button
              className={'cmd-list-mode-btn' + (customView ? ' active' : '')}
              aria-pressed={customView}
              title={t('snippetGroupByCustom')}
              onClick={() => setGroupMode('custom')}
            >
              {t('snippetGroupByCustom')}
            </button>
          </div>
        </div>

        <div className="cmd-list-body">
          {loading ? (
            <div className="cmd-list-empty">{t('loading')}</div>
          ) : groups.length === 0 ? (
            <div className="cmd-list-empty">
              {filtered.length > 0 ? t('snippetNoCommandsForConnection') : t('commandListEmpty')}
            </div>
          ) : (
            groups.map((g) => {
              const collapsed = isCollapsed(g.id)
              // The trailing "ungrouped" bucket is not a real group: it cannot be
              // renamed, deleted or dragged (only dropped onto).
              const groupHeaderActions = customView && g.id !== UNGROUPED_KEY
              return (
                <div
                  key={g.id}
                  className={
                    'cmd-list-section' +
                    (collapsed ? '' : ' expanded') +
                    (customView && dropTarget === g.id ? ' drag-over' : '')
                  }
                  onDragOver={customView ? (e) => onGroupDragOver(e, g.id) : undefined}
                  onDragLeave={
                    customView
                      ? () => setDropTarget((cur) => (cur === g.id ? null : cur))
                      : undefined
                  }
                  onDrop={customView ? (e) => onGroupDrop(e, g) : undefined}
                >
                  <div
                    className="cmd-list-section-header"
                    onClick={() => {
                      if (!renamingGroup) toggleGroup(g.id)
                    }}
                    onContextMenu={
                      groupHeaderActions
                        ? (e) => {
                            e.preventDefault()
                            e.stopPropagation()
                            setGroupMenu({ x: e.clientX, y: e.clientY, name: g.title })
                          }
                        : undefined
                    }
                    draggable={groupHeaderActions && !renamingGroup}
                    onDragStart={
                      groupHeaderActions
                        ? (e) => {
                            dragGroupRef.current = g.title
                            e.dataTransfer.effectAllowed = 'move'
                            e.dataTransfer.setData('text/plain', g.title)
                          }
                        : undefined
                    }
                    onDragEnd={
                      groupHeaderActions
                        ? () => {
                            dragGroupRef.current = null
                            setDropTarget(null)
                          }
                        : undefined
                    }
                  >
                    <Icon
                      name="chevronDown"
                      size={12}
                      className={'cmd-list-section-chevron' + (collapsed ? ' collapsed' : '')}
                    />
                    {renamingGroup?.name === g.title ? (
                      <input
                        className="cmd-list-group-rename-input"
                        value={renamingGroup.draft}
                        autoFocus
                        spellCheck={false}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => setRenamingGroup({ name: g.title, draft: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            renameHandledRef.current = true
                            void renameGroup(g.title, renamingGroup.draft)
                          } else if (e.key === 'Escape') {
                            renameHandledRef.current = true
                            setRenamingGroup(null)
                          }
                        }}
                        onBlur={() => {
                          if (renameHandledRef.current) {
                            renameHandledRef.current = false
                            return
                          }
                          void renameGroup(g.title, renamingGroup.draft)
                        }}
                      />
                    ) : (
                      <span className="cmd-list-section-title">{g.title}</span>
                    )}
                    <span className="cmd-list-section-count">{g.items.length}</span>
                  </div>
                  {!collapsed && g.empty && (
                    <div className="cmd-list-empty-group">{t('snippetGroupEmptyHint')}</div>
                  )}
                  {!collapsed &&
                    g.items.map((s) => (
                      <div
                        key={s.id}
                        className={
                          'cmd-list-item' +
                          (s.favorite ? ' favorite' : '') +
                          (s.hidden ? ' hidden' : '')
                        }
                        title={snippetTooltip(s)}
                        draggable={customView}
                        onDragStart={
                          customView
                            ? (e) => {
                                dragSnippetRef.current = s.id
                                e.dataTransfer.effectAllowed = 'move'
                                e.dataTransfer.setData('text/plain', s.id)
                              }
                            : undefined
                        }
                        onDragEnd={
                          customView
                            ? () => {
                                dragSnippetRef.current = null
                                setDropTarget(null)
                              }
                            : undefined
                        }
                        onClick={() => send(s)}
                        onContextMenu={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          setMenu({ x: e.clientX, y: e.clientY, snippet: s })
                        }}
                      >
                        {s.favorite && <Icon name="pin" size={11} className="cmd-list-star" />}
                        <div className="cmd-list-item-text">
                          {s.alias && <span className="cmd-list-alias">{s.alias}</span>}
                          <span className="cmd-list-command">{truncate(s.command)}</span>
                          {badgeCount(s) > 0 && (
                            <span className="cmd-list-var-badge" title={t('snippetParamsBadge')}>
                              {'$'}
                              {badgeCount(s)}
                            </span>
                          )}
                        </div>
                        {s.hidden && (
                          <Icon name="eyeOff" size={11} className="cmd-list-hidden-icon" />
                        )}
                        {/* Every variable already resolves from defaults / last
                          values -> one click sends without the fill dialog. */}
                        {resolveSilently(s, snippetMemory) !== null && (
                          <button
                            className="cmd-list-action cmd-list-send"
                            title={t('snippetSendDirect')}
                            onClick={(e) => {
                              e.stopPropagation()
                              sendDirect(s)
                            }}
                          >
                            <Icon name="send" size={11} />
                          </button>
                        )}
                        <div className="cmd-list-item-actions" onClick={(e) => e.stopPropagation()}>
                          <button
                            className={'cmd-list-action' + (s.favorite ? ' active' : '')}
                            title={s.favorite ? t('unfavorite') : t('favorite')}
                            onClick={() => toggleFavorite(s)}
                          >
                            <Icon name="pin" size={11} />
                          </button>
                          <button
                            className={
                              'cmd-list-action cmd-list-action--hidden' +
                              (s.hidden ? ' active' : '')
                            }
                            title={s.hidden ? t('unhideCommand') : t('hideCommand')}
                            onClick={() => toggleHidden(s)}
                          >
                            <Icon name={s.hidden ? 'eyeOff' : 'eye'} size={11} />
                          </button>
                          <button
                            className="cmd-list-action"
                            title={t('edit')}
                            onClick={() => startEdit(s)}
                          >
                            <Icon name="edit" size={11} />
                          </button>
                          <button
                            className="cmd-list-action danger"
                            title={t('delete')}
                            onClick={() => remove(s)}
                          >
                            <Icon name="trash" size={11} />
                          </button>
                        </div>
                      </div>
                    ))}
                </div>
              )
            })
          )}
          {customView && newGroupOpen && (
            <div className="cmd-list-new-group">
              <Icon name="folder" size={12} />
              <input
                value={newGroupDraft}
                autoFocus
                spellCheck={false}
                placeholder={t('snippetGroupNewPlaceholder')}
                onChange={(e) => setNewGroupDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') createGroup()
                  else if (e.key === 'Escape') {
                    setNewGroupOpen(false)
                    setNewGroupDraft('')
                  }
                }}
              />
              <button
                className="cmd-list-new-group-ok"
                onClick={createGroup}
                title={t('snippetGroupNew')}
              >
                <Icon name="plus" size={12} />
              </button>
              <button
                className="cmd-list-new-group-cancel"
                onClick={() => {
                  setNewGroupOpen(false)
                  setNewGroupDraft('')
                }}
                title={t('cancel')}
              >
                <Icon name="x" size={12} />
              </button>
            </div>
          )}
        </div>

        <div className="cmd-list-footer">
          <div className="cmd-list-hint">
            {activeTabId === null ? t('noActiveTerminal') : t('commandListHint')}
          </div>
          <label className="cmd-list-opacity" title={t('cmdListOpacity')}>
            <Icon name="eye" size={11} />
            <input
              type="range"
              min="30"
              max="100"
              value={Math.round(panelOpacity * 100)}
              onChange={(e) => setPanelOpacity(Number(e.target.value) / 100)}
            />
            <span>{Math.round(panelOpacity * 100)}%</span>
          </label>
        </div>

        {menu && (
          <div
            className="context-menu cmd-list-menu"
            style={{ left: menu.x, top: menu.y, position: 'fixed' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="context-menu-item" onClick={() => toggleFavorite(menu.snippet)}>
              <Icon name="pin" size={12} />{' '}
              {menu.snippet.favorite ? t('unfavorite') : t('favorite')}
            </div>
            <div className="context-menu-item" onClick={() => toggleHidden(menu.snippet)}>
              <Icon name={menu.snippet.hidden ? 'eye' : 'eyeOff'} size={12} />{' '}
              {menu.snippet.hidden ? t('unhideCommand') : t('hideCommand')}
            </div>
            {/* Moving is a property of the snippet, not of the view, but the
                connection view is deliberately left untouched. */}
            {customView && (
              <>
                <div className="context-menu-divider" />
                <div className="context-menu-label">{t('snippetMoveToGroup')}</div>
                {[...knownGroupNames, UNGROUPED_KEY].map((name) => {
                  const target = name === UNGROUPED_KEY ? null : name
                  const current = menu.snippet.groupName ?? null
                  return (
                    <div
                      key={name}
                      className={'context-menu-item' + (current === target ? ' active' : '')}
                      onClick={() => void moveSnippetToGroup(menu.snippet, target)}
                    >
                      <Icon name="folder" size={12} />{' '}
                      {name === UNGROUPED_KEY ? t('ungrouped') : name}
                    </div>
                  )
                })}
              </>
            )}
            <div className="context-menu-divider" />
            <div className="context-menu-item" onClick={() => startEdit(menu.snippet)}>
              <Icon name="edit" size={12} /> {t('edit')}
            </div>
            <div className="context-menu-item danger" onClick={() => remove(menu.snippet)}>
              <Icon name="trash" size={12} /> {t('delete')}
            </div>
          </div>
        )}

        {groupMenu && customView && (
          <div
            className="context-menu cmd-list-menu"
            style={{ left: groupMenu.x, top: groupMenu.y, position: 'fixed' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className="context-menu-item"
              onClick={() => {
                setRenamingGroup({ name: groupMenu.name, draft: groupMenu.name })
                setGroupMenu(null)
              }}
            >
              <Icon name="edit" size={12} /> {t('snippetGroupRename')}
            </div>
            <div
              className="context-menu-item danger"
              onClick={() => {
                const name = groupMenu.name
                setGroupMenu(null)
                void deleteGroup(name)
              }}
            >
              <Icon name="trash" size={12} /> {t('snippetGroupDelete')}
            </div>
          </div>
        )}

        {editing && (
          <ModalOverlay>
            <div
              className="modal cmd-list-modal-drag"
              style={
                dialogPos
                  ? { transform: `translate(${dialogPos.x}px, ${dialogPos.y}px)` }
                  : undefined
              }
            >
              <div className="modal-header" onMouseDown={startDialogDrag}>
                <h3>{isAdding ? t('addCommand') : t('editCommandList')}</h3>
                <span
                  onClick={closeDialog}
                  style={{ cursor: 'pointer', fontSize: 18, color: '#888' }}
                  title={t('close')}
                >
                  ✕
                </span>
              </div>
              <div className="modal-body">
                <div className="form-group">
                  <label>{t('snippetAlias')}</label>
                  <input
                    value={editingAlias}
                    onChange={(e) => setEditingAlias(e.target.value)}
                    placeholder={t('snippetAliasPlaceholder')}
                  />
                </div>
                <div className="form-group">
                  <label>{t('snippetConnection')}</label>
                  <div className="snippet-scope-radios">
                    <label>
                      <input
                        type="radio"
                        name="snippetScope"
                        checked={editingConnectionId === ''}
                        onChange={() => setEditingConnectionId('')}
                      />
                      {t('general')}
                    </label>
                    <label>
                      <input
                        type="radio"
                        name="snippetScope"
                        checked={editingConnectionId !== ''}
                        disabled={connections.length === 0}
                        onChange={() => {
                          if (editingConnectionId) return
                          // Prefer the active pane's connection, else the first
                          // configured one, so the radio stays on "connections".
                          const active =
                            activeConnectionId &&
                            connections.some((c) => c.id === activeConnectionId)
                              ? activeConnectionId
                              : ''
                          setEditingConnectionId(active || connections[0]?.id || '')
                        }}
                      />
                      {t('connections')}
                    </label>
                  </div>
                  {editingConnectionId !== '' && (
                    <select
                      value={editingConnectionId}
                      onChange={(e) => setEditingConnectionId(e.target.value)}
                    >
                      {/* Preserve a scope whose connection was deleted: show it
                          as an explicit option instead of a blank select. */}
                      {!connections.some((c) => c.id === editingConnectionId) && (
                        <option value={editingConnectionId}>{t('snippetGroupUnknown')}</option>
                      )}
                      {groupConnections(connections).map(({ group, items }) => (
                        <optgroup key={group || '__ungrouped__'} label={group || t('ungrouped')}>
                          {items.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                  )}
                </div>
                {/* Free-text group label with suggestions: picking an existing
                    name joins that group, typing a new one creates it. */}
                <div className="form-group">
                  <label>{t('group')}</label>
                  <input
                    list="snippet-groups"
                    value={editingGroupName}
                    onChange={(e) => setEditingGroupName(e.target.value)}
                    placeholder={t('snippetGroupNewPlaceholder')}
                    spellCheck={false}
                  />
                  <datalist id="snippet-groups">
                    {[...new Set([...groupOrder, ...snippets.map((s) => s.groupName ?? '')])]
                      .filter((n) => n.length > 0)
                      .map((n) => (
                        <option key={n} value={n} />
                      ))}
                  </datalist>
                </div>
                <div className="form-group">
                  <label>{t('snippetCommand')}</label>
                  <textarea
                    value={editingCommand}
                    onChange={(e) => setEditingCommand(e.target.value)}
                    placeholder={t('snippetCommandPlaceholder')}
                    rows={4}
                  />
                </div>
                {/* Sits right after the command, not after the alias: the note
                    answers "what does this command do", so it belongs next to
                    the command text. */}
                <div className="form-group">
                  <label>{t('snippetDescription')}</label>
                  <textarea
                    value={editingDescription}
                    onChange={(e) => setEditingDescription(e.target.value)}
                    placeholder={t('snippetDescriptionPlaceholder')}
                    rows={2}
                  />
                </div>

                <div className="form-group">
                  <label>{t('snippetParamSection')}</label>
                  <div className="snip-vars">
                    {editingParams.map((p, idx) => (
                      <div
                        key={idx}
                        className={
                          'snip-param-row' + (orphanParams.has(p.name.trim()) ? ' orphan' : '')
                        }
                      >
                        <input
                          className="snip-var-name"
                          value={p.name}
                          onChange={(e) => updateParam(idx, { name: e.target.value })}
                          placeholder={t('snippetParamName')}
                          spellCheck={false}
                        />
                        <select
                          value={p.type}
                          onChange={(e) =>
                            updateParam(idx, { type: e.target.value as CommandParamType })
                          }
                          title={t('snippetParamType')}
                        >
                          <option value="text">{t('snippetParamTypeText')}</option>
                          <option value="select">{t('snippetParamTypeSelect')}</option>
                        </select>
                        <input
                          value={p.defaultValue}
                          onChange={(e) => updateParam(idx, { defaultValue: e.target.value })}
                          placeholder={t('snippetParamDefault')}
                          spellCheck={false}
                        />
                        {p.type === 'select' && (
                          <textarea
                            className="snip-param-options"
                            value={p.optionsText}
                            onChange={(e) => updateParam(idx, { optionsText: e.target.value })}
                            placeholder={t('snippetParamOptions')}
                            spellCheck={false}
                            rows={2}
                          />
                        )}
                        <input
                          className="snip-param-desc"
                          value={p.description}
                          onChange={(e) => updateParam(idx, { description: e.target.value })}
                          placeholder={t('snippetParamDescription')}
                        />
                        <input
                          className="snip-exclusive"
                          value={p.exclusiveGroup}
                          onChange={(e) => updateParam(idx, { exclusiveGroup: e.target.value })}
                          placeholder={t('snippetExclusiveGroup')}
                          title={t('snippetExclusiveGroupHint')}
                          spellCheck={false}
                        />
                        <button
                          type="button"
                          className={'snip-link-btn' + (p.enables.length > 0 ? ' active' : '')}
                          onClick={() =>
                            setLinkPicker((cur) => (cur === `p${idx}` ? null : `p${idx}`))
                          }
                          title={t('snippetLinkHint')}
                          aria-expanded={linkPicker === `p${idx}`}
                        >
                          <Icon name="link" size={12} />
                          {p.enables.length > 0 && (
                            <span className="snip-link-count">{p.enables.length}</span>
                          )}
                        </button>
                        <label
                          className="snip-param-enabled"
                          title={t('snippetParamEnabledByDefault')}
                        >
                          <input
                            type="checkbox"
                            checked={p.defaultEnabled}
                            onChange={(e) => updateParam(idx, { defaultEnabled: e.target.checked })}
                          />
                        </label>
                        <button
                          type="button"
                          className="snip-var-remove"
                          onClick={() => setEditingParams((cur) => cur.filter((_, i) => i !== idx))}
                          title={t('snippetParamRemove')}
                        >
                          <Icon name="trash" size={12} />
                        </button>
                        {orphanParams.has(p.name.trim()) && (
                          <div className="snip-param-hint">{t('snippetParamOrphan')}</div>
                        )}
                        {linkPicker === `p${idx}` &&
                          renderLinkPanel(linkKeyOf('param', p.name.trim()), p.enables, (key, on) =>
                            toggleParamLink(idx, key, on),
                          )}
                      </div>
                    ))}
                    <button type="button" className="snip-var-add" onClick={addParamRow}>
                      <Icon name="plus" size={12} /> {t('snippetParamAdd')}
                    </button>
                  </div>
                </div>

                <div className="form-group">
                  <label>{t('snippetOptionSection')}</label>
                  <div className="snip-vars">
                    {editingOptions.map((o, idx) => (
                      <div
                        key={o.id}
                        className={
                          'snip-option-row' + (orphanOptions.has(o.text.trim()) ? ' orphan' : '')
                        }
                      >
                        <input
                          className="snip-option-text"
                          value={o.text}
                          onChange={(e) => updateOption(idx, { text: e.target.value })}
                          placeholder={t('snippetOptionText')}
                          spellCheck={false}
                        />
                        <input
                          className="snip-option-label"
                          value={o.label}
                          onChange={(e) => updateOption(idx, { label: e.target.value })}
                          placeholder={t('snippetOptionLabel')}
                        />
                        <select
                          value={o.valueType}
                          onChange={(e) =>
                            changeOptionValueType(idx, e.target.value as EditingOption['valueType'])
                          }
                          title={t('snippetOptionValueType')}
                        >
                          <option value="none">{t('snippetOptionValueNone')}</option>
                          <option value="text">{t('snippetOptionValueText')}</option>
                          <option value="select">{t('snippetOptionValueSelect')}</option>
                        </select>
                        {o.valueType !== 'none' && (
                          <input
                            value={o.valueDefault}
                            onChange={(e) => updateOption(idx, { valueDefault: e.target.value })}
                            placeholder={t('snippetParamDefault')}
                            spellCheck={false}
                          />
                        )}
                        {o.valueType === 'select' && (
                          <textarea
                            className="snip-option-options"
                            value={o.optionsText}
                            onChange={(e) => updateOption(idx, { optionsText: e.target.value })}
                            placeholder={t('snippetParamOptions')}
                            spellCheck={false}
                            rows={2}
                          />
                        )}
                        {o.valueType !== 'none' && (
                          <label
                            className="snip-opt-sep"
                            title={t('snippetOptionSpaceSeparatedHint')}
                          >
                            <input
                              type="checkbox"
                              checked={o.valueSeparator === ' '}
                              onChange={(e) =>
                                changeOptionSeparator(idx, e.target.checked ? ' ' : '=')
                              }
                            />
                            <span className="snip-opt-sep-text">
                              {t('snippetOptionSpaceSeparated')}
                            </span>
                          </label>
                        )}
                        <input
                          className="snip-exclusive"
                          value={o.exclusiveGroup}
                          onChange={(e) => updateOption(idx, { exclusiveGroup: e.target.value })}
                          placeholder={t('snippetExclusiveGroup')}
                          title={t('snippetExclusiveGroupHint')}
                          spellCheck={false}
                        />
                        <button
                          type="button"
                          className={'snip-link-btn' + (o.enables.length > 0 ? ' active' : '')}
                          onClick={() =>
                            setLinkPicker((cur) => (cur === `o${idx}` ? null : `o${idx}`))
                          }
                          title={t('snippetLinkHint')}
                          aria-expanded={linkPicker === `o${idx}`}
                        >
                          <Icon name="link" size={12} />
                          {o.enables.length > 0 && (
                            <span className="snip-link-count">{o.enables.length}</span>
                          )}
                        </button>
                        <label
                          className="snip-param-enabled"
                          title={t('snippetParamEnabledByDefault')}
                        >
                          <input
                            type="checkbox"
                            checked={o.defaultEnabled}
                            onChange={(e) =>
                              updateOption(idx, { defaultEnabled: e.target.checked })
                            }
                          />
                        </label>
                        <button
                          type="button"
                          className="snip-var-remove"
                          onClick={() =>
                            setEditingOptions((cur) => cur.filter((_, i) => i !== idx))
                          }
                          title={t('snippetOptionRemove')}
                        >
                          <Icon name="trash" size={12} />
                        </button>
                        {orphanOptions.has(o.text.trim()) && (
                          <div className="snip-param-hint">{t('snippetOptionOrphan')}</div>
                        )}
                        {linkPicker === `o${idx}` &&
                          renderLinkPanel(linkKeyOf('option', o.id), o.enables, (key, on) =>
                            toggleOptionLink(idx, key, on),
                          )}
                      </div>
                    ))}
                    <div className="snip-param-actions">
                      <button type="button" className="snip-var-add" onClick={() => addOptionRow()}>
                        <Icon name="plus" size={12} /> {t('snippetOptionAdd')}
                      </button>
                      {flagCandidates.length > 0 && (
                        <button
                          type="button"
                          className="snip-var-add"
                          onClick={() => flagCandidates.forEach((f) => addOptionRow(f))}
                        >
                          <Icon name="plus" size={12} /> {t('snippetOptionDetect')}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
              <div className="modal-footer">
                <button className="btn-cancel" onClick={closeDialog}>
                  {t('cancel')}
                </button>
                <button className="btn-primary" onClick={() => void saveEdit()}>
                  {isAdding ? t('addCommand') : t('saveSnippet')}
                </button>
              </div>
            </div>
          </ModalOverlay>
        )}

        {filling && (
          <SnippetFillDialog
            snippet={filling.snippet}
            params={filling.params}
            options={filling.options}
            pEnabled={filling.pEnabled}
            pValues={filling.pValues}
            oEnabled={filling.oEnabled}
            oValues={filling.oValues}
            error={fillError}
            onChangeParamEnabled={(name, v) =>
              setFilling((cur) =>
                cur ? { ...cur, ...applyLinkedToggle(cur, { kind: 'param', key: name }, v) } : cur,
              )
            }
            onChangeParamValue={(name, v) =>
              setFilling((cur) => (cur ? { ...cur, pValues: { ...cur.pValues, [name]: v } } : cur))
            }
            onChangeOptionEnabled={(id, v) =>
              setFilling((cur) =>
                cur ? { ...cur, ...applyLinkedToggle(cur, { kind: 'option', key: id }, v) } : cur,
              )
            }
            onChangeOptionValue={(id, v) =>
              setFilling((cur) => (cur ? { ...cur, oValues: { ...cur.oValues, [id]: v } } : cur))
            }
            onResetItem={(kind, key) =>
              setFilling((cur) => {
                if (!cur) return cur
                clearSnippetState(cur.snippet.id)
                const pEnabled = { ...cur.pEnabled }
                const pValues = { ...cur.pValues }
                const oEnabled = { ...cur.oEnabled }
                const oValues = { ...cur.oValues }
                if (kind === 'param') {
                  const p = cur.params.find((x) => x.name === key)
                  if (!p) return cur
                  pEnabled[key] = p.defaultEnabled !== false
                  pValues[key] = p.defaultValue ?? ''
                } else {
                  const o = cur.options.find((x) => x.id === key)
                  if (!o) return cur
                  oEnabled[key] = o.defaultEnabled !== false
                  oValues[key] = o.value?.defaultValue ?? ''
                }
                expandLinks(cur.params, cur.options, pEnabled, oEnabled)
                normalizeExclusive(cur.params, cur.options, pEnabled, oEnabled)
                return { ...cur, pEnabled, pValues, oEnabled, oValues }
              })
            }
            onResetAll={() =>
              setFilling((cur) => {
                if (!cur) return cur
                clearSnippetState(cur.snippet.id)
                const pEnabled: Record<string, boolean> = {}
                const pValues: Record<string, string> = {}
                const oEnabled: Record<string, boolean> = {}
                const oValues: Record<string, string> = {}
                for (const p of cur.params) {
                  pEnabled[p.name] = p.defaultEnabled !== false
                  pValues[p.name] = p.defaultValue ?? ''
                }
                for (const o of cur.options) {
                  oEnabled[o.id] = o.defaultEnabled !== false
                  oValues[o.id] = o.value?.defaultValue ?? ''
                }
                expandLinks(cur.params, cur.options, pEnabled, oEnabled)
                normalizeExclusive(cur.params, cur.options, pEnabled, oEnabled)
                return { ...cur, pEnabled, pValues, oEnabled, oValues }
              })
            }
            onClose={closeFill}
            onSubmit={submitFill}
          />
        )}

        {showVarManager && (
          <VariableManagerDialog
            initial={globalVars}
            onClose={() => setShowVarManager(false)}
            onSaved={() => {
              setShowVarManager(false)
              void loadVars()
            }}
          />
        )}

        <div className="cmd-list-resize cmd-list-rh-n" onMouseDown={startResize('n')} />
        <div className="cmd-list-resize cmd-list-rh-s" onMouseDown={startResize('s')} />
        <div className="cmd-list-resize cmd-list-rh-e" onMouseDown={startResize('e')} />
        <div className="cmd-list-resize cmd-list-rh-w" onMouseDown={startResize('w')} />
        <div className="cmd-list-resize cmd-list-rh-ne" onMouseDown={startResize('ne')} />
        <div className="cmd-list-resize cmd-list-rh-nw" onMouseDown={startResize('nw')} />
        <div className="cmd-list-resize cmd-list-rh-se" onMouseDown={startResize('se')} />
        <div className="cmd-list-resize cmd-list-rh-sw" onMouseDown={startResize('sw')} />
      </div>

      {toast && <div className="cmd-list-toast">{toast}</div>}
    </div>
  )
}

// ===== Fill dialog (params + options) =====

interface SnippetFillDialogProps {
  snippet: CommandSnippetDto
  params: CommandParam[]
  options: CommandOption[]
  pEnabled: Record<string, boolean>
  pValues: Record<string, string>
  oEnabled: Record<string, boolean>
  oValues: Record<string, string>
  error: string | null
  onChangeParamEnabled: (name: string, value: boolean) => void
  onChangeParamValue: (name: string, value: string) => void
  onChangeOptionEnabled: (id: string, value: boolean) => void
  onChangeOptionValue: (id: string, value: string) => void
  onResetItem: (kind: 'param' | 'option', key: string) => void
  onResetAll: () => void
  onClose: () => void
  onSubmit: () => void
}

/** Select options including the current value, so a stale value is never lost. */
function selectOptions(def: string[], current: string): string[] {
  return current && !def.includes(current) ? [current, ...def] : def
}

const SnippetFillDialog: React.FC<SnippetFillDialogProps> = ({
  snippet,
  params,
  options,
  pEnabled,
  pValues,
  oEnabled,
  oValues,
  error,
  onChangeParamEnabled,
  onChangeParamValue,
  onChangeOptionEnabled,
  onChangeOptionValue,
  onResetItem,
  onResetAll,
  onClose,
  onSubmit,
}) => {
  const { t } = useI18n()
  const preview = resolveCommand(
    snippet.command,
    params,
    options,
    pEnabled,
    pValues,
    oEnabled,
    oValues,
  )
  return (
    <ModalOverlay>
      <div className="modal snip-fill-modal">
        <div className="modal-header">
          <h3>{t('snippetFillParamsTitle')}</h3>
          <span
            onClick={onClose}
            style={{ cursor: 'pointer', fontSize: 18, color: '#888' }}
            title={t('close')}
          >
            ✕
          </span>
        </div>
        <div className="modal-body">
          <div className="snip-fill-desc">{t('snippetFillParamsDesc')}</div>
          <div className="snip-fill-command-preview">{preview}</div>
          {/* The dialog is where the values are actually decided, so the note is
              more useful here than behind a hover. */}
          {snippet.description && (
            <div className="snip-fill-snippet-desc">{snippet.description}</div>
          )}

          {options.length > 0 && (
            <div className="snip-fill-group">
              <div className="snip-fill-group-title">{t('snippetOptionSection')}</div>
              {options.map((o, idx) => {
                const on = oEnabled[o.id] !== false
                const valueName = optionValueName(o)
                const links = linkLabels(o.enables, params, options)
                return (
                  <div
                    key={o.id}
                    className={'snip-fill-row' + (on ? '' : ' snip-fill-row--disabled')}
                  >
                    <label className="snip-fill-check" title={t('snippetFillToggle')}>
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={(e) => onChangeOptionEnabled(o.id, e.target.checked)}
                      />
                    </label>
                    <div className="snip-fill-label">
                      <span className="snip-fill-name">{o.label || o.text}</span>
                      {o.description && <span className="snip-fill-hint">{o.description}</span>}
                    </div>
                    {o.value &&
                      (o.value.type === 'select' ? (
                        <select
                          value={oValues[o.id] ?? ''}
                          disabled={!on}
                          autoFocus={idx === 0}
                          onChange={(e) => onChangeOptionValue(o.id, e.target.value)}
                        >
                          {selectOptions(o.value.options, oValues[o.id] ?? '').map((opt) => (
                            <option key={opt} value={opt}>
                              {opt}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          value={oValues[o.id] ?? ''}
                          disabled={!on}
                          spellCheck={false}
                          autoFocus={idx === 0}
                          onChange={(e) => onChangeOptionValue(o.id, e.target.value)}
                        />
                      ))}
                    {valueName && <span className="snip-fill-slot">{`\${${valueName}}`}</span>}
                    {links.length > 0 && (
                      <span
                        className="snip-fill-link"
                        title={t('snippetFillLinkList', { items: links.join(', ') })}
                      >
                        <Icon name="link" size={11} />
                      </span>
                    )}
                    <button
                      type="button"
                      className="snip-fill-reset"
                      onClick={() => onResetItem('option', o.id)}
                      title={t('snippetFillResetItem')}
                    >
                      <Icon name="refresh" size={12} />
                    </button>
                  </div>
                )
              })}
            </div>
          )}

          {params.length > 0 && (
            <div className="snip-fill-group">
              <div className="snip-fill-group-title">{t('snippetParamSection')}</div>
              {params.map((p, idx) => {
                const on = pEnabled[p.name] !== false
                const links = linkLabels(p.enables, params, options)
                return (
                  <div
                    key={p.name}
                    className={'snip-fill-row' + (on ? '' : ' snip-fill-row--disabled')}
                  >
                    <label className="snip-fill-check" title={t('snippetFillToggle')}>
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={(e) => onChangeParamEnabled(p.name, e.target.checked)}
                      />
                    </label>
                    <div className="snip-fill-label">
                      <span className="snip-fill-name">{p.name}</span>
                      {p.description && <span className="snip-fill-hint">{p.description}</span>}
                    </div>
                    {p.type === 'select' ? (
                      <select
                        value={pValues[p.name] ?? ''}
                        disabled={!on}
                        autoFocus={options.length === 0 && idx === 0}
                        onChange={(e) => onChangeParamValue(p.name, e.target.value)}
                      >
                        {selectOptions(p.options, pValues[p.name] ?? '').map((opt) => (
                          <option key={opt} value={opt}>
                            {opt}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        value={pValues[p.name] ?? ''}
                        disabled={!on}
                        spellCheck={false}
                        autoFocus={options.length === 0 && idx === 0}
                        placeholder={p.description ?? ''}
                        onChange={(e) => onChangeParamValue(p.name, e.target.value)}
                      />
                    )}
                    {links.length > 0 && (
                      <span
                        className="snip-fill-link"
                        title={t('snippetFillLinkList', { items: links.join(', ') })}
                      >
                        <Icon name="link" size={11} />
                      </span>
                    )}
                    <button
                      type="button"
                      className="snip-fill-reset"
                      onClick={() => onResetItem('param', p.name)}
                      title={t('snippetFillResetItem')}
                    >
                      <Icon name="refresh" size={12} />
                    </button>
                  </div>
                )
              })}
            </div>
          )}

          {error && <div className="snip-fill-error">{error}</div>}
        </div>
        <div className="modal-footer">
          <button className="btn-cancel" onClick={onClose}>
            {t('cancel')}
          </button>
          <button className="btn-secondary" onClick={onResetAll}>
            {t('snippetFillResetAll')}
          </button>
          <button className="btn-primary" onClick={onSubmit}>
            {t('snippetSend')}
          </button>
        </div>
      </div>
    </ModalOverlay>
  )
}

// ===== Global variable manager dialog =====

interface VarRow {
  origName: string | null
  name: string
  defaultValue: string
  description: string
}

interface VariableManagerDialogProps {
  initial: GlobalVariable[]
  onClose: () => void
  onSaved: () => void
}

/**
 * Unified library of global variables shared by all command-list snippets.
 * Rows are edited inline; saving validates names, upserts each variable and
 * deletes any whose name was changed or row removed.
 */
const VariableManagerDialog: React.FC<VariableManagerDialogProps> = ({
  initial,
  onClose,
  onSaved,
}) => {
  const { t } = useI18n()
  const [rows, setRows] = useState<VarRow[]>(() =>
    initial.map((v) => ({
      origName: v.name,
      name: v.name,
      defaultValue: v.defaultValue,
      description: v.description ?? '',
    })),
  )
  const [saving, setSaving] = useState(false)

  const updateRow = (idx: number, patch: Partial<VarRow>) => {
    setRows((cur) => cur.map((r, i) => (i === idx ? { ...r, ...patch } : r)))
  }

  const addRow = () => {
    setRows((cur) => [...cur, { origName: null, name: '', defaultValue: '', description: '' }])
  }

  const removeRow = (idx: number) => {
    setRows((cur) => cur.filter((_, i) => i !== idx))
  }

  const handleSave = async () => {
    const cleaned: VarRow[] = []
    const seenNames = new Set<string>()
    for (const r of rows) {
      const n = r.name.trim()
      if (!n && !r.defaultValue && !r.description.trim()) continue // empty draft row
      if (!VAR_NAME_REGEX.test(n)) {
        alert(t('cmdVarNameInvalid'))
        return
      }
      if (seenNames.has(n)) {
        alert(t('cmdVarDuplicate', { name: n }))
        return
      }
      seenNames.add(n)
      cleaned.push({ ...r, name: n })
    }

    setSaving(true)
    try {
      const now = new Date().toISOString()
      const origByName = new Map(initial.map((v) => [v.name, v]))
      const keptNames = new Set(cleaned.map((r) => r.name))

      // Delete variables whose row was removed or renamed.
      for (const v of initial) {
        if (!keptNames.has(v.name)) {
          await deleteGlobalVariable(v.name).catch((e) =>
            console.error('delete_global_variable failed:', e),
          )
        }
      }

      // Upsert the remaining rows.
      for (const r of cleaned) {
        const existing = origByName.get(r.origName ?? '') ?? origByName.get(r.name)
        await saveGlobalVariable({
          name: r.name,
          defaultValue: r.defaultValue,
          description: r.description.trim() ? r.description.trim() : undefined,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        })
      }
      onSaved()
    } catch (e) {
      console.error('Failed to save global variables:', e)
    } finally {
      setSaving(false)
    }
  }

  return (
    <ModalOverlay>
      <div className="modal cmd-var-modal">
        <div className="modal-header">
          <h3>{t('cmdVarManager')}</h3>
          <span
            onClick={onClose}
            style={{ cursor: 'pointer', fontSize: 18, color: '#888' }}
            title={t('close')}
          >
            ✕
          </span>
        </div>
        <div className="modal-body">
          {rows.length === 0 && <div className="snip-vars-empty">{t('cmdVarEmpty')}</div>}
          {rows.map((r, idx) => (
            <div key={idx} className="snip-var-row">
              <input
                className="snip-var-name"
                value={r.name}
                onChange={(e) => updateRow(idx, { name: e.target.value })}
                placeholder={t('cmdVarName')}
                spellCheck={false}
              />
              <input
                className="snip-var-default"
                value={r.defaultValue}
                onChange={(e) => updateRow(idx, { defaultValue: e.target.value })}
                placeholder={t('cmdVarDefault')}
                spellCheck={false}
              />
              <input
                className="snip-var-desc"
                value={r.description}
                onChange={(e) => updateRow(idx, { description: e.target.value })}
                placeholder={t('cmdVarDescription')}
              />
              <button
                type="button"
                className="snip-var-remove"
                onClick={() => removeRow(idx)}
                title={t('cmdVarRemove')}
              >
                <Icon name="trash" size={12} />
              </button>
            </div>
          ))}
          <button type="button" className="snip-var-add" onClick={addRow}>
            <Icon name="plus" size={12} /> {t('cmdVarAdd')}
          </button>
        </div>
        <div className="modal-footer">
          <button className="btn-cancel" onClick={onClose}>
            {t('cancel')}
          </button>
          <button className="btn-primary" onClick={() => void handleSave()} disabled={saving}>
            {saving ? t('loading') : t('cmdVarSave')}
          </button>
        </div>
      </div>
    </ModalOverlay>
  )
}

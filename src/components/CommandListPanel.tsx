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

/** Persisted window prefs (position, size, opacity, filter toggles). */
interface CmdListPrefs {
  pos: { x: number; y: number } | null
  size: { w: number; h: number } | null
  opacity: number
  favoriteOnly: boolean
  showHidden: boolean
  /** Show only the active terminal's connection (+ general) commands. */
  activeConnectionOnly: boolean
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
    optionsText: (p.options ?? []).join('\n'),
    description: p.description ?? '',
    defaultEnabled: p.defaultEnabled !== false,
    exclusiveGroup: p.exclusiveGroup ?? '',
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
    optionsText: (o.value?.options ?? []).join('\n'),
    valueDefault: o.value?.defaultValue ?? '',
    defaultEnabled: o.defaultEnabled !== false,
    exclusiveGroup: o.exclusiveGroup ?? '',
    valueSeparator: optionSeparator(o.text),
  }))
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
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
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
    }
  }, [open, reload, loadVars])

  // Close the context menu on outside click / Escape.
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null)
    }
    document.addEventListener('click', close)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('click', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [menu])

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
    })
  }, [pos, size, panelOpacity, favoriteOnly, showHidden, activeConnectionOnly])

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
      const hay = `${s.command} ${s.alias ?? ''}`.toLowerCase()
      if (!hay.includes(query.toLowerCase())) return false
    }
    return true
  })

  // Scope to the active terminal's connection (+ general) when enabled.
  const scoped =
    activeConnectionOnly && activeConnectionId
      ? filtered.filter((s) => !s.connectionId || s.connectionId === activeConnectionId)
      : filtered

  // Group by connection: general first, then configured connections, then any
  // dangling connection ids (deleted connections). Empty groups are hidden.
  const groups: Array<{ id: string; title: string; items: CommandSnippetDto[] }> = []
  const generalItems = scoped.filter((s) => !s.connectionId)
  if (generalItems.length > 0) {
    groups.push({ id: '__general__', title: t('snippetGroupGeneral'), items: generalItems })
  }
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
      })
    }
  }
  const unknownItems = scoped.filter((s) => s.connectionId && !knownConnIds.has(s.connectionId))
  if (unknownItems.length > 0) {
    groups.push({ id: '__unknown__', title: t('snippetGroupUnknown'), items: unknownItems })
  }

  const toggleGroup = (id: string) => {
    setCollapsedGroups((cur) => {
      const next = new Set(cur)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const sendNow = (resolved: string) => {
    const tid = activeTabId
    onSendToTerminal(resolved)
    if (tid != null) requestAnimationFrame(() => focusTerminal(tid))
  }

  /** Send a snippet, opening the fill dialog when it has params/options. */
  const send = (s: CommandSnippetDto) => {
    setMenu(null)
    setFillError(null)
    const params = resolveParamDefs(s)
    const options = s.options ?? []

    if (params.length > 0 || options.length > 0) {
      const saved = loadSnippetState(s.id)
      const pEnabled: Record<string, boolean> = {}
      const pValues: Record<string, string> = {}
      for (const p of params) {
        pEnabled[p.name] = saved?.pEnabled[p.name] ?? p.defaultEnabled !== false
        pValues[p.name] = saved?.pValues[p.name] ?? p.defaultValue ?? ''
      }
      const oEnabled: Record<string, boolean> = {}
      const oValues: Record<string, string> = {}
      for (const o of options) {
        oEnabled[o.id] = saved?.oEnabled[o.id] ?? o.defaultEnabled !== false
        oValues[o.id] = saved?.oValues[o.id] ?? o.value?.defaultValue ?? ''
      }
      // A mis-authored default (or stale memory) could enable two members of
      // one exclusive group — collapse to the first before showing the dialog.
      normalizeExclusive(params, options, pEnabled, oEnabled)
      setFilling({ snippet: s, params, options, pEnabled, pValues, oEnabled, oValues })
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
    setEditingParams(toEditingParams(s.params ?? []))
    setEditingOptions(toEditingOptions(s.options ?? []))
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
    setEditingParams([])
    setEditingOptions([])
  }

  const closeDialog = () => {
    setEditing(null)
    setIsAdding(false)
    setDialogPos(null)
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
      })
    }
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
        </div>

        <div className="cmd-list-body">
          {loading ? (
            <div className="cmd-list-empty">{t('loading')}</div>
          ) : groups.length === 0 ? (
            <div className="cmd-list-empty">
              {filtered.length > 0 ? t('snippetNoCommandsForConnection') : t('commandListEmpty')}
            </div>
          ) : (
            groups.map((g) => (
              <div key={g.id} className="cmd-list-section">
                <div className="cmd-list-section-header" onClick={() => toggleGroup(g.id)}>
                  <Icon
                    name="chevronDown"
                    size={12}
                    className={
                      'cmd-list-section-chevron' + (collapsedGroups.has(g.id) ? ' collapsed' : '')
                    }
                  />
                  <span className="cmd-list-section-title">{g.title}</span>
                  <span className="cmd-list-section-count">{g.items.length}</span>
                </div>
                {!collapsedGroups.has(g.id) &&
                  g.items.map((s) => (
                    <div
                      key={s.id}
                      className={
                        'cmd-list-item' +
                        (s.favorite ? ' favorite' : '') +
                        (s.hidden ? ' hidden' : '')
                      }
                      title={s.command}
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
                            'cmd-list-action cmd-list-action--hidden' + (s.hidden ? ' active' : '')
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
            ))
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
            <div className="context-menu-divider" />
            <div className="context-menu-item" onClick={() => startEdit(menu.snippet)}>
              <Icon name="edit" size={12} /> {t('edit')}
            </div>
            <div className="context-menu-item danger" onClick={() => remove(menu.snippet)}>
              <Icon name="trash" size={12} /> {t('delete')}
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
                <div className="form-group">
                  <label>{t('snippetCommand')}</label>
                  <textarea
                    value={editingCommand}
                    onChange={(e) => setEditingCommand(e.target.value)}
                    placeholder={t('snippetCommandPlaceholder')}
                    rows={4}
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
                          <input
                            className="snip-param-options"
                            value={p.optionsText}
                            onChange={(e) => updateParam(idx, { optionsText: e.target.value })}
                            placeholder={t('snippetParamOptions')}
                            spellCheck={false}
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
                          <input
                            className="snip-option-options"
                            value={o.optionsText}
                            onChange={(e) => updateOption(idx, { optionsText: e.target.value })}
                            placeholder={t('snippetParamOptions')}
                            spellCheck={false}
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
                cur
                  ? { ...cur, ...applyExclusiveToggle(cur, { kind: 'param', key: name }, v) }
                  : cur,
              )
            }
            onChangeParamValue={(name, v) =>
              setFilling((cur) => (cur ? { ...cur, pValues: { ...cur.pValues, [name]: v } } : cur))
            }
            onChangeOptionEnabled={(id, v) =>
              setFilling((cur) =>
                cur
                  ? { ...cur, ...applyExclusiveToggle(cur, { kind: 'option', key: id }, v) }
                  : cur,
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

          {options.length > 0 && (
            <div className="snip-fill-group">
              <div className="snip-fill-group-title">{t('snippetOptionSection')}</div>
              {options.map((o, idx) => {
                const on = oEnabled[o.id] !== false
                const valueName = optionValueName(o)
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

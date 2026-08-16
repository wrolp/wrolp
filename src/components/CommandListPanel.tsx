import React, { useState, useEffect, useCallback, useRef } from 'react'
import type { CommandSnippetDto, GlobalVariable } from '../types'
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

/** Replace every occurrence of `${name}` with `value` for the provided values. */
function applyVariables(
  command: string,
  values: Record<string, string>,
): string {
  return command.replace(VAR_REGEX, (match, name: string) =>
    name in values ? values[name] : match,
  )
}

/** Persisted window prefs (position, size, opacity, filter toggles). */
interface CmdListPrefs {
  pos: { x: number; y: number } | null
  size: { w: number; h: number } | null
  opacity: number
  favoriteOnly: boolean
  showHidden: boolean
}

const CMDLIST_PREFS_KEY = 'wrolp.cmdListPrefs'

function defaultPrefs(): CmdListPrefs {
  return { pos: null, size: null, opacity: 1, favoriteOnly: false, showHidden: false }
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
  /** Send the command text to the terminal WITHOUT executing it (no Enter). */
  onSendToTerminal: (command: string) => void
}

/** A `${name}` placeholder awaiting a value before the snippet can be sent. */
interface PendingVar {
  name: string
  description?: string
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
  onSendToTerminal,
}) => {
  const { t } = useI18n()
  const [snippets, setSnippets] = useState<CommandSnippetDto[]>([])
  const [globalVars, setGlobalVars] = useState<GlobalVariable[]>([])
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [favoriteOnly, setFavoriteOnly] = useState(() => loadCmdListPrefs().favoriteOnly)
  const [showHidden, setShowHidden] = useState(() => loadCmdListPrefs().showHidden)
  const [menu, setMenu] = useState<{ x: number; y: number; snippet: CommandSnippetDto } | null>(
    null,
  )
  const [editing, setEditing] = useState<CommandSnippetDto | null>(null)
  const [isAdding, setIsAdding] = useState(false)
  const [editingAlias, setEditingAlias] = useState('')
  const [editingCommand, setEditingCommand] = useState('')
  const [toast, setToast] = useState<string | null>(null)
  const [showVarManager, setShowVarManager] = useState(false)
  // Snippet awaiting variable values before we can send it.
  const [filling, setFilling] = useState<{
    snippet: CommandSnippetDto
    pending: PendingVar[]
    values: Record<string, string>
  } | null>(null)

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
    saveCmdListPrefs({ pos, size, opacity: panelOpacity, favoriteOnly, showHidden })
  }, [pos, size, panelOpacity, favoriteOnly, showHidden])

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

  /** Send a snippet, substituting global defaults and prompting for the rest. */
  const send = (s: CommandSnippetDto) => {
    setMenu(null)
    const names = extractVariables(s.command)
    const defs = new Map(globalVars.map((v) => [v.name, v]))

    const pending: PendingVar[] = names
      .filter((n) => !defs.has(n) || defs.get(n)!.defaultValue.length === 0)
      .map((n) => ({ name: n, description: defs.get(n)?.description }))

    if (pending.length === 0) {
      const values: Record<string, string> = {}
      for (const n of names) values[n] = defs.get(n)?.defaultValue ?? ''
      onSendToTerminal(applyVariables(s.command, values))
      const tid = activeTabId
      if (tid != null) requestAnimationFrame(() => focusTerminal(tid))
      return
    }

    // Prefill values from global defaults (all empty here since non-empty
    // defaults were filtered out above — but keep it explicit).
    const initial: Record<string, string> = {}
    for (const p of pending) initial[p.name] = defs.get(p.name)?.defaultValue ?? ''
    setFilling({ snippet: s, pending, values: initial })
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
  }

  /** Open the dialog in "add new" mode (blank snippet, created on save). */
  const startAdd = () => {
    setMenu(null)
    setIsAdding(true)
    setEditing({} as CommandSnippetDto)
    setEditingAlias('')
    setEditingCommand('')
  }

  const closeDialog = () => {
    setEditing(null)
    setIsAdding(false)
    setDialogPos(null)
  }

  const saveEdit = async () => {
    const command = editingCommand.trim()
    if (command.length === 0) return
    if (isAdding) {
      try {
        await saveCommandSnippet({
          id: `snip-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          command,
          alias: editingAlias.trim() || null,
          favorite: false,
          hidden: false,
          sortOrder: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
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
        updatedAt: new Date().toISOString(),
      })
    }
    closeDialog()
  }

  const remove = async (s: CommandSnippetDto) => {
    if (!window.confirm(t('deleteSnippetConfirm'))) return
    setMenu(null)
    try {
      await deleteCommandSnippet(s.id)
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
    opacity: panelOpacity,
  }

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
          ) : filtered.length === 0 ? (
            <div className="cmd-list-empty">{t('commandListEmpty')}</div>
          ) : (
            filtered.map((s) => (
              <div
                key={s.id}
                className={
                  'cmd-list-item' + (s.favorite ? ' favorite' : '') + (s.hidden ? ' hidden' : '')
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
                  {extractVariables(s.command).length > 0 && (
                    <span className="cmd-list-var-badge" title={t('cmdVarManager')}>
                      {'$'}{extractVariables(s.command).length}
                    </span>
                  )}
                </div>
                {s.hidden && <Icon name="eyeOff" size={11} className="cmd-list-hidden-icon" />}
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
          <div className="modal-overlay" onClick={closeDialog}>
            <div
              className="modal cmd-list-modal-drag"
              onClick={(e) => e.stopPropagation()}
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
                  <label>{t('snippetCommand')}</label>
                  <textarea
                    value={editingCommand}
                    onChange={(e) => setEditingCommand(e.target.value)}
                    placeholder={t('snippetCommandPlaceholder')}
                    rows={4}
                  />
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
          </div>
        )}

        {filling && (
          <SnippetFillDialog
            snippet={filling.snippet}
            pending={filling.pending}
            values={filling.values}
            onChangeValue={(name, v) =>
              setFilling((cur) => (cur ? { ...cur, values: { ...cur.values, [name]: v } } : cur))
            }
            onClose={() => setFilling(null)}
            onSubmit={() => {
              if (!filling) return
              // Merge global defaults with what the user filled in the dialog.
              const full: Record<string, string> = {}
              for (const v of globalVars) full[v.name] = v.defaultValue
              for (const [k, v] of Object.entries(filling.values)) full[k] = v
              const resolved = applyVariables(filling.snippet.command, full)
              const tid = activeTabId
              setFilling(null)
              onSendToTerminal(resolved)
              if (tid != null) requestAnimationFrame(() => focusTerminal(tid))
            }}
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

// ===== Variable fill dialog =====

interface SnippetFillDialogProps {
  snippet: CommandSnippetDto
  pending: PendingVar[]
  values: Record<string, string>
  onChangeValue: (name: string, value: string) => void
  onClose: () => void
  onSubmit: () => void
}

const SnippetFillDialog: React.FC<SnippetFillDialogProps> = ({
  snippet,
  pending,
  values,
  onChangeValue,
  onClose,
  onSubmit,
}) => {
  const { t } = useI18n()
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal snip-fill-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{t('snippetFillVarsTitle')}</h3>
          <span
            onClick={onClose}
            style={{ cursor: 'pointer', fontSize: 18, color: '#888' }}
            title={t('close')}
          >
            ✕
          </span>
        </div>
        <div className="modal-body">
          <div className="snip-fill-desc">{t('snippetFillVarsDesc')}</div>
          <div className="snip-fill-command-preview">{snippet.command}</div>
          {pending.map((v) => (
            <div key={v.name} className="form-group">
              <label>{v.name}</label>
              <input
                value={values[v.name] ?? ''}
                onChange={(e) => onChangeValue(v.name, e.target.value)}
                placeholder={v.description ?? ''}
                autoFocus={pending[0]?.name === v.name}
                spellCheck={false}
              />
              {v.description && <div className="snip-fill-hint">{v.description}</div>}
            </div>
          ))}
        </div>
        <div className="modal-footer">
          <button className="btn-cancel" onClick={onClose}>
            {t('cancel')}
          </button>
          <button className="btn-primary" onClick={onSubmit}>
            {t('snippetSend')}
          </button>
        </div>
      </div>
    </div>
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
    setRows((cur) => [
      ...cur,
      { origName: null, name: '', defaultValue: '', description: '' },
    ])
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
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal cmd-var-modal" onClick={(e) => e.stopPropagation()}>
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
    </div>
  )
}

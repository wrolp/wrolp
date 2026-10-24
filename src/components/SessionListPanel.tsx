import React, { useState, useEffect, useCallback, useRef } from 'react'
import type { ConnectionConfig, SessionSummary } from '../types'
import {
  listSessions,
  deleteSession,
  deleteAllSessions,
  renameSession,
  extractCommands,
  revealSessionFile,
  exportLegacySessions,
  rescanRecordingFiles,
  exportSessionCast,
} from '../commands'
import { save } from '@tauri-apps/plugin-dialog'
import { ConfirmDialog } from './ConfirmDialog'
import { Icon } from './Icon'
import type { IconName } from './Icon'
import { useI18n } from '../i18n'

/**
 * Below this row width the six inline icon buttons would leave the title/meta column
 * too little room, so they collapse into one menu button. The number is the buttons'
 * own footprint (6 × ~28px + gaps) plus a readable info column and the row's padding.
 */
const INLINE_ACTIONS_MIN_WIDTH = 320

/**
 * The toolbar's threshold is higher: its connection filter (~140px) and the session
 * count (~60px) stay on the line, and the four buttons add ~130px on top.
 */
const INLINE_TOOLBAR_MIN_WIDTH = 360

/** One panel action, rendered inline on a wide panel and as a menu item on a narrow one. */
interface PanelAction {
  key: string
  icon: IconName
  label: string
  /** Tooltip override — the recording path for "show in folder". */
  title?: string
  disabled?: boolean
  /** Red styling for the destructive verb. */
  danger?: boolean
  run: () => void
}

/**
 * An open action menu, in viewport coordinates. Both strips share the machinery so
 * they behave the same way: close on outside click or Escape, and keep the action
 * list identical between the inline and collapsed forms.
 */
type PanelMenu =
  | { kind: 'row'; session: SessionSummary; x: number; y: number }
  | { kind: 'toolbar'; x: number; y: number }

interface SessionListPanelProps {
  connections: ConnectionConfig[]
  onPlaySession: (session: SessionSummary) => void
  onExtractCommands: (commands: string[]) => void
}

export const SessionListPanel: React.FC<SessionListPanelProps> = ({
  connections,
  onPlaySession,
  onExtractCommands,
}) => {
  const { t } = useI18n()
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [filterConn, setFilterConn] = useState<string>('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [confirm, setConfirm] = useState<{
    title: string
    message: string
    danger: boolean
    confirmLabel?: string
    onConfirm: () => void
  } | null>(null)
  // The panel is a resizable column (160–500px). Its two action strips need different
  // amounts of room, so one measurement feeds both thresholds rather than each
  // watching the element itself.
  const panelRef = useRef<HTMLDivElement>(null)
  const [panelWidth, setPanelWidth] = useState(0)
  const compactRow = panelWidth > 0 && panelWidth < INLINE_ACTIONS_MIN_WIDTH
  const compactToolbar = panelWidth > 0 && panelWidth < INLINE_TOOLBAR_MIN_WIDTH
  const [menu, setMenu] = useState<PanelMenu | null>(null)

  useEffect(() => {
    const el = panelRef.current
    if (!el) return
    const measure = (width: number) => setPanelWidth(width)
    measure(el.getBoundingClientRect().width)
    const ro = new ResizeObserver(([entry]) => measure(entry.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // The menus are positioned in viewport coordinates, so they have to close on the
  // interactions that would otherwise leave them floating over the list.
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('click', close)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('click', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const result = await listSessions(filterConn || undefined, 200)
      setSessions(result)
    } catch (e) {
      console.error('Failed to load sessions:', e)
    } finally {
      setLoading(false)
    }
  }, [filterConn])

  useEffect(() => {
    reload()
  }, [reload])

  const handleDelete = (id: string) => {
    setConfirm({
      title: t('deleteSession'),
      message: t('deleteSessionConfirm'),
      danger: false,
      onConfirm: async () => {
        await deleteSession(id)
        setConfirm(null)
        reload()
      },
    })
  }

  const handleDeleteAll = () => {
    setConfirm({
      title: t('deleteAllSessions'),
      message: t('deleteAllSessionsConfirm'),
      danger: true,
      onConfirm: async () => {
        await deleteAllSessions()
        setConfirm(null)
        reload()
      },
    })
  }

  const handleRename = async (id: string) => {
    if (editTitle.trim()) {
      await renameSession(id, editTitle.trim())
      setEditingId(null)
      reload()
    }
  }

  const handleExtract = async (id: string) => {
    try {
      const commands = await extractCommands(id)
      onExtractCommands(commands)
    } catch (e) {
      console.error('Failed to extract commands:', e)
    }
  }

  const handleReveal = async (id: string) => {
    try {
      await revealSessionFile(id)
    } catch (e) {
      console.error('Failed to reveal session file:', e)
    }
  }

  const startRename = (s: SessionSummary) => {
    setEditingId(s.id)
    setEditTitle(s.title || s.connectionName || '')
  }

  /**
   * The row's actions in display order. The compact menu renders this same list, so a
   * width change can never hide an action or drift the two forms apart.
   */
  const rowActions = (s: SessionSummary): PanelAction[] => {
    const actions: PanelAction[] = [
      {
        key: 'play',
        icon: 'play',
        label: t('playback'),
        disabled: s.eventCount === 0,
        run: () => onPlaySession(s),
      },
      {
        key: 'extract',
        icon: 'clipboard',
        label: t('extractCommands'),
        run: () => void handleExtract(s.id),
      },
      {
        key: 'cast',
        icon: 'download',
        label: t('exportCast'),
        disabled: s.eventCount === 0,
        run: () => void handleExportCast(s),
      },
    ]
    if (s.eventsFile) {
      actions.push({
        key: 'reveal',
        icon: 'folderOpen',
        label: t('showInFolder'),
        title: t('recordingFilePath', { path: s.eventsFile }),
        run: () => void handleReveal(s.id),
      })
    }
    actions.push(
      { key: 'rename', icon: 'edit', label: t('rename'), run: () => startRename(s) },
      {
        key: 'delete',
        icon: 'trash',
        label: t('delete'),
        danger: true,
        run: () => handleDelete(s.id),
      },
    )
    return actions
  }

  /** The toolbar's four verbs, in their inline order. */
  const toolbarActions = (): PanelAction[] => [
    { key: 'reload', icon: 'refresh', label: t('refresh'), run: () => void reload() },
    { key: 'migrate', icon: 'upload', label: t('migrateLegacy'), run: handleMigrateLegacy },
    { key: 'rescan', icon: 'search', label: t('rescanRecordings'), run: () => void runRescan() },
    {
      key: 'delete-all',
      icon: 'trash',
      label: t('deleteAllSessions'),
      danger: true,
      run: handleDeleteAll,
    },
  ]

  const openMenu = (
    e: React.MouseEvent<HTMLButtonElement>,
    target: { kind: 'row'; session: SessionSummary } | { kind: 'toolbar' },
  ) => {
    e.stopPropagation()
    const r = e.currentTarget.getBoundingClientRect()
    // Right-align the menu with the button, and keep it inside the window: the panel
    // can be docked on either side, so "open to the left" is not a safe default.
    const width = 176
    const x = Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8))
    const y = Math.min(r.bottom + 4, window.innerHeight - 200)
    setMenu(
      target.kind === 'row' ? { kind: 'row', session: target.session, x, y } : { ...target, x, y },
    )
  }

  /** Shared by both menus, so the row and toolbar menus cannot drift apart. */
  const renderMenuItems = (actions: PanelAction[]) =>
    actions.map((a) => (
      <div
        key={a.key}
        role="menuitem"
        className={`context-menu-item${a.danger ? ' ctx-danger' : ''}${
          a.disabled ? ' is-disabled' : ''
        }`}
        aria-disabled={a.disabled || undefined}
        title={a.title}
        onClick={() => {
          if (a.disabled) return
          setMenu(null)
          a.run()
        }}
      >
        <Icon name={a.icon} size={14} />
        {a.label}
      </div>
    ))

  const failedText = (failed: string[]) =>
    failed.length
      ? '\n\n' +
        t('failedItems') +
        '\n' +
        failed.slice(0, 5).join('\n') +
        (failed.length > 5 ? '\n…' : '')
      : ''

  /** FUT1: one-click export of legacy SQLite-backed sessions into files. */
  const runLegacyMigration = async () => {
    setConfirm(null)
    try {
      const r = await exportLegacySessions()
      reload()
      setConfirm({
        title: t('migrateLegacyDoneTitle'),
        message:
          r.migrated === 0
            ? t('migrateLegacyNone') + failedText(r.failed)
            : t('migrateLegacyDone', { m: r.migrated, e: r.events }) + failedText(r.failed),
        danger: r.failed.length > 0,
        confirmLabel: t('ok'),
        onConfirm: () => setConfirm(null),
      })
    } catch (e) {
      console.error('Legacy migration failed:', e)
      setConfirm(null)
    }
  }

  /** FUT2: scan `recordings/` and rebuild session rows for orphan files. */
  const handleMigrateLegacy = () => {
    setConfirm({
      title: t('migrateLegacy'),
      message: t('migrateLegacyConfirm'),
      danger: true,
      confirmLabel: t('confirmMigrate'),
      onConfirm: runLegacyMigration,
    })
  }

  const runRescan = async () => {
    try {
      const r = await rescanRecordingFiles()
      reload()
      setConfirm({
        title: t('rescanDoneTitle'),
        message:
          (r.restored > 0
            ? t('rescanDone', { restored: r.restored, empty: r.removedEmpty })
            : t('rescanNone')) + failedText(r.failed),
        danger: r.failed.length > 0,
        confirmLabel: t('ok'),
        onConfirm: () => setConfirm(null),
      })
    } catch (e) {
      console.error('Recording rescan failed:', e)
    }
  }

  /** FUT3: export one session as an asciinema v2 `.cast` file. */
  const handleExportCast = async (s: SessionSummary) => {
    try {
      const target = await save({
        title: t('exportCastTitle'),
        defaultPath: `session-${s.startedAt.slice(0, 10)}.cast`,
        filters: [{ name: 'asciinema', extensions: ['cast'] }],
      })
      if (!target) return
      const r = await exportSessionCast(s.id, target)
      setConfirm({
        title: t('exportCastDoneTitle'),
        message: t('exportCastDone', { lines: r.lines, path: r.path }),
        danger: false,
        confirmLabel: t('ok'),
        onConfirm: () => setConfirm(null),
      })
    } catch (e) {
      console.error('Cast export failed:', e)
    }
  }

  const formatDuration = (seconds: number | null) => {
    if (!seconds) return '-'
    const h = Math.floor(seconds / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    const s = seconds % 60
    if (h > 0) return `${h}h ${m}m`
    if (m > 0) return `${m}m ${s}s`
    return `${s}s`
  }

  const formatDate = (iso: string) => {
    const d = new Date(iso)
    return d.toLocaleString(undefined, {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  return (
    <div className="session-list-panel" ref={panelRef}>
      <div className="panel-toolbar">
        <select
          value={filterConn}
          onChange={(e) => setFilterConn(e.target.value)}
          className="filter-select"
        >
          <option value="">{t('allConnections')}</option>
          {connections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        {compactToolbar ? (
          <button
            type="button"
            className="refresh-btn session-more-btn"
            title={t('moreActions')}
            aria-label={t('moreActions')}
            aria-haspopup="menu"
            aria-expanded={menu?.kind === 'toolbar'}
            onClick={(e) => openMenu(e, { kind: 'toolbar' })}
          >
            <Icon name="more" />
          </button>
        ) : (
          <>
            <button onClick={reload} className="refresh-btn" title={t('refresh')}>
              <Icon name="refresh" />
            </button>
            <button
              onClick={handleMigrateLegacy}
              className="refresh-btn"
              title={t('migrateLegacy')}
            >
              <Icon name="upload" />
            </button>
            <button onClick={runRescan} className="refresh-btn" title={t('rescanRecordings')}>
              <Icon name="search" />
            </button>
            <button
              onClick={handleDeleteAll}
              className="delete-all-btn"
              title={t('deleteAllSessions')}
            >
              <Icon name="trash" />
            </button>
          </>
        )}
        <span className="session-count">{t('sessionCount', { n: sessions.length })}</span>
      </div>

      {loading ? (
        <div className="panel-empty">{t('loadingSessions')}</div>
      ) : sessions.length === 0 ? (
        <div className="panel-empty">{t('noRecordedSessions')}</div>
      ) : (
        <div className="session-table">
          {sessions.map((s) => (
            <div key={s.id} className="session-row">
              <div className="session-row-info">
                {editingId === s.id ? (
                  <input
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleRename(s.id)
                      if (e.key === 'Escape') setEditingId(null)
                    }}
                    onBlur={() => handleRename(s.id)}
                    autoFocus
                    className="rename-input"
                  />
                ) : (
                  <span
                    className="session-name"
                    onDoubleClick={() => {
                      setEditingId(s.id)
                      setEditTitle(s.title || s.connectionName || '')
                    }}
                  >
                    {s.title || s.connectionName || t('unknown')}
                  </span>
                )}
                <span className="session-meta">
                  {s.workspaceName && s.groupName && (
                    <span className="session-loc">
                      {s.workspaceName} / {s.groupName}
                    </span>
                  )}
                  {formatDate(s.startedAt)} · {formatDuration(s.durationSeconds)} · {s.eventCount}{' '}
                  {t('events')}
                </span>
              </div>
              <div className="session-row-actions">
                {compactRow ? (
                  <button
                    type="button"
                    className="session-more-btn"
                    title={t('moreActions')}
                    aria-label={t('moreActions')}
                    aria-haspopup="menu"
                    aria-expanded={menu?.kind === 'row' && menu.session.id === s.id}
                    onClick={(e) => openMenu(e, { kind: 'row', session: s })}
                  >
                    <Icon name="more" />
                  </button>
                ) : (
                  rowActions(s).map((a) => (
                    <button
                      key={a.key}
                      type="button"
                      onClick={a.run}
                      title={a.title ?? a.label}
                      aria-label={a.label}
                      disabled={a.disabled}
                    >
                      <Icon name={a.icon} />
                    </button>
                  ))
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* One menu serves both collapsed strips. Fixed coordinates from the button, so
          it escapes the row's `overflow: hidden` instead of being clipped. */}
      {menu && (
        <div
          className="context-menu session-action-menu"
          role="menu"
          style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {menu.kind === 'row'
            ? renderMenuItems(rowActions(menu.session))
            : renderMenuItems(toolbarActions())}
        </div>
      )}

      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          message={confirm.message}
          danger={confirm.danger}
          confirmLabel={confirm.confirmLabel ?? t('deleteSessionBtn')}
          onConfirm={confirm.onConfirm}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  )
}

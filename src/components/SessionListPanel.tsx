import React, { useState, useEffect, useCallback } from 'react'
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
import { useI18n } from '../i18n'

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

  const failedText = (failed: string[]) =>
    failed.length
      ? '\n\n' + t('failedItems') + '\n' + failed.slice(0, 5).join('\n') + (failed.length > 5 ? '\n…' : '')
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
    <div className="session-list-panel">
      <div className="panel-toolbar">
        <select
          value={filterConn}
          onChange={(e) => setFilterConn(e.target.value)}
          className="filter-select"
        >
          <option value="">{t('allConnections')}</option>
          {connections.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        <button onClick={reload} className="refresh-btn" title={t('refresh')}><Icon name="refresh" /></button>
        <button onClick={handleMigrateLegacy} className="refresh-btn" title={t('migrateLegacy')}>
          <Icon name="upload" />
        </button>
        <button onClick={runRescan} className="refresh-btn" title={t('rescanRecordings')}>
          <Icon name="search" />
        </button>
        <button onClick={handleDeleteAll} className="delete-all-btn" title={t('deleteAllSessions')}>
          <Icon name="trash" />
        </button>
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
                <button
                  onClick={() => onPlaySession(s)}
                  title={t('playback')}
                  disabled={s.eventCount === 0}
                >
                  <Icon name="play" />
                </button>
                <button onClick={() => handleExtract(s.id)} title={t('extractCommands')}>
                  <Icon name="clipboard" />
                </button>
                <button
                  onClick={() => handleExportCast(s)}
                  title={t('exportCast')}
                  disabled={s.eventCount === 0}
                >
                  <Icon name="download" />
                </button>
                {s.eventsFile && (
                  <button
                    onClick={() => handleReveal(s.id)}
                    title={
                      s.eventsFile
                        ? t('recordingFilePath', { path: s.eventsFile })
                        : t('showInFolder')
                    }
                  >
                    <Icon name="folderOpen" />
                  </button>
                )}
                <button
                  onClick={() => {
                    setEditingId(s.id)
                    setEditTitle(s.title || s.connectionName || '')
                  }}
                  title={t('rename')}
                >
                  <Icon name="edit" />
                </button>
                <button onClick={() => handleDelete(s.id)} title={t('delete')}>
                  <Icon name="trash" />
                </button>
              </div>
            </div>
          ))}
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

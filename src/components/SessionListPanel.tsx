import React, { useState, useEffect, useCallback } from 'react'
import type { ConnectionConfig, SessionSummary } from '../types'
import { listSessions, deleteSession, renameSession, extractCommands } from '../commands'

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
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [filterConn, setFilterConn] = useState<string>('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')

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

  const handleDelete = async (id: string) => {
    if (confirm('Delete this session recording?')) {
      await deleteSession(id)
      reload()
    }
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
          <option value="">All connections</option>
          {connections.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        <button onClick={reload} className="refresh-btn" title="Refresh">🔄</button>
        <span className="session-count">{sessions.length} sessions</span>
      </div>

      {loading ? (
        <div className="panel-empty">Loading...</div>
      ) : sessions.length === 0 ? (
        <div className="panel-empty">No recorded sessions yet</div>
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
                    {s.title || s.connectionName || 'Unknown'}
                  </span>
                )}
                <span className="session-meta">
                  {formatDate(s.startedAt)} · {formatDuration(s.durationSeconds)} · {s.eventCount} events
                </span>
              </div>
              <div className="session-row-actions">
                <button
                  onClick={() => onPlaySession(s)}
                  title="Playback"
                  disabled={s.eventCount === 0}
                >
                  ▶
                </button>
                <button onClick={() => handleExtract(s.id)} title="Extract commands">
                  📋
                </button>
                <button
                  onClick={() => {
                    setEditingId(s.id)
                    setEditTitle(s.title || s.connectionName || '')
                  }}
                  title="Rename"
                >
                  ✏️
                </button>
                <button onClick={() => handleDelete(s.id)} title="Delete">
                  🗑️
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

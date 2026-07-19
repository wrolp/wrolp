import React, { useState, useCallback, useMemo } from 'react'
import { v4 as uuidv4 } from 'uuid'
import { open } from '@tauri-apps/plugin-dialog'
import type { ConnectionConfig } from '../types'
import { saveConnection as saveConn, deleteConnection } from '../commands'
import { useCustomScrollbar } from '../hooks/useCustomScrollbar'

interface ConnectionManagerProps {
  connections: ConnectionConfig[]
  onConnect: (config: ConnectionConfig, tabId: number) => void
  onTabClosed: (tabId: number) => void
  activeTabId: number | null
  onConnectionChange: () => void
  onSelectConnection: (config: ConnectionConfig) => void
  sidebarWidth: number
  expanded?: boolean
  onToggleExpanded?: () => void
}

const UNGROUPED = '__ungrouped__'

export const ConnectionManager: React.FC<ConnectionManagerProps> = ({
  connections,
  onConnect,
  onTabClosed,
  activeTabId,
  onConnectionChange,
  onSelectConnection,
  sidebarWidth,
  expanded = true,
  onToggleExpanded,
}) => {
  const [showModal, setShowModal] = useState(false)
  const [editing, setEditing] = useState<ConnectionConfig | null>(null)
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    conn: ConnectionConfig
  } | null>(null)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())

  const {
    listRef,
    thumbHeight,
    thumbTop,
    showThumb,
    onScroll,
    onThumbMouseDown,
    onMouseEnter,
    onMouseLeave,
  } = useCustomScrollbar()

  // Group connections by `group` field, preserving insertion order
  const grouped = useMemo(() => {
    const map = new Map<string, ConnectionConfig[]>()
    for (const conn of connections) {
      const key = conn.group?.trim() || UNGROUPED
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(conn)
    }
    return Array.from(map.entries())
  }, [connections])

  const toggleGroup = (key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const handleEdit = (conn: ConnectionConfig) => {
    setEditing(conn)
    setShowModal(true)
  }

  const handleDelete = async (conn: ConnectionConfig) => {
    if (confirm(`Delete connection "${conn.name}"?`)) {
      await deleteConnection(conn.id)
      onConnectionChange()
    }
    setContextMenu(null)
  }

  return (
    <>
      <div className="sidebar">
        <div className="sidebar-header">
          <span
            className="collapse-chevron"
            onClick={onToggleExpanded}
            title={expanded ? 'Collapse' : 'Expand'}
          >
            {expanded ? '▼' : '▶'}
          </span>
          <span style={{ flex: 1 }}>Connections</span>
          {expanded && (
            <button
              onClick={() => {
                setEditing(null)
                setShowModal(true)
              }}
              style={{
                background: 'none',
                border: 'none',
                color: '#007acc',
                cursor: 'pointer',
                fontSize: '16px',
              }}
            >
              +
            </button>
          )}
        </div>
        {expanded && (
          <div
            className="sidebar-list-wrapper"
            onMouseEnter={onMouseEnter}
            onMouseLeave={onMouseLeave}
          >
            <div className="sidebar-list" ref={listRef} onScroll={onScroll}>
              {connections.length === 0 ? (
                <div className="empty-state">
                  <div>🖥️</div>
                  <div>No connections yet</div>
                  <div style={{ fontSize: '12px', marginTop: '8px' }}>
                    Click + to add a new SSH connection
                  </div>
                </div>
              ) : grouped.length === 1 && grouped[0][0] === UNGROUPED ? (
                // No groups — render flat list
                grouped[0][1].map((conn) => (
                  <ConnectionItem
                    key={conn.id}
                    conn={conn}
                    onSelect={onSelectConnection}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      setContextMenu({ x: e.clientX, y: e.clientY, conn })
                    }}
                  />
                ))
              ) : (
                // Grouped rendering
                grouped.map(([key, conns]) => {
                  const isUngrouped = key === UNGROUPED
                  const collapsed = collapsedGroups.has(key)
                  return (
                    <div key={key} className="conn-group">
                      <div
                        className="conn-group-header"
                        onClick={() => toggleGroup(key)}
                      >
                        <span className="collapse-chevron">
                          {collapsed ? '▶' : '▼'}
                        </span>
                        <span className="conn-group-name">
                          {isUngrouped ? 'Ungrouped' : key}
                        </span>
                        <span className="conn-group-count">{conns.length}</span>
                      </div>
                      {!collapsed &&
                        conns.map((conn) => (
                          <ConnectionItem
                            key={conn.id}
                            conn={conn}
                            indent
                            onSelect={onSelectConnection}
                            onContextMenu={(e) => {
                              e.preventDefault()
                              setContextMenu({ x: e.clientX, y: e.clientY, conn })
                            }}
                          />
                        ))}
                    </div>
                  )
                })
              )}
            </div>

            {thumbHeight > 0 && (
              <div className={`sidebar-scrollbar${showThumb ? ' show' : ''}`}>
                <div
                  className="sidebar-scrollbar-thumb"
                  style={{ height: thumbHeight, top: thumbTop }}
                  onMouseDown={onThumbMouseDown}
                />
              </div>
            )}
          </div>
        )}
      </div>

      {showModal && (
        <ConnectionModal
          connection={editing}
          existingGroups={Array.from(
            new Set(
              connections
                .map((c) => c.group?.trim())
                .filter((g): g is string => !!g),
            ),
          )}
          onClose={() => {
            setShowModal(false)
            setEditing(null)
          }}
          onSave={(config) => {
            saveConn(config)
            onConnectionChange()
            setShowModal(false)
            setEditing(null)
          }}
        />
      )}

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onEdit={() => {
            handleEdit(contextMenu.conn)
            setContextMenu(null)
          }}
          onDelete={() => handleDelete(contextMenu.conn)}
          onClose={() => setContextMenu(null)}
        />
      )}
    </>
  )
}

// ===== Connection Item =====

interface ConnectionItemProps {
  conn: ConnectionConfig
  indent?: boolean
  onSelect: (conn: ConnectionConfig) => void
  onContextMenu: (e: React.MouseEvent) => void
}

const ConnectionItem: React.FC<ConnectionItemProps> = ({
  conn,
  indent,
  onSelect,
  onContextMenu,
}) => {
  return (
    <div
      className={`connection-item${indent ? ' indented' : ''}`}
      title={conn.description || undefined}
      onClick={() => onSelect(conn)}
      onContextMenu={onContextMenu}
    >
      <span className="conn-icon">🔗</span>
      <div className="conn-info">
        <div className="conn-name">{conn.name}</div>
        {conn.description ? (
          <div className="conn-desc" title={conn.description}>
            {conn.description}
          </div>
        ) : (
          <div className="conn-host">
            {conn.host}:{conn.port}
          </div>
        )}
      </div>
    </div>
  )
}

// ===== Connection Edit Modal =====

interface ConnectionModalProps {
  connection: ConnectionConfig | null
  existingGroups: string[]
  onClose: () => void
  onSave: (config: ConnectionConfig) => void
}

export const ConnectionModal: React.FC<ConnectionModalProps> = ({
  connection,
  existingGroups,
  onClose,
  onSave,
}) => {
  const [name, setName] = useState(connection?.name || '')
  const [host, setHost] = useState(connection?.host || '')
  const [port, setPort] = useState(connection?.port || 22)
  const [username, setUsername] = useState(connection?.username || '')
  const [authType, setAuthType] = useState<'password' | 'key'>(
    connection?.keyPath ? 'key' : 'password',
  )
  const [password, setPassword] = useState(connection?.password || '')
  const [keyPath, setKeyPath] = useState(connection?.keyPath || '')
  const [passphrase, setPassphrase] = useState(connection?.passphrase || '')
  const [group, setGroup] = useState(connection?.group || '')
  const [description, setDescription] = useState(connection?.description || '')

  const handleBrowseKey = async () => {
    try {
      const selected = await open({
        title: 'Select SSH Private Key',
      })
      if (selected) {
        setKeyPath(selected as string)
      }
    } catch (e) {
      console.error('File dialog error:', e)
    }
  }

  const handleSave = () => {
    const finalName = name.trim() || host.trim() || 'Unnamed'
    const finalUsername = username.trim() || 'root'
    if (!host.trim()) {
      alert('Please fill in host')
      return
    }
    const config: ConnectionConfig = {
      id: connection?.id || uuidv4(),
      name: finalName,
      host: host.trim(),
      port,
      username: finalUsername,
      password: authType === 'password' ? password : undefined,
      keyPath: authType === 'key' ? (keyPath.trim() || '~/.ssh/id_rsa') : undefined,
      passphrase: authType === 'key' ? passphrase || undefined : undefined,
      group: group.trim() || undefined,
      description: description.trim() || undefined,
    }
    onSave(config)
  }

  return (
    <div className="modal-overlay">
      <div className="modal">
        <div className="modal-header">
          <h3>{connection ? 'Edit Connection' : 'New Connection'}</h3>
          <span onClick={onClose} style={{ cursor: 'pointer', fontSize: '18px', color: '#888' }}>
            ✕
          </span>
        </div>
        <div className="modal-body">
          <div className="form-group">
            <label>Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="My Server" />
          </div>
          <div className="form-row">
            <div className="form-group">
              <label>Host</label>
              <input
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="192.168.1.100"
              />
            </div>
            <div className="form-group">
              <label>Port</label>
              <input
                type="number"
                value={port}
                onChange={(e) => setPort(Number(e.target.value))}
                placeholder="22"
              />
            </div>
          </div>
          <div className="form-group">
            <label>Username</label>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="root"
            />
          </div>
          <div className="form-group">
            <label>Group (optional)</label>
            <input
              value={group}
              onChange={(e) => setGroup(e.target.value)}
              placeholder="Production / Staging / ..."
              list="conn-groups"
            />
            <datalist id="conn-groups">
              {existingGroups.map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
          </div>
          <div className="form-group">
            <label>Description (optional)</label>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Notes about this connection"
            />
          </div>

          <div className="auth-type-toggle">
            <label>
              <input
                type="radio"
                checked={authType === 'password'}
                onChange={() => setAuthType('password')}
              />
              Password
            </label>
            <label>
              <input
                type="radio"
                checked={authType === 'key'}
                onChange={() => setAuthType('key')}
              />
              SSH Key
            </label>
          </div>

          {authType === 'password' ? (
            <div className="form-group">
              <label>Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter password"
              />
            </div>
          ) : (
            <>
              <div className="form-group">
                <label>Key Path</label>
                <div style={{ display: 'flex', gap: '6px' }}>
                  <input
                    value={keyPath}
                    onChange={(e) => setKeyPath(e.target.value)}
                    placeholder="~/.ssh/id_rsa (default)"
                    style={{ flex: 1 }}
                  />
                  <button
                    type="button"
                    onClick={handleBrowseKey}
                    className="btn-browse"
                  >
                    Browse
                  </button>
                </div>
              </div>
              <div className="form-group">
                <label>Passphrase (optional)</label>
                <input
                  type="password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  placeholder="Key passphrase"
                />
              </div>
            </>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn-cancel" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" onClick={handleSave}>
            {connection ? 'Update' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ===== Context Menu =====

interface ContextMenuProps {
  x: number
  y: number
  onEdit: () => void
  onDelete: () => void
  onClose: () => void
}

const ContextMenu: React.FC<ContextMenuProps> = ({ x, y, onEdit, onDelete, onClose }) => {
  React.useEffect(() => {
    const handler = () => onClose()
    document.addEventListener('click', handler)
    return () => document.removeEventListener('click', handler)
  }, [onClose])

  return (
    <div className="context-menu" style={{ left: x, top: y }} onClick={(e) => e.stopPropagation()}>
      <div className="context-menu-item" onClick={onEdit}>
        ✏️ Edit
      </div>
      <div className="context-menu-item" onClick={onDelete}>
        🗑️ Delete
      </div>
    </div>
  )
}

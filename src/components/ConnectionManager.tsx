import React, { useState, useCallback, useMemo, useRef } from 'react'
import { v4 as uuidv4 } from 'uuid'
import { open } from '@tauri-apps/plugin-dialog'
import type { ConnectionConfig } from '../types'
import { saveConnection as saveConn, deleteConnection, reorderConnections, renameGroup, deleteGroup } from '../commands'
import { useCustomScrollbar } from '../hooks/useCustomScrollbar'
import { Icon } from './Icon'

interface ConnectionManagerProps {
  connections: ConnectionConfig[]
  onConnect: (config: ConnectionConfig, tabId: number) => void
  onTabClosed: (tabId: number) => void
  activeTabId: number | null
  onConnectionChange: () => void
  onSelectConnection: (config: ConnectionConfig) => void
  onSplitRight: (config: ConnectionConfig) => void
  onSplitDown: (config: ConnectionConfig) => void
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
  onSplitRight,
  onSplitDown,
  sidebarWidth,
  expanded = true,
  onToggleExpanded,
}) => {
  const [showModal, setShowModal] = useState(false)
  const [editing, setEditing] = useState<ConnectionConfig | null>(null)
  const [defaultGroup, setDefaultGroup] = useState<string>('')
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    conn: ConnectionConfig
  } | null>(null)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  const [groupContextMenu, setGroupContextMenu] = useState<{
    x: number
    y: number
    group: string
  } | null>(null)

  // Drag-and-drop state
  const dragDataRef = useRef<{
    type: 'connection' | 'group'
    id?: string
    group: string
  } | null>(null)
  const [dragOverTarget, setDragOverTarget] = useState<{
    key: string // 'conn:<id>' | 'group:<key>' | 'group-end:<key>'
    position: 'before' | 'after'
  } | null>(null)

  const groupOf = (conn: ConnectionConfig) => conn.group?.trim() || UNGROUPED

  /**
   * Compute the new full order of connection IDs (and any group changes)
   * after a drag-and-drop operation, then persist via reorder_connections.
   */
  const handleDrop = useCallback(
    async (
      dropType: 'connection' | 'group' | 'group-end',
      dropConnId: string | undefined,
      dropGroup: string,
      dropPosition: 'before' | 'after',
    ) => {
      const drag = dragDataRef.current
      if (!drag) return

      const allConns = [...connections]
      const groupUpdates: Record<string, string> = {}

      if (drag.type === 'connection') {
        const dragConn = allConns.find((c) => c.id === drag.id)
        if (!dragConn) return

        // Remove dragged connection from the list
        const filtered = allConns.filter((c) => c.id !== drag.id)

        // If group changed, queue a group update
        if (drag.group !== dropGroup) {
          groupUpdates[drag.id!] = dropGroup === UNGROUPED ? '' : dropGroup
        }

        let insertIdx: number
        if (dropType === 'group') {
          // Drop on group header → add to end of that group
          const groupConns = filtered.filter((c) => groupOf(c) === dropGroup)
          if (groupConns.length === 0) {
            insertIdx = filtered.length // empty group → end of list
          } else {
            const lastInGroup = groupConns[groupConns.length - 1]
            insertIdx = filtered.findIndex((c) => c.id === lastInGroup.id) + 1
          }
        } else {
          // Drop on a connection item
          const dropIdx = filtered.findIndex((c) => c.id === dropConnId)
          if (dropIdx < 0) return
          insertIdx = dropPosition === 'after' ? dropIdx + 1 : dropIdx
        }

        filtered.splice(insertIdx, 0, dragConn)

        const orderedIds = filtered.map((c) => c.id)
        await reorderConnections(
          orderedIds,
          Object.keys(groupUpdates).length > 0 ? groupUpdates : undefined,
        )
      } else if (drag.type === 'group' && dropType === 'group') {
        // Reordering whole groups — move all of dragGroup before/after dropGroup
        if (drag.group === dropGroup) return

        const dragGroupConns = allConns.filter((c) => groupOf(c) === drag.group)
        if (dragGroupConns.length === 0) return

        const remaining = allConns.filter((c) => groupOf(c) !== drag.group)

        // Find the first connection of dropGroup in remaining
        const firstDropIdx = remaining.findIndex((c) => groupOf(c) === dropGroup)
        if (firstDropIdx < 0) {
          // Drop group doesn't exist in remaining → append to end
          remaining.push(...dragGroupConns)
          const orderedIds = remaining.map((c) => c.id)
          await reorderConnections(orderedIds)
        } else {
          const insertIdx = dropPosition === 'after' ? firstDropIdx + 1 : firstDropIdx
          const newOrder = [
            ...remaining.slice(0, insertIdx),
            ...dragGroupConns,
            ...remaining.slice(insertIdx),
          ]
          const orderedIds = newOrder.map((c) => c.id)
          await reorderConnections(orderedIds)
        }
      }

      dragDataRef.current = null
      setDragOverTarget(null)
      onConnectionChange()
    },
    [connections, onConnectionChange],
  )

  /** Determine before/after based on cursor Y relative to element center */
  const computeDropPosition = (e: React.DragEvent, el: HTMLElement): 'before' | 'after' => {
    const rect = el.getBoundingClientRect()
    return e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
  }

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

  const handleRenameGroup = async (oldName: string) => {
    const newName = window.prompt('Rename group', oldName)
    if (newName === null) return
    const trimmed = newName.trim()
    if (trimmed === oldName) return
    await renameGroup(oldName, trimmed)
    // Keep collapsed state in sync with the renamed group
    setCollapsedGroups((prev) => {
      if (!prev.has(oldName)) return prev
      const next = new Set(prev)
      next.delete(oldName)
      if (trimmed) next.add(trimmed)
      return next
    })
    onConnectionChange()
    setGroupContextMenu(null)
  }

  const handleDeleteGroup = async (groupName: string) => {
    if (confirm(`Delete group "${groupName}"?\nConnections in this group will be moved to Ungrouped.`)) {
      await deleteGroup(groupName)
      setCollapsedGroups((prev) => {
        if (!prev.has(groupName)) return prev
        const next = new Set(prev)
        next.delete(groupName)
        return next
      })
      onConnectionChange()
    }
    setGroupContextMenu(null)
  }

  return (
    <>
      <div className="sidebar">
        <div className="sidebar-header">
          <span
            className={`collapse-chevron${expanded ? ' expanded' : ''}`}
            onClick={onToggleExpanded}
            title={expanded ? 'Collapse' : 'Expand'}
          />
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
                  <div><Icon name="desktop" /></div>
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
                    onDragStart={(e, c) => {
                      dragDataRef.current = { type: 'connection', id: c.id, group: groupOf(c) }
                      e.dataTransfer.effectAllowed = 'move'
                    }}
                    onDragOver={(e, c) => {
                      e.preventDefault()
                      const pos = computeDropPosition(e, e.currentTarget as HTMLElement)
                      setDragOverTarget({ key: `conn:${c.id}`, position: pos })
                    }}
                    onDragLeave={() => setDragOverTarget(null)}
                    onDrop={(e, c) => {
                      e.preventDefault()
                      const pos = computeDropPosition(e, e.currentTarget as HTMLElement)
                      handleDrop('connection', c.id, groupOf(c), pos)
                    }}
                    onDragEnd={() => {
                      dragDataRef.current = null
                      setDragOverTarget(null)
                    }}
                    isDragOver={
                      dragOverTarget?.key === `conn:${conn.id}`
                        ? dragOverTarget.position
                        : null
                    }
                  />
                ))
              ) : (
                // Grouped rendering
                grouped.map(([key, conns]) => {
                  const isUngrouped = key === UNGROUPED
                  const collapsed = collapsedGroups.has(key)
                  const isGroupDragOver = dragOverTarget?.key === `group:${key}`
                  return (
                    <div key={key} className="conn-group">
                      <div
                        className={`conn-group-header${isGroupDragOver ? ' drag-over' : ''}`}
                        onClick={() => toggleGroup(key)}
                        onContextMenu={(e) => {
                          if (isUngrouped) return
                          e.preventDefault()
                          e.stopPropagation()
                          setGroupContextMenu({ x: e.clientX, y: e.clientY, group: key })
                        }}
                        draggable={!isUngrouped}
                        onDragStart={(e) => {
                          if (isUngrouped) return
                          dragDataRef.current = { type: 'group', group: key }
                          e.dataTransfer.effectAllowed = 'move'
                        }}
                        onDragOver={(e) => {
                          e.preventDefault()
                          // Only highlight if dragging a connection (to move into this group)
                          // or dragging a group (to reorder)
                          if (dragDataRef.current) {
                            const pos = computeDropPosition(e, e.currentTarget as HTMLElement)
                            setDragOverTarget({ key: `group:${key}`, position: pos })
                          }
                        }}
                        onDragLeave={() => {
                          if (dragOverTarget?.key === `group:${key}`) setDragOverTarget(null)
                        }}
                        onDrop={(e) => {
                          e.preventDefault()
                          if (!dragDataRef.current) return
                          const drag = dragDataRef.current
                          if (drag.type === 'connection') {
                            // Move connection into this group (end of group)
                            handleDrop('group', undefined, key, 'after')
                          } else if (drag.type === 'group') {
                            // Reorder groups
                            const pos = computeDropPosition(e, e.currentTarget as HTMLElement)
                            handleDrop('group', undefined, key, pos)
                          }
                        }}
                        onDragEnd={() => {
                          dragDataRef.current = null
                          setDragOverTarget(null)
                        }}
                      >
                        <span className={`collapse-chevron${collapsed ? '' : ' expanded'}`} />
                        <span className="conn-group-name">
                          {isUngrouped ? 'Ungrouped' : key}
                        </span>
                        <span className="conn-group-count">{conns.length}</span>
                        <button
                          className="conn-group-add"
                          title={`Add connection to ${isUngrouped ? 'Ungrouped' : key}`}
                          onClick={(e) => {
                            e.stopPropagation()
                            setEditing(null)
                            setDefaultGroup(isUngrouped ? '' : key)
                            setShowModal(true)
                          }}
                        >
                          +
                        </button>
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
                            onDragStart={(e, c) => {
                              dragDataRef.current = { type: 'connection', id: c.id, group: groupOf(c) }
                              e.dataTransfer.effectAllowed = 'move'
                            }}
                            onDragOver={(e, c) => {
                              e.preventDefault()
                              const pos = computeDropPosition(e, e.currentTarget as HTMLElement)
                              setDragOverTarget({ key: `conn:${c.id}`, position: pos })
                            }}
                            onDragLeave={() => setDragOverTarget(null)}
                            onDrop={(e, c) => {
                              e.preventDefault()
                              const pos = computeDropPosition(e, e.currentTarget as HTMLElement)
                              handleDrop('connection', c.id, groupOf(c), pos)
                            }}
                            onDragEnd={() => {
                              dragDataRef.current = null
                              setDragOverTarget(null)
                            }}
                            isDragOver={
                              dragOverTarget?.key === `conn:${conn.id}`
                                ? dragOverTarget.position
                                : null
                            }
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
          defaultGroup={defaultGroup}
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
            setDefaultGroup('')
          }}
          onSave={(config) => {
            saveConn(config)
            onConnectionChange()
            setShowModal(false)
            setEditing(null)
            setDefaultGroup('')
          }}
        />
      )}

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onSplitRight={() => {
            onSplitRight(contextMenu.conn)
            setContextMenu(null)
          }}
          onSplitDown={() => {
            onSplitDown(contextMenu.conn)
            setContextMenu(null)
          }}
          onEdit={() => {
            handleEdit(contextMenu.conn)
            setContextMenu(null)
          }}
          onDelete={() => handleDelete(contextMenu.conn)}
          onClose={() => setContextMenu(null)}
        />
      )}

      {groupContextMenu && (
        <GroupContextMenu
          x={groupContextMenu.x}
          y={groupContextMenu.y}
          onRename={() => handleRenameGroup(groupContextMenu.group)}
          onDelete={() => handleDeleteGroup(groupContextMenu.group)}
          onClose={() => setGroupContextMenu(null)}
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
  onDragStart: (e: React.DragEvent, conn: ConnectionConfig) => void
  onDragOver: (e: React.DragEvent, conn: ConnectionConfig) => void
  onDragLeave: (e: React.DragEvent) => void
  onDrop: (e: React.DragEvent, conn: ConnectionConfig) => void
  onDragEnd: () => void
  isDragOver: 'before' | 'after' | null
}

const ConnectionItem: React.FC<ConnectionItemProps> = ({
  conn,
  indent,
  onSelect,
  onContextMenu,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
  isDragOver,
}) => {
  return (
    <div
      className={`connection-item${indent ? ' indented' : ''}${
        isDragOver === 'before' ? ' drag-over-before' : ''
      }${isDragOver === 'after' ? ' drag-over-after' : ''}`}
      title={conn.description || undefined}
      onClick={() => onSelect(conn)}
      onContextMenu={onContextMenu}
      draggable
      onDragStart={(e) => onDragStart(e, conn)}
      onDragOver={(e) => onDragOver(e, conn)}
      onDragLeave={onDragLeave}
      onDrop={(e) => onDrop(e, conn)}
      onDragEnd={onDragEnd}
    >
      <span className="conn-icon"><Icon name="link" /></span>
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
  defaultGroup?: string
  existingGroups: string[]
  onClose: () => void
  onSave: (config: ConnectionConfig) => void
}

export const ConnectionModal: React.FC<ConnectionModalProps> = ({
  connection,
  defaultGroup = '',
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
  const [group, setGroup] = useState(connection?.group || defaultGroup)
  const [description, setDescription] = useState(connection?.description || '')
  const [groupFocused, setGroupFocused] = useState(false)

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
              onFocus={() => setGroupFocused(true)}
              onBlur={() => setTimeout(() => setGroupFocused(false), 120)}
              placeholder="Production / Staging / ..."
            />
            {groupFocused && existingGroups.length > 0 && (
              <ul className="group-suggestions">
                {existingGroups
                  .filter(
                    (g) =>
                      g.toLowerCase().includes(group.trim().toLowerCase()) &&
                      g !== group.trim(),
                  )
                  .map((g) => (
                    <li
                      key={g}
                      onMouseDown={(e) => {
                        e.preventDefault()
                        setGroup(g)
                      }}
                    >
                      {g}
                    </li>
                  ))}
              </ul>
            )}
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
  onSplitRight?: () => void
  onSplitDown?: () => void
  onEdit: () => void
  onDelete: () => void
  onClose: () => void
}

const ContextMenu: React.FC<ContextMenuProps> = ({
  x,
  y,
  onSplitRight,
  onSplitDown,
  onEdit,
  onDelete,
  onClose,
}) => {
  React.useEffect(() => {
    const handler = () => onClose()
    document.addEventListener('click', handler)
    return () => document.removeEventListener('click', handler)
  }, [onClose])

  return (
    <div className="context-menu" style={{ left: x, top: y }} onClick={(e) => e.stopPropagation()}>
      {onSplitRight && (
        <div className="context-menu-item" onClick={onSplitRight}>
          Split Right (horizontal)
        </div>
      )}
      {onSplitDown && (
        <div className="context-menu-item" onClick={onSplitDown}>
          Split Down (vertical)
        </div>
      )}
      {(onSplitRight || onSplitDown) && <div className="context-menu-divider" />}
      <div className="context-menu-item" onClick={onEdit}>
        <Icon name="edit" /> Edit
      </div>
      <div className="context-menu-item" onClick={onDelete}>
        <Icon name="trash" /> Delete
      </div>
    </div>
  )
}

// ===== Group Context Menu =====

interface GroupContextMenuProps {
  x: number
  y: number
  onRename: () => void
  onDelete: () => void
  onClose: () => void
}

const GroupContextMenu: React.FC<GroupContextMenuProps> = ({
  x,
  y,
  onRename,
  onDelete,
  onClose,
}) => {
  React.useEffect(() => {
    const handler = () => onClose()
    document.addEventListener('click', handler)
    return () => document.removeEventListener('click', handler)
  }, [onClose])

  return (
    <div className="context-menu" style={{ left: x, top: y }} onClick={(e) => e.stopPropagation()}>
      <div className="context-menu-item" onClick={onRename}>
        <Icon name="edit" /> Rename Group
      </div>
      <div className="context-menu-item" onClick={onDelete}>
        <Icon name="trash" /> Delete Group
      </div>
    </div>
  )
}

import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import { v4 as uuidv4 } from 'uuid'
import { open } from '@tauri-apps/plugin-dialog'
import type { ConnectionConfig, LocalTerminalEntry, TunnelConfig, TunnelInfo } from '../types'
import {
  saveConnection as saveConn,
  deleteConnection,
  reorderConnections,
  renameGroup,
  deleteGroup,
  getLocalTerminals,
  saveLocalTerminals,
  addTunnel,
  updateTunnel,
  stopTunnel,
} from '../commands'
import { useCustomScrollbar } from '../hooks/useCustomScrollbar'
import { Icon } from './Icon'
import { useI18n } from '../i18n'
import type { TranslationKey } from '../i18n/en'

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
  localTerminals?: LocalTerminalEntry[]
  onOpenLocalTerminal?: (entry: LocalTerminalEntry) => void
  onOpenLocalSplit?: (entry: LocalTerminalEntry, direction: 'row' | 'column') => void
  /** Open a local terminal entry's directory in the OS file manager. */
  onOpenLocalDir?: (entry: LocalTerminalEntry) => void
  onLocalTerminalsChanged?: () => void
  collapsedGroups?: string[]
  onCollapsedGroupsChange?: (value: string[]) => void
  /** Active SSH tunnels, used to mark saved definitions as running. */
  tunnels?: TunnelInfo[]
  /** Start a saved tunnel definition (opens/auto-connects a tab if needed). */
  onStartTunnel?: (connectionId: string, config: import('../types').TunnelConfig) => void
  /** Delete a saved tunnel definition (backend also stops it if running). */
  onRemoveTunnel?: (connectionId: string, tunnelId: string) => void
  onTunnelsChanged?: () => void
}

// Built-in shell presets selectable for a local terminal entry.
const SHELL_PRESETS: { value: string; labelKey: TranslationKey }[] = [
  { value: 'cmd', labelKey: 'shellCmd' },
  { value: 'pwsh', labelKey: 'shellPwsh' },
  { value: 'powershell', labelKey: 'shellPowerShell' },
  { value: 'bash', labelKey: 'shellBash' },
  { value: 'wsl', labelKey: 'shellWsl' },
  { value: 'gitbash', labelKey: 'shellGitBash' },
]

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
  localTerminals = [],
  onOpenLocalTerminal,
  onOpenLocalSplit,
  onOpenLocalDir,
  onLocalTerminalsChanged,
  collapsedGroups = [],
  onCollapsedGroupsChange,
  tunnels = [],
  onStartTunnel,
  onRemoveTunnel,
  onTunnelsChanged,
}) => {
  const { t } = useI18n()
  const [showModal, setShowModal] = useState(false)
  const [editing, setEditing] = useState<ConnectionConfig | null>(null)
  const [localModalOpen, setLocalModalOpen] = useState(false)
  const [localEditing, setLocalEditing] = useState<LocalTerminalEntry | null>(null)
  const [localCollapsed, setLocalCollapsed] = useState(false)
  const [defaultGroup, setDefaultGroup] = useState<string>('')
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    conn: ConnectionConfig
  } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<{
    title: string
    message: string
    onConfirm: () => void | Promise<void>
  } | null>(null)
  const [groupContextMenu, setGroupContextMenu] = useState<{
    x: number
    y: number
    group: string
  } | null>(null)
  const [tunnelForm, setTunnelForm] = useState<ConnectionConfig | null>(null)
  // When set, the tunnel form edits the definition with this id instead of adding a new one.
  const [tunnelEditTarget, setTunnelEditTarget] = useState<{
    connId: string
    tunnelId: string
  } | null>(null)
  const [tunnelFormError, setTunnelFormError] = useState('')
  const [tfLocalPort, setTfLocalPort] = useState('')
  const [tfRemoteHost, setTfRemoteHost] = useState('')
  const [tfRemotePort, setTfRemotePort] = useState('')
  const [tfName, setTfName] = useState('')
  const [tunnelStarting, setTunnelStarting] = useState(false)

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
    const next = collapsedGroups.includes(key)
      ? collapsedGroups.filter((g) => g !== key)
      : [...collapsedGroups, key]
    onCollapsedGroupsChange?.(next)
  }

  const handleEdit = (conn: ConnectionConfig) => {
    setEditing(conn)
    setShowModal(true)
  }

  const handleDelete = async (conn: ConnectionConfig) => {
    setConfirmDelete({
      title: t('deleteConnection'),
      message: t('deleteConnectionConfirm', { name: conn.name }),
      onConfirm: () => deleteConnection(conn.id).then(onConnectionChange),
    })
    setContextMenu(null)
  }

  const openTunnelForm = (conn: ConnectionConfig) => {
    setTunnelFormError('')
    setTfLocalPort('')
    setTfRemoteHost('')
    setTfRemotePort('')
    setTfName('')
    setTunnelEditTarget(null)
    setTunnelForm(conn)
  }

  const openTunnelEditForm = (conn: ConnectionConfig, def: TunnelConfig) => {
    setTunnelFormError('')
    setTfLocalPort(String(def.localPort))
    setTfRemoteHost(def.remoteHost)
    setTfRemotePort(String(def.remotePort))
    setTfName(def.name ?? '')
    setTunnelEditTarget({ connId: conn.id, tunnelId: def.id })
    setTunnelForm(conn)
  }

  // Save a new tunnel definition under the connection. It is not started here;
  // clicking the definition node in the tree starts it on demand.
  const handleSaveTunnel = async () => {
    if (!tunnelForm) return
    const localPort = Number(tfLocalPort)
    const remotePort = Number(tfRemotePort)
    if (!Number.isInteger(localPort) || localPort <= 0 || localPort > 65535) {
      setTunnelFormError(t('tunnelBadLocalPort'))
      return
    }
    if (!Number.isInteger(remotePort) || remotePort <= 0 || remotePort > 65535) {
      setTunnelFormError(t('tunnelBadRemotePort'))
      return
    }
    const remoteHost = tfRemoteHost.trim()
    if (!remoteHost) {
      setTunnelFormError(t('tunnelBadRemoteHost'))
      return
    }
    setTunnelStarting(true)
    setTunnelFormError('')
    try {
      if (tunnelEditTarget) {
        await updateTunnel(tunnelEditTarget.connId, tunnelEditTarget.tunnelId, {
          id: tunnelEditTarget.tunnelId,
          name: tfName.trim() || undefined,
          localAddr: undefined,
          localPort,
          remoteHost,
          remotePort,
        })
      } else {
        await addTunnel(tunnelForm.id, {
          id: uuidv4(),
          name: tfName.trim() || undefined,
          localAddr: undefined,
          localPort,
          remoteHost,
          remotePort,
        })
      }
      setTunnelForm(null)
      setTunnelEditTarget(null)
      onConnectionChange()
    } catch (e) {
      setTunnelFormError(String(e))
    } finally {
      setTunnelStarting(false)
    }
  }

  const handleStopTunnel = async (id: number) => {
    try {
      await stopTunnel(id)
      onTunnelsChanged?.()
    } catch (e) {
      console.error('Failed to stop tunnel:', e)
    }
  }

  const handleRemoveTunnel = async (connId: string, tunnelId: string) => {
    try {
      await onRemoveTunnel?.(connId, tunnelId)
    } catch (e) {
      console.error('Failed to remove tunnel:', e)
    }
  }

  const handleRenameGroup = async (oldName: string) => {
    const newName = window.prompt('Rename group', oldName)
    if (newName === null) return
    const trimmed = newName.trim()
    if (trimmed === oldName) return
    await renameGroup(oldName, trimmed)
    // Keep collapsed state in sync with the renamed group
    if (collapsedGroups.includes(oldName)) {
      onCollapsedGroupsChange?.(collapsedGroups.filter((g) => g !== oldName).concat(trimmed))
    }
    onConnectionChange()
    setGroupContextMenu(null)
  }

  const handleDeleteGroup = async (groupName: string) => {
    if (confirm(t('deleteGroupConfirm', { group: groupName }))) {
      await deleteGroup(groupName)
      if (collapsedGroups.includes(groupName)) {
        onCollapsedGroupsChange?.(collapsedGroups.filter((g) => g !== groupName))
      }
      onConnectionChange()
    }
    setGroupContextMenu(null)
  }

  /** Saved tunnel definitions of a connection, rendered as tree children.
   *  Clicking a node toggles it: start when inactive, stop when running. */
  const renderTunnels = (conn: ConnectionConfig) => {
    const defs = conn.tunnels ?? []
    if (defs.length === 0) return null
    return (
      <div className="conn-tunnels">
        {defs.map((def) => {
          const active = tunnels.find(
            (tun) => tun.connectionId === conn.id && tun.configId === def.id,
          )
          const localAddr = active?.localAddr ?? `${def.localAddr ?? '127.0.0.1'}:${def.localPort}`
          return (
            <div
              className={`conn-tunnel${active ? ' active' : ''}`}
              key={def.id}
              title={
                active
                  ? `${t('stopTunnel')} — ${localAddr} → ${def.remoteHost}:${def.remotePort}`
                  : `${t('startTunnel')} — ${localAddr} → ${def.remoteHost}:${def.remotePort}`
              }
              onClick={() => {
                if (active) {
                  void handleStopTunnel(active.id)
                } else {
                  onStartTunnel?.(conn.id, def)
                }
              }}
            >
              <Icon name="link" size={11} className="conn-tunnel-icon" />
              {def.name && <span className="conn-tunnel-name">{def.name}</span>}
              <span className="conn-tunnel-local">{localAddr}</span>
              <span className="conn-tunnel-arrow">→</span>
              <span className="conn-tunnel-remote">
                {def.remoteHost}:{def.remotePort}
              </span>
              {/* Open/close toggle button */}
              {active ? (
                <span
                  className="conn-tunnel-toggle active"
                  title={t('stopTunnel')}
                  onClick={(e) => {
                    e.stopPropagation()
                    void handleStopTunnel(active.id)
                  }}
                >
                  <Icon name="pause" size={10} />
                </span>
              ) : (
                <span
                  className="conn-tunnel-toggle"
                  title={t('startTunnel')}
                  onClick={(e) => {
                    e.stopPropagation()
                    onStartTunnel?.(conn.id, def)
                  }}
                >
                  <Icon name="play" size={10} />
                </span>
              )}
              {/* Edit definition button */}
              <span
                className="conn-tunnel-edit"
                title={t('editTunnel')}
                onClick={(e) => {
                  e.stopPropagation()
                  openTunnelEditForm(conn, def)
                }}
              >
                <Icon name="edit" size={10} />
              </span>
              <span
                className="conn-tunnel-del"
                title={t('deleteTunnel')}
                onClick={(e) => {
                  e.stopPropagation()
                  void handleRemoveTunnel(conn.id, def.id)
                }}
              >
                <Icon name="trash" size={10} />
              </span>
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <>
      <div className="sidebar">
        <div className="sidebar-header">
          <span
            className={`collapse-chevron${expanded ? ' expanded' : ''}`}
            onClick={onToggleExpanded}
            title={expanded ? t('collapse') : t('expand')}
          />
          <span style={{ flex: 1 }}>{t('connections')}</span>
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
              <LocalTerminalsSection
                entries={localTerminals}
                onOpen={onOpenLocalTerminal}
                onOpenSplit={onOpenLocalSplit}
                onOpenInFileManager={onOpenLocalDir}
                onChanged={onLocalTerminalsChanged}
              />
              {connections.length === 0 ? (
                <div className="empty-state">
                  <div>
                    <Icon name="desktop" />
                  </div>
                  <div>{t('noConnectionsYet')}</div>
                  <div style={{ fontSize: '12px', marginTop: '8px' }}>
                    {t('addSshConnectionHint')}
                  </div>
                </div>
              ) : grouped.length === 1 && grouped[0][0] === UNGROUPED ? (
                // No groups — render flat list
                grouped[0][1].map((conn) => (
                  <React.Fragment key={conn.id}>
                    <ConnectionItem
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
                        dragOverTarget?.key === `conn:${conn.id}` ? dragOverTarget.position : null
                      }
                      onEdit={(c) => handleEdit(c)}
                      onDelete={(c) => handleDelete(c)}
                    />
                    {renderTunnels(conn)}
                  </React.Fragment>
                ))
              ) : (
                // Grouped rendering
                grouped.map(([key, conns]) => {
                  const isUngrouped = key === UNGROUPED
                  const collapsed = collapsedGroups.includes(key)
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
                          {isUngrouped ? t('ungrouped') : key}
                        </span>
                        <span className="conn-group-count">{conns.length}</span>
                        <button
                          className="conn-group-add"
                          title={t('addConnectionTo', {
                            group: isUngrouped ? t('ungrouped') : key,
                          })}
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
                          <React.Fragment key={conn.id}>
                            <ConnectionItem
                              conn={conn}
                              indent
                              onSelect={onSelectConnection}
                              onContextMenu={(e) => {
                                e.preventDefault()
                                setContextMenu({ x: e.clientX, y: e.clientY, conn })
                              }}
                              onDragStart={(e, c) => {
                                dragDataRef.current = {
                                  type: 'connection',
                                  id: c.id,
                                  group: groupOf(c),
                                }
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
                              onEdit={(c) => handleEdit(c)}
                              onDelete={(c) => handleDelete(c)}
                            />
                            {renderTunnels(conn)}
                          </React.Fragment>
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
            new Set(connections.map((c) => c.group?.trim()).filter((g): g is string => !!g)),
          )}
          onClose={() => {
            setShowModal(false)
            setEditing(null)
            setDefaultGroup('')
          }}
          onSave={async (config) => {
            // B15: saveConn is async (invoke save_connection -> backend mutates
            // in-memory list + persists to disk). Calling onConnectionChange()
            // (-> loadConnections -> list_connections) before the save resolves
            // reads the stale list, so the new connection doesn't appear until
            // a restart. Await the save first, then refresh.
            try {
              await saveConn(config)
            } catch (err) {
              console.error('Failed to save connection:', err)
            }
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
          onAddTunnel={() => {
            openTunnelForm(contextMenu.conn)
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

      {confirmDelete && (
        <div className="modal-overlay" onClick={() => setConfirmDelete(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">{confirmDelete.title}</div>
            <div className="modal-body" style={{ padding: '12px 20px' }}>
              {confirmDelete.message}
            </div>
            <div className="modal-actions">
              <button onClick={() => setConfirmDelete(null)}>{t('cancel')}</button>
              <button
                className="danger"
                onClick={() => {
                  const cb = confirmDelete.onConfirm
                  setConfirmDelete(null)
                  void cb()
                }}
              >
                {t('delete')}
              </button>
            </div>
          </div>
        </div>
      )}

      {tunnelForm && (
        <div className="modal-overlay" onClick={() => !tunnelStarting && setTunnelForm(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">
              {tunnelEditTarget ? t('editTunnel') : t('addTunnel')} — {tunnelForm.name}
            </div>
            <div
              className="modal-body"
              style={{ padding: '12px 20px', display: 'flex', flexDirection: 'column', gap: 10 }}
            >
              <div className="form-group">
                <label>{t('tunnelLocalPort')}</label>
                <input
                  type="number"
                  min={1}
                  max={65535}
                  value={tfLocalPort}
                  onChange={(e) => setTfLocalPort(e.target.value)}
                  placeholder="8080"
                />
              </div>
              <div className="form-group">
                <label>{t('tunnelRemoteHost')}</label>
                <input
                  value={tfRemoteHost}
                  onChange={(e) => setTfRemoteHost(e.target.value)}
                  placeholder="localhost"
                />
              </div>
              <div className="form-group">
                <label>{t('tunnelRemotePort')}</label>
                <input
                  type="number"
                  min={1}
                  max={65535}
                  value={tfRemotePort}
                  onChange={(e) => setTfRemotePort(e.target.value)}
                  placeholder="3306"
                />
              </div>
              <div className="form-group">
                <label>{t('tunnelName')}</label>
                <input
                  value={tfName}
                  onChange={(e) => setTfName(e.target.value)}
                  placeholder={t('tunnelNamePlaceholder')}
                />
              </div>
              {tunnelFormError && <div className="form-error">{tunnelFormError}</div>}
            </div>
            <div className="modal-actions">
              <button onClick={() => setTunnelForm(null)}>{t('cancel')}</button>
              <button
                className="primary"
                disabled={tunnelStarting}
                onClick={() => void handleSaveTunnel()}
              >
                {tunnelStarting ? t('saving') : t('saveTunnel')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

// ===== Local Terminals Section =====

interface LocalTerminalsSectionProps {
  entries: LocalTerminalEntry[]
  onOpen?: (entry: LocalTerminalEntry) => void
  onOpenSplit?: (entry: LocalTerminalEntry, direction: 'row' | 'column') => void
  onOpenInFileManager?: (entry: LocalTerminalEntry) => void
  onChanged?: () => void
}

const LocalTerminalsSection: React.FC<LocalTerminalsSectionProps> = ({
  entries,
  onOpen,
  onOpenSplit,
  onOpenInFileManager,
  onChanged,
}) => {
  const { t } = useI18n()
  const [collapsed, setCollapsed] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<LocalTerminalEntry | null>(null)
  const [name, setName] = useState('')
  const [cwd, setCwd] = useState('')
  const [shell, setShell] = useState('cmd')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [localMenu, setLocalMenu] = useState<{
    x: number
    y: number
    entry: LocalTerminalEntry
  } | null>(null)

  const localMenuRef = useRef<HTMLDivElement>(null)
  // Close the local context menu on outside click / Escape.
  useEffect(() => {
    if (!localMenu) return
    const onDoc = (e: MouseEvent) => {
      const el = localMenuRef.current
      if (el && !el.contains(e.target as Node)) setLocalMenu(null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLocalMenu(null)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [localMenu])

  const openModal = (entry?: LocalTerminalEntry) => {
    setSaveError(null)
    if (entry) {
      setEditing(entry)
      setName(entry.name)
      setCwd(entry.cwd)
      setShell(entry.shell)
    } else {
      setEditing(null)
      setName('')
      setCwd('')
      setShell('cmd')
    }
    setModalOpen(true)
  }

  const pickDir = async () => {
    try {
      const picked = await open({
        directory: true,
        multiple: false,
        title: t('browseDir'),
      })
      if (typeof picked === 'string') setCwd(picked)
    } catch (err) {
      console.error(err)
    }
  }

  const persist = async (next: LocalTerminalEntry[]) => {
    try {
      await saveLocalTerminals(next)
      onChanged?.()
    } catch (err) {
      console.error(err)
      setSaveError(String(err))
    }
  }

  const handleSave = async () => {
    if (!cwd.trim()) {
      setSaveError(t('localTermFieldsRequired'))
      return
    }
    // Name is optional; fall back to the last path segment of the directory.
    const fallbackName =
      cwd
        .trim()
        .replace(/[\\/]+$/, '')
        .split(/[\\/]/)
        .pop() || cwd.trim()
    const finalName = name.trim() || fallbackName
    const current = await getLocalTerminals().catch(() => entries)
    let next: LocalTerminalEntry[]
    if (editing) {
      next = current.map((e) =>
        e.id === editing.id ? { ...e, name: finalName, cwd: cwd.trim(), shell } : e,
      )
    } else {
      next = [
        ...current,
        {
          id: `lt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          name: finalName,
          cwd: cwd.trim(),
          shell,
        },
      ]
    }
    await persist(next)
    setModalOpen(false)
  }

  const [confirmLocalDelete, setConfirmLocalDelete] = useState<LocalTerminalEntry | null>(null)
  const handleDelete = async (entry: LocalTerminalEntry) => {
    const current = await getLocalTerminals().catch(() => entries)
    await persist(current.filter((e) => e.id !== entry.id))
    setConfirmLocalDelete(null)
  }

  const shellLabel = (s: string) => {
    const preset = SHELL_PRESETS.find((p) => p.value === s)
    return preset ? t(preset.labelKey) : s
  }

  return (
    <div className="conn-group local-terminals-group">
      <div className="conn-group-header" onClick={() => setCollapsed((c) => !c)}>
        <span className={`collapse-chevron${collapsed ? '' : ' expanded'}`} />
        <span className="conn-group-name">{t('localTerminals')}</span>
        <span className="conn-group-count">{entries.length}</span>
        <button
          className="conn-group-add"
          title={t('addLocalTerminal')}
          onClick={(e) => {
            e.stopPropagation()
            openModal()
          }}
        >
          +
        </button>
      </div>
      {!collapsed && (
        <div className="conn-group-items">
          {/* Default entry: opens a local terminal in the default directory/shell. */}
          <div
            className="conn-item local-term-item local-term-default"
            onClick={() =>
              onOpen?.({ id: '__default__', name: t('openLocalShell'), cwd: '', shell: '' })
            }
            title={t('openLocalShell')}
          >
            <span className="conn-item-icon">
              <Icon name="terminal" size={14} />
            </span>
            <span className="conn-item-label">
              <span className="conn-item-name">{t('openLocalShell')}</span>
              <span className="conn-item-sub">{t('openLocalShellHint')}</span>
            </span>
          </div>
          {entries.map((entry) => (
            <div
              key={entry.id}
              className="conn-item local-term-item"
              onClick={() => onOpen?.(entry)}
              onContextMenu={(e) => {
                e.preventDefault()
                setLocalMenu({ x: e.clientX, y: e.clientY, entry })
              }}
              title={`${entry.cwd}  [${shellLabel(entry.shell)}]`}
            >
              <span className="conn-item-icon">
                <Icon name="terminal" size={14} />
              </span>
              <span className="conn-item-label">
                <span className="conn-item-name">{entry.name}</span>
                <span className="conn-item-sub">{shellLabel(entry.shell)}</span>
              </span>
              <span
                className="conn-item-edit"
                title={t('editLocalTerminal')}
                onClick={(e) => {
                  e.stopPropagation()
                  openModal(entry)
                }}
              >
                <Icon name="edit" size={12} />
              </span>
              <span
                className="conn-item-del"
                title={t('deleteLocalTerminal')}
                onClick={(e) => {
                  e.stopPropagation()
                  setConfirmLocalDelete(entry)
                }}
              >
                ×
              </span>
            </div>
          ))}
        </div>
      )}

      {modalOpen && (
        <div className="modal-overlay" onClick={() => setModalOpen(false)}>
          <div className="modal local-term-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">
              {editing ? t('editLocalTerminal') : t('addLocalTerminal')}
            </div>
            <div className="modal-body">
              <label className="modal-field">
                <span>{t('localTerminalName')}</span>
                <input
                  type="text"
                  value={name}
                  autoFocus
                  placeholder={t('localTerminalNamePlaceholder')}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <label className="modal-field">
                <span>{t('localTerminalDir')}</span>
                <div className="dir-row">
                  <input
                    type="text"
                    value={cwd}
                    placeholder={t('localTerminalDirPlaceholder')}
                    onChange={(e) => setCwd(e.target.value)}
                  />
                  <button type="button" onClick={pickDir}>
                    {t('browseDir')}
                  </button>
                </div>
              </label>
              <label className="modal-field">
                <span>{t('localTerminalShell')}</span>
                <select value={shell} onChange={(e) => setShell(e.target.value)}>
                  {SHELL_PRESETS.map((p) => (
                    <option key={p.value} value={p.value}>
                      {t(p.labelKey)}
                    </option>
                  ))}
                  {shell && !SHELL_PRESETS.some((p) => p.value === shell) && (
                    <option value={shell}>{shell}</option>
                  )}
                </select>
              </label>
              {saveError && <div className="modal-error">{saveError}</div>}
            </div>
            <div className="modal-actions">
              <button onClick={() => setModalOpen(false)}>{t('cancel')}</button>
              <button className="primary" onClick={handleSave}>
                {t('save')}
              </button>
            </div>
          </div>
        </div>
      )}

      {localMenu && (
        <div
          className="context-menu"
          style={{ left: localMenu.x, top: localMenu.y }}
          ref={localMenuRef}
          onClick={(e) => e.stopPropagation()}
        >
          {onOpenSplit && (
            <>
              <div
                className="context-menu-item"
                onClick={() => {
                  onOpenSplit(localMenu.entry, 'row')
                  setLocalMenu(null)
                }}
              >
                {t('splitRight')}
              </div>
              <div
                className="context-menu-item"
                onClick={() => {
                  onOpenSplit(localMenu.entry, 'column')
                  setLocalMenu(null)
                }}
              >
                {t('splitDown')}
              </div>
            </>
          )}
          {onOpenInFileManager && localMenu.entry.cwd && (
            <div
              className="context-menu-item"
              onClick={() => {
                onOpenInFileManager(localMenu.entry)
                setLocalMenu(null)
              }}
            >
              {t('openInFileManager')}
            </div>
          )}
          <div className="context-menu-divider" />
          <div
            className="context-menu-item"
            onClick={() => {
              openModal(localMenu.entry)
              setLocalMenu(null)
            }}
          >
            <Icon name="edit" /> {t('edit')}
          </div>
          <div
            className="context-menu-item danger"
            onClick={() => {
              setConfirmLocalDelete(localMenu.entry)
              setLocalMenu(null)
            }}
          >
            <Icon name="trash" /> {t('delete')}
          </div>
        </div>
      )}

      {confirmLocalDelete && (
        <div className="modal-overlay" onClick={() => setConfirmLocalDelete(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">{t('deleteLocalTerminal')}</div>
            <div className="modal-body" style={{ padding: '12px 20px' }}>
              {t('deleteLocalTerminalConfirm', { name: confirmLocalDelete.name })}
            </div>
            <div className="modal-actions">
              <button onClick={() => setConfirmLocalDelete(null)}>{t('cancel')}</button>
              <button className="danger" onClick={() => handleDelete(confirmLocalDelete)}>
                {t('delete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
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
  onEdit: (conn: ConnectionConfig) => void
  onDelete: (conn: ConnectionConfig) => void
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
  onEdit,
  onDelete,
}) => {
  const { t } = useI18n()
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
      <span className="conn-icon">
        <Icon name="link" />
      </span>
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
      <div className="conn-item-actions">
        <span
          className="conn-item-edit"
          title={t('editConnection')}
          onClick={(e) => {
            e.stopPropagation()
            onEdit(conn)
          }}
        >
          <Icon name="edit" size={12} />
        </span>
        <span
          className="conn-item-del"
          title={t('deleteConnection')}
          onClick={(e) => {
            e.stopPropagation()
            onDelete(conn)
          }}
        >
          ×
        </span>
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
  const { t } = useI18n()
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
  const [showPassword, setShowPassword] = useState(false)
  const [showPassphrase, setShowPassphrase] = useState(false)
  const [group, setGroup] = useState(connection?.group || defaultGroup)
  const [description, setDescription] = useState(connection?.description || '')
  const [startupDir, setStartupDir] = useState(connection?.startupDir || '')
  const [groupMode, setGroupMode] = useState<'select' | 'new'>(
    group && !existingGroups.includes(group) ? 'new' : 'select',
  )

  const handleBrowseKey = async () => {
    try {
      const selected = await open({
        title: t('selectSshKey'),
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
      alert(t('fillHost'))
      return
    }
    const config: ConnectionConfig = {
      id: connection?.id || uuidv4(),
      name: finalName,
      host: host.trim(),
      port,
      username: finalUsername,
      password: authType === 'password' ? password : undefined,
      keyPath: authType === 'key' ? keyPath.trim() || '~/.ssh/id_rsa' : undefined,
      passphrase: authType === 'key' ? passphrase || undefined : undefined,
      group: group.trim() || undefined,
      description: description.trim() || undefined,
      startupDir: startupDir.trim() || undefined,
    }
    onSave(config)
  }

  return (
    <div className="modal-overlay">
      <div className="modal">
        <div className="modal-header">
          <h3>{connection ? t('editConnection') : t('newConnection')}</h3>
          <span onClick={onClose} style={{ cursor: 'pointer', fontSize: '18px', color: '#888' }}>
            ✕
          </span>
        </div>
        <div className="modal-body">
          <div className="form-row">
            <div className="form-group">
              <label>{t('host')}</label>
              <input
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="192.168.1.100"
              />
            </div>
            <div className="form-group">
              <label>{t('port')}</label>
              <input
                type="number"
                value={port}
                onChange={(e) => setPort(Number(e.target.value))}
                placeholder="22"
              />
            </div>
          </div>
          <div className="form-group">
            <label>{t('connectionName')}</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('myServer')}
            />
          </div>
          <div className="form-group">
            <label>{t('username')}</label>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="root"
            />
          </div>
          <div className="form-group">
            <label>
              {t('group')} ({t('default')})
            </label>
            <select
              className="form-select"
              value={groupMode === 'new' ? '__new__' : group}
              onChange={(e) => {
                const v = e.target.value
                if (v === '__new__') {
                  setGroupMode('new')
                  if (!group) setGroup('')
                } else {
                  setGroupMode('select')
                  setGroup(v)
                }
              }}
            >
              <option value="">{t('noGroup')}</option>
              {existingGroups.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
              <option value="__new__">{t('newGroup')}</option>
            </select>
            {groupMode === 'new' && (
              <input
                style={{ marginTop: '6px' }}
                value={group}
                onChange={(e) => setGroup(e.target.value)}
                placeholder={t('newGroupName')}
              />
            )}
          </div>
          <div className="form-group">
            <label>{t('description')}</label>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('notes')}
            />
          </div>
          <div className="form-group">
            <label>{t('startupDir')}</label>
            <input
              value={startupDir}
              onChange={(e) => setStartupDir(e.target.value)}
              placeholder={t('startupDirPlaceholder')}
              spellCheck={false}
            />
          </div>

          <div className="auth-type-toggle">
            <label>
              <input
                type="radio"
                checked={authType === 'password'}
                onChange={() => setAuthType('password')}
              />
              {t('authPassword')}
            </label>
            <label>
              <input
                type="radio"
                checked={authType === 'key'}
                onChange={() => setAuthType('key')}
              />
              {t('sshKey')}
            </label>
          </div>

          {authType === 'password' ? (
            <div className="form-group">
              <label>{t('password')}</label>
              <div className="input-with-icon">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={t('password')}
                />
                <button
                  type="button"
                  className="input-icon-btn"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? t('hidePassword') : t('showPassword')}
                >
                  <Icon name={showPassword ? 'eyeOff' : 'eye'} size={16} />
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="form-group">
                <label>{t('keyPath')}</label>
                <div style={{ display: 'flex', gap: '6px' }}>
                  <input
                    value={keyPath}
                    onChange={(e) => setKeyPath(e.target.value)}
                    placeholder="~/.ssh/id_rsa (default)"
                    style={{ flex: 1 }}
                  />
                  <button type="button" onClick={handleBrowseKey} className="btn-browse">
                    {t('browse')}
                  </button>
                </div>
              </div>
              <div className="form-group">
                <label>{t('passphrase')}</label>
                <div className="input-with-icon">
                  <input
                    type={showPassphrase ? 'text' : 'password'}
                    value={passphrase}
                    onChange={(e) => setPassphrase(e.target.value)}
                    placeholder={t('passphrase')}
                  />
                  <button
                    type="button"
                    className="input-icon-btn"
                    onClick={() => setShowPassphrase((v) => !v)}
                    aria-label={showPassphrase ? 'Hide passphrase' : 'Show passphrase'}
                  >
                    <Icon name={showPassphrase ? 'eyeOff' : 'eye'} size={16} />
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn-cancel" onClick={onClose}>
            {t('cancel')}
          </button>
          <button className="btn-primary" onClick={handleSave}>
            {connection ? t('update') : t('create')}
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
  onAddTunnel?: () => void
  onEdit: () => void
  onDelete: () => void
  onClose: () => void
}

const ContextMenu: React.FC<ContextMenuProps> = ({
  x,
  y,
  onSplitRight,
  onSplitDown,
  onAddTunnel,
  onEdit,
  onDelete,
  onClose,
}) => {
  const { t } = useI18n()
  const menuRef = useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    // Close on ANY outside mousedown (left or right click) — using 'click'
    // alone would leave the menu open when another context menu opens via a
    // right-click elsewhere.
    const handler = (e: MouseEvent) => {
      const el = menuRef.current
      if (el && !el.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  return (
    <div className="context-menu" style={{ left: x, top: y }} ref={menuRef}>
      {onSplitRight && (
        <div className="context-menu-item" onClick={onSplitRight}>
          {t('splitRight')}
        </div>
      )}
      {onSplitDown && (
        <div className="context-menu-item" onClick={onSplitDown}>
          {t('splitDown')}
        </div>
      )}
      {(onSplitRight || onSplitDown) && <div className="context-menu-divider" />}
      {onAddTunnel && (
        <div className="context-menu-item" onClick={onAddTunnel}>
          <Icon name="link" /> {t('addTunnel')}
        </div>
      )}
      <div className="context-menu-item" onClick={onEdit}>
        <Icon name="edit" /> {t('edit')}
      </div>
      <div className="context-menu-item" onClick={onDelete}>
        <Icon name="trash" /> {t('delete')}
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
  const { t } = useI18n()
  const menuRef = useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    const handler = (e: MouseEvent) => {
      const el = menuRef.current
      if (el && !el.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  return (
    <div className="context-menu" style={{ left: x, top: y }} ref={menuRef}>
      <div className="context-menu-item" onClick={onRename}>
        <Icon name="edit" /> {t('renameGroup')}
      </div>
      <div className="context-menu-item" onClick={onDelete}>
        <Icon name="trash" /> {t('deleteGroup')}
      </div>
    </div>
  )
}

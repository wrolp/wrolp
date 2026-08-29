import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import { v4 as uuidv4 } from 'uuid'
import { open } from '@tauri-apps/plugin-dialog'
import { listen } from '@tauri-apps/api/event'
import type {
  ConnectionConfig,
  LocalTerminalEntry,
  SerialPortView,
  BaudCandidate,
  TunnelConfig,
  TunnelInfo,
} from '../types'
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
  listSerialPorts,
  detectSerialBaud,
} from '../commands'
import { useCustomScrollbar } from '../hooks/useCustomScrollbar'
import { Icon } from './Icon'
import { useI18n } from '../i18n'
import type { TranslationKey } from '../i18n/en'
import { ClearableInput } from './ClearableInput'

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
            {conn.kind === 'serial'
              ? `${conn.portName || 'Serial'}${conn.baudRate ? ' @ ' + conn.baudRate : ''}`
              : `${conn.host}:${conn.port}`}
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

/** Baud rates offered by the serial baud-rate dropdown.
 *
 *  74880 is the fixed rate of the ESP8266 ROM boot log. The rates above
 *  230400 need a USB-serial adapter that accepts arbitrary divisors
 *  (FTDI / CP210x / CH34x) — a real 16550 UART will not reach them.
 */
const COMMON_BAUD_RATES: { value: number; note?: string }[] = [
  { value: 1200 },
  { value: 2400 },
  { value: 4800 },
  { value: 9600, note: 'default' },
  { value: 14400 },
  { value: 19200 },
  { value: 28800 },
  { value: 38400 },
  { value: 57600 },
  { value: 74880, note: 'ESP8266 boot' },
  { value: 115200, note: 'most common' },
  { value: 128000 },
  { value: 230400 },
  { value: 256000 },
  { value: 460800 },
  { value: 500000 },
  { value: 921600 },
  { value: 1000000 },
  { value: 2000000 },
]

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

  // Serial-port connection fields
  const [kind, setKind] = useState<'ssh' | 'serial' | 'telnet'>(
    connection?.kind === 'serial' ? 'serial' : connection?.kind === 'telnet' ? 'telnet' : 'ssh',
  )
  // Telnet: opt-in best-effort auto-login (`login:` / `Password:` prompt
  // matching). Off by default — Telnet is plaintext, so credentials are never
  // injected unless the user explicitly asks for it.
  const [autoLogin, setAutoLogin] = useState(connection?.autoLogin ?? false)
  const [portName, setPortName] = useState(connection?.portName || '')
  const [serialPorts, setSerialPorts] = useState<SerialPortView[]>([])
  const [baudRate, setBaudRate] = useState(connection?.baudRate || 9600)
  const [dataBits, setDataBits] = useState(connection?.dataBits || 8)
  const [stopBits, setStopBits] = useState(connection?.stopBits || 1)
  const [parity, setParity] = useState(connection?.parity || 'none')
  const [flowControl, setFlowControl] = useState(connection?.flowControl || 'none')
  // Baud-rate auto-detection. UART cannot report the peer's rate (no clock
  // line, no negotiation), so the backend brute-forces the common rates and
  // scores how much each one's received bytes look like real terminal text.
  const [detectingBaud, setDetectingBaud] = useState(false)
  const [baudProgress, setBaudProgress] = useState<{
    index: number
    total: number
    baud: number
  } | null>(null)
  const [baudCandidates, setBaudCandidates] = useState<BaudCandidate[] | null>(null)
  const [baudDetectError, setBaudDetectError] = useState<string | null>(null)
  // Custom baud-rate dropdown: the native <datalist> is not used for the same
  // reason as the port picker (unreliable label rendering across Chromium).
  const [showBaudList, setShowBaudList] = useState(false)
  const filteredBaudRates = useMemo(() => {
    const q = String(baudRate || '')
    if (!q) return COMMON_BAUD_RATES
    return COMMON_BAUD_RATES.filter((b) => String(b.value).includes(q))
  }, [baudRate])
  // Custom serial-port combobox: the native <datalist> does not render the
  // option `label`/description reliably across Chromium builds, so we render
  // our own suggestion list (port name + friendly description, both visible).
  const [showPortList, setShowPortList] = useState(false)
  const filteredSerialPorts = useMemo(() => {
    const q = portName.trim().toLowerCase()
    if (!q) return serialPorts
    return serialPorts.filter(
      (p) => p.name.toLowerCase().includes(q) || (p.description || '').toLowerCase().includes(q),
    )
  }, [serialPorts, portName])

  useEffect(() => {
    if (kind === 'serial') {
      listSerialPorts()
        .then(setSerialPorts)
        .catch(() => setSerialPorts([]))
    }
  }, [kind])

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

  const handleDetectBaud = async () => {
    const port = portName.trim()
    if (!port || detectingBaud) return
    setDetectingBaud(true)
    setBaudDetectError(null)
    setBaudCandidates(null)
    setBaudProgress(null)
    let unlisten: (() => void) | undefined
    try {
      unlisten = await listen<{ index: number; total: number; baudRate: number }>(
        'baud-detect-progress',
        (ev) =>
          setBaudProgress({
            index: ev.payload.index,
            total: ev.payload.total,
            baud: ev.payload.baudRate,
          }),
      )
      const candidates = await detectSerialBaud({
        portName: port,
        dataBits,
        stopBits,
        parity,
        flowControl,
      })
      setBaudCandidates(candidates)
      // Only auto-apply a reasonably confident match; otherwise show the list
      // and let the user choose.
      const best = candidates[0]
      if (best && best.score >= 0.15) {
        setBaudRate(best.baudRate)
      }
    } catch (e) {
      setBaudDetectError(typeof e === 'string' ? e : String(e))
    } finally {
      unlisten?.()
      setDetectingBaud(false)
      setBaudProgress(null)
    }
  }

  const handleSave = () => {
    const isSerial = kind === 'serial'
    const isTelnet = kind === 'telnet'
    const finalName = name.trim() || (isSerial ? portName.trim() : host.trim()) || 'Unnamed'
    if (isSerial) {
      if (!portName.trim()) {
        alert('Please select a serial port')
        return
      }
    } else if (!host.trim()) {
      alert(t('fillHost'))
      return
    }
    const config: ConnectionConfig = {
      id: connection?.id || uuidv4(),
      name: finalName,
      host: isSerial ? portName.trim() : host.trim(),
      // The port field can be cleared while typing; fall back to the kind's
      // default so no connection is ever saved with port 0.
      port: isSerial ? 0 : port || (isTelnet ? 23 : 22),
      username: isSerial ? '' : username.trim() || 'root',
      // Telnet is password-only (no SSH keys), so key fields are cleared.
      password: isSerial ? undefined : isTelnet || authType === 'password' ? password : undefined,
      keyPath:
        isSerial || isTelnet
          ? undefined
          : authType === 'key'
            ? keyPath.trim() || '~/.ssh/id_rsa'
            : undefined,
      passphrase:
        isSerial || isTelnet ? undefined : authType === 'key' ? passphrase || undefined : undefined,
      group: group.trim() || undefined,
      description: description.trim() || undefined,
      startupDir: isSerial ? undefined : startupDir.trim() || undefined,
      kind: isSerial ? 'serial' : isTelnet ? 'telnet' : 'ssh',
      portName: isSerial ? portName.trim() : undefined,
      // The baud field can be cleared while typing; never persist 0.
      baudRate: isSerial ? baudRate || 9600 : undefined,
      dataBits: isSerial ? dataBits : undefined,
      stopBits: isSerial ? stopBits : undefined,
      parity: isSerial ? parity : undefined,
      flowControl: isSerial ? flowControl : undefined,
      autoLogin: isTelnet ? autoLogin : undefined,
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
          {/* Connection type: SSH, Serial or Telnet */}
          <div className="auth-type-toggle" style={{ marginBottom: 12 }}>
            <label>
              <input type="radio" checked={kind === 'ssh'} onChange={() => setKind('ssh')} />
              SSH
            </label>
            <label>
              <input type="radio" checked={kind === 'serial'} onChange={() => setKind('serial')} />
              Serial
            </label>
            <label>
              <input
                type="radio"
                checked={kind === 'telnet'}
                onChange={() => {
                  setKind('telnet')
                  // Nudge the port to the Telnet default, but only while the
                  // user hasn't edited it away from the SSH default.
                  if (port === 22) setPort(23)
                }}
              />
              Telnet
            </label>
          </div>
          {kind === 'serial' && (
            <>
              <div className="form-row">
                <div className="form-group">
                  <label>Port</label>
                  <div
                    className="serial-port-combo"
                    onBlur={(e) => {
                      if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                        setShowPortList(false)
                      }
                    }}
                  >
                    <input
                      className="form-input serial-port-input"
                      value={portName}
                      onChange={(e) => {
                        setPortName(e.target.value)
                        setShowPortList(true)
                      }}
                      onFocus={() => setShowPortList(true)}
                      placeholder="COM3 / /dev/ttyUSB0 …"
                      spellCheck={false}
                      autoComplete="off"
                    />
                    {portName && (
                      <button
                        type="button"
                        className="input-clear-btn"
                        title="Clear"
                        aria-label="Clear"
                        onMouseDown={(e) => {
                          e.preventDefault()
                          setPortName('')
                          setShowPortList(true)
                        }}
                      >
                        ✕
                      </button>
                    )}
                    {showPortList && filteredSerialPorts.length > 0 && (
                      <ul className="serial-port-suggestions">
                        {filteredSerialPorts.map((p) => (
                          <li
                            key={p.name}
                            onMouseDown={(e) => {
                              e.preventDefault()
                              setPortName(p.name)
                              setShowPortList(false)
                            }}
                          >
                            <span className="port-name">{p.name}</span>
                            {p.description && p.description !== p.name && (
                              <span className="port-desc">{p.description}</span>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
                <div className="form-group">
                  <label>Baud rate</label>
                  <div className="dir-row">
                    <div
                      className="baud-rate-combo"
                      onBlur={(e) => {
                        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                          setShowBaudList(false)
                        }
                      }}
                    >
                      <input
                        type="text"
                        inputMode="numeric"
                        value={baudRate ? String(baudRate) : ''}
                        onChange={(e) => {
                          const digits = e.target.value.replace(/\D/g, '')
                          setBaudRate(digits ? Number(digits) : 0)
                          setShowBaudList(true)
                        }}
                        onFocus={() => setShowBaudList(true)}
                        placeholder="9600"
                        spellCheck={false}
                        autoComplete="off"
                      />
                      {baudRate > 0 && (
                        <button
                          type="button"
                          className="input-clear-btn"
                          title="Clear"
                          aria-label="Clear"
                          onMouseDown={(e) => {
                            e.preventDefault()
                            setBaudRate(0)
                            setShowBaudList(true)
                          }}
                        >
                          ✕
                        </button>
                      )}
                      {showBaudList && filteredBaudRates.length > 0 && (
                        <ul className="baud-rate-suggestions">
                          {filteredBaudRates.map((b) => (
                            <li
                              key={b.value}
                              onMouseDown={(e) => {
                                e.preventDefault()
                                setBaudRate(b.value)
                                setShowBaudList(false)
                              }}
                            >
                              <span className="baud-value">{b.value.toLocaleString('en-US')}</span>
                              {b.note && <span className="baud-note">{b.note}</span>}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={handleDetectBaud}
                      disabled={detectingBaud || !portName.trim()}
                      title={
                        portName.trim()
                          ? 'Probe the common baud rates and score what the device sends'
                          : 'Select a port first'
                      }
                    >
                      {detectingBaud ? 'Detecting…' : 'Detect'}
                    </button>
                  </div>
                </div>
              </div>
              {(detectingBaud || baudDetectError || baudCandidates) && (
                <div className="baud-detect-result">
                  {detectingBaud && (
                    <div className="baud-detect-hint">
                      Probing {baudProgress?.total ?? 12} common rates…
                      {baudProgress
                        ? ` (${baudProgress.index + 1}/${baudProgress.total}: ${baudProgress.baud})`
                        : ''}
                    </div>
                  )}
                  {baudDetectError && <div className="baud-detect-error">{baudDetectError}</div>}
                  {!detectingBaud && baudCandidates && (
                    <>
                      {baudCandidates.every((c) => c.bytes === 0) ? (
                        <div className="baud-detect-hint">
                          No data received at any probed rate — the device may be silent, need a
                          specific handshake, or use a rate outside the probed list. Set it
                          manually.
                        </div>
                      ) : (
                        <>
                          <div className="baud-detect-hint">
                            Best match <strong>{baudCandidates[0].baudRate}</strong> (
                            {Math.round(baudCandidates[0].score * 100)}% confidence)
                            {baudCandidates[0].score >= 0.15
                              ? ' — applied.'
                              : ' — too weak to apply, pick one below.'}
                          </div>
                          <ul className="baud-candidate-list">
                            {baudCandidates.map((c) => (
                              <li
                                key={c.baudRate}
                                className={c.baudRate === baudRate ? 'active' : ''}
                                onClick={() => setBaudRate(c.baudRate)}
                                title={c.sample || 'No data received'}
                              >
                                <span className="baud-value">{c.baudRate}</span>
                                <span className="baud-bar">
                                  <span style={{ width: `${Math.round(c.score * 100)}%` }} />
                                </span>
                                <span className="baud-score">{Math.round(c.score * 100)}%</span>
                                <span className="baud-sample">{c.sample || '—'}</span>
                              </li>
                            ))}
                          </ul>
                        </>
                      )}
                    </>
                  )}
                </div>
              )}
              <div className="form-row">
                <div className="form-group">
                  <label>Data bits</label>
                  <select
                    className="form-select"
                    value={dataBits}
                    onChange={(e) => setDataBits(Number(e.target.value))}
                  >
                    {[5, 6, 7, 8].map((b) => (
                      <option key={b} value={b}>
                        {b}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label>Stop bits</label>
                  <select
                    className="form-select"
                    value={stopBits}
                    onChange={(e) => setStopBits(Number(e.target.value))}
                  >
                    {[1, 2].map((b) => (
                      <option key={b} value={b}>
                        {b}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label>Parity</label>
                  <select
                    className="form-select"
                    value={parity}
                    onChange={(e) => setParity(e.target.value)}
                  >
                    {['none', 'odd', 'even'].map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label>Flow control</label>
                  <select
                    className="form-select"
                    value={flowControl}
                    onChange={(e) => setFlowControl(e.target.value)}
                  >
                    {['none', 'software', 'hardware'].map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </>
          )}
          {kind !== 'serial' && (
            <div className="form-row">
              <div className="form-group">
                <label>{t('host')}</label>
                <ClearableInput
                  value={host}
                  onValueChange={setHost}
                  placeholder="192.168.1.100"
                  spellCheck={false}
                  autoComplete="off"
                />
              </div>
              <div className="form-group">
                <label>{t('port')}</label>
                <ClearableInput
                  type="text"
                  inputMode="numeric"
                  value={port ? String(port) : ''}
                  onValueChange={(v) => setPort(Number(v.replace(/\D/g, '')) || 0)}
                  placeholder={kind === 'telnet' ? '23' : '22'}
                  spellCheck={false}
                  autoComplete="off"
                />
              </div>
            </div>
          )}
          <div className="form-group">
            <label>{t('connectionName')}</label>
            <ClearableInput
              value={name}
              onValueChange={setName}
              placeholder={t('myServer')}
              spellCheck={false}
              autoComplete="off"
            />
          </div>
          {kind !== 'serial' && (
            <div className="form-group">
              <label>{t('username')}</label>
              <ClearableInput
                value={username}
                onValueChange={setUsername}
                placeholder="root"
                spellCheck={false}
                autoComplete="off"
              />
            </div>
          )}
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
              <ClearableInput
                wrapperStyle={{ marginTop: '6px' }}
                value={group}
                onValueChange={setGroup}
                placeholder={t('newGroupName')}
                spellCheck={false}
                autoComplete="off"
              />
            )}
          </div>
          <div className="form-group">
            <label>{t('description')}</label>
            <ClearableInput
              value={description}
              onValueChange={setDescription}
              placeholder={t('notes')}
              spellCheck={false}
              autoComplete="off"
            />
          </div>
          {kind === 'ssh' && (
            <div className="form-group">
              <label>{t('startupDir')}</label>
              <ClearableInput
                value={startupDir}
                onValueChange={setStartupDir}
                placeholder={t('startupDirPlaceholder')}
                spellCheck={false}
                autoComplete="off"
              />
            </div>
          )}

          {kind !== 'serial' && (
            <>
              {/* Telnet is password-only — no SSH-key toggle. */}
              {kind === 'ssh' && (
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
              )}

              {authType === 'password' || kind === 'telnet' ? (
                <div className="form-group">
                  <label>{t('password')}</label>
                  <ClearableInput
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onValueChange={setPassword}
                    placeholder={t('password')}
                    autoComplete="off"
                    trailing={
                      <button
                        type="button"
                        className="input-icon-btn"
                        onClick={() => setShowPassword((v) => !v)}
                        aria-label={showPassword ? t('hidePassword') : t('showPassword')}
                        title={showPassword ? t('hidePassword') : t('showPassword')}
                      >
                        <Icon name={showPassword ? 'eyeOff' : 'eye'} size={16} />
                      </button>
                    }
                  />
                </div>
              ) : (
                <>
                  <div className="form-group">
                    <label>{t('keyPath')}</label>
                    <div className="dir-row">
                      <ClearableInput
                        value={keyPath}
                        onValueChange={setKeyPath}
                        placeholder="~/.ssh/id_rsa (default)"
                        spellCheck={false}
                        autoComplete="off"
                      />
                      <button type="button" onClick={handleBrowseKey}>
                        {t('browse')}
                      </button>
                    </div>
                  </div>
                  <div className="form-group">
                    <label>{t('passphrase')}</label>
                    <ClearableInput
                      type={showPassphrase ? 'text' : 'password'}
                      value={passphrase}
                      onValueChange={setPassphrase}
                      placeholder={t('passphrase')}
                      autoComplete="off"
                      trailing={
                        <button
                          type="button"
                          className="input-icon-btn"
                          onClick={() => setShowPassphrase((v) => !v)}
                          aria-label={showPassphrase ? 'Hide passphrase' : 'Show passphrase'}
                          title={showPassphrase ? 'Hide passphrase' : 'Show passphrase'}
                        >
                          <Icon name={showPassphrase ? 'eyeOff' : 'eye'} size={16} />
                        </button>
                      }
                    />
                  </div>
                </>
              )}

              {kind === 'telnet' && (
                <div className="form-group">
                  <label
                    style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 'normal' }}
                  >
                    <input
                      type="checkbox"
                      checked={autoLogin}
                      onChange={(e) => setAutoLogin(e.target.checked)}
                    />
                    Auto-login with the saved username / password
                  </label>
                  <div style={{ fontSize: 11, opacity: 0.7, marginTop: 4 }}>
                    Best-effort: matches <code>login:</code> / <code>Password:</code> prompts.
                    Telnet is unencrypted — credentials travel in plain text.
                  </div>
                </div>
              )}
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

import React, { useState, useEffect, useCallback, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { PhysicalPosition, PhysicalSize } from '@tauri-apps/api/dpi'
import { Titlebar } from './components/Titlebar'
import { ConnectionManager } from './components/ConnectionManager'
import { TerminalComponent } from './components/Terminal'
import { FilePanel } from './components/FilePanel'
import type { ConnectionConfig, TabInfo } from './types'
import { loadWindowConfig, saveWindowConfig } from './commands'
import './styles/App.scss'

// Global connection cache
let cachedConnections: ConnectionConfig[] = []

// Auto-incrementing tab id counter
let nextTabId = 1

export default function App() {
  const [tabs, setTabs] = useState<TabInfo[]>([])
  const [activeTabId, setActiveTabId] = useState<number | null>(null)
  const [connections, setConnections] = useState<ConnectionConfig[]>([])
  const [sidebarWidth, setSidebarWidth] = useState(260)
  const [connectionListHeight, setConnectionListHeight] = useState(200)
  const [tabContextMenu, setTabContextMenu] = useState<{ x: number; y: number; tab: TabInfo } | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [opacity, setOpacity] = useState(1)
  const isDragging = useRef(false)
  const isDraggingV = useRef(false)

  // Load connection list
  useEffect(() => {
    loadConnections()
  }, [])

  // Close tab context menu on click anywhere
  useEffect(() => {
    const closeMenu = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      if (target.closest('.tab-context-menu')) return
      setTabContextMenu(null)
    }
    document.addEventListener('click', closeMenu)
    return () => document.removeEventListener('click', closeMenu)
  }, [])

  // Ref to keep current opacity accessible in debounced save without re-registering listeners
  const opacityRef = useRef(opacity)
  opacityRef.current = opacity

  // Load opacity from saved window config on startup
  useEffect(() => {
    loadWindowConfig().then(config => {
      if (config.opacity !== undefined) {
        setOpacity(config.opacity)
      }
    }).catch(() => {})
  }, [])

  // Save window position/size on move/resize (restore handled by Rust setup)
  useEffect(() => {
    const win = getCurrentWindow()
    let unlistenMoved: (() => void) | undefined
    let unlistenResized: (() => void) | undefined
    let saveTimer: ReturnType<typeof setTimeout> | null = null

    const scheduleSave = () => {
      if (saveTimer) clearTimeout(saveTimer)
      saveTimer = setTimeout(async () => {
        try {
          if (await win.isMinimized()) return
          const pos = await win.outerPosition()
          const size = await win.outerSize()
          const maximized = await win.isMaximized()
          await saveWindowConfig({
            x: pos.x,
            y: pos.y,
            width: size.width,
            height: size.height,
            maximized,
            opacity: opacityRef.current,
          })
        } catch (e) {
          console.error('Failed to save window config:', e)
        }
      }, 500)
    }

    win.onMoved(() => scheduleSave()).then(fn => { unlistenMoved = fn })
    win.onResized(() => scheduleSave()).then(fn => { unlistenResized = fn })

    return () => {
      if (unlistenMoved) unlistenMoved()
      if (unlistenResized) unlistenResized()
      if (saveTimer) clearTimeout(saveTimer)
    }
  }, [])

  // Save config immediately when opacity changes (slider already provides final value)
  const mountedRef = useRef(false)
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true
      return // skip initial render (handled by load effect above)
    }
    const win = getCurrentWindow()
    Promise.all([win.outerPosition(), win.outerSize(), win.isMaximized()])
      .then(([pos, size, maximized]) => {
        saveWindowConfig({
          x: pos.x,
          y: pos.y,
          width: size.width,
          height: size.height,
          maximized,
          opacity,
        })
      })
      .catch(() => {})
  }, [opacity])

  const loadConnections = async () => {
    try {
      const result = await invoke<string>('list_connections')
      const conns = JSON.parse(result) as ConnectionConfig[]
      cachedConnections = conns
      setConnections(conns)
    } catch (err) {
      console.error('Failed to load connections:', err)
    }
  }

  // Open new tab (create tab only, connect later)
  const openTab = useCallback((conn: ConnectionConfig) => {
    const tabId = nextTabId++
    const newTab: TabInfo = {
      tabId,
      connectionId: conn.id,
      connectionName: conn.name,
      host: `${conn.host}:${conn.port}`,
      status: 'connecting',
    }

    setTabs((prev) => [...prev, newTab])
    setActiveTabId(tabId)
  }, [])

  // Close tab
  const closeTab = useCallback(
    async (tabId: number) => {
      // Disconnect SSH session
      try {
        await invoke('disconnect', { tabId })
      } catch (e) {
        console.error('Disconnect error:', e)
      }

      setTabs((prev) => {
        const newTabs = prev.filter((t) => t.tabId !== tabId)
        if (activeTabId === tabId) {
          setActiveTabId(newTabs.length > 0 ? newTabs[newTabs.length - 1].tabId : null)
        }
        return newTabs
      })
    },
    [activeTabId],
  )

  // Select connection — always open a new tab
  const handleSelectConnection = useCallback(
    (conn: ConnectionConfig) => {
      openTab(conn)
    },
    [openTab],
  )

  // Compute tab display label (number tabs sharing the same connection)
  const getTabLabel = useCallback(
    (tab: TabInfo): string => {
      if (!tab.connectionId) return tab.connectionName
      const siblings = tabs.filter((t) => t.connectionId === tab.connectionId)
      if (siblings.length <= 1) return tab.connectionName
      const idx = siblings.findIndex((t) => t.tabId === tab.tabId)
      return `${tab.connectionName} (${idx + 1})`
    },
    [tabs],
  )

  // Duplicate tab via right-click menu
  const duplicateTab = useCallback(
    (tab: TabInfo) => {
      setTabContextMenu(null)
      if (!tab.connectionId) return
      const conn = cachedConnections.find((c) => c.id === tab.connectionId)
      if (conn) openTab(conn)
    },
    [openTab],
  )

  // Handle connection changes (reload list)

  const handleConnectionChange = useCallback(() => {
    loadConnections()
  }, [])

  // Sidebar drag-to-resize
  const handleDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isDragging.current = true

    const handleMouseMove = (ev: MouseEvent) => {
      if (!isDragging.current) return
      const newWidth = Math.max(160, Math.min(500, ev.clientX))
      setSidebarWidth(newWidth)
    }

    const handleMouseUp = () => {
      isDragging.current = false
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [])

  // Connection list / SFTP vertical divider drag-to-resize
  const handleVDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isDraggingV.current = true
    const sidebarEl = (e.target as HTMLElement).closest('.sidebar-container')
    const startY = e.clientY
    const startHeight = connectionListHeight

    const handleMouseMove = (ev: MouseEvent) => {
      if (!isDraggingV.current) return
      const delta = ev.clientY - startY
      const containerHeight = sidebarEl?.clientHeight || 700
      const newHeight = Math.max(60, Math.min(containerHeight - 100, startHeight + delta))
      setConnectionListHeight(newHeight)
    }

    const handleMouseUp = () => {
      isDraggingV.current = false
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    document.body.style.cursor = 'ns-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [connectionListHeight])

  // Get connection config by tabId
  const getConnectionById = useCallback(
    (tabId: number): ConnectionConfig | undefined => {
      const tab = tabs.find((t) => t.tabId === tabId)
      if (!tab?.connectionId) return undefined
      return cachedConnections.find((c) => c.id === tab.connectionId)
    },
    [tabs],
  )

  return (
    <div className="app-container" style={{ '--win-opacity': opacity } as React.CSSProperties}>
      {/* Custom titlebar */}
      <Titlebar onSettings={() => setShowSettings(true)} />

      <div className="main-content">
        {/* Left sidebar — connection list + file panel */}
        <div className="sidebar-container" style={{ width: sidebarWidth, minWidth: sidebarWidth }}>
          {(() => {
            const showFilePanel = activeTabId != null && tabs.find((t) => t.tabId === activeTabId)?.status === 'connected'
            return (
              <>
                <div style={showFilePanel ? { height: connectionListHeight, flexShrink: 0, overflow: 'hidden' } : { flex: 1, overflow: 'hidden' }}>
                  <ConnectionManager
                    connections={connections}
                    onConnect={(config, tabId) => {
                      // Not used
                    }}
                    onTabClosed={closeTab}
                    activeTabId={activeTabId}
                    onConnectionChange={handleConnectionChange}
                    onSelectConnection={handleSelectConnection}
                    sidebarWidth={sidebarWidth}
                  />
                </div>

                {showFilePanel && (
                  <>
                    {/* Draggable divider between connection list and SFTP panel */}
                    <div className="panel-divider-h" onMouseDown={handleVDividerMouseDown} />

                    <FilePanel
                      tabId={activeTabId}
                      isConnected={true}
                      defaultPath="."
                    />
                  </>
                )}
              </>
            )
          })()}
        </div>

        {/* Draggable panel divider */}
        <div className="panel-divider" onMouseDown={handleDividerMouseDown} />

        {/* Terminal area (right) */}
        <div className="terminal-area">
          {/* Tab bar */}
          <div className="tab-bar">
            {tabs.map((tab) => (
              <div
                key={tab.tabId}
                className={`tab-item ${tab.tabId === activeTabId ? 'active' : ''}`}
                onClick={() => setActiveTabId(tab.tabId)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  setTabContextMenu({ x: e.clientX, y: e.clientY, tab })
                }}
              >
                <span>{getTabLabel(tab)}</span>
                <span
                  className="tab-close"
                  onClick={(e) => {
                    e.stopPropagation()
                    closeTab(tab.tabId)
                  }}
                >
                  ×
                </span>
              </div>
            ))}
            <div
              className="tab-add"
              onClick={() => {
                const newId = nextTabId++
                const newTab: TabInfo = {
                  tabId: newId,
                  connectionId: '',
                  connectionName: 'New Tab',
                  host: '',
                  status: 'disconnected',
                }
                setTabs((prev) => [...prev, newTab])
                setActiveTabId(newId)
              }}
            >
              +
            </div>
          </div>

          {/* Tab right-click context menu */}
          {tabContextMenu && tabContextMenu.tab.connectionId && (
            <div
              className="tab-context-menu"
              style={{ left: tabContextMenu.x, top: tabContextMenu.y }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="context-menu-item" onClick={() => duplicateTab(tabContextMenu.tab)}>
                Duplicate Tab
              </div>
            </div>
          )}

          {/* Terminal content */}
          <div className="terminal-wrapper">
            {tabs.length === 0 ? (
              <div className="terminal-placeholder">
                <div className="icon">🖥️</div>
                <div>Welcome to SSH Terminal</div>
                <div style={{ fontSize: '12px' }}>
                  Add a connection from the sidebar to get started
                </div>
              </div>
            ) : (
              tabs.map((tab) => (
                <div
                  key={tab.tabId}
                  style={{
                    display: tab.tabId === activeTabId ? 'block' : 'none',
                    height: '100%',
                  }}
                >
                  {tab.status === 'error' ? (
                    <div className="terminal-placeholder">
                      <div style={{ color: '#f44747' }}>
                        Connection failed: {tab.connectionName}
                      </div>
                      {tab.errorMessage && (
                        <div
                          style={{
                            color: '#808080',
                            fontSize: '12px',
                            marginTop: '8px',
                            maxWidth: '500px',
                            wordBreak: 'break-word',
                          }}
                        >
                          {tab.errorMessage}
                        </div>
                      )}
                    </div>
                  ) : (
                    <TerminalComponent
                      tabId={tab.tabId}
                      isActive={tab.tabId === activeTabId}
                      connectConfig={
                        tab.connectionId
                          ? (() => {
                              const conn = cachedConnections.find((c) => c.id === tab.connectionId)
                              if (!conn) return undefined
                              return {
                                host: conn.host,
                                port: conn.port,
                                username: conn.username,
                                password: conn.password,
                                keyPath: conn.keyPath,
                              }
                            })()
                          : undefined
                      }
                      autoConnect={!!tab.connectionId}
                      onStatusChange={(status, errorMessage) => {
                        setTabs((prev) =>
                          prev.map((t) =>
                            t.tabId === tab.tabId ? { ...t, status, errorMessage } : t,
                          ),
                        )
                      }}
                    />
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Status bar */}
      <div className="status-bar">
        <div className="status-bar-left">
          {(() => {
            const activeTab = tabs.find((t) => t.tabId === activeTabId)
            if (!activeTab) {
              return <span className="status-text">No active connection</span>
            }
            return (
              <>
                <span
                  className={`conn-status ${activeTab.status}`}
                  style={{ width: 8, height: 8, borderRadius: '50%' }}
                />
                <span className="status-text">
                  {activeTab.connectionName}
                  {activeTab.host ? ` — ${activeTab.host}` : ''}
                </span>
                <span className={`status-tag ${activeTab.status}`}>
                  {activeTab.status}
                </span>
              </>
            )
          })()}
        </div>
        <div className="status-bar-right">
          <span className="status-text">SSH Terminal</span>
        </div>
      </div>

      {/* Settings modal */}
      {showSettings && (
        <div className="modal-overlay" onClick={() => setShowSettings(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Settings</h3>
              <span
                onClick={() => setShowSettings(false)}
                style={{ cursor: 'pointer', fontSize: '18px', color: '#888' }}
              >
                ✕
              </span>
            </div>
            <div className="modal-body" style={{ color: '#888', fontSize: '13px' }}>
              <div className="form-group">
                <label>Window Opacity: {Math.round(opacity * 100)}%</label>
                <input
                  type="range"
                  min="20"
                  max="100"
                  value={Math.round(opacity * 100)}
                  onChange={(e) => setOpacity(Number(e.target.value) / 100)}
                  style={{ width: '100%', accentColor: '#007acc' }}
                />
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn-primary" onClick={() => setShowSettings(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

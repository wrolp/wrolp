import React, { useState, useEffect, useCallback, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { PhysicalPosition, PhysicalSize } from '@tauri-apps/api/dpi'
import { check } from '@tauri-apps/plugin-updater'
import type { Update, DownloadEvent } from '@tauri-apps/plugin-updater'
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
  const [showSidebar, setShowSidebar] = useState(true)
  const [connectionsExpanded, setConnectionsExpanded] = useState(true)
  const [filesExpanded, setFilesExpanded] = useState(true)
  const [opacity, setOpacity] = useState(1)
  const isDragging = useRef(false)
  const isDraggingV = useRef(false)

  // Update state
  const [updateInfo, setUpdateInfo] = useState<{ version: string; body?: string } | null>(null)
  const [updateState, setUpdateState] = useState<'idle' | 'checking' | 'downloading' | 'installing'>('idle')
  const [showUpdateBanner, setShowUpdateBanner] = useState(true)
  const updateRef = useRef<Update | null>(null)

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

  // Auto-check for updates on mount
  useEffect(() => {
    const checkForUpdates = async () => {
      try {
        const update = await check()
        if (update) {
          updateRef.current = update
          setUpdateInfo({ version: update.version, body: update.body })
        }
      } catch (_) {
        // No update available or check failed — silently ignore
      }
    }
    checkForUpdates()
  }, [])

  // Manual update check + install flow
  const handleCheckUpdate = async () => {
    try {
      setUpdateState('checking')
      const update = await check()
      if (update) {
        updateRef.current = update
        setUpdateInfo({ version: update.version, body: update.body })
        setShowUpdateBanner(true)
      } else {
        setUpdateInfo(null)
      }
      setUpdateState('idle')
    } catch (_) {
      setUpdateState('idle')
    }
  }

  const handleDownloadUpdate = async () => {
    const update = updateRef.current
    if (!update) return
    try {
      setUpdateState('downloading')
      await update.download((_event: DownloadEvent) => {
        // Progress: _event.event === 'Progress' with _event.data.chunkLength
      })
      setUpdateState('installing')
      await update.install()
      // App will restart after install
    } catch (e) {
      console.error('Update failed:', e)
      setUpdateState('idle')
    }
  }

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
      tabType: 'terminal',
    }

    setTabs((prev) => [...prev, newTab])
    setActiveTabId(tabId)
  }, [])

  // Open settings as a tab (reuse if already open)
  const handleOpenSettings = useCallback(() => {
    const existing = tabs.find(t => t.tabType === 'settings')
    if (existing) {
      setActiveTabId(existing.tabId)
      return
    }
    const tabId = nextTabId++
    const settingsTab: TabInfo = {
      tabId,
      connectionName: 'Settings',
      host: '',
      status: 'settings',
      tabType: 'settings',
    }
    setTabs(prev => [...prev, settingsTab])
    setActiveTabId(tabId)
  }, [tabs])

  // Close tab
  const closeTab = useCallback(
    async (tabId: number) => {
      const tab = tabs.find(t => t.tabId === tabId)
      // Only disconnect SSH sessions, not settings tab
      if (tab?.tabType === 'terminal') {
        try {
          await invoke('disconnect', { tabId })
        } catch (e) {
          console.error('Disconnect error:', e)
        }
      }

      setTabs((prev) => {
        const newTabs = prev.filter((t) => t.tabId !== tabId)
        if (activeTabId === tabId) {
          setActiveTabId(newTabs.length > 0 ? newTabs[newTabs.length - 1].tabId : null)
        }
        return newTabs
      })
    },
    [activeTabId, tabs],
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
      if (tab.tabType === 'settings') return '⚙ Settings'
      if (!tab.connectionId) return tab.connectionName
      const siblings = tabs.filter((t) => t.tabType === 'terminal' && t.connectionId === tab.connectionId)
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
      if (tab.tabType !== 'terminal' || !tab.connectionId) return
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
    e.stopPropagation()
    isDragging.current = true
    const win = getCurrentWindow()
    win.setResizable(false).catch(() => {})

    const handleMouseMove = (ev: MouseEvent) => {
      if (!isDragging.current) return
      const newWidth = Math.max(160, Math.min(500, ev.clientX))
      setSidebarWidth(newWidth)
    }

    const handleMouseUp = () => {
      isDragging.current = false
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.classList.remove('resize-h')
      document.body.style.userSelect = ''
      win.setResizable(true).catch(() => {})
    }

    document.body.classList.add('resize-h')
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [])

  // Connection list / SFTP vertical divider drag-to-resize
  const handleVDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    isDraggingV.current = true
    const win = getCurrentWindow()
    const sidebarEl = (e.target as HTMLElement).closest('.sidebar-container')
    const startY = e.clientY
    const startHeight = connectionListHeight
    win.setResizable(false).catch(() => {})

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
      document.body.classList.remove('resize-v')
      document.body.style.userSelect = ''
      win.setResizable(true).catch(() => {})
    }

    document.body.classList.add('resize-v')
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
      <Titlebar onSettings={handleOpenSettings} />

      <div className="main-content">
        {/* Left sidebar — connection list + file panel */}
        {showSidebar && (
          <div className="sidebar-container" style={{ width: sidebarWidth, minWidth: sidebarWidth }}>
            {(() => {
              const showFilePanel = activeTabId != null && tabs.find((t) => t.tabId === activeTabId)?.status === 'connected'
              return (
                <>
                  {/* Connections section */}
                  <div
                    className="collapsible-section"
                    style={
                      connectionsExpanded
                        ? (showFilePanel && filesExpanded
                          ? { height: connectionListHeight, flexShrink: 0, overflow: 'hidden' }
                          : { flex: 1, overflow: 'hidden' })
                        : { flexShrink: 0 }
                    }
                  >
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
                      expanded={connectionsExpanded}
                      onToggleExpanded={() => setConnectionsExpanded(v => !v)}
                    />
                  </div>

                  {showFilePanel && (
                    <>
                      {connectionsExpanded && (
                        <div className="panel-divider-h" onMouseDown={handleVDividerMouseDown} />
                      )}

                      {/* Files section */}
                      <div
                        className="collapsible-section"
                        style={filesExpanded ? { flex: 1, overflow: 'hidden' } : { flexShrink: 0 }}
                      >
                        <FilePanel
                          tabId={activeTabId}
                          isConnected={true}
                          defaultPath="."
                          expanded={filesExpanded}
                          onToggleExpanded={() => setFilesExpanded(v => !v)}
                        />
                      </div>
                    </>
                  )}
                </>
              )
            })()}
          </div>
        )}

        {/* Draggable panel divider */}
        {showSidebar && (
          <div className="panel-divider" onMouseDown={handleDividerMouseDown} />
        )}

        {/* Terminal area (right) */}
        <div className="terminal-area">
          {/* Tab bar */}
          <div className="tab-bar">
            <button
              className="sidebar-toggle"
              onClick={() => setShowSidebar(v => !v)}
              title={showSidebar ? 'Hide sidebar' : 'Show sidebar'}
            >
              {showSidebar ? (
                <svg width="14" height="14" viewBox="0 0 16 16">
                  <rect x="1" y="2" width="4" height="12" rx="1" fill="none" stroke="currentColor" strokeWidth="1.5" />
                  <rect x="6" y="2" width="9" height="12" rx="1" fill="none" stroke="currentColor" strokeWidth="1.5" />
                  <path d="M12 6l-2 2 2 2" stroke="currentColor" strokeWidth="1.5" fill="none" />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 16 16">
                  <rect x="1" y="2" width="4" height="12" rx="1" fill="none" stroke="currentColor" strokeWidth="1.5" />
                  <rect x="6" y="2" width="9" height="12" rx="1" fill="none" stroke="currentColor" strokeWidth="1.5" />
                  <path d="M9 6l2 2-2 2" stroke="currentColor" strokeWidth="1.5" fill="none" />
                </svg>
              )}
            </button>
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
          </div>

          {/* Tab right-click context menu */}
          {tabContextMenu && tabContextMenu.tab.tabType === 'terminal' && tabContextMenu.tab.connectionId && (
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
                <div>Welcome to Wrolp Terminal</div>
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
                  {tab.tabType === 'settings' ? (
                    <div className="settings-tab-content">
                      <h3>Settings</h3>
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
                      <div className="form-group" style={{ marginTop: 16 }}>
                        <label>Updates</label>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6 }}>
                          <button
                            className="btn-primary"
                            onClick={handleCheckUpdate}
                            disabled={updateState === 'checking' || updateState === 'downloading' || updateState === 'installing'}
                            style={{ fontSize: '12px', padding: '4px 12px' }}
                          >
                            {updateState === 'checking' ? 'Checking...' : 'Check for Updates'}
                          </button>
                          {updateInfo ? (
                            <span style={{ color: '#4ec9b0' }}>
                              New version v{updateInfo.version}
                            </span>
                          ) : updateInfo === null && updateState !== 'checking' ? (
                            <span>Up to date</span>
                          ) : null}
                        </div>
                        {updateInfo && (
                          <div style={{ marginTop: 8 }}>
                            <button
                              className="btn-primary"
                              onClick={handleDownloadUpdate}
                              disabled={updateState !== 'idle'}
                              style={{ fontSize: '12px', padding: '4px 12px' }}
                            >
                              {updateState === 'downloading' ? 'Downloading...' : updateState === 'installing' ? 'Installing...' : 'Download & Install'}
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  ) : tab.status === 'error' ? (
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
            if (activeTab.tabType === 'settings') {
              return <span className="status-text">⚙ Settings</span>
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
          {/* Update available banner */}
          {updateInfo && showUpdateBanner && (
            <div className="update-banner">
              <span className="update-text">
                v{updateInfo.version} available
              </span>
              <button className="update-btn" onClick={handleDownloadUpdate} disabled={updateState !== 'idle'}>
                {updateState === 'downloading' ? 'Downloading...' : updateState === 'installing' ? 'Installing...' : 'Update'}
              </button>
              <span className="update-close" onClick={() => setShowUpdateBanner(false)}>✕</span>
            </div>
          )}
          <span className="status-text">Wrolp Terminal</span>
        </div>
      </div>

    </div>
  )
}

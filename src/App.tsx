import React, { useState, useEffect, useCallback, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Titlebar } from './components/Titlebar'
import { ConnectionManager } from './components/ConnectionManager'
import { TerminalComponent } from './components/Terminal'
import type { ConnectionConfig, TabInfo } from './types'
import './styles/App.scss'

// Global connection cache
let cachedConnections: ConnectionConfig[] = []

// Tab id auto-increment counter
let nextTabId = 1

export default function App() {
  const [tabs, setTabs] = useState<TabInfo[]>([])
  const [activeTabId, setActiveTabId] = useState<number | null>(null)
  const [connections, setConnections] = useState<ConnectionConfig[]>([])
  const [sidebarWidth, setSidebarWidth] = useState(260)
  const [tabContextMenu, setTabContextMenu] = useState<{ x: number; y: number; tab: TabInfo } | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const isDragging = useRef(false)

  // Load connection list
  useEffect(() => {
    loadConnections()
  }, [])

  // Click anywhere on the page to close tab context menu
  useEffect(() => {
    const closeMenu = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      if (target.closest('.tab-context-menu')) return
      setTabContextMenu(null)
    }
    document.addEventListener('click', closeMenu)
    return () => document.removeEventListener('click', closeMenu)
  }, [])

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

  // Open a new tab (only creates the tab, does not connect immediately)
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
      // Disconnect
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

  // Select connection — opens a new tab each click
  const handleSelectConnection = useCallback(
    (conn: ConnectionConfig) => {
      openTab(conn)
    },
    [openTab],
  )

  // Compute tab display label (number when multiple tabs share a connection)
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

  // Right-click to duplicate tab
  const duplicateTab = useCallback(
    (tab: TabInfo) => {
      setTabContextMenu(null)
      if (!tab.connectionId) return
      const conn = cachedConnections.find((c) => c.id === tab.connectionId)
      if (conn) openTab(conn)
    },
    [openTab],
  )

  // Add new connection
  const handleConnectionChange = useCallback(() => {
    loadConnections()
  }, [])

  // Sidebar drag to resize
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
    <div className="app-container">
      {/* Custom titlebar */}
      <Titlebar onSettings={() => setShowSettings(true)} />

      <div className="main-content">
        {/* Left sidebar — connection list */}
        <ConnectionManager
          connections={connections}
          onConnect={(config, tabId) => {
            // This callback is not actually called; connections triggered via onSelectConnection
          }}
          onTabClosed={closeTab}
          activeTabId={activeTabId}
          onConnectionChange={handleConnectionChange}
          onSelectConnection={handleSelectConnection}
          sidebarWidth={sidebarWidth}
        />

        {/* Draggable sidebar divider */}
        <div className="panel-divider" onMouseDown={handleDividerMouseDown} />

        {/* Right terminal area */}
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

          {/* Tab context menu */}
          {tabContextMenu && tabContextMenu.tab.connectionId && (
            <div
              className="tab-context-menu"
              style={{ left: tabContextMenu.x, top: tabContextMenu.y }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="context-menu-item" onClick={() => duplicateTab(tabContextMenu.tab)}>
                Duplicate to New Tab
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
              <p>Settings panel coming soon.</p>
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

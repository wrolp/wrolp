import React, { useState, useEffect, useCallback, useRef } from 'react';
import { listen, emit } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { v4 as uuidv4 } from 'uuid';
import { ConnectionManager } from './components/ConnectionManager';
import { TerminalComponent } from './components/Terminal';
import type { ConnectionConfig, TabInfo } from './types';
import './App.css';

// Global connection cache
let cachedConnections: ConnectionConfig[] = [];

export default function App() {
  const [tabs, setTabs] = useState<TabInfo[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [connections, setConnections] = useState<ConnectionConfig[]>([]);
  const connectingRef = useRef<Set<string>>(new Set());

  // Load connection list
  useEffect(() => {
    loadConnections();
  }, []);

  const loadConnections = async () => {
    try {
      const result = await invoke<string>('list_connections');
      const conns = JSON.parse(result) as ConnectionConfig[];
      cachedConnections = conns;
      setConnections(conns);
    } catch (err) {
      console.error('Failed to load connections:', err);
    }
  };

  // Open new tab
  const openTab = useCallback((conn: ConnectionConfig) => {
    const tabId = uuidv4();
    const newTab: TabInfo = {
      tabId,
      connectionId: conn.id,
      connectionName: conn.name,
      host: `${conn.host}:${conn.port}`,
      status: 'connecting',
    };

    setTabs(prev => [...prev, newTab]);
    setActiveTabId(tabId);
    connectingRef.current.add(tabId);

    // Auto connect
    connectToTab(conn, tabId);
  }, []);

  // Connect to specified tab
  const connectToTab = useCallback(async (conn: ConnectionConfig, tabId: string) => {
    try {
      await invoke('connect', {
        config: conn,
        tabId,
      });

      setTabs(prev => prev.map(t =>
        t.tabId === tabId ? { ...t, status: 'connected' as const } : t
      ));
      connectingRef.current.delete(tabId);
    } catch (err) {
      setTabs(prev => prev.map(t =>
        t.tabId === tabId ? { ...t, status: 'error' as const, connectionName: `Error: ${err}` } : t
      ));
      connectingRef.current.delete(tabId);
    }
  }, []);

  // Close tab
  const closeTab = useCallback(async (tabId: string) => {
    // Disconnect
    try {
      await invoke('disconnect', { tabId });
    } catch (e) {
      console.error('Disconnect error:', e);
    }

    setTabs(prev => {
      const newTabs = prev.filter(t => t.tabId !== tabId);
      if (activeTabId === tabId) {
        setActiveTabId(newTabs.length > 0 ? newTabs[newTabs.length - 1].tabId : null);
      }
      return newTabs;
    });
  }, [activeTabId]);

  // Select connection (double-click or click)
  const handleSelectConnection = useCallback((conn: ConnectionConfig) => {
    // If a tab for this connection exists, activate it
    const existingTab = tabs.find(t => t.connectionId === conn.id);
    if (existingTab) {
      setActiveTabId(existingTab.tabId);
    } else {
      openTab(conn);
    }
  }, [tabs, openTab]);

  // Add new connection
  const handleConnectionChange = useCallback(() => {
    loadConnections();
  }, []);

  return (
    <div className="app-container">
      {/* Top toolbar */}
      <div className="toolbar">
        <span className="toolbar-title">⚡ SSH Terminal</span>
        <button
          onClick={() => {
            const newId = uuidv4();
            const newTab: TabInfo = {
              tabId: newId,
              connectionId: '',
              connectionName: 'New Tab',
              host: '',
              status: 'disconnected',
            };
            setTabs(prev => [...prev, newTab]);
            setActiveTabId(newId);
          }}
        >
          + New Tab
        </button>
      </div>

      <div className="main-content">
        {/* Left sidebar - connection list */}
        <ConnectionManager
          connections={connections}
          onConnect={(config, tabId) => {
            const tab: TabInfo = {
              tabId,
              connectionId: config.id,
              connectionName: config.name,
              host: `${config.host}:${config.port}`,
              status: 'connecting',
            };
            setTabs(prev => [...prev, tab]);
            setActiveTabId(tabId);
            connectToTab(config, tabId);
          }}
          onTabClosed={closeTab}
          activeTabId={activeTabId}
          onConnectionChange={handleConnectionChange}
          onSelectConnection={handleSelectConnection}
        />

        {/* Right side - terminal area */}
        <div className="terminal-area">
          {/* Tab bar */}
          <div className="tab-bar">
            {tabs.map(tab => (
              <div
                key={tab.tabId}
                className={`tab-item ${tab.tabId === activeTabId ? 'active' : ''}`}
                onClick={() => setActiveTabId(tab.tabId)}
              >
                <span>{tab.connectionName}</span>
                <span
                  className="tab-close"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(tab.tabId);
                  }}
                >
                  ×
                </span>
              </div>
            ))}
            <div
              className="tab-add"
              onClick={() => {
                const newId = uuidv4();
                const newTab: TabInfo = {
                  tabId: newId,
                  connectionId: '',
                  connectionName: 'New Tab',
                  host: '',
                  status: 'disconnected',
                };
                setTabs(prev => [...prev, newTab]);
                setActiveTabId(newId);
              }}
            >
              +
            </div>
          </div>

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
              tabs.map(tab => (
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
                    </div>
                  ) : (
                    <TerminalComponent
                      tabId={tab.tabId}
                      isActive={tab.tabId === activeTabId}
                    />
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

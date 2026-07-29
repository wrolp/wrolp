import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'

import { check } from '@tauri-apps/plugin-updater'
import type { Update, DownloadEvent } from '@tauri-apps/plugin-updater'
import { Titlebar } from './components/Titlebar'
import { ConnectionManager } from './components/ConnectionManager'
import { TerminalComponent } from './components/Terminal'
import { FilePanel } from './components/FilePanel'
import { BottomPanel } from './components/BottomPanel'
import { FileEditor, type EditorTab } from './components/FileEditor'
import { DockerPanel } from './components/DockerPanel'
import { Icon } from './components/Icon'
import type { FileTreeHandle } from './components/FilePanel'
import type { ConnectionConfig, TabInfo, TargetRef, ContainerInfo, WorkspaceLayout, FileTargetMode } from './types'
import { defaultLayout, mergeLayout } from './types'
import {
  SplitNode,
  SplitBranch,
  SplitLeaf,
  makeLeaf,
  findLeaf,
  collectLeaves,
  buildTabToLeaf,
  updateLeafTab,
  splitLeaf,
  removeLeafById,
  adjustSiblingSizes,
  pruneEmptyLeaves,
  movePane,
  DropPosition,
} from './components/splitTree'
import { loadWindowConfig, saveWindowConfig, fsReadFileContent, fsWriteFileContent, loadLayout, saveLayout, sendInput } from './commands'
import { detectLanguage } from './editor/languages'
import './styles/App.scss'

// Global connection cache
let cachedConnections: ConnectionConfig[] = []

// Auto-incrementing tab id counter
let nextTabId = 1

export default function App() {
  const [tabs, setTabs] = useState<TabInfo[]>([])
  const [activeTabId, setActiveTabId] = useState<number | null>(null)
  const [connections, setConnections] = useState<ConnectionConfig[]>([])
  const [tabContextMenu, setTabContextMenu] = useState<{ x: number; y: number; tab: TabInfo } | null>(null)
  const [tabDragIndex, setTabDragIndex] = useState<number | null>(null)
  const tabDragRef = useRef<number | null>(null)
  // Customizable workspace layout (sidebar side/visibility, panel position,
  // section visibility/collapse, sizes). Persisted to layout.json via loadLayout/saveLayout.
  const [layout, setLayout] = useState<WorkspaceLayout>(defaultLayout)
  const layoutLoadedRef = useRef(false)
  const updateLayout = useCallback(
    (updater: (prev: WorkspaceLayout) => WorkspaceLayout) => setLayout(updater),
    [],
  )

  // Derived values so the rest of the render can keep using the familiar names.
  const sidebarWidth = layout.sidebar.width
  const showSidebar = layout.sidebar.visible
  const connectionsExpanded = !layout.sidebar.sections.connections.collapsed
  const filesExpanded = !layout.sidebar.sections.files.collapsed
  const dockerExpanded = !layout.sidebar.sections.docker.collapsed
  const connectionListHeight = layout.sidebar.sections.connections.height ?? 200
  const dockerHeight = layout.sidebar.sections.docker.height ?? 220
  const bottomPanelExpanded = layout.bottomPanel.visible
  // Remote filesystem shown in the Files panel (null = the tab's main session).
  const [fileTarget, setFileTarget] = useState<TargetRef | null>(null)
  const [dockerAnalysisTarget, setDockerAnalysisTarget] = useState<string | null>(null)
  // Which filesystem mode the Files panel switcher is on (ssh / jump / docker).
  const [fileMode, setFileMode] = useState<FileTargetMode>('ssh')

  // Shell (terminal) pane height / collapse when a file editor is open
  const [shellHeight, setShellHeight] = useState(240)
  const [shellCollapsed, setShellCollapsed] = useState(false)

  // SSH terminal size (cols × rows) reported by the active Terminal component,
  // shown in the shell-pane status bar.
  // Per-pane terminal size, keyed by leaf id so each shell window shows its
  // own dimensions in its status bar.
  const [termSizes, setTermSizes] = useState<Record<string, { cols: number; rows: number }>>({})

  // ---------------------------------------------------------------------------
  // Terminal split layout (Phase 2). The tree is ephemeral (tabIds are
  // session-scoped) and is intentionally NOT persisted to layout.json.
  // ---------------------------------------------------------------------------
  // Each top-level tab (workspace) owns its own split-pane tree, so tabs are
  // fully isolated and switching tabs shows that tab's own layout. The active
  // workspace's tree is `splitTree` (derived below) and is rendered inside its
  // own always-mounted container, toggled by visibility — so sessions are never
  // remounted and never reconnect when you switch tabs.
  const [splitTrees, setSplitTrees] = useState<Record<number, SplitNode>>({})
  const [focusedLeafByRoot, setFocusedLeafByRoot] = useState<Record<number, string>>({})
  // Phase 3 — terminal pane drag reorder. `source` is the dragged leaf id,
  // `target`/`position` describe where it would drop. `center` swaps the two
  // panes' sessions; a direction inserts the source as a sibling of the target.
  const [paneDrag, setPaneDrag] = useState<{ source: string | null; target: string | null; position: DropPosition | null }>({
    source: null,
    target: null,
    position: null,
  })
  // Mirror of `paneDrag` kept in a ref so the drop can be applied reliably in
  // `onDragEnd` (which ALWAYS fires on release) instead of relying on the native
  // `drop` event, which is frequently swallowed by the portaled xterm surface.
  const paneDragRef = useRef<{ source: string | null; target: string | null; position: DropPosition | null }>({
    source: null,
    target: null,
    position: null,
  })
  // Phase 3 — panel dock drag (sidebar / bottom panel re-docking). `source` is
  // which panel is being dragged; `over` is the dock zone currently hovered.
  // DockZone covers every zone either panel can be dropped into.
  type DockZone = 'left' | 'right' | 'bottom'
  const [dockDrag, setDockDrag] = useState<{ source: 'sidebar' | 'bottomPanel' | null; over: DockZone | null }>({
    source: null,
    over: null,
  })
  const applyDock = (source: 'sidebar' | 'bottomPanel', pos: DockZone) => {
    if (source === 'sidebar') {
      if (pos === 'left' || pos === 'right') {
        updateLayout((l) => ({ ...l, sidebar: { ...l.sidebar, side: pos } }))
      }
    } else {
      if (pos === 'right' || pos === 'bottom') {
        updateLayout((l) => ({ ...l, bottomPanel: { ...l.bottomPanel, pos } }))
      }
    }
    setDockDrag({ source: null, over: null })
  }
  const leafIdCounter = useRef(1)
  const newLeafId = useCallback(() => `leaf-${leafIdCounter.current++}`, [])
  // Active workspace's tree (a stable single leaf if missing).
  const splitTree: SplitNode =
    activeTabId != null
      ? splitTrees[activeTabId] ?? makeLeaf(newLeafId(), activeTabId)
      : makeLeaf('leaf-0')
  const splitTreeRef = useRef<SplitNode>(splitTree)
  splitTreeRef.current = splitTree
  // Focused leaf within the active workspace.
  const focusedLeafId = activeTabId != null ? focusedLeafByRoot[activeTabId] ?? null : null
  const focusedLeafIdRef = useRef<string | null>(focusedLeafId)
  focusedLeafIdRef.current = focusedLeafId
  // The connection whose remote filesystem the Files panel should show: the
  // focused pane's session within the active workspace (falls back to the
  // workspace's own session). Clicking a different split pane switches the
  // Files panel to that pane's connection.
  const focusedLeafTabId: number | null =
    activeTabId != null
      ? (focusedLeafId ? findLeaf(splitTree, focusedLeafId)?.tabId : null) ?? activeTabId
      : null
  const activeTabIdRef = useRef(activeTabId)
  activeTabIdRef.current = activeTabId
  const splitTreesRef = useRef(splitTrees)
  splitTreesRef.current = splitTrees
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  const focusedLeafByRootRef = useRef(focusedLeafByRoot)
  focusedLeafByRootRef.current = focusedLeafByRoot
  // Update the active workspace's tree.
  const updateActiveTree = useCallback(
    (updater: (t: SplitNode) => SplitNode) => {
      const root = activeTabIdRef.current
      if (root == null) return
      setSplitTrees((prev) => ({ ...prev, [root]: updater(prev[root] ?? makeLeaf(newLeafId(), root)) }))
    },
    [newLeafId],
  )
  // Focus a pane within the active workspace.
  const setFocusedLeafId = useCallback((id: string | null) => {
    const root = activeTabIdRef.current
    if (root == null) return
    setFocusedLeafByRoot((prev) => ({ ...prev, [root]: id ?? '' }))
  }, [])

  // Phase 3 — apply a terminal-pane drag drop: move/swap the dragged leaf
  // relative to the drop target within the active workspace's split tree.
  const performPaneMove = useCallback(
    (sourceId: string, targetId: string, position: DropPosition) => {
      const root = activeTabIdRef.current
      if (root == null) return
      setSplitTrees((prev) => {
        const tree = prev[root]
        if (!tree) return prev
        return { ...prev, [root]: movePane(tree, sourceId, targetId, position, newLeafId) }
      })
    },
    [newLeafId],
  )

  // Keep terminal instances mounted even when not shown in any pane by portaling
  // their DOM into stable containers. Pane-body ref callbacks are cached per leaf
  // id so React only calls them on mount/unmount (not every render); that lets us
  // re-trigger portal placement via a render tick.
  const paneBodyRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const paneBodyRefCallbacks = useRef<Map<string, (el: HTMLDivElement | null) => void>>(new Map())
  const getPaneBodyRef = useCallback((id: string) => {
    let cb = paneBodyRefCallbacks.current.get(id)
    if (!cb) {
      cb = (el: HTMLDivElement | null) => {
        if (el) paneBodyRefs.current.set(id, el)
        else paneBodyRefs.current.delete(id)
        setPaneRenderTick((t) => (t + 1) % 1_000_000)
      }
      paneBodyRefCallbacks.current.set(id, cb)
    }
    return cb
  }, [])
  const [, setPaneRenderTick] = useState(0)
  const terminalPoolRef = useRef<HTMLDivElement>(null)
  const terminalPoolRefCb = useCallback((el: HTMLDivElement | null) => {
    terminalPoolRef.current = el
    setPaneRenderTick((t) => (t + 1) % 1_000_000)
  }, [])
  const tabToLeafRef = useRef<Map<number, string>>(new Map())

  // Reset the Files panel target when switching tabs (targets are tab-scoped).
  useEffect(() => {
    setFileTarget(null)
    setFileMode('ssh')
  }, [activeTabId])

  // Send any queued post-connect commands (e.g. docker exec) when a tab finishes connecting.
  const prevStatusesRef = useRef<Record<number, string>>({})
  useEffect(() => {
    for (const tab of tabs) {
      const prev = prevStatusesRef.current[tab.tabId]
      if (prev !== 'connected' && tab.status === 'connected') {
        const cmd = pendingCommandsRef.current.get(tab.tabId)
        if (cmd) {
          pendingCommandsRef.current.delete(tab.tabId)
          // Allow the terminal a moment to settle
          setTimeout(() => sendInput(tab.tabId, cmd), 300)
        }
      }
      prevStatusesRef.current[tab.tabId] = tab.status
    }
  }, [tabs])

  // Open (or toggle closed) a Docker container's filesystem in the Files panel.
  const handleOpenContainer = useCallback(
    (container: ContainerInfo) => {
      if (activeTabId == null) return
      setFileTarget((prev) =>
        prev?.kind === 'docker' && prev.container === container.name
          ? null
          : { kind: 'docker', jumpTabId: activeTabId, container: container.name },
      )
      setFileMode('docker')
      updateLayout((l) => ({
        ...l,
        sidebar: {
          ...l.sidebar,
          sections: {
            ...l.sidebar.sections,
            files: { ...l.sidebar.sections.files, collapsed: false },
          },
        },
      }))
    },
    [activeTabId],
  )

  // Open a new terminal tab connected to the same jump host and automatically
  // run `docker exec -it <container> /bin/bash || docker exec -it <container> /bin/sh`
  const handleEnterContainerShell = useCallback(
    (container: ContainerInfo) => {
      if (activeTabId == null) return
      const activeTab = tabs.find((t) => t.tabId === activeTabId)
      if (!activeTab?.connectionId) return
      const conn = connections.find((c) => c.id === activeTab.connectionId)
      if (!conn) return

      const newTabId = openTab(conn)
      // Queue the docker exec command to be sent once the tab connects
      pendingCommandsRef.current.set(
        newTabId,
        `docker exec -it ${container.name} /bin/bash || docker exec -it ${container.name} /bin/sh\r`,
      )
    },
    [activeTabId, tabs, connections],
  )

  // Trigger Docker container analysis (opens report in bottom panel's "Docker" tab).
  const handleAnalyzeContainer = useCallback(
    (container: ContainerInfo) => {
      setDockerAnalysisTarget(container.name)
      // Ensure bottom panel is visible
      if (!layout.bottomPanel.visible) {
        updateLayout((l) => ({ ...l, bottomPanel: { ...l.bottomPanel, visible: true } }))
      }
    },
    [layout.bottomPanel.visible],
  )

  // Remote file editor state
  const [editorTabs, setEditorTabs] = useState<EditorTab[]>([])
  const [activeEditorKey, setActiveEditorKey] = useState<string | null>(null)
  const [syncEnabled, setSyncEnabled] = useState(() => {
    try {
      return localStorage.getItem('wrolp-sync-enabled') === '1'
    } catch {
      return false
    }
  })
  const [opacity, setOpacity] = useState(1)
  const [maxScrollback, setMaxScrollback] = useState(() => {
    try {
      const v = localStorage.getItem('wrolp-maxScrollback')
      return v ? Number(v) : 5000
    } catch {
      return 5000
    }
  })
  const [reconnectKeys, setReconnectKeys] = useState<Record<number, number>>({})
  const isDragging = useRef(false)
  const isDraggingV = useRef(false)
  const panelDragRef = useRef(false)
  /** Commands to send after a tab finishes connecting, keyed by tabId. */
  const pendingCommandsRef = useRef<Map<number, string>>(new Map())

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

  // Listen for unexpected SSH disconnections
  useEffect(() => {
    const unlisten = listen<{ tabId: number }>('connection-closed', (event) => {
      const tid = event.payload.tabId
      setTabs((prev) =>
        prev.map((t) =>
          t.tabId === tid && t.status === 'connected'
            ? { ...t, status: 'disconnected', errorMessage: 'Connection lost' }
            : t,
        ),
      )
    })
    return () => { unlisten.then(fn => fn()) }
  }, [])

  // Enter key retry on disconnected/error tabs
  const handleReconnectRef = useRef<((tabId: number) => void) | null>(null)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Enter') return
      // Ignore if focus is in an input/button/textarea/select
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'BUTTON' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (activeTabId == null) return
      const tab = tabs.find(t => t.tabId === activeTabId)
      if (!tab || (tab.status !== 'disconnected' && tab.status !== 'error')) return
      handleReconnectRef.current?.(activeTabId)
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [activeTabId, tabs])

  // Load persisted workspace layout on startup (merged onto defaults).
  useEffect(() => {
    let cancelled = false
    loadLayout()
      .then((json) => {
        if (cancelled) return
        try {
          setLayout((prev) => mergeLayout(prev, JSON.parse(json)))
        } catch {
          // keep defaults on parse error
        }
        layoutLoadedRef.current = true
      })
      .catch(() => {
        layoutLoadedRef.current = true
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Persist layout changes (debounced) once the initial load has completed.
  useEffect(() => {
    if (!layoutLoadedRef.current) return
    const id = setTimeout(() => {
      saveLayout(JSON.stringify(layout)).catch(() => {})
    }, 400)
    return () => clearTimeout(id)
  }, [layout])

  // Layout shortcuts:
  //   Ctrl+B            toggle sidebar visibility
  //   Ctrl+Alt+B        move sidebar to the other side
  //   Ctrl+J            toggle the bottom/panel
  //   Ctrl+Alt+J        move the panel to bottom <-> right
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey
      if (!ctrl) return
      const key = e.key.toLowerCase()
      if (key === 'b' && e.altKey) {
        e.preventDefault()
        updateLayout((l) => ({
          ...l,
          sidebar: { ...l.sidebar, side: l.sidebar.side === 'left' ? 'right' : 'left' },
        }))
        return
      }
      if (key === 'b') {
        e.preventDefault()
        updateLayout((l) => ({ ...l, sidebar: { ...l.sidebar, visible: !l.sidebar.visible } }))
        return
      }
      if (key === 'j' && e.altKey) {
        e.preventDefault()
        updateLayout((l) => ({
          ...l,
          bottomPanel: {
            ...l.bottomPanel,
            pos: l.bottomPanel.pos === 'bottom' ? 'right' : 'bottom',
          },
        }))
        return
      }
      if (key === 'j') {
        e.preventDefault()
        updateLayout((l) => ({
          ...l,
          bottomPanel: { ...l.bottomPanel, visible: !l.bottomPanel.visible },
        }))
        return
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [updateLayout])

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
  // Open a connection as a NEW top-level tab (workspace). Each workspace owns
  // its own single-pane tree; splitting later adds panes inside it (not a new
  // top tab). This keeps tabs isolated — switching tabs shows that workspace's
  // own layout.
  const openTab = useCallback(
    (conn: ConnectionConfig): number => {
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
      const leafId = newLeafId()
      setSplitTrees((prev) => ({ ...prev, [tabId]: makeLeaf(leafId, tabId) }))
      setFocusedLeafByRoot((prev) => ({ ...prev, [tabId]: leafId }))
      setActiveTabId(tabId)
      return tabId
    },
    [newLeafId],
  )

  // Split the currently focused pane inside the active workspace and open the
  // chosen connection in the new pane as an EMBEDDED session. The new session is
  // NOT added to the top tab bar (it lives inside this workspace's pane layout),
  // so the split never spawns a new top-level tab.
  const openInSplit = useCallback(
    (conn: ConnectionConfig, direction: 'row' | 'column') => {
      const rootId = activeTabIdRef.current
      if (rootId == null) return
      const tree = splitTreeRef.current
      const focus = focusedLeafIdRef.current
      const focusLeaf = focus ? findLeaf(tree, focus) : null
      const targetId = focusLeaf ? focus! : collectLeaves(tree)[0]?.id
      if (!targetId) return
      const tabId = nextTabId++
      const newTab: TabInfo = {
        tabId,
        connectionId: conn.id,
        connectionName: conn.name,
        host: `${conn.host}:${conn.port}`,
        status: 'connecting',
        tabType: 'terminal',
        embedded: true,
      }
      setTabs((prev) => [...prev, newTab])
      const { tree: nt, newLeafId: nl } = splitLeaf(tree, targetId, tabId, direction, newLeafId)
      updateActiveTree(() => nt)
      if (nl) setFocusedLeafId(nl)
    },
    [newLeafId, updateActiveTree],
  )

  // Right-click → split the current window; default (left-click) opens a new tab.
  const handleOpenSplit = useCallback(
    (conn: ConnectionConfig, direction: 'row' | 'column') => {
      openInSplit(conn, direction)
    },
    [openInSplit],
  )

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

  // Close a top-level tab (workspace): disconnect and remove its own session
  // plus every embedded session created by splitting inside it, and drop its
  // tree.
  const closeTab = useCallback(async (tabId: number) => {
    const root = tabsRef.current.find((t) => t.tabId === tabId)
    if (!root) return
    // Sessions belonging to this workspace: the root itself + any embedded ones
    // referenced by its tree.
    const tree = splitTreesRef.current[tabId]
    const sessionIds = tree
      ? collectLeaves(tree)
          .map((l) => l.tabId)
          .filter((x): x is number => x != null)
      : [tabId]
    for (const sid of sessionIds) {
      const s = tabsRef.current.find((t) => t.tabId === sid)
      if (s?.tabType === 'terminal') {
        try {
          await invoke('disconnect', { tabId: sid })
        } catch (e) {
          console.error('Disconnect error:', e)
        }
      }
    }
    setTabs((prev) => prev.filter((t) => !sessionIds.includes(t.tabId)))
    setSplitTrees((prev) => {
      const n = { ...prev }
      delete n[tabId]
      return n
    })
    setFocusedLeafByRoot((prev) => {
      const n = { ...prev }
      delete n[tabId]
      return n
    })
    setActiveTabId((prev) => {
      if (prev !== tabId) return prev
      const remaining = tabsRef.current.filter(
        (t) => t.tabType === 'terminal' && !t.embedded && !sessionIds.includes(t.tabId),
      )
      return remaining.length ? remaining[0].tabId : null
    })
  }, [])

  // Select connection — always open a new tab
  const handleSelectConnection = useCallback(
    (conn: ConnectionConfig) => {
      openTab(conn)
    },
    [openTab],
  )

  // Open a remote file in the inline editor (loads content on demand).
  // `target` identifies which remote filesystem the file lives on.
  const openInEditor = useCallback(async (target: TargetRef, path: string) => {
    const key = `${JSON.stringify(target)}:${path}`
    const legacyTabId = target.kind === 'session' ? target.tabId : target.jumpTabId
    setEditorTabs((prev) => {
      if (prev.some((t) => t.key === key)) return prev
      return [
        ...prev,
        {
          key,
          sshTabId: legacyTabId,
          targetRef: target,
          path,
          name: path.split('/').pop() || path,
          content: '',
          savedContent: '',
          isBinary: false,
          isTooLarge: false,
          isDirty: false,
          loading: true,
          size: 0,
          language: detectLanguage(path.split('/').pop() || path),
          encoding: 'utf-8',
          needsEncoding: false,
          lineEnding: 'LF' as const,
        },
      ]
    })
    setActiveEditorKey(key)
    try {
      const fc = await fsReadFileContent(target, path)
      setEditorTabs((prev) =>
        prev.map((t) =>
          t.key === key
              ? {
                  ...t,
                  loading: false,
                  content: fc.content,
                  savedContent: fc.content,
                  isBinary: fc.isBinary,
                  isTooLarge: fc.isTooLarge,
                  size: fc.size,
                  encoding: fc.encoding,
                  needsEncoding: fc.needsEncoding,
                  lineEnding: (
                    typeof fc.content === 'string' && /\r\n/.test(fc.content)
                      ? 'CRLF'
                      : 'LF'
                  ) as 'LF' | 'CRLF',
                }
            : t,
        ),
      )
    } catch (e) {
      setEditorTabs((prev) =>
        prev.map((t) =>
          t.key === key ? { ...t, loading: false, error: String(e) } : t,
        ),
      )
    }
  }, [])

  const closeEditorTab = useCallback(
    (key: string) => {
      setEditorTabs((prev) => {
        const idx = prev.findIndex((t) => t.key === key)
        if (idx < 0) return prev
        const next = prev.filter((t) => t.key !== key)
        if (activeEditorKey === key) {
          setActiveEditorKey(
            next.length > 0
              ? next[Math.min(idx, next.length - 1)].key
              : null,
          )
        }
        return next
      })
    },
    [activeEditorKey],
  )

  const fileTreeRef = useRef<FileTreeHandle>(null)

  const handleEditorContentChange = useCallback((key: string, content: string) => {
    setEditorTabs((prev) =>
      prev.map((t) =>
        t.key === key
          ? { ...t, content, isDirty: content !== t.savedContent }
          : t,
      ),
    )
  }, [])

  // Resolve the remote filesystem a tab's file lives on (defaults to its session).
  const tabTarget = (t: EditorTab): TargetRef =>
    t.targetRef ?? { kind: 'session', tabId: t.sshTabId }

  const handleSaveEditorTab = useCallback(
    async (key: string) => {
      const target = editorTabs.find((t) => t.key === key)
      if (!target || target.isBinary || target.isTooLarge) return
      setEditorTabs((prev) =>
        prev.map((t) =>
          t.key === key ? { ...t, saving: true, error: undefined } : t,
        ),
      )
      try {
        await fsWriteFileContent(
          tabTarget(target),
          target.path,
          target.content,
          target.encoding,
        )
        setEditorTabs((prev) =>
          prev.map((t) =>
            t.key === key
              ? { ...t, saving: false, savedContent: t.content, isDirty: false, needsEncoding: false }
              : t,
          ),
        )
        // Refresh file tree after save
        fileTreeRef.current?.refresh()
      } catch (e) {
        setEditorTabs((prev) =>
          prev.map((t) =>
            t.key === key ? { ...t, saving: false, error: String(e) } : t,
          ),
        )
      }
    },
    [editorTabs],
  )

  const changeEditorTabLanguage = useCallback(
    (key: string, language: string) => {
      setEditorTabs((prev) =>
        prev.map((t) => (t.key === key ? { ...t, language } : t)),
      )
    },
    [],
  )

  const changeEditorTabLineEnding = useCallback(
    (key: string, lineEnding: 'LF' | 'CRLF') => {
      setEditorTabs((prev) =>
        prev.map((t) => (t.key === key ? { ...t, lineEnding } : t)),
      )
    },
    [],
  )

  const changeEditorTabEncoding = useCallback(
    async (key: string, encoding: string) => {
      const target = editorTabs.find((t) => t.key === key)
      if (!target) return
      if (target?.isDirty) {
        const ok = window.confirm(
          'Switching encoding will reload the file and discard unsaved changes. Continue?',
        )
        if (!ok) return
      }
      try {
        const fc = await fsReadFileContent(tabTarget(target), target.path, {
          encoding,
        })
        if (fc.isBinary || fc.isTooLarge) return
        setEditorTabs((prev) =>
          prev.map((t) =>
            t.key === key
              ? {
                  ...t,
                  content: fc.content,
                  savedContent: fc.content,
                  isDirty: false,
                  encoding: fc.encoding,
                  needsEncoding: fc.needsEncoding,
                  error: undefined,
                }
              : t,
          ),
        )
      } catch {
        // encoding not supported by server; keep current tab state
      }
    },
    [editorTabs],
  )

  // Reconnect a disconnected tab
  const handleReconnect = useCallback((tabId: number) => {
    setTabs((prev) =>
      prev.map((t) =>
        t.tabId === tabId ? { ...t, status: 'connecting', errorMessage: undefined } : t,
      ),
    )
    setReconnectKeys((prev) => ({ ...prev, [tabId]: (prev[tabId] || 0) + 1 }))
  }, [])

  // Sync handleReconnect to ref for keyboard listener
  useEffect(() => { handleReconnectRef.current = handleReconnect }, [handleReconnect])

  // Compute tab display label (number tabs sharing the same connection)
  const getTabLabel = useCallback(
    (tab: TabInfo): string => {
      if (tab.tabType === 'settings') return '⚙ Settings'
      if (!tab.connectionId) return tab.connectionName
      const siblings = tabs.filter(
        (t) => t.tabType === 'terminal' && !t.embedded && t.connectionId === tab.connectionId,
      )
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

  // Close a single pane within a workspace. Only that pane's session is
  // disconnected/removed; the workspace (top tab) stays open as long as at
  // least one pane remains. The workspace is keyed by its top-tab id (rootId)
  // and is never re-keyed on pane close, so surviving terminals are never
  // remounted or reconnected. When the closed pane is the workspace's own
  // (identity) session but other panes remain, we keep the rootId tab as the
  // workspace entry (marking it disconnected) and just drop its leaf, rather
  // than tearing down the whole workspace. Only when the last pane is closed
  // does the whole workspace close.
  const closePane = useCallback(
    (leafId: string) => {
      const disconnectTab = (id: number) => {
        const tab = tabsRef.current.find((t) => t.tabId === id)
        if (tab?.tabType === 'terminal') {
          try {
            invoke('disconnect', { tabId: id })
          } catch (e) {
            console.error('Disconnect error:', e)
          }
        }
      }
      // Find which workspace contains this leaf.
      let rootId: number | null = null
      let closedTabId: number | null = null
      for (const [rid, t] of Object.entries(splitTreesRef.current)) {
        const leaf = findLeaf(t, leafId)
        if (leaf) {
          rootId = Number(rid)
          closedTabId = leaf.tabId ?? null
          break
        }
      }
      if (rootId == null) return
      const prevTree = splitTreesRef.current[rootId]
      const removed = removeLeafById(prevTree, leafId, newLeafId)
      if (!removed) {
        // The closed pane was the last one in the workspace -> close it fully.
        closeTab(rootId)
        return
      }
      const nt = pruneEmptyLeaves(removed, newLeafId)
      const remainingLeaves = collectLeaves(nt)
      if (remainingLeaves.length === 0) {
        closeTab(rootId)
        return
      }
      // Tear down only the closed session's tab.
      if (closedTabId != null) {
        if (closedTabId === rootId) {
          // The workspace's identity pane closed, but others remain. Keep the
          // rootId tab as the workspace entry (now disconnected) so the top tab
          // bar stays valid; do not remove it.
          disconnectTab(rootId)
          setTabs((prev) => prev.map((t) => (t.tabId === rootId ? { ...t, status: 'disconnected' } : t)))
        } else {
          disconnectTab(closedTabId)
          setTabs((prev) => prev.filter((t) => t.tabId !== closedTabId))
        }
      }
      // Update the tree (functional updater composes correctly with rapid calls).
      setSplitTrees((prev) => {
        const tree = prev[rootId]
        if (!tree) return prev
        const r = removeLeafById(tree, leafId, newLeafId)
        if (!r) return prev
        return { ...prev, [rootId!]: pruneEmptyLeaves(r, newLeafId) }
      })
      // Keep focus on a still-present pane.
      setFocusedLeafByRoot((prev) => {
        const next: Record<number, string> = { ...prev }
        const f = next[rootId!]
        next[rootId!] = f && findLeaf(nt, f) ? f : remainingLeaves[remainingLeaves.length - 1]?.id ?? ''
        return next
      })
    },
    [newLeafId, closeTab],
  )

  // Tab-bar click: switch the active workspace. Because each workspace renders
  // inside its own always-mounted container, switching only toggles visibility —
  // no portal moves, so sessions are preserved (no reconnect). The focused pane
  // is reset to the workspace's first pane.
  const handleTabClick = useCallback((tabId: number) => {
    setActiveTabId(tabId)
    const tree = splitTreesRef.current[tabId]
    if (tree) {
      const leaves = collectLeaves(tree)
      setFocusedLeafId(leaves.length ? leaves[0].id : null)
    } else {
      setFocusedLeafId(null)
    }
  }, [])

  // Tab drag to reorder
  const handleTabDragStart = useCallback((e: React.DragEvent, index: number) => {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', String(index))
    tabDragRef.current = index
    setTabDragIndex(index)
  }, [])

  const handleTabDragOver = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (tabDragRef.current !== null && tabDragRef.current !== index) {
      setTabDragIndex(index)
    }
  }, [])

  const handleTabDragEnd = useCallback(() => {
    tabDragRef.current = null
    setTabDragIndex(null)
  }, [])

  const handleTabDrop = useCallback((e: React.DragEvent, targetIndex: number) => {
    e.preventDefault()
    const sourceIndex = tabDragRef.current
    tabDragRef.current = null
    setTabDragIndex(null)
    if (sourceIndex === null || sourceIndex === targetIndex) return
    setTabs((prev) => {
      const nonEmbedded = prev.filter((t) => !t.embedded)
      const embedded = prev.filter((t) => t.embedded)
      if (sourceIndex < 0 || sourceIndex >= nonEmbedded.length ||
          targetIndex < 0 || targetIndex >= nonEmbedded.length) return prev
      const [moved] = nonEmbedded.splice(sourceIndex, 1)
      nonEmbedded.splice(targetIndex, 0, moved)
      return [...nonEmbedded, ...embedded]
    })
  }, [])

  // Drag a split divider to resize two adjacent panes.
  const handleSplitDividerMouseDown = useCallback(
    (e: React.MouseEvent, branch: SplitBranch, index: number) => {
      e.preventDefault()
      e.stopPropagation()
      // The divider lives directly inside the workspace container now (no
      // intermediate .term-split wrapper), so measure the workspace box.
      const splitEl = (e.currentTarget as HTMLElement).closest('.term-workspace') as HTMLElement | null
      if (!splitEl) return
      const rect = splitEl.getBoundingClientRect()
      const isRow = branch.dir === 'row'
      const total = isRow ? rect.width : rect.height
      if (total <= 0) return
      const startPos = isRow ? e.clientX : e.clientY
      const sizeA = branch.sizes[index - 1]
      const sizeB = branch.sizes[index]
      const startSum = sizeA + sizeB
      const onMove = (ev: MouseEvent) => {
        const pos = isRow ? ev.clientX : ev.clientY
        const delta = ((pos - startPos) / total) * startSum
        let na = sizeA + delta
        let nb = sizeB - delta
        const min = 0.05
        na = Math.max(min, Math.min(startSum - min, na))
        nb = startSum - na
        updateActiveTree((t) => adjustSiblingSizes(t, branch.id, index - 1, index, na, nb))
      }
      const onUp = () => {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        document.body.classList.remove('resizing-h', 'resizing-v')
        document.body.style.userSelect = ''
        try {
          getCurrentWindow().setResizable(true)
        } catch {
          /* ignore */
        }
      }
      document.body.classList.add(isRow ? 'resizing-h' : 'resizing-v')
      document.body.style.userSelect = 'none'
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
      try {
        getCurrentWindow().setResizable(false)
      } catch {
        /* ignore — internal resize must still work even if window lock fails */
      }
    },
    [],
  )

  // Split the active session into a new side-by-side pane (Ctrl+\): open the
  // same connection again as an embedded pane within the current workspace.
  const handleSplitTerminal = useCallback(() => {
    const rootId = activeTabIdRef.current
    if (rootId == null) return
    const focus = focusedLeafIdRef.current
    const tree = splitTreeRef.current
    const leaf = focus ? findLeaf(tree, focus) : collectLeaves(tree)[0]
    const sessId = leaf?.tabId
    const sess = sessId != null ? tabsRef.current.find((t) => t.tabId === sessId) : null
    if (!sess || sess.tabType !== 'terminal' || !sess.connectionId) return
    const conn = cachedConnections.find((c) => c.id === sess.connectionId)
    if (conn) openInSplit(conn, 'row')
  }, [openInSplit])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey
      if (!ctrl || e.key !== '\\') return
      e.preventDefault()
      handleSplitTerminal()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [handleSplitTerminal])

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
      const newWidth =
        layout.sidebar.side === 'right'
          ? window.innerWidth - ev.clientX
          : ev.clientX
      updateLayout((l) => ({
        ...l,
        sidebar: { ...l.sidebar, width: Math.max(160, Math.min(500, newWidth)) },
      }))
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
  }, [layout.sidebar.side])

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
      updateLayout((l) => ({
        ...l,
        sidebar: {
          ...l.sidebar,
          sections: {
            ...l.sidebar.sections,
            connections: { ...l.sidebar.sections.connections, height: newHeight },
          },
        },
      }))
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

  // Files <-> Docker vertical divider drag-to-resize (only when the Docker panel is expanded)
  const handleDockerDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    isDraggingV.current = true
    const win = getCurrentWindow()
    const sidebarEl = (e.target as HTMLElement).closest('.sidebar-container')
    const startY = e.clientY
    const startHeight = dockerHeight
    win.setResizable(false).catch(() => {})

    const handleMouseMove = (ev: MouseEvent) => {
      if (!isDraggingV.current) return
      // Docker panel sits BELOW this divider, so dragging the divider down
      // (increasing clientY) must SHRINK it — mirror the shell divider's sign.
      const delta = startY - ev.clientY
      const containerHeight = sidebarEl?.clientHeight || 700
      const newHeight = Math.max(80, Math.min(containerHeight - 100, startHeight + delta))
      updateLayout((l) => ({
        ...l,
        sidebar: {
          ...l.sidebar,
          sections: {
            ...l.sidebar.sections,
            docker: { ...l.sidebar.sections.docker, height: newHeight },
          },
        },
      }))
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
  }, [dockerHeight])

  // Bottom panel resize when docked to the bottom (horizontal divider -> height).
  const handleBottomDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const win = getCurrentWindow()
    win.setResizable(false).catch(() => {})
    const isDragging = panelDragRef
    isDragging.current = true
    const startY = e.clientY
    const startSize = layout.bottomPanel.size ?? 240
    const handleMouseMove = (ev: MouseEvent) => {
      if (!isDragging.current) return
      const delta = startY - ev.clientY
      const newSize = Math.max(120, Math.min(800, startSize + delta))
      updateLayout((l) => ({
        ...l,
        bottomPanel: {
          ...l.bottomPanel,
          size: newSize,
        },
      }))
    }
    const handleMouseUp = () => {
      isDragging.current = false
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
  }, [layout.bottomPanel.size])

  // Bottom panel resize when docked to the right (vertical divider -> width).
  const handlePanelDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const win = getCurrentWindow()
    win.setResizable(false).catch(() => {})
    const isDragging = panelDragRef
    isDragging.current = true
    const handleMouseMove = (ev: MouseEvent) => {
      if (!isDragging.current) return
      const newWidth = window.innerWidth - ev.clientX
      updateLayout((l) => ({
        ...l,
        bottomPanel: {
          ...l.bottomPanel,
          size: Math.max(180, Math.min(700, newWidth)),
        },
      }))
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

  // Editor <-> Shell vertical divider drag-to-resize (only when a file editor is open)
  const handleEditorShellDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const win = getCurrentWindow()
    const areaEl = (e.target as HTMLElement).closest('.terminal-area')
    const startY = e.clientY
    const startHeight = shellHeight
    const areaH = areaEl?.clientHeight || 600
    const maxHeight = Math.max(80, areaH - 160 - 28 - 6)
    win.setResizable(false).catch(() => {})

    const handleMouseMove = (ev: MouseEvent) => {
      const delta = startY - ev.clientY
      const newHeight = Math.max(60, Math.min(maxHeight, startHeight + delta))
      setShellHeight(newHeight)
    }

    const handleMouseUp = () => {
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
  }, [shellHeight])

  // Terminals block (reused standalone or inside the editor + shell split)
  // ---- Split-tree render helpers ----
  // Map every session to the leaf that shows it, across ALL workspaces (leaf
  // ids are globally unique). Used by terminalPortals to route each terminal
  // into its own workspace's pane body — every workspace container stays mounted
  // (just hidden), so sessions never remount or reconnect.
  const allTabToLeaf = useMemo(() => {
    const m = new Map<number, string>()
    for (const root of tabs) {
      if (root.tabType !== 'terminal' || root.embedded) continue
      const tree = splitTrees[root.tabId]
      if (!tree) continue
      buildTabToLeaf(tree).forEach((v, k) => m.set(k, v))
    }
    return m
  }, [tabs, splitTrees])
  tabToLeafRef.current = allTabToLeaf
  const activeTerminalTab = tabs.find((t) => t.tabId === activeTabId)
  const settingsActive = activeTerminalTab?.tabType === 'settings'
  const settingsOverlayRef = useRef<HTMLDivElement>(null)

  const renderTerminalForTab = (tab: TabInfo, isFocused: boolean, leafId?: string) => {
    const connectConfig = tab.connectionId
      ? (() => {
          const conn = cachedConnections.find((c) => c.id === tab.connectionId)
          if (!conn) return undefined
          return {
            id: conn.id,
            name: conn.name,
            host: conn.host,
            port: conn.port,
            username: conn.username,
            password: conn.password,
            keyPath: conn.keyPath,
          }
        })()
      : undefined
    return (
      <div style={{ height: '100%', width: '100%', position: 'relative' }}>
        {tab.tabType !== 'settings' && (
          <div
            style={{
              display: tab.status === 'disconnected' || tab.status === 'error' ? 'none' : 'block',
              height: '100%',
            }}
          >
            <TerminalComponent
              tabId={tab.tabId}
              isActive={true}
              isFocused={isFocused}
              reconnectTrigger={reconnectKeys[tab.tabId] || 0}
              connectConfig={connectConfig}
              autoConnect={!!tab.connectionId}
              maxScrollback={maxScrollback}
              onStatusChange={(status, errorMessage) =>
                setTabs((prev) =>
                  prev.map((t) => (t.tabId === tab.tabId ? { ...t, status, errorMessage } : t)),
                )
              }
              onSizeChange={(cols, rows) => {
                if (leafId) setTermSizes((prev) => ({ ...prev, [leafId]: { cols, rows } }))
              }}
            />
          </div>
        )}
        {tab.tabType === 'settings' && (
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
              <label htmlFor="maxScrollback">Max Scrollback Lines: {maxScrollback}</label>
              <input
                id="maxScrollback"
                type="number"
                min="100"
                max="100000"
                step="100"
                value={maxScrollback}
                onChange={(e) => {
                  const v = Math.max(100, Math.min(100000, Number(e.target.value) || 5000))
                  setMaxScrollback(v)
                  try { localStorage.setItem('wrolp-maxScrollback', String(v)) } catch {}
                }}
                style={{ width: '120px', marginLeft: 10 }}
              />
              <span style={{ fontSize: 11, color: '#888', marginLeft: 8 }}>
                (applies to new tabs)
              </span>
            </div>
            <div className="form-group" style={{ marginTop: 16 }}>
              <label>Updates</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6 }}>
                <button
                  className="btn-primary"
                  onClick={handleCheckUpdate}
                  disabled={
                    updateState === 'checking' ||
                    updateState === 'downloading' ||
                    updateState === 'installing'
                  }
                  style={{ fontSize: '12px', padding: '4px 12px' }}
                >
                  {updateState === 'checking' ? 'Checking...' : 'Check for Updates'}
                </button>
                {updateInfo ? (
                  <span style={{ color: '#4ec9b0' }}>New version v{updateInfo.version}</span>
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
                    {updateState === 'downloading'
                      ? 'Downloading...'
                      : updateState === 'installing'
                        ? 'Installing...'
                        : 'Download & Install'}
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
        {tab.tabType !== 'settings' && tab.status === 'disconnected' ? (
          <div className="terminal-placeholder" style={{ position: 'absolute', inset: 0 }}>
            <div className="icon">🔌</div>
            <div style={{ color: '#f44747' }}>Connection lost</div>
            <div style={{ fontSize: '12px', color: '#888' }}>
              {tab.connectionName} — {tab.host}
            </div>
            <div style={{ fontSize: '12px', color: '#666', marginTop: 8 }}>Press Enter to retry</div>
            <button
              className="btn-primary"
              onClick={() => handleReconnect(tab.tabId)}
              style={{ marginTop: 12, fontSize: '13px', padding: '6px 20px' }}
            >
              <Icon name="refresh" /> Reconnect
            </button>
          </div>
        ) : tab.tabType !== 'settings' && tab.status === 'error' ? (
          <div className="terminal-placeholder" style={{ position: 'absolute', inset: 0 }}>
            <div style={{ color: '#f44747' }}>Connection failed: {tab.connectionName}</div>
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
            <div style={{ fontSize: '12px', color: '#666', marginTop: 12 }}>Press Enter to retry</div>
            <button
              className="btn-primary"
              onClick={() => handleReconnect(tab.tabId)}
              style={{ marginTop: 8, fontSize: '13px', padding: '6px 20px' }}
            >
              <Icon name="refresh" /> Reconnect
            </button>
          </div>
        ) : null}
      </div>
    )
  }

  // Render a workspace's split layout as a FLAT list of absolutely-positioned
  // panes (one per leaf) plus divider handles. Panes are keyed by their stable
  // leaf id, so restructuring the tree (split / close) only changes a pane's
  // position/size — the pane DOM (and the terminal portaled into its body) is
  // never remounted, so sessions never reconnect on split/close. The recursive
  // tree is used only to compute each pane's rectangle.
  interface PaneRect {
    left: number
    top: number
    width: number
    height: number
  }

  const renderPane = (
    leaf: SplitLeaf,
    focusedLeafIdForRoot: string | null,
    rect: PaneRect,
  ): React.ReactElement => {
    const tab = leaf.tabId != null ? tabs.find((t) => t.tabId === leaf.tabId) : undefined
    const isFocused = leaf.id === focusedLeafIdForRoot
    const isDragSource = paneDrag.source === leaf.id
    const dropPos = paneDrag.target === leaf.id ? paneDrag.position : null
    // Decide where a drop would land from the cursor position within the pane.
    const computePos = (e: React.DragEvent): DropPosition => {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
      const relX = (e.clientX - r.left) / r.width
      const relY = (e.clientY - r.top) / r.height
      if (relX > 0.3 && relX < 0.7 && relY > 0.3 && relY < 0.7) return 'center'
      if (relX < relY && relX < 1 - relY) return 'left'
      if (relX > relY && relX > 1 - relY) return 'right'
      if (relY < relX && relY < 1 - relX) return 'top'
      return 'bottom'
    }
    return (
      <div
        key={leaf.id}
        className={`term-pane${isFocused ? ' focused' : ''}${isDragSource ? ' drag-source' : ''}${dropPos ? ` drop-${dropPos}` : ''}`}
        onMouseDown={() => setFocusedLeafId(leaf.id)}
        onDragOver={(e) => {
          if (!paneDrag.source || paneDrag.source === leaf.id) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          const pos = computePos(e)
          if (paneDrag.target !== leaf.id || paneDrag.position !== pos) {
            setPaneDrag((d) => ({ ...d, target: leaf.id, position: pos }))
          }
          paneDragRef.current = { source: paneDrag.source, target: leaf.id, position: pos }
        }}
        onDrop={(e) => {
          // Only accept the drop here; the actual reorder is applied in the
          // grip's `onDragEnd` (which always fires) using `paneDragRef`.
          e.preventDefault()
        }}
        style={{
          position: 'absolute',
          left: `${rect.left * 100}%`,
          top: `${rect.top * 100}%`,
          width: `${rect.width * 100}%`,
          height: `${rect.height * 100}%`,
          display: 'flex',
          flexDirection: 'column',
          minWidth: 0,
          minHeight: 0,
        }}
      >
        <div className="term-pane-header">
          <span
            className="term-pane-grip"
            title="Drag to reorder this pane"
            draggable
            onMouseDown={(e) => e.stopPropagation()}
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = 'move'
              e.dataTransfer.setData('text/plain', leaf.id)
              setPaneDrag({ source: leaf.id, target: null, position: null })
              paneDragRef.current = { source: leaf.id, target: null, position: null }
            }}
            onDragEnd={() => {
              const d = paneDragRef.current
              if (d.source && d.target && d.target !== d.source) {
                performPaneMove(d.source, d.target, d.position ?? 'center')
              }
              paneDragRef.current = { source: null, target: null, position: null }
              setPaneDrag({ source: null, target: null, position: null })
            }}
          >
            ⠿
          </span>
          <span className="term-pane-title">{tab ? getTabLabel(tab) : 'No terminal'}</span>
          <span
            className="term-pane-close"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              closePane(leaf.id)
            }}
            title="Close pane"
          >
            ×
          </span>
        </div>
        <div className="term-pane-body" ref={getPaneBodyRef(leaf.id)}>
          {leaf.tabId == null && (
            <div className="terminal-placeholder">
              <div className="icon"><Icon name="desktop" /></div>
              <div>Select a connection to start</div>
            </div>
          )}
        </div>
        <div className="term-pane-statusbar">
          <div className="tsb-left">
            <span
              className={`tsb-dot ${tab?.status ?? 'disconnected'}`}
              title={tab?.status ?? 'disconnected'}
            />
          </div>
          <div className="tsb-right">
            {termSizes[leaf.id]?.cols > 0 && (
              <span className="tsb-size" title="SSH terminal width × height">
                {termSizes[leaf.id].cols} × {termSizes[leaf.id].rows}
              </span>
            )}
          </div>
        </div>
        {/* VS Code-style drop mask: the whole target pane is highlighted as a
            droppable region the moment the cursor enters it (base mask), and a
            stronger overlay shows the exact landing area (left/right/top/
            bottom/center). The move is applied on mouse-up (onDragEnd). */}
        {dropPos && (
          <>
            <div className="drop-mask drop-mask-base" />
            <div className={`drop-mask drop-mask-${dropPos}`} />
          </>
        )}
      </div>
    )
  }

  const renderWorkspacePanes = (node: SplitNode, focusedLeafIdForRoot: string | null): React.ReactElement[] => {
    const out: React.ReactElement[] = []
    const walk = (n: SplitNode, rect: PaneRect) => {
      if (n.type === 'leaf') {
        out.push(renderPane(n, focusedLeafIdForRoot, rect))
        return
      }
      const total = n.sizes.reduce((a, b) => a + b, 0) || 1
      let offset = 0
      for (let i = 0; i < n.children.length; i++) {
        const frac = (n.sizes[i] || 0) / total
        const childRect: PaneRect =
          n.dir === 'row'
            ? { left: rect.left + offset * rect.width, top: rect.top, width: frac * rect.width, height: rect.height }
            : { left: rect.left, top: rect.top + offset * rect.height, width: rect.width, height: frac * rect.height }
        if (i > 0) {
          const pct = (n.dir === 'row' ? rect.left + offset * rect.width : rect.top + offset * rect.height) * 100
          out.push(
            <div
              key={`${n.id}-div-${i}`}
              className={`term-split-divider ${n.dir === 'row' ? 'divider-row' : 'divider-col'}`}
              style={
                n.dir === 'row'
                  ? {
                      position: 'absolute',
                      left: `${pct}%`,
                      top: `${rect.top * 100}%`,
                      width: 4,
                      height: `${rect.height * 100}%`,
                      transform: 'translateX(-50%)',
                      cursor: 'col-resize',
                      zIndex: 10,
                    }
                  : {
                      position: 'absolute',
                      left: `${rect.left * 100}%`,
                      top: `${pct}%`,
                      width: `${rect.width * 100}%`,
                      height: 4,
                      transform: 'translateY(-50%)',
                      cursor: 'row-resize',
                      zIndex: 10,
                    }
              }
              onMouseDown={(e) => handleSplitDividerMouseDown(e, n, i)}
            />,
          )
        }
        walk(n.children[i], childRect)
        offset += frac
      }
    }
    walk(node, { left: 0, top: 0, width: 1, height: 1 })
    return out
  }

  // Portals keep each terminal instance mounted (preserving its SSH session and
  // scrollback) while placing its DOM into the correct pane body, or into the
  // hidden pool when it isn't shown in any pane.
  const terminalPortals = tabs
    .filter((t) => t.tabType === 'terminal' || (t.tabType === 'settings' && settingsActive))
    .map((tab) => {
      if (tab.tabType === 'settings') {
        return settingsOverlayRef.current
          ? createPortal(renderTerminalForTab(tab, false), settingsOverlayRef.current, String(tab.tabId))
          : null
      }
      // Route each terminal into the leaf that shows it within its own workspace.
      // Every workspace container is always mounted (only visibility toggles),
      // so the portal destination never changes on tab switch — sessions stay
      // mounted and never reconnect.
      const leafId = allTabToLeaf.get(tab.tabId)
      const dest = leafId ? paneBodyRefs.current.get(leafId) : null
      if (!leafId || !dest) return null
      const isFocused = leafId === (activeTabId != null ? focusedLeafId : null)
      // Stable key: without it, removing one tab shifts the others' array
      // index, making React remount the surviving terminal — which re-runs
      // its connection (looks like the "other pane reconnected").
      // The wrapper's onMouseDown focuses this pane even though the terminal is
      // portaled (React events don't bubble through a portal to the pane div),
      // so clicking a shell window marks its tab as the active/focused one.
      return createPortal(
        <div style={{ height: '100%', width: '100%' }} onMouseDown={() => setFocusedLeafId(leafId)}>
          {renderTerminalForTab(tab, isFocused, leafId)}
        </div>,
        dest,
        String(tab.tabId),
      )
    })

  // Top-level terminal tabs (workspaces): each renders its own split layout
  // inside an always-mounted container. Only the active workspace is visible;
  // switching toggles visibility (never remounts), so sessions persist.
  const rootTabs = tabs.filter((t) => t.tabType === 'terminal' && !t.embedded)

  const terminalContent = (
    <div className="terminal-wrapper">
      <div className="terminal-split-root" style={{ position: 'relative' }}>
        {rootTabs.map((root) => {
          const tree = splitTrees[root.tabId] ?? makeLeaf(`leaf-${root.tabId}`, root.tabId)
          const workspaceHidden = settingsActive || root.tabId !== activeTabId
          return (
            <div
              key={root.tabId}
              className="term-workspace"
              style={{
                position: 'absolute',
                inset: 0,
                display: workspaceHidden ? 'none' : 'flex',
                flexDirection: 'column',
                minWidth: 0,
                minHeight: 0,
              }}
                onDragOver={(e) => {
                  // Accept the pane drag anywhere inside the workspace so the
                  // cursor never shows the "no-drop" (prohibited) icon over gaps,
                  // the source pane, or the terminal surface — the per-pane
                  // onDragOver still decides where the mask lands.
                  if (paneDrag.source) {
                    e.preventDefault()
                    e.dataTransfer.dropEffect = 'move'
                  }
                }}
              >
                {renderWorkspacePanes(tree, focusedLeafByRoot[root.tabId] ?? null)}
              </div>
            )
          })}
        <div
          ref={settingsOverlayRef}
          className="settings-overlay"
          style={{
            position: 'absolute',
            inset: 0,
            overflow: 'auto',
            display: settingsActive ? 'block' : 'none',
          }}
        />
        {terminalPortals}
      </div>
      <div ref={terminalPoolRefCb} className="terminal-pool" />
    </div>
  )

  // Sidebar body (connections / files / docker), reused for left or right placement.
  const sidebarBody = (() => {
    // Show the Files panel only when the focused pane's connection is connected.
    // In a split, focusedLeafTabId points at the focused pane's session, so the
    // panel tracks whichever connection you clicked into.
    const filesTab = focusedLeafTabId != null ? tabs.find((t) => t.tabId === focusedLeafTabId) : null
    const showFilePanel = filesTab?.status === 'connected'
    return (
      <>
        {layout.sidebar.sections.connections.visible && (
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
              onConnect={(_config, _tabId) => {
                // Not used
              }}
              onTabClosed={closeTab}
              activeTabId={activeTabId}
              onConnectionChange={handleConnectionChange}
              onSelectConnection={handleSelectConnection}
              onSplitRight={(conn) => handleOpenSplit(conn, 'row')}
              onSplitDown={(conn) => handleOpenSplit(conn, 'column')}
              sidebarWidth={sidebarWidth}
              expanded={connectionsExpanded}
              onToggleExpanded={() =>
                updateLayout((l) => ({
                  ...l,
                  sidebar: {
                    ...l.sidebar,
                    sections: {
                      ...l.sidebar.sections,
                      connections: {
                        ...l.sidebar.sections.connections,
                        collapsed: !l.sidebar.sections.connections.collapsed,
                      },
                    },
                  },
                }))
              }
            />
          </div>
        )}

        {showFilePanel && layout.sidebar.sections.files.visible && (
          <>
            {connectionsExpanded && (
              <div className="panel-divider-h" onMouseDown={handleVDividerMouseDown} />
            )}

            {/* Files section (session, or a jump/docker target) */}
            <div
              className="collapsible-section"
              style={filesExpanded ? { flex: 1, overflow: 'hidden' } : { flexShrink: 0 }}
            >
                <FilePanel
                  key={fileTarget ? JSON.stringify(fileTarget) : 'session'}
                  ref={fileTreeRef}
                  tabId={focusedLeafTabId ?? activeTabId ?? 0}
                  isConnected={true}
                  defaultPath={fileTarget?.kind === 'docker' ? '/' : '.'}
                  targetRef={fileTarget ?? undefined}
                  fileMode={fileMode}
                  onFileModeChange={setFileMode}
                  onSelectTarget={setFileTarget}
                expanded={filesExpanded}
                onToggleExpanded={() =>
                  updateLayout((l) => ({
                    ...l,
                    sidebar: {
                      ...l.sidebar,
                      sections: {
                        ...l.sidebar.sections,
                        files: {
                          ...l.sidebar.sections.files,
                          collapsed: !l.sidebar.sections.files.collapsed,
                        },
                      },
                    },
                  }))
                }
                syncEnabled={syncEnabled}
                onToggleSync={() => {
                  const next = !syncEnabled
                  setSyncEnabled(next)
                  try {
                    localStorage.setItem('wrolp-sync-enabled', next ? '1' : '0')
                  } catch {
                    // ignore localStorage errors
                  }
                }}
                onEditFile={openInEditor}
              />
            </div>

            {dockerExpanded && layout.sidebar.sections.docker.visible && (
              <div className="panel-divider-h" onMouseDown={handleDockerDividerMouseDown} />
            )}

            {/* Docker containers on the connected host */}
            {layout.sidebar.sections.docker.visible && activeTabId != null && (
              <div
                className="collapsible-section"
                style={dockerExpanded ? { flexShrink: 0, height: dockerHeight, overflow: 'hidden' } : { flexShrink: 0 }}
              >
                <DockerPanel
                  jumpTabId={activeTabId}
                  expanded={dockerExpanded}
                  onToggleExpanded={() =>
                    updateLayout((l) => ({
                      ...l,
                      sidebar: {
                        ...l.sidebar,
                        sections: {
                          ...l.sidebar.sections,
                          docker: {
                            ...l.sidebar.sections.docker,
                            collapsed: !l.sidebar.sections.docker.collapsed,
                          },
                        },
                      },
                    }))
                  }
                  activeContainer={fileTarget?.kind === 'docker' ? fileTarget.container : null}
                  onOpenContainer={handleOpenContainer}
                  onEnterShell={handleEnterContainerShell}
                  onAnalyzeContainer={handleAnalyzeContainer}
                />
              </div>
            )}
          </>
        )}
      </>
    )
  })()

  const sidebarEl = showSidebar ? (
    <div className="sidebar-container" style={{ width: sidebarWidth, minWidth: sidebarWidth }}>
      <div
        className="panel-drag-handle"
        title="Drag to re-dock sidebar (left / right)"
        draggable
        onMouseDown={(e) => e.stopPropagation()}
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData('text/plain', 'sidebar')
          setDockDrag({ source: 'sidebar', over: null })
        }}
        onDragEnd={() => setDockDrag({ source: null, over: null })}
      >
        ⠿
      </div>
      {sidebarBody}
    </div>
  ) : null

  return (
    <div className="app-container" style={{ '--win-opacity': opacity } as React.CSSProperties}>
      {/* Custom titlebar */}
      <Titlebar onSettings={handleOpenSettings} />

      <div className="main-content">
        {layout.sidebar.side === 'left' && sidebarEl}
        {layout.sidebar.side === 'left' && showSidebar && (
          <div className="panel-divider" onMouseDown={handleDividerMouseDown} />
        )}

        {/* Terminal area (right) */}
        <div className={`terminal-area ${layout.bottomPanel.pos === 'right' ? 'panel-right' : ''}`}>
          <div className="terminal-main">
          {/* Tab bar */}
          <div className="tab-bar">
            <button
              className="sidebar-toggle"
              onClick={() =>
                updateLayout((l) => ({ ...l, sidebar: { ...l.sidebar, visible: !l.sidebar.visible } }))
              }
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
            {tabs.filter((tab) => !tab.embedded).map((tab, idx) => (
              <div
                key={tab.tabId}
                className={`tab-item ${tab.tabId === activeTabId ? 'active' : ''}${tabDragIndex === idx ? ' drag-over' : ''}`}
                draggable
                onClick={() => handleTabClick(tab.tabId)}
                onDragStart={(e) => handleTabDragStart(e, idx)}
                onDragOver={(e) => handleTabDragOver(e, idx)}
                onDrop={(e) => handleTabDrop(e, idx)}
                onDragEnd={handleTabDragEnd}
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
            <button
              className="tab-split-btn"
              onClick={handleSplitTerminal}
              title="Split Terminal (Ctrl+\)"
            >
              ⊞
            </button>
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

          {/* Remote file editor (inline editing) + Shell pane.
              NOTE (B2 fix): `terminalContent` is ALWAYS rendered inside the same
              `.shell-pane > .shell-pane-body` DOM position (keyed), so opening or
              closing the file editor no longer remounts the TerminalComponent
              (which previously triggered a fresh connect() and lost focus). */}
          {[
            editorTabs.length > 0 && (
              <FileEditor
                key="file-editor"
                tabs={editorTabs}
                activeKey={activeEditorKey}
                onSelect={setActiveEditorKey}
                onClose={closeEditorTab}
                onContentChange={handleEditorContentChange}
                onSave={handleSaveEditorTab}
                onChangeLanguage={changeEditorTabLanguage}
                onChangeEncoding={changeEditorTabEncoding}
                onChangeLineEnding={changeEditorTabLineEnding}
              />
            ),
            <div
              key="editor-shell-divider"
              className="editor-shell-divider"
              style={{ display: editorTabs.length > 0 ? 'block' : 'none' }}
              onMouseDown={handleEditorShellDividerMouseDown}
              title="Drag to resize · use ▲/▼ in the Shell header to collapse"
            />,
            <div
              key="shell-pane"
              className="shell-pane"
              style={{ flex: editorTabs.length === 0 ? 1 : '0 0 auto', minHeight: 0 }}
            >
              {editorTabs.length > 0 && (
                <div className="shell-pane-header">
                  <span className="shell-pane-title">Shell</span>
                  <button
                    className="shell-pane-toggle"
                    onClick={() => setShellCollapsed((v) => !v)}
                    title={shellCollapsed ? 'Expand shell' : 'Collapse shell'}
                  >
                    {shellCollapsed ? '▲' : '▼'}
                  </button>
                </div>
              )}
              <div
                className="shell-pane-body"
                style={{ height: editorTabs.length === 0 ? undefined : (shellCollapsed ? 0 : shellHeight) }}
              >
                {terminalContent}
              </div>
            </div>,
          ]}

          </div>

          {/* Bottom panel — session recordings & command sets */}
          {layout.bottomPanel.pos === 'right' && bottomPanelExpanded && (
            <div className="panel-divider-v" onMouseDown={handlePanelDividerMouseDown} />
          )}
          {layout.bottomPanel.pos === 'bottom' && bottomPanelExpanded && (
            <div className="panel-divider-h" onMouseDown={handleBottomDividerMouseDown} />
          )}
          <BottomPanel
            connections={connections}
            activeTabId={activeTabId}
            expanded={bottomPanelExpanded}
            pos={layout.bottomPanel.pos}
            size={layout.bottomPanel.size}
            onDockDragStart={() => setDockDrag({ source: 'bottomPanel', over: null })}
            onDockDragEnd={() => setDockDrag({ source: null, over: null })}
            onToggleExpanded={() =>
              updateLayout((l) => ({
                ...l,
                bottomPanel: { ...l.bottomPanel, visible: !l.bottomPanel.visible },
              }))
            }
            dockerAnalysisTarget={dockerAnalysisTarget}
            onDockerAnalyzed={() => setDockerAnalysisTarget(null)}
          />
        </div>
        {layout.sidebar.side === 'right' && showSidebar && (
          <div className="panel-divider" onMouseDown={handleDividerMouseDown} />
        )}
        {layout.sidebar.side === 'right' && sidebarEl}

        {/* Phase 3 — dock drop zones, shown while dragging a panel */}
        {dockDrag.source && (
          <div className="dock-overlay">
            {dockDrag.source === 'sidebar' ? (
              <>
                <div
                  className={`dock-zone dock-left${dockDrag.over === 'left' ? ' active' : ''}`}
                  onDragOver={(e) => { e.preventDefault(); setDockDrag((d) => ({ ...d, over: 'left' })) }}
                  onDrop={(e) => { e.preventDefault(); applyDock('sidebar', 'left') }}
                >
                  ◧&nbsp;Left
                </div>
                <div
                  className={`dock-zone dock-right${dockDrag.over === 'right' ? ' active' : ''}`}
                  onDragOver={(e) => { e.preventDefault(); setDockDrag((d) => ({ ...d, over: 'right' })) }}
                  onDrop={(e) => { e.preventDefault(); applyDock('sidebar', 'right') }}
                >
                  Right&nbsp;◨
                </div>
              </>
            ) : (
              <>
                <div
                  className={`dock-zone dock-right${dockDrag.over === 'right' ? ' active' : ''}`}
                  onDragOver={(e) => { e.preventDefault(); setDockDrag((d) => ({ ...d, over: 'right' })) }}
                  onDrop={(e) => { e.preventDefault(); applyDock('bottomPanel', 'right') }}
                >
                  Right&nbsp;◨
                </div>
                <div
                  className={`dock-zone dock-bottom${dockDrag.over === 'bottom' ? ' active' : ''}`}
                  onDragOver={(e) => { e.preventDefault(); setDockDrag((d) => ({ ...d, over: 'bottom' })) }}
                  onDrop={(e) => { e.preventDefault(); applyDock('bottomPanel', 'bottom') }}
                >
                  ▁&nbsp;Bottom
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* Status bar — temporarily disabled
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
          // Update available banner
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
      */}


    </div>
  )
}

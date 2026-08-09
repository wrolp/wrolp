import React, { useState, useEffect, useCallback, useRef, useMemo, useLayoutEffect } from 'react'
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
import { DockerLogViewer } from './components/DockerLogViewer'
import { Icon } from './components/Icon'
import FloatingWindow from './components/FloatingWindow'
import type { FileTreeHandle } from './components/FilePanel'
import type { ConnectionConfig, TabInfo, TargetRef, ContainerInfo, WorkspaceLayout, FileTargetMode, LocalTerminalEntry, FloatingItem, FloatingKind } from './types'
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
import { loadWindowConfig, saveWindowConfig, setAutoRecord, setRecordingEnabled, getRecordingEnabled, fsReadFileContent, fsWriteFileContent, loadLayout, saveLayout, sendInput, getAppVersion, openConfigDir, loadAiConfig, saveAiConfig, encryptApiKey, decryptApiKey, listAiModels, restartDockerContainer, localClose, getLocalTerminals } from './commands'
import type { AppVersion, AiConfig, AiEndpointProfile, ToolCallEvent } from './types'
import { open } from '@tauri-apps/plugin-shell'
import AiChatPanel, { type ChatMessage } from './components/AiChatPanel'
import { detectLanguage } from './editor/languages'
import { useI18n, LANG_LABELS } from './i18n'
import './styles/App.scss'

// Global connection cache
let cachedConnections: ConnectionConfig[] = []

// Auto-incrementing tab id counter
let nextTabId = 1

export default function App() {
  const { t, lang, setLang } = useI18n()
  const [tabs, setTabs] = useState<TabInfo[]>([])
  const [activeTabId, setActiveTabId] = useState<number | null>(null)
  const [connections, setConnections] = useState<ConnectionConfig[]>([])
  const [localTerminals, setLocalTerminals] = useState<LocalTerminalEntry[]>([])
  const [tabContextMenu, setTabContextMenu] = useState<{ x: number; y: number; tab: TabInfo } | null>(null)
  const tabContextMenuRef = useRef<HTMLDivElement | null>(null)
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

  // When the user clicks a different shell (split pane), sync the Files panel
  // with the newly focused session: a Docker shell shows that container's file
  // panel; a regular host shell shows the host's session file panel.
  const prevFocusedLeafTabIdRef = useRef<number | null>(null)
  useEffect(() => {
    if (prevFocusedLeafTabIdRef.current === focusedLeafTabId) return
    prevFocusedLeafTabIdRef.current = focusedLeafTabId
    const focusedTab = focusedLeafTabId != null ? tabs.find((t) => t.tabId === focusedLeafTabId) : null
    if (!focusedTab) return
    const container = focusedTab.dockerContainer
    if (focusedTab.tabType === 'localShell') {
      // Local shell → browse the user's own machine.
      setFileMode('local')
      setFileTarget({ kind: 'local', tabId: focusedTab.tabId })
    } else if (container) {
      // Focused shell is inside a Docker container → show its file panel.
      // The docker exec runs on the same SSH session the shell uses, so that
      // session's tabId is the jump host for the container file ops.
      setFileMode('docker')
      setFileTarget({ kind: 'docker', jumpTabId: focusedTab.tabId, container })
    } else {
      // Regular host shell → host session file panel.
      setFileMode('ssh')
      setFileTarget(null)
    }
  }, [focusedLeafTabId, tabs])

  // Split the currently focused pane inside the active workspace and open the
  // chosen connection in the new pane as an EMBEDDED session. The new session is
  // NOT added to the top tab bar (it lives inside this workspace's pane layout),
  // so the split never spawns a new top-level tab. Returns the new tab id.
  const openInSplit = useCallback(
    (conn: ConnectionConfig, direction: 'row' | 'column', dockerContainer?: string): number | null => {
      const rootId = activeTabIdRef.current
      if (rootId == null) return null
      const tree = splitTreeRef.current
      const focus = focusedLeafIdRef.current
      const focusLeaf = focus ? findLeaf(tree, focus) : null
      const targetId = focusLeaf ? focus! : collectLeaves(tree)[0]?.id
      if (!targetId) return null
      const tabId = nextTabId++
      const newTab: TabInfo = {
        tabId,
        connectionId: conn.id,
        connectionName: conn.name,
        host: `${conn.host}:${conn.port}`,
        status: 'connecting',
        tabType: 'terminal',
        embedded: true,
        dockerContainer,
        // Persisted so the shell re-enters the container on every reconnect
        // (e.g. when the pane is floated/restored and reconnects).
        postConnectCmd: dockerContainer
          ? `docker exec -it ${dockerContainer} /bin/bash || docker exec -it ${dockerContainer} /bin/sh\r`
          : undefined,
      }
      setTabs((prev) => [...prev, newTab])
      const { tree: nt, newLeafId: nl } = splitLeaf(tree, targetId, tabId, direction, newLeafId)
      updateActiveTree(() => nt)
      if (nl) setFocusedLeafId(nl)
      return tabId
    },
    [newLeafId, updateActiveTree, setFocusedLeafId],
  )

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
  // NOTE: do NOT reset the file panel mode here on workspace switch — the
  // focused-leaf effect above decides the correct mode (ssh/jump/docker/local)
  // for the newly focused tab, so a blanket reset would override local/docker.

  // Send any post-connect command (e.g. docker exec) when a tab finishes
  // connecting. The command is persisted on the tab (`postConnectCmd`) so it is
  // re-sent on every reconnect — floating/restoring a docker-shell pane triggers
  // a fresh SSH connect, and without this the pane would show the host shell.
  const prevStatusesRef = useRef<Record<number, string>>({})
  useEffect(() => {
    for (const tab of tabs) {
      const prev = prevStatusesRef.current[tab.tabId]
      if (prev !== 'connected' && tab.status === 'connected') {
        const cmd = tab.postConnectCmd
        if (cmd) {
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

  // Open a new pane (split) inside the current workspace connected to the same
  // jump host and automatically run
  // `docker exec -it <container> /bin/bash || docker exec -it <container> /bin/sh`
  const handleEnterContainerShell = useCallback(
    (container: ContainerInfo) => {
      if (activeTabId == null) return
      const activeTab = tabs.find((t) => t.tabId === activeTabId)
      if (!activeTab?.connectionId) return
      const conn = connections.find((c) => c.id === activeTab.connectionId)
      if (!conn) return

      const newTabId = openInSplit(conn, 'column', container.name)
      // The docker exec command is persisted on the new tab (postConnectCmd),
      // so it is sent on connect and re-sent on any reconnect (float/restore).
      if (newTabId == null) return
    },
    [activeTabId, tabs, connections, openInSplit],
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

  // Open a Docker container log viewer in a new tab.
  // Restart a Docker container
  const handleRestartContainer = useCallback(
    async (container: ContainerInfo) => {
      if (activeTabId == null) return
      setToast({ kind: 'progress', text: t('dockerRestarting', { name: container.name }) })
      try {
        await restartDockerContainer(activeTabId, container.name)
        setToast({ kind: 'success', text: t('dockerRestarted', { name: container.name }) })
      } catch (e) {
        const msg = String(e)
        console.error(`Docker restart failed: ${msg}`)
        setToast({ kind: 'error', text: t('dockerRestartFailed', { name: container.name, err: msg }) })
      }
    },
    [activeTabId, t],
  )

  const handleViewContainerLogs = useCallback(
    (container: ContainerInfo) => {
      if (activeTabId == null) return
      const tabId = nextTabId++
      const newTab: TabInfo = {
        tabId,
        connectionName: `Logs: ${container.name}`,
        host: `Docker`,
        status: 'connected',
        tabType: 'dockerLog',
        jumpTabId: activeTabId,
        containerName: container.name,
        containerId: container.id,
        containerImage: container.image,
        embedded: true, // lives on the pane header, like an open file
      }
      setTabs((prev) => [...prev, newTab])
      // Show the log view on the focused pane (like opening a file).
      if (activeTabId != null) setShellViewFor(activeTabId, `dockerlog:${tabId}`)
    },
    [activeTabId],
  )

  // Remote file editor state
  const [editorTabs, setEditorTabs] = useState<EditorTab[]>([])
  const editorTabsRef = useRef(editorTabs)
  editorTabsRef.current = editorTabs
  const [activeEditorKey, setActiveEditorKey] = useState<Record<number, string>>({})
  // Which view occupies the shell pane area, per SSH session (tabId):
  // 'terminal' or the key of the active editor tab (editor replaces the
  // terminal area). Isolated per session so files opened in one tab don't
  // show up in another.
  const [shellView, setShellView] = useState<Record<number, string>>({})
  const getShellView = (tabId: number) => shellView[tabId] ?? 'terminal'
  const setShellViewFor = useCallback((tabId: number, view: string) => {
    setShellView((prev) => {
      if (prev[tabId] === view) return prev
      return { ...prev, [tabId]: view }
    })
  }, [])
  const setActiveEditorKeyFor = useCallback((tabId: number, key: string) => {
    setActiveEditorKey((prev) => ({ ...prev, [tabId]: key }))
  }, [])
  const [syncEnabled, setSyncEnabled] = useState(() => {
    try {
      return localStorage.getItem('wrolp-sync-enabled') === '1'
    } catch {
      return false
    }
  })
  const [opacity, setOpacity] = useState(1)
  const [aiInputHeight, setAiInputHeight] = useState(0)
  const [collapsedGroups, setCollapsedGroups] = useState<string[]>([])
  const [autoRecord, setAutoRecordState] = useState(false)
  // Per-tab recording indicator (map from tabId → recording on/off). Loaded
  // from the backend so the button reflects the actual state after reconnect.
  const [recordingByTab, setRecordingByTab] = useState<Record<number, boolean>>({})
  const [appVersion, setAppVersion] = useState<AppVersion | null>(null)

  // Fetch app version info on mount
  useEffect(() => {
    getAppVersion().then(setAppVersion).catch(() => {})
  }, [])

  // AI config
  const [aiConfig, setAiConfig] = useState<AiConfig | null>(null)
  const [aiApiKeyInput, setAiApiKeyInput] = useState('')
  const [aiShowKey, setAiShowKey] = useState(false)
  const [aiModels, setAiModels] = useState<string[]>([])
  const [aiFetchingModels, setAiFetchingModels] = useState(false)
  const [aiModelManual, setAiModelManual] = useState(false)
  // AI conversation state is keyed per tab (tabId) so each shell tab keeps its
  // own conversation, and survives tab switches / panel remounts.
  type AiConv = {
    messages: ChatMessage[]
    input: string
    streaming: boolean
    streamingText: string
    error: string | null
    toolCalls: ToolCallEvent[]
    showSuggestions: boolean
  }
  const emptyConv = (): AiConv => ({
    messages: [],
    input: '',
    streaming: false,
    streamingText: '',
    error: null,
    toolCalls: [],
    showSuggestions: true,
  })
  const [aiConversations, setAiConversations] = useState<Record<number, AiConv>>({})
  // Which shell tabs have their AI pane open (docked).
  const [showAiByTab, setShowAiByTab] = useState<Record<number, boolean>>({})
  // Dock side of the AI pane per shell tab: 'right' | 'left' | 'top' | 'bottom'.
  const [aiDockSideByTab, setAiDockSideByTab] = useState<Record<number, 'right' | 'left' | 'top' | 'bottom'>>({})
  // Dock size (px) of the AI pane per shell tab: width for left/right, height for top/bottom.
  const [aiDockSizeByTab, setAiDockSizeByTab] = useState<Record<number, number>>({})
  const aiDockResizeRef = useRef<{ dir: string; sx: number; sy: number; sSize: number } | null>(null)
  const MIN_DOCK = 140
  const MAX_DOCK = 900
  // Persist AI input-area height (debounced) so it survives reloads.
  const aiInputHeightSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const handleAiInputHeightChange = useCallback((height: number) => {
    setAiInputHeight(height)
    if (aiInputHeightSaveTimer.current) clearTimeout(aiInputHeightSaveTimer.current)
    aiInputHeightSaveTimer.current = setTimeout(() => {
      const win = getCurrentWindow()
      Promise.all([win.outerPosition(), win.outerSize(), win.isMaximized()])
        .then(([pos, size, maximized]) =>
          saveWindowConfig({
            x: pos.x,
            y: pos.y,
            width: size.width,
            height: size.height,
            maximized,
            opacity: opacityRef.current,
            aiInputHeight: height,
          }),
        )
        .catch(() => {})
    }, 400)
  }, [])
  // Persist collapsed connection-group state (debounced).
  const collapsedGroupsSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const handleCollapsedGroupsChange = useCallback((value: string[]) => {
    setCollapsedGroups(value)
    if (collapsedGroupsSaveTimer.current) clearTimeout(collapsedGroupsSaveTimer.current)
    collapsedGroupsSaveTimer.current = setTimeout(() => {
      const win = getCurrentWindow()
      Promise.all([win.outerPosition(), win.outerSize(), win.isMaximized()])
        .then(([pos, size, maximized]) =>
          saveWindowConfig({
            x: pos.x,
            y: pos.y,
            width: size.width,
            height: size.height,
            maximized,
            opacity: opacityRef.current,
            aiInputHeight: aiInputHeightRef.current,
            collapsedGroups: value,
          }),
        )
        .catch(() => {})
    }, 400)
  }, [])
  // Auto-record Sessions toggle (Settings). Persists to window.json so future
  // connect() calls in Rust pick it up.
  const handleAutoRecordChange = useCallback((enabled: boolean) => {
    setAutoRecordState(enabled)
    setAutoRecord(enabled).catch(() => {})
  }, [])

  // Toggle session recording for one pane (the record button in the pane
  // header). Only meaningful for SSH sessions; the button is hidden otherwise.
  const handleToggleRecording = useCallback(async (tabId: number) => {
    try {
      const cur = recordingByTab[tabId] ?? false
      const next = await setRecordingEnabled(tabId, !cur)
      setRecordingByTab((prev) => ({ ...prev, [tabId]: next }))
    } catch {
      // ignore
    }
  }, [recordingByTab])

  // Refresh the recording indicator for a tab (after connect/reconnect).
  const refreshRecordingState = useCallback((tabId: number) => {
    getRecordingEnabled(tabId).then((enabled) => {
      setRecordingByTab((prev) => ({ ...prev, [tabId]: enabled }))
    }).catch(() => {})
  }, [])
  // Which tab's AI is currently floating as a separate draggable panel (null = none).
  const [aiFloatingTabId, setAiFloatingTabId] = useState<number | null>(null)
  // Position of the floating AI panel (top-left in px).
  const [aiFloatPos, setAiFloatPos] = useState<{ x: number; y: number }>({ x: 120, y: 120 })
  // Size of the floating AI panel (px).
  const [aiFloatSize, setAiFloatSize] = useState<{ w: number; h: number }>({ w: 420, h: 560 })
  const aiFloatDragRef = useRef<{ dx: number; dy: number } | null>(null)
  const aiFloatResizeRef = useRef<{ dir: string; sx: number; sy: number; sw: number; sh: number } | null>(null)

  const getAiConv = useCallback(
    (tabId: number): AiConv => aiConversations[tabId] ?? emptyConv(),
    [aiConversations],
  )
  const setAiConv = useCallback((tabId: number, updater: AiConv | ((c: AiConv) => AiConv)) => {
    setAiConversations((prev) => {
      const cur = prev[tabId] ?? emptyConv()
      const next = typeof updater === 'function' ? (updater as (c: AiConv) => AiConv)(cur) : { ...cur, ...updater }
      return { ...prev, [tabId]: next }
    })
  }, [])
  const [saveFlash, setSaveFlash] = useState<string | null>(null)
  const [settingsActiveTab, setSettingsActiveTab] = useState<'general' | 'ai'>('general')
  useEffect(() => {
    if (saveFlash) {
      const t = setTimeout(() => setSaveFlash(null), 1800)
      return () => clearTimeout(t)
    }
  }, [saveFlash])

  // Transient toast notification (auto-dismiss, manually closable)
  const [toast, setToast] = useState<
    { kind: 'success' | 'error' | 'progress'; text: string } | null
  >(null)
  useEffect(() => {
    if (toast && toast.kind !== 'progress') {
      const id = setTimeout(() => setToast(null), 3000)
      return () => clearTimeout(id)
    }
  }, [toast])

  useEffect(() => {
    loadAiConfig()
      .then(async (cfg) => {
        setAiConfig(cfg)
        const active = cfg.profiles.find((p) => p.id === cfg.activeId) ?? cfg.profiles[0]
        if (active?.apiKeyEnc) {
          try {
            const dec = await decryptApiKey(active.apiKeyEnc)
            setAiApiKeyInput(dec)
          } catch { /* leave empty */ }
        } else {
          setAiApiKeyInput('')
        }
      })
      .catch(() => setAiConfig(null))
  }, [])

  // The profile currently being edited / used (falls back to first profile).
  const activeProfile =
    aiConfig?.profiles.find((p) => p.id === aiConfig.activeId) ?? aiConfig?.profiles[0] ?? null

  // Whether a usable AI endpoint is configured (endpoint + model + saved key).
  const aiConfigured =
    !!activeProfile &&
    !!activeProfile.endpoint.trim() &&
    !!activeProfile.model.trim() &&
    !!activeProfile.apiKeyEnc

  // Switch the active AI endpoint from within an AI chat panel (persisted).
  const handleSelectAiProfile = useCallback((id: string) => {
    setAiConfig((prev) => {
      if (!prev) return prev
      const next = { ...prev, activeId: id }
      saveAiConfig(next).catch(() => {})
      return next
    })
  }, [])

  // Change the model for the active endpoint (persisted).
  const handleSelectAiModel = useCallback((model: string) => {
    setAiConfig((prev) => {
      if (!prev) return prev
      const next = {
        ...prev,
        profiles: prev.profiles.map((p) =>
          p.id === prev.activeId ? { ...p, model } : p,
        ),
      }
      saveAiConfig(next).catch(() => {})
      return next
    })
  }, [])

  // Reload the key input from the active profile's encrypted key whenever the
  // active profile changes, so each endpoint keeps and shows its own key.
  useEffect(() => {
    let cancelled = false
    if (activeProfile?.apiKeyEnc) {
      decryptApiKey(activeProfile.apiKeyEnc)
        .then((dec) => {
          if (!cancelled) setAiApiKeyInput(dec)
        })
        .catch(() => {
          if (!cancelled) setAiApiKeyInput('')
        })
    } else {
      setAiApiKeyInput('')
    }
    return () => {
      cancelled = true
    }
  }, [activeProfile?.id])
  const [maxScrollback, setMaxScrollback] = useState(() => {
    try {
      const v = localStorage.getItem('wrolp-maxScrollback')
      return v ? Number(v) : 5000
    } catch {
      return 5000
    }
  })
  // Docker log viewer preferences (persisted; apply to new viewers).
  const [dockerWordWrap, setDockerWordWrap] = useState(() => {
    try {
      const v = localStorage.getItem('wrolp-docker-wordwrap')
      return v === null ? true : v === '1'
    } catch {
      return true
    }
  })
  const [dockerFollow, setDockerFollow] = useState(() => {
    try {
      const v = localStorage.getItem('wrolp-docker-follow')
      return v === null ? true : v === '1'
    } catch {
      return true
    }
  })
  const [dockerMaxLines, setDockerMaxLines] = useState(() => {
    try {
      const v = localStorage.getItem('wrolp-docker-maxlines')
      return v ? Number(v) : 5000
    } catch {
      return 5000
    }
  })
  const [reconnectKeys, setReconnectKeys] = useState<Record<number, number>>({})
  const isDragging = useRef(false)
  const isDraggingV = useRef(false)
  const panelDragRef = useRef(false)

  // Update state
  const [updateInfo, setUpdateInfo] = useState<{ version: string; body?: string } | null>(null)
  const [updateState, setUpdateState] = useState<'idle' | 'checking' | 'downloading' | 'installing'>('idle')
  const [showUpdateBanner, setShowUpdateBanner] = useState(true)
  const updateRef = useRef<Update | null>(null)

  // Load connection list
  useEffect(() => {
    loadConnections()
    reloadLocalTerminals()
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

  // Keep the tab context menu fully on-screen (e.g. when triggered near the
  // bottom edge it would otherwise be clipped).
  useLayoutEffect(() => {
    if (!tabContextMenu) return
    const el = tabContextMenuRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const vh = window.innerHeight
    let top = tabContextMenu.y
    if (top + rect.height > vh - 8) {
      top = Math.max(8, vh - rect.height - 8)
    }
    let left = tabContextMenu.x
    const vw = window.innerWidth
    if (left + rect.width > vw - 8) {
      left = Math.max(8, vw - rect.width - 8)
    }
    el.style.top = `${top}px`
    el.style.left = `${left}px`
  }, [tabContextMenu])

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

  const aiInputHeightRef = useRef(aiInputHeight)
  aiInputHeightRef.current = aiInputHeight
  const collapsedGroupsRef = useRef(collapsedGroups)
  collapsedGroupsRef.current = collapsedGroups

  // Load opacity from saved window config on startup
  useEffect(() => {
    loadWindowConfig().then(config => {
      if (config.opacity !== undefined) {
        setOpacity(config.opacity)
      }
      if (config.aiInputHeight !== undefined && config.aiInputHeight > 0) {
        setAiInputHeight(config.aiInputHeight)
      } else {
        setAiInputHeight(0)
      }
      if (config.collapsedGroups !== undefined && Array.isArray(config.collapsedGroups)) {
        setCollapsedGroups(config.collapsedGroups)
      }
      if (config.autoRecordSessions !== undefined) {
        setAutoRecordState(config.autoRecordSessions)
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
            aiInputHeight: aiInputHeightRef.current,
            collapsedGroups: collapsedGroupsRef.current,
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
          aiInputHeight,
          collapsedGroups,
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

  // Open a local shell as a NEW top-level tab (workspace).
  const openLocalShellTab = useCallback(
    (cwd?: string, shell?: string): number => {
      const tabId = nextTabId++
      const newTab: TabInfo = {
        tabId,
        connectionId: undefined,
        connectionName: t('localTerminal'),
        host: 'localhost',
        status: 'connected',
        tabType: 'localShell',
        localShellCwd: cwd,
        localShellType: shell,
      }
      setTabs((prev) => [...prev, newTab])
      const leafId = newLeafId()
      setSplitTrees((prev) => ({ ...prev, [tabId]: makeLeaf(leafId, tabId) }))
      setFocusedLeafByRoot((prev) => ({ ...prev, [tabId]: leafId }))
      setActiveTabId(tabId)
      return tabId
    },
    [newLeafId, t],
  )

  // Open a local shell as a NEW top-level tab (workspace).
  const handleOpenLocalTerminal = useCallback(
    (cwd?: string, shell?: string) => {
      return openLocalShellTab(cwd, shell)
    },
    [openLocalShellTab],
  )

  // Right-click → split the current window; default (left-click) opens a new tab.
  const handleOpenSplit = useCallback(
    (conn: ConnectionConfig, direction: 'row' | 'column') => {
      openInSplit(conn, direction)
    },
    [openInSplit],
  )

  // Open a LOCAL shell as an embedded split pane inside the active workspace.
  const handleOpenLocalSplit = useCallback(
    (cwd: string | undefined, shell: string | undefined, direction: 'row' | 'column'): number | null => {
      const rootId = activeTabIdRef.current
      if (rootId == null) return null
      const tree = splitTreeRef.current
      const focus = focusedLeafIdRef.current
      const focusLeaf = focus ? findLeaf(tree, focus) : null
      const targetId = focusLeaf ? focus! : collectLeaves(tree)[0]?.id
      if (!targetId) return null
      const tabId = nextTabId++
      const newTab: TabInfo = {
        tabId,
        connectionId: undefined,
        connectionName: t('localTerminal'),
        host: 'localhost',
        status: 'connected',
        tabType: 'localShell',
        embedded: true,
        localShellCwd: cwd,
        localShellType: shell,
      }
      setTabs((prev) => [...prev, newTab])
      const { tree: nt, newLeafId: nl } = splitLeaf(tree, targetId, tabId, direction, newLeafId)
      updateActiveTree(() => nt)
      if (nl) setFocusedLeafId(nl)
      return tabId
    },
    [t, newLeafId, updateActiveTree, setFocusedLeafId],
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

  const [aiContextText, setAiContextText] = useState<string | null>(null)

  // Open the Settings tab on the AI section (used when AI is not configured).
  const handleOpenAiSettings = useCallback(() => {
    setSettingsActiveTab('ai')
    handleOpenSettings()
  }, [handleOpenSettings])

  // Open AI chat. If `tabId` is given, attach to that shell tab (open its
  // docked AI pane); otherwise open/activate the standalone AI Chat tab.
  const handleOpenAiChat = useCallback(
    (contextText?: string, tabId?: number) => {
      if (contextText) setAiContextText(contextText)
      if (tabId !== undefined) {
        setShowAiByTab((prev) => ({ ...prev, [tabId]: true }))
        setAiFloatingTabId(null)
        setActiveTabId(tabId)
        return
      }
      const existing = tabs.find((t) => t.tabType === 'aiChat')
      if (existing) {
        setActiveTabId(existing.tabId)
        return
      }
      const newTabId = nextTabId++
      const aiChatTab: TabInfo = {
        tabId: newTabId,
        connectionName: 'AI Chat',
        host: '',
        status: 'aiChat',
        tabType: 'aiChat',
      }
      setTabs((prev) => [...prev, aiChatTab])
      setActiveTabId(newTabId)
    },
    [tabs],
  )

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
      } else if (s?.tabType === 'localShell') {
        try {
          await localClose(sid)
        } catch (e) {
          console.error('Local shell close error:', e)
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
    // Clean up per-session view/editor state belonging to the closed sessions.
    setShellView((prev) => {
      const n = { ...prev }
      for (const sid of sessionIds) delete n[sid]
      return n
    })
    setActiveEditorKey((prev) => {
      const n = { ...prev }
      for (const sid of sessionIds) delete n[sid]
      return n
    })
    setEditorTabs((prev) => prev.filter((et) => !sessionIds.includes(et.sshTabId)))
    setActiveTabId((prev) => {
      if (prev !== tabId) return prev
      const remaining = tabsRef.current.filter(
        (t) =>
          (t.tabType === 'terminal' || t.tabType === 'localShell') &&
          !t.embedded &&
          !sessionIds.includes(t.tabId),
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
    const legacyTabId = target.kind === 'session' || target.kind === 'local' ? target.tabId : target.jumpTabId
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
    setActiveEditorKeyFor(legacyTabId, key)
    setShellViewFor(legacyTabId, key)
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
                  hexBase64: fc.hexBase64,
                  imageMime: fc.imageMime,
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

  const closeEditorTab = useCallback((key: string) => {
    setEditorTabs((prev) => {
      const idx = prev.findIndex((t) => t.key === key)
      if (idx < 0) return prev
      const sshTabId = prev[idx].sshTabId
      const next = prev.filter((t) => t.key !== key)
      // If the closed file was the active one for its session, pick the next
      // file of that same session (if any).
      const sessionFiles = next.filter((t) => t.sshTabId === sshTabId)
      setActiveEditorKey((aek) => {
        if (aek[sshTabId] === key) {
          return {
            ...aek,
            [sshTabId]: sessionFiles.length > 0 ? sessionFiles[Math.min(idx, sessionFiles.length - 1)].key : '',
          }
        }
        return aek
      })
      if (sessionFiles.length === 0) {
        setShellView((prev) => {
          const nextView = { ...prev }
          delete nextView[sshTabId]
          return nextView
        })
      }
      return next
    })
  }, [])

  // Close a docker log view tab (it lives on the pane header like a file).
  // The DockerLogViewer unmount effect stops its own stream.
  const closeDockerLogTab = useCallback((tabId: number) => {
    const dl = tabsRef.current.find((t) => t.tabId === tabId)
    setTabs((prev) => prev.filter((t) => t.tabId !== tabId))
    if (dl?.jumpTabId != null) {
      setShellView((prev) => {
        if (prev[dl.jumpTabId!] !== `dockerlog:${tabId}`) return prev
        const next = { ...prev }
        delete next[dl.jumpTabId!]
        return next
      })
    }
  }, [])

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
      if (tab.tabType === 'settings') return '⚙ ' + t('tabSettings')
      if (tab.tabType === 'aiChat') return '🤖 ' + t('tabAiChat')
      if (tab.tabType === 'dockerLog') return `📋 ${tab.containerName ?? 'Logs'}`
      if (tab.tabType === 'localShell')
        return `🖥 ${tab.localShellCwd ? tab.localShellCwd : t('localTerminal')}`
      if (tab.dockerContainer) return `🐳 ${tab.dockerContainer}`
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
      if (tab.tabType === 'localShell') {
        openLocalShellTab(tab.localShellCwd)
        return
      }
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

  // ===== Floating (pop-out) panes =====
  // Floated panes are removed from the split-tree layout (their leaf is pruned)
  // and re-rendered as draggable, top-most overlays inside the same window. The
  // underlying session keeps running; closing the overlay restores the exact
  // previous tree so the pane returns to its spot.
  const [floatingItems, setFloatingItems] = useState<FloatingItem[]>([])
  const floatingItemsRef = useRef(floatingItems)
  floatingItemsRef.current = floatingItems
  // floatId -> { rootId, tree, shellView } snapshot taken when the pane was
  // floated. `shellView` is captured so a floated docker-log / editor overlay
  // can be restored when the floating window closes (and reset meanwhile so
  // other panes don't render the overlay).
  // `tree` is null for overlay floats (file editor / docker log): the leaf is
  // kept in the split tree so the shell below stays mounted and usable, and
  // only the overlay is popped out — closing the float restores shellView.
  const floatRestoreRef = useRef<Record<string, { rootId: number; tree: SplitNode | null; shellView?: string }>>({})
  const floatingZRef = useRef(1000)

  const floatPane = useCallback(
    (
      leafId: string,
      force?: { kind?: FloatingKind; dockerLogTabId?: number; editorKey?: string },
    ) => {
      // Locate the leaf + its workspace root.
      let rootId: number | null = null
      let leaf: SplitLeaf | null = null
      for (const [rid, tree] of Object.entries(splitTreesRef.current)) {
        const l = findLeaf(tree, leafId)
        if (l) {
          rootId = Number(rid)
          leaf = l
          break
        }
      }
      if (rootId == null || !leaf || leaf.tabId == null) return
      const tabId = leaf.tabId
      const tab = tabsRef.current.find((t) => t.tabId === tabId)
      if (!tab) return
      const floatId = `float-${leafId}`
      if (floatingItemsRef.current.some((i) => i.floatId === floatId)) return

      // Decide what the pane is currently showing. Note: the docker log / file
      // editor views are overlays on top of a connection's terminal leaf, so the
      // leaf's tabId is the *connection* tabId, not the dockerLog/editor tabId.
      // An explicit `force` (from a docker-log / editor tab's own float button)
      // takes precedence over the inferred view.
      const sv = getShellView(tabId)
      let kind: FloatingKind = force?.kind ?? 'terminal'
      let editorKey: string | undefined = force?.editorKey
      let dockerLogTabId: number | undefined = force?.dockerLogTabId
      let title = getTabLabel(tab)
      // Docker log / file editor overlays only ever render on the FOCUSED pane
      // (renderPane gates them behind `isFocused`). A non-focused pane always
      // shows its plain terminal, even though `shellView` is per-session — so
      // only treat this leaf as the overlay when it is the focused one (or when
      // no focus is recorded yet, i.e. a single-pane workspace).
      if (force?.kind) {
        if (force.kind === 'dockerLog' && force.dockerLogTabId != null) {
          const dl = dockerLogTabsRef.current.find((d) => d.tabId === force.dockerLogTabId)
          if (dl) title = `${t('dockerLogs')}: ${dl.containerName ?? force.dockerLogTabId}`
        } else if (force.kind === 'editor' && force.editorKey) {
          const et = editorTabsRef.current.find((e) => e.key === force.editorKey)
          if (et) title = et.name
        }
      } else {
        const focusedId = focusedLeafByRootRef.current[rootId]
        const showsOverlay = focusedId === leafId || focusedId == null || focusedId === ''
        if (showsOverlay && sv.startsWith('dockerlog:')) {
          const dlId = Number(sv.slice('dockerlog:'.length))
          const dl = dockerLogTabsRef.current.find((d) => d.tabId === dlId)
          // The log view is shown on the focused leaf; `jumpTabId` may point at
          // the workspace root tab while the leaf is an embedded split tab, so
          // accept the match when this leaf is the focused pane.
          if (dl && (dl.jumpTabId === tabId || focusedId === leafId)) {
            kind = 'dockerLog'
            dockerLogTabId = dl.tabId
            title = `${t('dockerLogs')}: ${dl.containerName ?? dlId}`
          }
        } else if (
          showsOverlay &&
          editorTabsRef.current.some((e) => e.key === sv && e.sshTabId === tabId)
        ) {
          kind = 'editor'
          editorKey = sv
          const et = editorTabsRef.current.find((e) => e.key === sv && e.sshTabId === tabId)
          if (et) title = et.name
        }
      }

      // Snapshot the tree so we can restore the pane exactly on close. When the
      // floated pane was showing an overlay (docker log / file editor), the
      // global shellView is reset to the terminal so the rest of the workspace
      // (other panes) doesn't keep rendering that overlay — it is restored to
      // the overlay when the floating window is closed.
      let restoreShellView: string | undefined
      if (kind === 'dockerLog') {
        // Prefer the docker log's own view key (works even when floated via the
        // tab's explicit float button and shellView points elsewhere).
        restoreShellView = sv.startsWith('dockerlog:') && sv === `dockerlog:${dockerLogTabId}` ? sv : `dockerlog:${dockerLogTabId}`
      } else if (kind === 'editor') {
        restoreShellView = editorKey
      }

      // Overlay floats (file editor / docker log): the overlay lives ON TOP of
      // a terminal leaf. Keep the leaf in the split tree so the shell below
      // stays mounted and usable — only the overlay moves to the floating
      // window. shellView is switched back to the terminal meanwhile and
      // restored to the overlay when the float closes.
      if (kind === 'dockerLog' || kind === 'editor') {
        floatRestoreRef.current[floatId] = { rootId, tree: null, shellView: restoreShellView }
        setShellViewFor(tabId, 'terminal')
      } else {
        // Terminal float: snapshot the tree, prune the leaf (session is NOT
        // torn down), and clear the pane's focus.
        floatRestoreRef.current[floatId] = { rootId, tree: splitTreesRef.current[rootId] }
        setSplitTrees((prev) => {
          const tree = prev[rootId]
          if (!tree) return prev
          const r = removeLeafById(tree, leafId, newLeafId)
          if (!r) {
            // The floated leaf was the root's only leaf — removeLeafById
            // returns null (no node left). Replace the tree with an empty
            // placeholder so the original pane disappears (otherwise the
            // terminal stays mounted AND the floating copy renders → two live
            // instances, input echoes).
            return { ...prev, [rootId]: makeLeaf(newLeafId()) }
          }
          return { ...prev, [rootId]: pruneEmptyLeaves(r, newLeafId) }
        })
        setFocusedLeafByRoot((prev) => {
          const next = { ...prev }
          if (next[rootId] === leafId) delete next[rootId]
          return next
        })
      }

      const z = ++floatingZRef.current
      setFloatingItems((prev) => [
        ...prev,
        {
          floatId,
          kind,
          tabId,
          editorKey,
          dockerLogTabId,
          title,
          x: 120,
          y: 90,
          w: 640,
          h: 420,
          z,
        },
      ])
    },
    [newLeafId, getTabLabel],
  )

  const closeFloating = useCallback((floatId: string) => {
    const snap = floatRestoreRef.current[floatId]
    if (snap) {
      const { rootId, tree, shellView } = snap
      // Only terminal floats detached the leaf from the split tree; overlay
      // floats (file editor / docker log) left the tree untouched, so there is
      // nothing to restore there.
      if (tree) {
        setSplitTrees((prev) => ({ ...prev, [rootId]: tree }))
        const leafId = floatId.replace('float-', '')
        setFocusedLeafByRoot((prev) => ({ ...prev, [rootId]: leafId }))
      }
      // Restore the overlay (docker log / file editor) that the floated pane
      // was showing before it was popped out.
      if (shellView !== undefined) {
        const item = floatingItemsRef.current.find((i) => i.floatId === floatId)
        if (item && item.tabId != null) setShellViewFor(item.tabId, shellView)
      }
      delete floatRestoreRef.current[floatId]
    }
    setFloatingItems((prev) => prev.filter((i) => i.floatId !== floatId))
  }, [])

  const bringFloatingToFront = useCallback((floatId: string) => {
    const z = ++floatingZRef.current
    setFloatingItems((prev) => prev.map((i) => (i.floatId === floatId ? { ...i, z } : i)))
  }, [])

  const moveFloating = useCallback((floatId: string, x: number, y: number) => {
    setFloatingItems((prev) => prev.map((i) => (i.floatId === floatId ? { ...i, x, y } : i)))
  }, [])

  const resizeFloating = useCallback((floatId: string, w: number, h: number) => {
    setFloatingItems((prev) => prev.map((i) => (i.floatId === floatId ? { ...i, w, h } : i)))
  }, [])

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

  // Load saved local terminal entries
  const reloadLocalTerminals = useCallback(() => {
    getLocalTerminals()
      .then(setLocalTerminals)
      .catch((err: unknown) => console.error('getLocalTerminals', err))
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
  // Terminals block (reused standalone or inside the editor + shell split)
  // ---- Floating pane content ----
  // Renders the same content a floated pane would show, hosted inside the
  // FloatingWindow overlay. Reuses the exact component wiring used inside a
  // normal pane so behaviour is identical.
  const renderFloatingContent = (item: FloatingItem) => {
    const tab = tabs.find((t) => t.tabId === item.tabId)
    if (!tab) return null
    if (item.kind === 'editor' && item.editorKey) {
      const et = editorTabs.find((e) => e.key === item.editorKey)
      if (!et) return null
      return (
        <FileEditor
          tabs={editorTabs}
          activeKey={item.editorKey}
          onSelect={(key) => {
            if (item.tabId != null) {
              setActiveEditorKeyFor(item.tabId, key)
              setShellViewFor(item.tabId, key)
            }
          }}
          onClose={closeEditorTab}
          onContentChange={handleEditorContentChange}
          onSave={handleSaveEditorTab}
          onChangeLanguage={changeEditorTabLanguage}
          onChangeEncoding={changeEditorTabEncoding}
          onChangeLineEnding={changeEditorTabLineEnding}
          hideTabs
        />
      )
    }
    if (item.kind === 'dockerLog') {
      const dl = dockerLogTabs.find((d) => d.tabId === item.dockerLogTabId)
      if (!dl) return null
      return (
        <DockerLogViewer
          tabId={dl.tabId}
          jumpTabId={dl.jumpTabId!}
          containerName={dl.containerName!}
          containerImage={dl.containerImage}
          defaultWordWrap={dockerWordWrap}
          defaultFollow={dockerFollow}
          maxLines={dockerMaxLines}
          onAskAi={(text) => handleOpenAiChat(text)}
        />
      )
    }
    // terminal / docker shell — reuse the same renderer the panes use.
    return renderTerminalForTab(tab, true, item.floatId)
  }
  // ---- Split-tree render helpers ----
  // Map every session to the leaf that shows it, across ALL workspaces (leaf
  // ids are globally unique). Used by terminalPortals to route each terminal
  // into its own workspace's pane body — every workspace container stays mounted
  // (just hidden), so sessions never remount or reconnect.
  const allTabToLeaf = useMemo(() => {
    const m = new Map<number, string>()
    for (const root of tabs) {
      if ((root.tabType !== 'terminal' && root.tabType !== 'localShell') || root.embedded) continue
      const tree = splitTrees[root.tabId]
      if (!tree) continue
      buildTabToLeaf(tree).forEach((v, k) => m.set(k, v))
    }
    return m
  }, [tabs, splitTrees])
  tabToLeafRef.current = allTabToLeaf
  const activeTerminalTab = tabs.find((t) => t.tabId === activeTabId)
  const settingsActive = activeTerminalTab?.tabType === 'settings'
  const aiChatActive = activeTerminalTab?.tabType === 'aiChat'
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
    const isLocalShell = tab.tabType === 'localShell'
    return (
      <div style={{ height: '100%', width: '100%', position: 'relative' }}>
        {tab.tabType !== 'settings' && (
          <div
            style={{
              display: 'block',
              height: '100%',
            }}
          >
            <TerminalComponent
              tabId={tab.tabId}
              isActive={true}
              isFocused={isFocused}
              reconnectTrigger={reconnectKeys[tab.tabId] || 0}
              connectConfig={connectConfig}
              autoConnect={!!tab.connectionId || isLocalShell}
              isLocal={isLocalShell}
              localCwd={tab.localShellCwd}
              localShellType={tab.localShellType}
              maxScrollback={maxScrollback}
              onStatusChange={(status, errorMessage) => {
                setTabs((prev) =>
                  prev.map((t) => (t.tabId === tab.tabId ? { ...t, status, errorMessage } : t)),
                )
                if (status === 'connected') {
                  refreshRecordingState(tab.tabId)
                }
              }}
              onSizeChange={(cols, rows) => {
                if (leafId) setTermSizes((prev) => ({ ...prev, [leafId]: { cols, rows } }))
              }}
              onAskAi={(selectedText) => {
                handleOpenAiChat(selectedText, tab.tabId)
              }}
            />
          </div>
        )}
        {tab.tabType === 'settings' && (
          <div className="settings-layout">
            <div className="settings-sidebar">
              <button
                className={'settings-nav-item' + (settingsActiveTab === 'general' ? ' active' : '')}
                onClick={() => setSettingsActiveTab('general')}
              >
                <Icon name="settings" size={15} />
                {t('settingsGeneral')}
              </button>
              <button
                className={'settings-nav-item' + (settingsActiveTab === 'ai' ? ' active' : '')}
                onClick={() => setSettingsActiveTab('ai')}
              >
                <Icon name="sparkles" size={15} />
                {t('aiSettingsHeader')}
              </button>
            </div>

            <div className="settings-content">
              {settingsActiveTab === 'general' && (
                <div className="settings-pane">
                  <div className="settings-pane-header">
                    <h3>{t('settingsGeneral')}</h3>
                    <p>{t('settingsAppearance')}</p>
                  </div>

                  <div className="settings-card">
                    <div className="settings-fields">
                      <div className="settings-field">
                        <label className="settings-label">{t('windowOpacity')}</label>
                        <input
                          type="range"
                          min="20"
                          max="100"
                          value={Math.round(opacity * 100)}
                          onChange={(e) => setOpacity(Number(e.target.value) / 100)}
                          className="settings-range"
                        />
                        <span className="settings-help">Current: {Math.round(opacity * 100)}%</span>
                      </div>

                      <div className="settings-field">
                        <label htmlFor="ui-language" className="settings-label">{t('language')}</label>
                        <select
                          id="ui-language"
                          className="settings-input"
                          style={{ width: '200px' }}
                          value={lang}
                          onChange={(e) => setLang(e.target.value as 'en' | 'zh')}
                        >
                          {(['en', 'zh'] as const).map((l) => (
                            <option key={l} value={l}>
                              {LANG_LABELS[l]}
                            </option>
                          ))}
                        </select>
                        <span className="settings-help">{t('settingsAppearance')}</span>
                      </div>

                      <div className="settings-field">
                        <label htmlFor="maxScrollback" className="settings-label">{t('maxScrollbackLines')}</label>
                        <input
                          id="maxScro[plugin:vite:css] [sass] Error: Undefined variable.llback"
                          type="number"
                          min="100"
                          max="100000"
                          step="100"
                          className="settings-input"
                          style={{ width: '140px' }}
                          value={maxScrollback}
                          onChange={(e) => {
                            const v = Math.max(100, Math.min(100000, Number(e.target.value) || 5000))
                            setMaxScrollback(v)
                            try { localStorage.setItem('wrolp-maxScrollback', String(v)) } catch {}
                          }}
                        />
                        <span className="settings-help">{t('appliesToNewTabs')}</span>
                      </div>

                      <div className="settings-field checkbox-field">
                        <input
                          id="auto-record-sessions"
                          type="checkbox"
                          checked={autoRecord}
                          onChange={(e) => handleAutoRecordChange(e.target.checked)}
                        />
                        <label htmlFor="auto-record-sessions" className="settings-label">{t('autoRecordSessions')}</label>
                        <span className="settings-help">{t('autoRecordSessionsDesc')}</span>
                      </div>

                      <div className="settings-field">
                        <label className="settings-label">{t('updates')}</label>
                        <div className="settings-update-row">
                          <button
                            className="settings-save-btn"
                            onClick={handleCheckUpdate}
                            disabled={
                              updateState === 'checking' ||
                              updateState === 'downloading' ||
                              updateState === 'installing'
                            }
                          >
                            {updateState === 'checking' ? t('loading') : t('checkForUpdates')}
                          </button>
                          {updateInfo ? (
                            <span className="settings-update-status">{t('newVersion', { ver: updateInfo.version })}</span>
                          ) : updateInfo === null && updateState !== 'checking' ? (
                            <span className="settings-update-status">{t('upToDate')}</span>
                          ) : null}
                        </div>
                        {updateInfo && (
                          <div className="settings-update-row" style={{ marginTop: 10 }}>
                            <button
                              className="settings-save-btn"
                              onClick={handleDownloadUpdate}
                              disabled={updateState !== 'idle'}
                            >
                              {updateState === 'downloading'
                                ? t('downloading')
                                : updateState === 'installing'
                                  ? t('installing')
                                  : t('downloadAndInstall')}
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="settings-card">
                    <div className="settings-card-header">
                      <div className="settings-card-icon">🐳</div>
                      <div>
                        <h3 className="settings-card-title">{t('dockerLogs')}</h3>
                        <p className="settings-card-sub">{t('dockerLogsDesc')}</p>
                      </div>
                    </div>
                    <div className="settings-fields">
                      <div className="settings-field checkbox-field">
                        <input
                          id="docker-wordwrap"
                          type="checkbox"
                          checked={dockerWordWrap}
                          onChange={(e) => {
                            setDockerWordWrap(e.target.checked)
                            try { localStorage.setItem('wrolp-docker-wordwrap', e.target.checked ? '1' : '0') } catch {}
                          }}
                        />
                        <label htmlFor="docker-wordwrap" className="settings-label">{t('autoWrapLines')}</label>
                      </div>
                      <div className="settings-field checkbox-field">
                        <input
                          id="docker-follow"
                          type="checkbox"
                          checked={dockerFollow}
                          onChange={(e) => {
                            setDockerFollow(e.target.checked)
                            try { localStorage.setItem('wrolp-docker-follow', e.target.checked ? '1' : '0') } catch {}
                          }}
                        />
                        <label htmlFor="docker-follow" className="settings-label">{t('followNewest')}</label>
                      </div>
                      <div className="settings-field">
                        <label htmlFor="docker-maxlines" className="settings-label">{t('maxRetainedLines')}</label>
                        <input
                          id="docker-maxlines"
                          type="number"
                          min="100"
                          max="1000000"
                          step="100"
                          className="settings-input"
                          style={{ width: '140px' }}
                          value={dockerMaxLines}
                          onChange={(e) => {
                            const v = Math.max(100, Math.min(1000000, Number(e.target.value) || 5000))
                            setDockerMaxLines(v)
                            try { localStorage.setItem('wrolp-docker-maxlines', String(v)) } catch {}
                          }}
                        />
                        <span className="settings-help">{t('olderLinesDropped')}</span>
                      </div>
                    </div>
                  </div>

                  {appVersion && (
                    <div className="settings-card">
                      <div className="settings-card-header">
                        <div className="settings-card-icon">
                          <Icon name="link" size={16} />
                        </div>
                        <div>
                          <h3 className="settings-card-title">{t('about')}</h3>
                          <p className="settings-card-sub">{t('aboutDesc')}</p>
                        </div>
                      </div>
                      <div className="app-version-info">
                        <div className="app-version-row">
                          <span className="app-version-label">Version</span>
                          <span className="app-version-value">{appVersion.version}</span>
                        </div>
                        <div className="app-version-row">
                          <span className="app-version-label">Git Commit</span>
                          <span className="app-version-value" title={appVersion.gitCommit}>
                            {appVersion.gitHash}
                          </span>
                        </div>
                        <div className="app-version-row">
                          <span className="app-version-label">Branch</span>
                          <span className="app-version-value">{appVersion.gitBranch}</span>
                        </div>
                        <div className="app-version-row">
                          <span className="app-version-label">Build Time</span>
                          <span className="app-version-value">
                            {appVersion.buildTime !== 'unknown'
                              ? new Date(Number(appVersion.buildTime) * 1000).toLocaleString()
                              : 'unknown'}
                          </span>
                        </div>
                        <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                          <button
                            className="app-version-link"
                            onClick={async () => {
                              try {
                                await openConfigDir()
                              } catch (e) {
                                console.error('open config dir failed', e)
                              }
                            }}
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ verticalAlign: 'middle', marginRight: 4 }}>
                              <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
                            </svg>
                            {t('openConfigDir')}
                          </button>
                          <button
                            className="app-version-link"
                            onClick={() => open(appVersion.repoUrl)}
                          >
                            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style={{ verticalAlign: 'middle', marginRight: 4 }}>
                              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
                            </svg>
                            GitHub Repository
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {settingsActiveTab === 'ai' && (
                <div className="settings-pane">
                  <div className="settings-pane-header">
                    <h3>AI Assistant</h3>
                    <p>OpenAI-compatible chat with built-in tools. Configure multiple endpoints and pick one to use.</p>
                  </div>

                  {aiConfig && aiConfig.profiles.length > 0 && (
                    <div className="settings-card">
                      <div className="settings-card-header">
                        <div className="settings-card-icon">
                          <Icon name="sparkles" size={16} />
                        </div>
                        <div>
                          <h3 className="settings-card-title">{t('endpoints')}</h3>
                          <p className="settings-card-sub">{t('endpointsDesc')}</p>
                        </div>
                      </div>

                      <div className="ai-profile-list">
                        {aiConfig.profiles.map((p) => (
                          <div
                            key={p.id}
                            className={'ai-profile-item' + (p.id === activeProfile?.id ? ' active' : '')}
                            onClick={() => {
                              setAiConfig((prev) => {
                                if (!prev) return prev
                                const next = { ...prev, activeId: p.id }
                                saveAiConfig(next).catch(() => {})
                                return next
                              })
                              setAiModels([])
                              setAiModelManual(false)
                            }}
                          >
                            <div className="ai-profile-info">
                              <span className="ai-profile-name">{p.name || 'Untitled'}</span>
                              <span className="ai-profile-endpoint">{p.endpoint}</span>
                            </div>
                            <button
                              type="button"
                              className="ai-profile-del"
                              title="Delete endpoint"
                              disabled={aiConfig.profiles.length <= 1}
                              onClick={(e) => {
                                e.stopPropagation()
                                setAiConfig((prev) => {
                                  if (!prev) return prev
                                  const profiles = prev.profiles.filter((x) => x.id !== p.id)
                                  const activeId =
                                    prev.activeId === p.id
                                      ? profiles[0]?.id ?? ''
                                      : prev.activeId
                                  const next = { ...prev, profiles, activeId }
                                  saveAiConfig(next).catch(() => {})
                                  return next
                                })
                              }}
                            >
                              <Icon name="x" size={13} />
                            </button>
                          </div>
                        ))}
                      </div>

                      <button
                        type="button"
                        className="ai-profile-add"
                        onClick={() => {
                          const id = crypto.randomUUID()
                          const newProfile: AiEndpointProfile = {
                            id,
                            name: `Endpoint ${aiConfig.profiles.length + 1}`,
                            endpoint: 'https://api.openai.com/v1',
                            apiKeyEnc: '',
                            model: 'gpt-4o',
                            systemPrompt:
                              activeProfile?.systemPrompt ??
                              'You are the AI assistant built into Wrolp Terminal, an SSH terminal and server operations (DevOps / Ops) tool for system administrators. You help users with system administration, command-line operations, debugging, performance tuning, Docker and service management, and understanding server configurations. When asked, run read-only tools on the connected server to investigate. Be concise, practical, and safety-conscious.',
                          }
                          setAiConfig((prev) => {
                            if (!prev) return prev
                            const next = { ...prev, profiles: [...prev.profiles, newProfile], activeId: id }
                            saveAiConfig(next).catch(() => {})
                            return next
                          })
                          setAiApiKeyInput('')
                        }}
                      >
                        <Icon name="plus" size={14} /> {t('addEndpoint')}
                      </button>
                    </div>
                  )}

                  {activeProfile && (
                    <div className="settings-card ai-settings-card">
                      <p className="settings-card-desc">
                        Works with OpenAI, Anthropic (via compatible proxy), Ollama, vLLM, and any
                        OpenAI-compatible endpoint. The assistant can run read-only tools on your
                        connected servers to give accurate answers.
                      </p>

                      <div className="settings-fields">
                        <div className="settings-field">
                          <label htmlFor="ai-name" className="settings-label">
                            <Icon name="sparkles" size={13} /> {t('connectionName')}
                          </label>
                          <input
                            id="ai-name"
                            type="text"
                            className="settings-input"
                            value={activeProfile.name}
                            onChange={(e) =>
                              setAiConfig((prev) =>
                                prev
                                  ? {
                                      ...prev,
                                      profiles: prev.profiles.map((p) =>
                                        p.id === activeProfile.id ? { ...p, name: e.target.value } : p
                                      ),
                                    }
                                  : prev
                              )
                            }
                            placeholder="My Endpoint"
                          />
                        </div>

                        <div className="settings-field">
                          <label htmlFor="ai-endpoint" className="settings-label">
                            <Icon name="link" size={13} /> {t('baseUrl')}
                          </label>
                          <input
                            id="ai-endpoint"
                            type="text"
                            className="settings-input"
                            value={activeProfile.endpoint}
                            onChange={(e) =>
                              setAiConfig((prev) =>
                                prev
                                  ? {
                                      ...prev,
                                      profiles: prev.profiles.map((p) =>
                                        p.id === activeProfile.id ? { ...p, endpoint: e.target.value } : p
                                      ),
                                    }
                                  : prev
                              )
                            }
                            placeholder="https://api.openai.com/v1"
                          />
                          <span className="settings-help">Base URL including the <code>/v1</code> path.</span>
                        </div>

                        <div className="settings-field">
                          <label htmlFor="ai-key" className="settings-label">
                            <Icon name="lock" size={13} /> {t('apiKey')}
                          </label>
                          <div className="settings-input-with-btn">
                            <input
                              id="ai-key"
                              type={aiShowKey ? 'text' : 'password'}
                              className="settings-input"
                              value={aiApiKeyInput}
                              onChange={(e) => setAiApiKeyInput(e.target.value)}
                              placeholder="sk-..."
                              autoComplete="off"
                            />
                            <button
                              type="button"
                              className="settings-icon-btn"
                              onClick={() => setAiShowKey(!aiShowKey)}
                              title={aiShowKey ? t('off') : t('on')}
                            >
                              <Icon name={aiShowKey ? 'eyeOff' : 'eye'} size={15} />
                            </button>
                          </div>
                          <span className="settings-help">Stored encrypted locally; never sent anywhere except your endpoint.</span>
                        </div>

                        <div className="settings-field">
                          <label htmlFor="ai-model" className="settings-label">
                            <Icon name="terminal" size={13} /> {t('model')}
                          </label>
                          {aiModelManual || aiModels.length === 0 ? (
                            <input
                              id="ai-model"
                              type="text"
                              className="settings-input"
                              value={activeProfile.model}
                              onChange={(e) =>
                                setAiConfig((prev) =>
                                  prev
                                    ? {
                                        ...prev,
                                        profiles: prev.profiles.map((p) =>
                                          p.id === activeProfile.id ? { ...p, model: e.target.value } : p
                                        ),
                                      }
                                    : prev
                                )
                              }
                              placeholder="gpt-4o"
                            />
                          ) : (
                            <select
                              id="ai-model"
                              className="settings-input"
                              value={activeProfile.model}
                              onChange={(e) =>
                                setAiConfig((prev) =>
                                  prev
                                    ? {
                                        ...prev,
                                        profiles: prev.profiles.map((p) =>
                                          p.id === activeProfile.id ? { ...p, model: e.target.value } : p
                                        ),
                                      }
                                    : prev
                                )
                              }
                            >
                              {!aiModels.includes(activeProfile.model) && activeProfile.model && (
                                <option value={activeProfile.model}>{activeProfile.model} (current)</option>
                              )}
                              {aiModels.map((m) => (
                                <option key={m} value={m}>
                                  {m}
                                </option>
                              ))}
                            </select>
                          )}
                          <button
                            type="button"
                            className="settings-model-fetch"
                            disabled={aiFetchingModels || !activeProfile.endpoint}
                            onClick={async () => {
                              setAiFetchingModels(true)
                              try {
                                const keyEnc = aiApiKeyInput ? await encryptApiKey(aiApiKeyInput) : ''
                                const models = await listAiModels(keyEnc, activeProfile.endpoint)
                                setAiModels(models)
                                setAiModelManual(false)
                              } catch (e) {
                                setAiModels([])
                                setAiModelManual(true)
                                alert('Failed to fetch models from /v1/models: ' + String(e) + '\n\nYou can type the model name manually.')
                              } finally {
                                setAiFetchingModels(false)
                              }
                            }}
                          >
                            {aiFetchingModels ? t('downloading') : t('fetchModelsFromV1')}
                          </button>
                          {aiModels.length > 0 && (
                            <label className="settings-checkbox-label">
                              <input
                                type="checkbox"
                                checked={aiModelManual}
                                onChange={(e) => setAiModelManual(e.target.checked)}
                              />
                              Type model name manually
                            </label>
                          )}
                          <span className="settings-help">
                            {aiModels.length > 0
                              ? 'Select a model from the dropdown, or tick the box to enter one manually.'
                              : 'Click to list models from the endpoint. You can type the model name manually.'}
                          </span>
                        </div>

                        <div className="settings-field">
                          <label htmlFor="ai-system-prompt" className="settings-label">
                            <Icon name="edit" size={13} /> System Prompt
                          </label>
                          <textarea
                            id="ai-system-prompt"
                            className="settings-input settings-textarea"
                            value={activeProfile.systemPrompt}
                            onChange={(e) =>
                              setAiConfig((prev) =>
                                prev
                                  ? {
                                      ...prev,
                                      profiles: prev.profiles.map((p) =>
                                        p.id === activeProfile.id
                                          ? { ...p, systemPrompt: e.target.value }
                                          : p
                                      ),
                                    }
                                  : prev
                              )
                            }
                            rows={3}
                          />
                          <span className="settings-help">Optional instructions that shape the assistant's behavior.</span>
                        </div>
                      </div>

                      <div className="settings-actions">
                        <button
                          className="settings-save-btn"
                          onClick={async () => {
                            if (!aiConfig || !activeProfile) return
                            try {
                              const keyEnc = await encryptApiKey(aiApiKeyInput)
                              const toSave: AiConfig = {
                                ...aiConfig,
                                profiles: aiConfig.profiles.map((p) =>
                                  p.id === activeProfile.id ? { ...p, apiKeyEnc: keyEnc } : p
                                ),
                              }
                              await saveAiConfig(toSave)
                              setAiConfig(toSave)
                              setSaveFlash('ai')
                            } catch (e) {
                              alert('Failed to save: ' + String(e))
                            }
                          }}
                        >
                          {saveFlash === 'ai' ? 'Saved ✓' : 'Save AI Settings'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
        {tab.tabType !== 'settings' && tab.tabType !== 'aiChat' && tab.status === 'disconnected' ? (
          <div
            className="terminal-placeholder"
            style={{
              position: 'absolute',
              inset: 0,
              background: 'rgba(0,0,0,0.55)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <div className="icon">🔌</div>
            <div style={{ color: '#f44747' }}>{t('connectionLost')}</div>
            <div style={{ fontSize: '12px', color: '#888' }}>
              {tab.connectionName} — {tab.host}
            </div>
            <div style={{ fontSize: '12px', color: '#666', marginTop: 8 }}>
              {t('pressEnterToRetry')} / {t('clickReconnectHint')}
            </div>
          </div>
        ) : tab.tabType !== 'settings' && tab.status === 'error' ? (
          <div
            className="terminal-placeholder"
            style={{
              position: 'absolute',
              inset: 0,
              background: 'rgba(0,0,0,0.55)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <div style={{ color: '#f44747' }}>{t('connectionFailed')}: {tab.connectionName}</div>
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
            <div style={{ fontSize: '12px', color: '#666', marginTop: 12 }}>
              Press Enter to retry / {t('clickReconnectHint')}
            </div>
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

  // Docker log viewer tabs — each is a view on a pane's header (like a file).
  // Defined BEFORE renderPane/terminalContent so the pane header (which renders
  // the log tabs) can reference them without hitting a temporal-dead-zone error.
  const dockerLogTabs = tabs.filter((t) => t.tabType === 'dockerLog' && t.embedded)
  const dockerLogTabsRef = useRef(dockerLogTabs)
  dockerLogTabsRef.current = dockerLogTabs

  // True when the given file-editor tab / docker-log tab has been popped out to
  // a floating window. While floated, the overlay is rendered ONLY in the
  // floating window — the original pane (whose leaf stays in the split tree for
  // overlay floats) must not render it again.
  const isOverlayFloated = (editorKeyOrDlTabId: string | number) =>
    floatingItemsRef.current.some(
      (i) =>
        (i.kind === 'editor' && i.editorKey === editorKeyOrDlTabId) ||
        (i.kind === 'dockerLog' && i.dockerLogTabId === editorKeyOrDlTabId),
    )

  const renderPane = (
    leaf: SplitLeaf,
    focusedLeafIdForRoot: string | null,
    rect: PaneRect,
  ): React.ReactElement => {
    const tab = leaf.tabId != null ? tabs.find((t) => t.tabId === leaf.tabId) : undefined
    const isFocused = leaf.id === focusedLeafIdForRoot
    const isDragSource = paneDrag.source === leaf.id
    // Per-session view state: which overlay (if any) this session's pane shows.
    const sv = leaf.tabId != null ? getShellView(leaf.tabId) : 'terminal'
    const sessionEditorTabs = editorTabs.filter((et) => et.sshTabId === leaf.tabId)
    const sessionDockerLogTabs = dockerLogTabs.filter((dt) => dt.jumpTabId === leaf.tabId)
    const sessionActiveEditorKey = leaf.tabId != null ? activeEditorKey[leaf.tabId] ?? null : null
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
          {tab?.tabType === 'terminal' && leaf.tabId != null && (
            <button
              className="term-pane-reconnect"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                handleReconnect(leaf.tabId as number)
              }}
              title={t('reconnect')}
            >
              <Icon name="refresh" size={12} />
            </button>
          )}
          {/* Session recording toggle — only for SSH terminal sessions. */}
          {tab?.tabType === 'terminal' && leaf.tabId != null && (
            <button
              className={'term-pane-record' + (recordingByTab[leaf.tabId] ? ' active' : '')}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                handleToggleRecording(leaf.tabId as number)
              }}
              title={recordingByTab[leaf.tabId] ? t('stopRecording') : t('startRecording')}
            >
              <span className="term-pane-record-dot" />
            </button>
          )}
          {(tab?.tabType === 'terminal' || tab?.tabType === 'localShell') && leaf.tabId != null && (
            <button
              className={'term-pane-ai-toggle' + (showAiByTab[leaf.tabId] ? ' active' : '')}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                setShowAiByTab((prev) => ({ ...prev, [leaf.tabId as number]: !prev[leaf.tabId as number] }))
              }}
              title="Toggle AI chat for this shell"
            >
              🤖 AI
            </button>
          )}
          {/* Open files and docker logs live on the same pane-header panel as
              the AI button (only on the focused pane so splits don't duplicate).
              Each pane shows only the files/logs that belong to ITS OWN SSH
              session (leaf.tabId) — files opened in one workspace tab never
              appear in another. */}
          {(isFocused || focusedLeafIdForRoot == null) &&
            (sessionEditorTabs.length > 0 || sessionDockerLogTabs.length > 0) && (
            <div className="term-pane-file-tabs">
              <div
                className={`term-pane-file-tab${sv === 'terminal' ? ' active' : ''}`}
                onClick={(e) => {
                  e.stopPropagation()
                  if (leaf.tabId != null) setShellViewFor(leaf.tabId, 'terminal')
                }}
                title={t('shellTerminal')}
              >
                <Icon name="terminal" size={11} />
                <span>{t('shellTerminal')}</span>
              </div>
              {sessionEditorTabs
                .filter((et) => !isOverlayFloated(et.key))
                .map((et) => (
                <div
                  key={et.key}
                  className={`term-pane-file-tab${sv === et.key ? ' active' : ''}${et.isDirty ? ' dirty' : ''}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    if (leaf.tabId != null) {
                      setActiveEditorKeyFor(leaf.tabId, et.key)
                      setShellViewFor(leaf.tabId, et.key)
                    }
                  }}
                  title={et.path}
                >
                  <span className="term-pane-file-tab-name">{et.name}</span>
                  {et.isDirty && <span className="term-pane-file-tab-dirty">●</span>}
                  <span
                    className="term-pane-file-tab-float"
                    onClick={(e) => {
                      e.stopPropagation()
                      // Float the file editor overlay directly (explicit kind),
                      // so it doesn't depend on the global shellView / focus.
                      floatPane(leaf.id, { kind: 'editor', editorKey: et.key })
                    }}
                    title={t('floatPane')}
                  >
                    ⤢
                  </span>
                  <span
                    className="term-pane-file-tab-close"
                    onClick={(e) => {
                      e.stopPropagation()
                      closeEditorTab(et.key)
                    }}
                  >
                    ×
                  </span>
                </div>
              ))}
              {sessionDockerLogTabs
                .filter((dt) => !isOverlayFloated(dt.tabId))
                .map((dt) => (
                <div
                  key={dt.tabId}
                  className={`term-pane-file-tab${sv === `dockerlog:${dt.tabId}` ? ' active' : ''}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    if (leaf.tabId != null) setShellViewFor(leaf.tabId, `dockerlog:${dt.tabId}`)
                  }}
                  title={`${t('dockerLogs')}: ${dt.containerName}`}
                >
                  <span className="term-pane-file-tab-name">📋 {dt.containerName}</span>
                  <span
                    className="term-pane-file-tab-float"
                    onClick={(e) => {
                      e.stopPropagation()
                      // Float the docker log overlay directly (explicit kind), so
                      // it doesn't depend on the global shellView / focus state.
                      floatPane(leaf.id, { kind: 'dockerLog', dockerLogTabId: dt.tabId })
                    }}
                    title={t('floatPane')}
                  >
                    ⤢
                  </span>
                  <span
                    className="term-pane-file-tab-close"
                    onClick={(e) => {
                      e.stopPropagation()
                      closeDockerLogTab(dt.tabId)
                    }}
                  >
                    ×
                  </span>
                </div>
              ))}
            </div>
          )}
          <span
            className="term-pane-float"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              floatPane(leaf.id)
            }}
            title={t('floatPane')}
          >
            ⤢
          </span>
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
        <div
          className="term-pane-body"
          style={{
            flexDirection:
              leaf.tabId != null && showAiByTab[leaf.tabId] && aiFloatingTabId !== leaf.tabId
                ? (() => {
                    const s = aiDockSideByTab[leaf.tabId]
                    return s === 'top' || s === 'bottom' ? 'column' : 'row'
                  })()
                : 'row',
          }}
        >
          {/* Terminal surface — stays mounted even while the file editor is
              shown on the focused pane, so switching tabs never reconnects. */}
          <div
            className="term-pane-term"
            ref={getPaneBodyRef(leaf.id)}
            style={{
              flex: 1,
              minWidth: 0,
              minHeight: 0,
              overflow: 'hidden',
              // Hide the terminal only when a non-floated overlay is active;
              // a floated overlay renders exclusively in its floating window,
              // so the shell stays visible here.
              display:
                isFocused &&
                sv !== 'terminal' &&
                (sessionEditorTabs.length > 0 || sessionDockerLogTabs.length > 0) &&
                !isOverlayFloated(sv)
                  ? 'none'
                  : 'flex',
              flexDirection: 'column',
            }}
          >
            {leaf.tabId == null && (
              <div className="terminal-placeholder">
                <div className="icon"><Icon name="desktop" /></div>
                <div>{t('selectConnectionToStart')}</div>
              </div>
            )}
          </div>
          {/* Docked AI chat attached to this pane's shell tab. Hidden while the
              pane is showing a file editor / docker log overlay so the AI panel
              doesn't follow along next to the editor. */}
          {(tab?.tabType === 'terminal' || tab?.tabType === 'localShell') &&
            leaf.tabId != null &&
            activeProfile &&
            sv === 'terminal' &&
            showAiByTab[leaf.tabId] &&
            aiFloatingTabId !== leaf.tabId && (
              (() => {
                const tid = leaf.tabId as number
                const side = aiDockSideByTab[tid] ?? 'right'
                const isVertical = side === 'top' || side === 'bottom'
                // Default size is half of the pane; once the user drags the
                // divider the explicit px size takes over (persisted per tab).
                const hasExplicitSize = aiDockSizeByTab[tid] != null
                const size = aiDockSizeByTab[tid] ?? (isVertical ? 220 : 340)
                const dockFlex = hasExplicitSize ? `0 0 ${size}px` : '0 0 50%'
                // Switch dock side (top/bottom = stacked above/below; left/right = beside).
                const setDockSide = (s: 'left' | 'top' | 'right' | 'bottom') =>
                  setAiDockSideByTab((prev) => ({ ...prev, [tid]: s }))
                const dockStyle: React.CSSProperties = isVertical
                  ? {
                      height: hasExplicitSize ? size : undefined,
                      flex: dockFlex,
                      minWidth: 0,
                      minHeight: 0,
                      display: 'flex',
                      flexDirection: 'column',
                      borderTop: side === 'top' ? '1px solid var(--border, #333)' : 'none',
                      borderBottom: side === 'bottom' ? '1px solid var(--border, #333)' : 'none',
                      order: side === 'top' ? -1 : 0,
                      width: '100%',
                    }
                  : {
                      width: hasExplicitSize ? size : undefined,
                      flex: dockFlex,
                      minWidth: 0,
                      minHeight: 0,
                      display: 'flex',
                      flexDirection: 'column',
                      borderLeft: side === 'left' ? '1px solid var(--border, #333)' : 'none',
                      borderRight: side === 'right' ? '1px solid var(--border, #333)' : 'none',
                      order: side === 'left' ? -1 : 0,
                    }
                // Resize handle sits on the edge adjacent to the terminal.
                const startDockResize = (e: React.MouseEvent) => {
                  e.preventDefault()
                  e.stopPropagation()
                  // Capture the workspace element now — `e.currentTarget` is only
                  // valid during dispatch, so it would be null inside onUp.
                  const ws = (e.currentTarget as HTMLElement).closest('.term-workspace') as HTMLElement | null
                  // Without an explicit size the dock renders at 50% — seed the
                  // drag baseline with the actual 50% of the workspace so the
                  // first drag starts from the on-screen size, not the px fallback.
                  const seedSize = hasExplicitSize
                    ? size
                    : ws
                      ? isVertical
                        ? Math.round(ws.clientHeight / 2)
                        : Math.round(ws.clientWidth / 2)
                      : size
                  aiDockResizeRef.current = {
                    dir: side,
                    sx: e.clientX,
                    sy: e.clientY,
                    sSize: seedSize,
                  }
                  const onMove = (ev: MouseEvent) => {
                    const r = aiDockResizeRef.current
                    if (!r) return
                    // Dragging away from the terminal grows the dock.
                    const delta =
                      r.dir === 'right'
                        ? r.sx - ev.clientX
                        : r.dir === 'left'
                        ? ev.clientX - r.sx
                        : r.dir === 'bottom'
                        ? r.sy - ev.clientY
                        : ev.clientY - r.sy
                    const next = Math.max(MIN_DOCK, Math.min(MAX_DOCK, r.sSize + delta))
                    setAiDockSizeByTab((prev) => ({ ...prev, [tid]: next }))
                  }
                  const onUp = () => {
                    aiDockResizeRef.current = null
                    window.removeEventListener('mousemove', onMove)
                    window.removeEventListener('mouseup', onUp)
                    // Restore normal interaction / cursor.
                    document.body.classList.remove('resizing-h', 'resizing-v', 'resizing-dock')
                    document.body.style.userSelect = ''
                    if (ws) ws.classList.remove('dock-resizing')
                    try {
                      getCurrentWindow().setResizable(true)
                    } catch {
                      /* ignore */
                    }
                  }
                  // While dragging, block the terminal (xterm) and chat from
                  // receiving the mouse so the drag resizes the panes instead of
                  // scrolling/selecting content inside them.
                  document.body.classList.add(isVertical ? 'resizing-v' : 'resizing-h', 'resizing-dock')
                  document.body.style.userSelect = 'none'
                  if (ws) ws.classList.add('dock-resizing')
                  window.addEventListener('mousemove', onMove)
                  window.addEventListener('mouseup', onUp)
                  try {
                    getCurrentWindow().setResizable(false)
                  } catch {
                    /* ignore — internal resize must still work even if window lock fails */
                  }
                }
                // For vertical docks the handle is horizontal (top/bottom edge);
                // for horizontal docks it is vertical (left/right edge).
                const resizeHandleStyle: React.CSSProperties = isVertical
                  ? {
                      position: 'absolute',
                      left: 0,
                      right: 0,
                      // Sit entirely in the gap between panes so it never overlaps
                      // the chat's top/bottom edge (which would occlude content).
                      [side === 'top' ? 'bottom' : 'top']: -6,
                      height: 6,
                      cursor: 'ns-resize',
                      zIndex: 5,
                    }
                  : {
                      position: 'absolute',
                      top: 0,
                      bottom: 0,
                      [side === 'left' ? 'right' : 'left']: -6,
                      width: 6,
                      cursor: 'ew-resize',
                      zIndex: 5,
                    }
                // Clear, grouped side buttons: docking position + pop-out/close.
                const sideTitle: Record<'left' | 'top' | 'right' | 'bottom', string> = {
                  left: t('aiChatDockLeft'),
                  top: t('aiChatDockTop'),
                  right: t('aiChatDockRight'),
                  bottom: t('aiChatDockBottom'),
                }
                const sideBtn = (s: 'left' | 'top' | 'right' | 'bottom', icon: 'panelLeft' | 'panelTop' | 'panelRight' | 'panelBottom') => (
                  <button
                    key={s}
                    className={'ai-dock-side-btn' + (side === s ? ' active' : '')}
                    onClick={() => setDockSide(s)}
                    title={sideTitle[s]}
                  >
                    <Icon name={icon} size={12} />
                  </button>
                )
                return (
                  <div className="ai-dock-pane" style={{ ...dockStyle, position: 'relative' }}>
                    <div className="ai-dock-bar" style={{ position: 'relative', zIndex: 6 }}>
                      <span className="ai-dock-bar-title">{t('aiChatTitle')}</span>
                      <div className="ai-dock-sides">
                        {sideBtn('left', 'panelLeft')}
                        {sideBtn('top', 'panelTop')}
                        {sideBtn('right', 'panelRight')}
                        {sideBtn('bottom', 'panelBottom')}
                      </div>
                      <button
                        className="ai-dock-bar-btn"
                        onClick={() => setAiFloatingTabId(tid)}
                        title={t('aiChatPopOut')}
                      >
                        ⤢
                      </button>
                      <button
                        className="ai-dock-bar-btn"
                        onClick={() =>
                          setShowAiByTab((prev) => ({ ...prev, [tid]: false }))
                        }
                        title={t('aiChatClose')}
                      >
                        ×
                      </button>
                    </div>
                    <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                      <AiChatPanel
                        tabId={tid}
                        config={activeProfile}
                        profiles={aiConfig?.profiles ?? []}
                        onSelectProfile={handleSelectAiProfile}
                        onSelectModel={handleSelectAiModel}
                        conv={getAiConv(tid)}
                        setConv={(u) => setAiConv(tid, u)}
                        floating={false}
                        onToggleFloat={() => setAiFloatingTabId(tid)}
                        onClose={() => setShowAiByTab((prev) => ({ ...prev, [tid]: false }))}
                        initialContext={aiContextText}
                        onContextConsumed={() => setAiContextText(null)}
                        inputHeight={aiInputHeight > 0 ? aiInputHeight : undefined}
                        onInputHeightChange={handleAiInputHeightChange}
                        onOpenSettings={handleOpenAiSettings}
                      />
                    </div>
                    <div className="ai-dock-resize" onMouseDown={startDockResize} style={resizeHandleStyle} />
                  </div>
                )
              })()
            )}
          {/* File editor replaces the terminal surface of the focused pane
              (the pane header with the AI button and file tabs stays). Only the
              current session's files are shown. Skipped when the overlay is
              popped out to a floating window — it renders only there. */}
          {isFocused &&
            sv !== 'terminal' &&
            sessionEditorTabs.length > 0 &&
            sessionEditorTabs.some((et) => et.key === sv) &&
            !isOverlayFloated(sv) && (
            <div style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              <FileEditor
                key="file-editor"
                tabs={sessionEditorTabs}
                activeKey={sessionActiveEditorKey && sessionEditorTabs.some((et) => et.key === sessionActiveEditorKey) ? sessionActiveEditorKey : sv}
                onSelect={(key) => {
                  if (leaf.tabId != null) {
                    setActiveEditorKeyFor(leaf.tabId, key)
                    setShellViewFor(leaf.tabId, key)
                  }
                }}
                onClose={closeEditorTab}
                onContentChange={handleEditorContentChange}
                onSave={handleSaveEditorTab}
                onChangeLanguage={changeEditorTabLanguage}
                onChangeEncoding={changeEditorTabEncoding}
                onChangeLineEnding={changeEditorTabLineEnding}
                hideTabs
              />
            </div>
          )}
          {/* Docker log view replaces the terminal surface of the focused pane
              (like an open file). Skipped when floated — renders only in the
              floating window. */}
          {isFocused && sessionDockerLogTabs.some((dt) => sv === `dockerlog:${dt.tabId}`) && (() => {
            const dl = sessionDockerLogTabs.find((dt) => sv === `dockerlog:${dt.tabId}`)
            if (!dl || isOverlayFloated(dl.tabId)) return null
            return (
            <div style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              <DockerLogViewer
                tabId={dl.tabId}
                jumpTabId={dl.jumpTabId!}
                containerName={dl.containerName!}
                containerImage={dl.containerImage}
                defaultWordWrap={dockerWordWrap}
                defaultFollow={dockerFollow}
                maxLines={dockerMaxLines}
                onAskAi={(text) => handleOpenAiChat(text)}
              />
            </div>
            )
          })()}
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
    .filter(
      (t) =>
        t.tabType === 'terminal' ||
        t.tabType === 'localShell' ||
        (t.tabType === 'settings' && settingsActive),
    )
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
  const rootTabs = tabs.filter(
    (t) => (t.tabType === 'terminal' || t.tabType === 'localShell') && !t.embedded,
  )

  const terminalContent = (
    <div className="terminal-wrapper">
      <div className="terminal-split-root" style={{ position: 'relative' }}>
        {rootTabs.map((root) => {
          const tree = splitTrees[root.tabId] ?? makeLeaf(`leaf-${root.tabId}`, root.tabId)
          const workspaceHidden = settingsActive || aiChatActive || root.tabId !== activeTabId
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

          {/* Floating (pop-out) panes: draggable overlays rendered inside the
              same window. Each mirrors a pane currently removed from the split
              tree; closing one restores the pane to its original spot. */}
          {floatingItems.map((item) => (
            <FloatingWindow
              key={item.floatId}
              item={item}
              t={t}
              onClose={() => closeFloating(item.floatId)}
              onFocus={() => bringFloatingToFront(item.floatId)}
              onMove={(x, y) => moveFloating(item.floatId, x, y)}
              onResize={(w, h) => resizeFloating(item.floatId, w, h)}
            >
              {renderFloatingContent(item)}
            </FloatingWindow>
          ))}
        <div
          ref={settingsOverlayRef}
          className="settings-overlay"
          style={{
            position: 'absolute',
            inset: 0,
            overflow: 'auto',
            display: (settingsActive || aiChatActive) ? 'block' : 'none',
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
              localTerminals={localTerminals}
              onOpenLocalTerminal={(entry) => handleOpenLocalTerminal(entry.cwd, entry.shell)}
              onOpenLocalSplit={(entry, direction) => handleOpenLocalSplit(entry.cwd, entry.shell, direction)}
              onLocalTerminalsChanged={reloadLocalTerminals}
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
              collapsedGroups={collapsedGroups}
              onCollapsedGroupsChange={handleCollapsedGroupsChange}
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
                {(() => {
                  // Server label shown in the file panel header: the SSH
                  // connection of the focused tab (host:port), or a docker
                  // target's container.
                  const ftabId = focusedLeafTabId ?? activeTabId ?? 0
                  const ftab = tabs.find((t) => t.tabId === ftabId)
                  const fconn = ftab?.connectionId
                    ? connections.find((c) => c.id === ftab.connectionId)
                    : undefined
                  // When the connection name equals the host (a common case),
                  // drop the redundant name and show only host:port.
                  const hostLabel = fconn
                    ? fconn.name === fconn.host
                      ? `${fconn.host}:${fconn.port}`
                      : `${fconn.name} (${fconn.host}:${fconn.port})`
                    : ftab?.connectionName ?? undefined
                  // Docker targets: show BOTH the host machine and the container
                  // name (e.g. "prod (10.0.0.5:22) → docker:nginx"). Other
                  // non-session targets (jump) use their own targetLabel.
                  const serverLabel = fileTarget
                    ? fileTarget.kind === 'docker'
                      ? hostLabel
                        ? `${hostLabel} → docker:${fileTarget.container}`
                        : `docker:${fileTarget.container}`
                      : undefined
                    : hostLabel
                  return <FilePanel
                  key={fileTarget ? JSON.stringify(fileTarget) : 'session'}
                  ref={fileTreeRef}
                  tabId={ftabId}
                  isConnected={true}
                  serverLabel={serverLabel}
                  defaultPath={
                    fileTarget?.kind === 'docker'
                      ? '/'
                      : fileTarget?.kind === 'local'
                        ? tabs.find((t) => t.tabId === fileTarget.tabId)?.localShellCwd ?? '/'
                        : '.'
                  }
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
                })()}
            </div>

            {dockerExpanded && layout.sidebar.sections.docker.visible && (
              <div className="panel-divider-h" onMouseDown={handleDockerDividerMouseDown} />
            )}

            {/* Docker containers on the focused host — follows the focused
                shell so splitting / switching panes swaps the container list. */}
            {layout.sidebar.sections.docker.visible && (focusedLeafTabId ?? activeTabId) != null && (
              <div
                className="collapsible-section"
                style={dockerExpanded ? { flexShrink: 0, height: dockerHeight, overflow: 'hidden' } : { flexShrink: 0 }}
              >
                <DockerPanel
                  jumpTabId={focusedLeafTabId ?? activeTabId ?? 0}
                  serverLabel={
                    (() => {
                      const dtId = focusedLeafTabId ?? activeTabId ?? 0
                      const dt = tabs.find((t) => t.tabId === dtId)
                      const dc = dt?.connectionId
                        ? connections.find((c) => c.id === dt.connectionId)
                        : undefined
                      return dc
                        ? dc.name === dc.host
                          ? `${dc.host}:${dc.port}`
                          : `${dc.name} (${dc.host}:${dc.port})`
                        : dt?.connectionName
                    })()
                  }
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
                  onViewLogs={handleViewContainerLogs}
                  onRestartContainer={handleRestartContainer}
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
      <Titlebar onSettings={handleOpenSettings} onAiChat={() => handleOpenAiChat()} />

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
              ref={tabContextMenuRef}
              className="tab-context-menu"
              style={{ left: tabContextMenu.x, top: tabContextMenu.y }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="context-menu-item" onClick={() => duplicateTab(tabContextMenu.tab)}>
                Duplicate Tab
              </div>
            </div>
          )}

          {/* Shell pane. The view tab bar (Terminal + open files) sits at the
              top; the content area below it shows EITHER the terminal split
              tree OR the file editor. `terminalContent` stays mounted in the
              same DOM position regardless of the active view so opening a file
              never remounts the TerminalComponent (which would trigger a fresh
              connect() and lose focus). */}
          <div className="shell-pane" style={{ flex: 1, minHeight: 0 }}>
            <div className="shell-pane-body" style={{ display: 'flex', flex: 1, minHeight: 0, flexDirection: 'row' }}>
              <div style={{ display: aiChatActive ? 'none' : 'flex', flex: 1, minHeight: 0, flexDirection: 'column' }}>
                {terminalContent}
              </div>
              {/* Standalone AI Chat tab (full screen) */}
              {activeProfile && aiChatActive && activeTerminalTab && (
                <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                  <AiChatPanel
                    tabId={activeTerminalTab.tabId}
                    config={activeProfile}
                    profiles={aiConfig?.profiles ?? []}
                    onSelectProfile={handleSelectAiProfile}
                    onSelectModel={handleSelectAiModel}
                    conv={getAiConv(activeTerminalTab.tabId)}
                    setConv={(u) => setAiConv(activeTerminalTab.tabId, u)}
                    floating={false}
                    onToggleFloat={() => setAiFloatingTabId(activeTerminalTab.tabId)}
                    onClose={() => closeTab(activeTerminalTab.tabId)}
                    initialContext={aiContextText}
                    onContextConsumed={() => setAiContextText(null)}
                    inputHeight={aiInputHeight > 0 ? aiInputHeight : undefined}
                    onInputHeightChange={handleAiInputHeightChange}
                    onOpenSettings={handleOpenAiSettings}
                  />
                </div>
              )}
            </div>
          </div>

          </div>

          {/* Floating AI chat panel (popped out from a shell tab) */}
          {aiFloatingTabId !== null && activeProfile && (
            (() => {
              const MIN_W = 280
              const MIN_H = 240
              const startResize = (e: React.MouseEvent, dir: string) => {
                e.preventDefault()
                e.stopPropagation()
                aiFloatResizeRef.current = {
                  dir,
                  sx: e.clientX,
                  sy: e.clientY,
                  sw: aiFloatSize.w,
                  sh: aiFloatSize.h,
                }
                const onMove = (ev: MouseEvent) => {
                  const r = aiFloatResizeRef.current
                  if (!r) return
                  let { w, h } = { w: r.sw, h: r.sh }
                  let { x, y } = aiFloatPos
                  const dx = ev.clientX - r.sx
                  const dy = ev.clientY - r.sy
                  if (r.dir.includes('e')) w = Math.max(MIN_W, r.sw + dx)
                  if (r.dir.includes('s')) h = Math.max(MIN_H, r.sh + dy)
                  if (r.dir.includes('w')) {
                    w = Math.max(MIN_W, r.sw - dx)
                    x = aiFloatPos.x - (w - r.sw)
                  }
                  if (r.dir.includes('n')) {
                    h = Math.max(MIN_H, r.sh - dy)
                    y = aiFloatPos.y - (h - r.sh)
                  }
                  setAiFloatSize({ w, h })
                  setAiFloatPos({ x, y })
                }
                const onUp = () => {
                  aiFloatResizeRef.current = null
                  window.removeEventListener('mousemove', onMove)
                  window.removeEventListener('mouseup', onUp)
                }
                window.addEventListener('mousemove', onMove)
                window.addEventListener('mouseup', onUp)
              }
              const resizeHandles: { dir: string; style: React.CSSProperties; cursor: string }[] = [
                { dir: 'n', style: { top: -3, left: 8, right: 8, height: 6 }, cursor: 'ns-resize' },
                { dir: 's', style: { bottom: -3, left: 8, right: 8, height: 6 }, cursor: 'ns-resize' },
                { dir: 'w', style: { left: -3, top: 8, bottom: 8, width: 6 }, cursor: 'ew-resize' },
                { dir: 'e', style: { right: -3, top: 8, bottom: 8, width: 6 }, cursor: 'ew-resize' },
                { dir: 'nw', style: { top: -3, left: -3, width: 10, height: 10 }, cursor: 'nwse-resize' },
                { dir: 'ne', style: { top: -3, right: -3, width: 10, height: 10 }, cursor: 'nesw-resize' },
                { dir: 'sw', style: { bottom: -3, left: -3, width: 10, height: 10 }, cursor: 'nesw-resize' },
                { dir: 'se', style: { bottom: -3, right: -3, width: 10, height: 10 }, cursor: 'nwse-resize' },
              ]
              return (
                <div
                  className="ai-floating-panel"
                  style={{
                    position: 'fixed',
                    left: aiFloatPos.x,
                    top: aiFloatPos.y,
                    width: aiFloatSize.w,
                    height: aiFloatSize.h,
                    zIndex: 1000,
                    display: 'flex',
                    flexDirection: 'column',
                    boxShadow: '0 8px 30px rgba(0,0,0,0.5)',
                    borderRadius: 8,
                    overflow: 'hidden',
                    background: 'var(--bg-secondary, #1e1e1e)',
                    border: '1px solid var(--border, #333)',
                  }}
                >
                  <div
                    className="ai-floating-header"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '6px 10px',
                      cursor: 'move',
                      background: 'var(--bg-tertiary, #252526)',
                      borderBottom: '1px solid var(--border, #333)',
                      userSelect: 'none',
                    }}
                    onMouseDown={(e) => {
                      aiFloatDragRef.current = { dx: e.clientX - aiFloatPos.x, dy: e.clientY - aiFloatPos.y }
                      const onMove = (ev: MouseEvent) => {
                        setAiFloatPos({ x: ev.clientX - (aiFloatDragRef.current?.dx ?? 0), y: ev.clientY - (aiFloatDragRef.current?.dy ?? 0) })
                      }
                      const onUp = () => {
                        aiFloatDragRef.current = null
                        window.removeEventListener('mousemove', onMove)
                        window.removeEventListener('mouseup', onUp)
                      }
                      window.addEventListener('mousemove', onMove)
                      window.addEventListener('mouseup', onUp)
                    }}
                  >
                    <span style={{ fontSize: 12, color: 'var(--text-secondary, #aaa)' }}>
                      AI Chat · {tabs.find((t) => t.tabId === aiFloatingTabId)?.connectionName || 'Shell'}
                    </span>
                    <button
                      className="ai-float-header-btn"
                      onClick={() => setAiFloatingTabId(null)}
                      title="Dock back"
                    >
                      ⤡ Dock
                    </button>
                  </div>
                  <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                    <AiChatPanel
                      tabId={aiFloatingTabId}
                      config={activeProfile}
                      profiles={aiConfig?.profiles ?? []}
                      onSelectProfile={handleSelectAiProfile}
                      onSelectModel={handleSelectAiModel}
                      conv={getAiConv(aiFloatingTabId)}
                      setConv={(u) => setAiConv(aiFloatingTabId, u)}
                      floating
                      onToggleFloat={() => setAiFloatingTabId(null)}
                      onClose={() => {
                        setShowAiByTab((prev) => ({ ...prev, [aiFloatingTabId]: false }))
                        setAiFloatingTabId(null)
                      }}
                      initialContext={aiContextText}
                      onContextConsumed={() => setAiContextText(null)}
                      inputHeight={aiInputHeight}
                      onInputHeightChange={handleAiInputHeightChange}
                      onOpenSettings={handleOpenAiSettings}
                    />
                  </div>
                  {resizeHandles.map((h) => (
                    <div
                      key={h.dir}
                      onMouseDown={(e) => startResize(e, h.dir)}
                      style={{
                        position: 'absolute',
                        ...h.style,
                        cursor: h.cursor,
                        zIndex: 1001,
                      }}
                    />
                  ))}
                </div>
              )
            })()
          )}

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
              return <span className="status-text">{t('noActiveConnection')}</span>
            }
            if (activeTab.tabType === 'settings') {
              return <span className="status-text">⚙ {t('tabSettings')}</span>
            }
            if (activeTab.tabType === 'aiChat') {
              return <span className="status-text">🤖 {t('tabAiChat')}</span>
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
                v{updateInfo.version} {t('updateAvailable')}
              </span>
              <button className="update-btn" onClick={handleDownloadUpdate} disabled={updateState !== 'idle'}>
                {updateState === 'downloading' ? t('downloading') : updateState === 'installing' ? t('installing') : t('update')}
              </button>
              <span className="update-close" onClick={() => setShowUpdateBanner(false)}>✕</span>
            </div>
          )}
          <span className="status-text">Wrolp Terminal</span>
        </div>
      </div>
      */}

      {toast && (
        <div
          className={`toast toast-${toast.kind}`}
          onClick={() => setToast(null)}
          title={t('close')}
        >
          {toast.kind === 'progress' ? (
            <span className="toast-spinner" />
          ) : (
            <span className="toast-icon">{toast.kind === 'success' ? '✓' : '✕'}</span>
          )}
          <span className="toast-text">{toast.text}</span>
          <span
            className="toast-close"
            onClick={(e) => {
              e.stopPropagation()
              setToast(null)
            }}
          >
            ✕
          </span>
        </div>
      )}


    </div>
  )
}

import React, {
  useState,
  useEffect,
  useCallback,
  useRef,
  useLayoutEffect,
  useImperativeHandle,
  useMemo,
  forwardRef,
  type ReactNode,
} from 'react'
import { listen } from '@tauri-apps/api/event'
import type { FileEntry, TargetRef, FileTargetMode, ContainerInfo } from '../types'
import { targetLabel } from '../types'
import {
  fsListFiles,
  fsUploadFile,
  fsUploadFileStream,
  getClipboardFiles,
  listLocalDrives,
  fsDownloadFile,
  fsDownloadDirectory,
  fsDeleteFile,
  fsCreateDirectory,
  fsRenameFile,
  fsWriteFileContent,
  pauseTransfer,
  resumeTransfer,
  cancelTransfer,
  switchSftpUser,
  revertSftpUser,
  getSftpUser,
  sendInput,
  pollWorkingDir,
  listDockerContainers,
} from '../commands'
import { open, save } from '@tauri-apps/plugin-dialog'
import { useCustomScrollbar } from '../hooks/useCustomScrollbar'
import { Icon } from './Icon'
import { useI18n } from '../i18n'

/** How many file transfers run at once for a multi-file upload batch. */
const UPLOAD_CONCURRENCY = 4

/**
 * Run `worker` over `items` with at most `limit` tasks in flight at once.
 * Workers pull from a shared index, so a slow file doesn't stall the batch.
 */
async function runConcurrent<T>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return
  let next = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      await worker(items[i], i)
    }
  })
  await Promise.all(runners)
}

/* ---------- types ---------- */

interface TransferProgress {
  tabId: number
  op: 'upload' | 'download' | 'directory' | 'delete'
  filename: string
  transferred: number
  total: number
  elapsed: number
  /** Directory downloads: the base directory name (row key), the current
      file's path relative to it, and aggregate counters. */
  dirName?: string
  relativePath?: string
  doneFiles?: number
  totalFiles?: number
  doneBytes?: number
  totalBytes?: number
}

/** One row in the multi-file transfer progress list. */
interface TransferRow {
  /** Stable unique key: op + full path (local path for upload, remote path for download). */
  key: string
  filename: string
  op: 'upload' | 'download' | 'directory' | 'delete'
  status: 'queued' | 'active' | 'done' | 'error' | 'cancelled'
  transferred: number
  total: number
  speed: string
}

interface TreeNode {
  name: string
  path: string
  isDir: boolean
  size: number
  mode: string
  modified: string
  expanded: boolean
  loaded: boolean
  loading: boolean
  children?: TreeNode[]
}

interface FilePanelProps {
  tabId: number
  isConnected: boolean
  defaultPath?: string
  expanded?: boolean
  onToggleExpanded?: () => void
  syncEnabled?: boolean
  onToggleSync?: () => void
  /**
   * Called when the user sets the current browsed directory as the SSH
   * connection's startup directory (main session target only). Receives the
   * normalized absolute path ('.' means home).
   */
  onSetStartupDir?: (dir: string) => void
  onEditFile?: (target: TargetRef, path: string) => void
  /** Label of the currently connected server (host:port), shown in the header. */
  serverLabel?: string
  /**
   * Which remote filesystem this panel operates on. Defaults to the tab's main
   * session (`{ kind: 'session', tabId }`). Non-session targets disable
   * session-only features (shell sync, SFTP user switch, transfer pause).
   */
  targetRef?: TargetRef
  /**
   * Active filesystem mode for the switcher (`ssh` = local session,
   * `jump` = ProxyJump remote, `docker` = container). When `jump`/`docker` is
   * selected but no matching `targetRef` is set, the panel shows a picker/form.
   */
  fileMode?: FileTargetMode
  onFileModeChange?: (mode: FileTargetMode) => void
  /** Set the active filesystem target (e.g. a selected container or jump host). */
  onSelectTarget?: (target: TargetRef | null) => void
}

export interface FileTreeHandle {
  refresh: () => void
}

/* ---------- helpers ---------- */

function getParentDir(p: string): string {
  const trimmed = p.replace(/\/+$/, '')
  // Windows drive root like "C:" or "C:/" has no parent — return itself.
  if (/^[A-Za-z]:$/.test(trimmed)) return trimmed + '/'
  const i = trimmed.lastIndexOf('/')
  if (i <= 0) return '/'
  return trimmed.slice(0, i + 1)
}

function join(p: string, name: string): string {
  const base = p.endsWith('/') ? p : p + '/'
  return base + name
}

// Whether `path` is the root itself or a descendant of `root`.
// A root of '.' (home) or '/' is treated as unrestricted.
function isWithinRoot(path: string, root: string): boolean {
  if (root === '.' || root === '/') return true
  const r = root.endsWith('/') ? root : root + '/'
  const p = path.endsWith('/') && path !== '/' ? path.slice(0, -1) + '/' : path + '/'
  return p === r || p.startsWith(r)
}

// Normalize: drop a single trailing slash (keep '/' itself and drive roots
// like "C:/" — "C:" alone is not an absolute path on Windows).
function normalizePath(p: string): string {
  if (p === '/' || p === '.') return p
  if (/^[A-Za-z]:\/$/.test(p)) return p
  return p.endsWith('/') ? p.slice(0, -1) : p
}

function toNode(e: FileEntry): TreeNode {
  return {
    name: e.name,
    path: e.path,
    isDir: e.isDir,
    size: e.size,
    mode: e.mode,
    modified: e.modified,
    expanded: false,
    loaded: false,
    loading: false,
  }
}

function updateNode(
  nodes: TreeNode[],
  path: string,
  updater: (n: TreeNode) => TreeNode,
): TreeNode[] {
  return nodes.map((n) => {
    if (n.path === path) return updater(n)
    if (n.children) return { ...n, children: updateNode(n.children, path, updater) }
    return n
  })
}

const formatSize = (bytes: number): string => {
  if (bytes === 0) return '-'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let size = bytes
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024
    i++
  }
  return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

const formatSpeed = (bytesPerSec: number): string => {
  if (bytesPerSec < 1024) return `${bytesPerSec.toFixed(0)} B/s`
  if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`
  return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`
}

/* ---------- component ---------- */

// Per-target browse state, kept at module scope (NOT inside the component):
// the Files panel is unmounted whenever the focused tab isn't connected
// (App.tsx `showFilePanel = filesTab?.status === 'connected'`), so a component-
// level ref would be wiped on every tab switch and the directory the user left
// would be lost. Module-level persistence survives remounts.
const filePanelBrowseCache: Record<
  string,
  { currentPath: string; rootPath: string }
> = {}

export const FilePanel = forwardRef<FileTreeHandle, FilePanelProps>(function FilePanel(
  {
    tabId,
    isConnected,
    defaultPath = '.',
    expanded = true,
    onToggleExpanded,
    syncEnabled = false,
    onToggleSync,
    onSetStartupDir,
    onEditFile,
    targetRef,
    fileMode = 'ssh',
    onFileModeChange,
    onSelectTarget,
    serverLabel,
  },
  ref,
) {
  const { t } = useI18n()
  // The remote filesystem this panel operates on (defaults to the tab session).
  // Memoized by its serialized form so callbacks/effects get a stable identity.
  const targetKey = JSON.stringify(targetRef ?? { kind: 'session' as const, tabId })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const target: TargetRef = useMemo(() => JSON.parse(targetKey) as TargetRef, [targetKey])
  // Session-only tab id (null for jump/docker targets) — gates shell sync, SFTP
  // user switching and transfer pause, which only apply to the main connection.
  const sessionTabId = target.kind === 'session' ? target.tabId : null

  // Jump (ProxyJump remote) connection form state. Shown when the `jump` mode is
  // active but no jump target has been selected yet.
  const [jumpHost, setJumpHost] = useState('')
  const [jumpPort, setJumpPort] = useState(22)
  const [jumpUser, setJumpUser] = useState('')
  const [jumpAuthType, setJumpAuthType] = useState<'password' | 'key'>('password')
  const [jumpPassword, setJumpPassword] = useState('')
  const [jumpKeyPath, setJumpKeyPath] = useState('')
  const [jumpPassphrase, setJumpPassphrase] = useState('')
  const [jumpConnecting, setJumpConnecting] = useState(false)
  const [jumpError, setJumpError] = useState('')

  // Docker container picker state. Shown when the `docker` mode is active but no
  // container has been selected yet.
  const [dockerContainers, setDockerContainers] = useState<ContainerInfo[]>([])
  const [dockerLoading, setDockerLoading] = useState(false)
  const [dockerError, setDockerError] = useState('')

  const loadDockerContainers = useCallback(async () => {
    setDockerLoading(true)
    setDockerError('')
    try {
      setDockerContainers(await listDockerContainers(tabId))
    } catch (e) {
      setDockerError(String(e))
      setDockerContainers([])
    } finally {
      setDockerLoading(false)
    }
  }, [tabId])

  // Decide what the body should render given the active mode and current target.
  const showJumpForm =
    fileMode === 'jump' && target.kind !== 'jumpRemote' && target.kind !== 'dockerSsh'
  const showDockerPicker = fileMode === 'docker' && target.kind !== 'docker'
  const showTree = !showJumpForm && !showDockerPicker

  const handleModeClick = (mode: FileTargetMode) => {
    if (mode === fileMode) {
      // Clicking the active mode clears the current target, returning to the
      // picker/form so a different remote/container can be chosen.
      onSelectTarget?.(null)
    } else {
      if (mode === 'docker') loadDockerContainers()
      // Switching to SSH always shows the local session, so drop any non-session
      // target that may still be set.
      if (mode === 'ssh') onSelectTarget?.(null)
      onFileModeChange?.(mode)
    }
  }

  const handleConnectJump = () => {
    if (!jumpHost.trim() || !jumpUser.trim()) {
      setJumpError('Host and username are required')
      return
    }
    const auth = {
      username: jumpUser.trim(),
      password: jumpAuthType === 'password' ? jumpPassword : undefined,
      keyPath: jumpAuthType === 'key' ? jumpKeyPath.trim() : undefined,
      passphrase: jumpAuthType === 'key' ? jumpPassphrase : undefined,
    }
    setJumpConnecting(false)
    setJumpError('')
    onSelectTarget?.({
      kind: 'jumpRemote',
      jumpTabId: tabId,
      host: jumpHost.trim(),
      port: Number(jumpPort) || 22,
      auth,
    })
  }

  const handlePickContainer = (c: ContainerInfo) => {
    onSelectTarget?.({ kind: 'docker', jumpTabId: tabId, container: c.name })
  }

  const [currentPath, setCurrentPath] = useState(defaultPath)
  const [rootPath, setRootPath] = useState(defaultPath)
  const [tree, setTree] = useState<TreeNode[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  // Guards the browse-state write against target switches: on the render right
  // after `targetKey` changes, `currentPath` is still the PREVIOUS target's
  // value (the reset effect below sets it later), so writing it would corrupt
  // the new target's cached path. We remember the last target and skip that
  // one write; the follow-up render (after the reset applied) persists correctly.
  const lastTargetKeyRef = useRef(targetKey)
  // Local drive letters (Windows) offered by the location dropdown, plus the
  // current selection of that dropdown (reset after each jump).
  const [drives, setDrives] = useState<string[]>([])
  const [jumpOpen, setJumpOpen] = useState(false)
  const [jumpPos, setJumpPos] = useState<{ x: number; y: number } | null>(null)
  const jumpBtnRef = useRef<HTMLButtonElement>(null)
  const [selPaths, setSelPaths] = useState<Set<string>>(new Set())
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    node: TreeNode | null
  } | null>(null)
  // Custom rename / delete dialogs (replaces the native browser prompt/confirm
  // which looks out of place in the WebView and can be blocked).
  const [renameTarget, setRenameTarget] = useState<TreeNode | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<TreeNode | null>(null)
  const [paused, setPaused] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  // Directory row currently under a dragged item (highlight + drop target).
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null)
  // Per-file transfer rows shown in the bottom progress panel. Both upload and
  // download batches populate this list so the user sees one row per file
  // (filename + progress bar + speed) instead of a single shared progress bar.
  const [transferRows, setTransferRows] = useState<TransferRow[]>([])
  // Keys of rows the user cancelled. The sequential transfer loops consult it
  // to skip cancelled queued files and to mark an aborted in-flight file as
  // 'cancelled' instead of 'error'.
  const cancelledKeysRef = useRef<Set<string>>(new Set())
  // Height of the transfer list panel; user can drag the handle on its top edge.
  const [transfersPanelHeight, setTransfersPanelHeight] = useState(140)
  const panelRef = useRef<HTMLDivElement>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const [contextMenuStyle, setContextMenuStyle] = useState<React.CSSProperties>({})
  const [sftpUser, setSftpUser] = useState<string | null>(null)
  const [showSwitchUser, setShowSwitchUser] = useState(false)
  const [switchUsername, setSwitchUsername] = useState('')
  const [switchPassword, setSwitchPassword] = useState('')
  const [editingPath, setEditingPath] = useState(false)
  const [editPathValue, setEditPathValue] = useState('')

  /* ---- sync ---- */
  const syncRef = useRef(syncEnabled)
  syncRef.current = syncEnabled
  const rootPathRef = useRef(rootPath)
  rootPathRef.current = rootPath
  const lastPolledPath = useRef<string | null>(null)

  const cdToTerminal = useCallback(
    async (path: string) => {
      if (!syncRef.current || sessionTabId == null) return
      const cmd = path === '.' ? 'cd\n' : `cd "${path}"\n`
      try {
        await sendInput(sessionTabId, cmd)
      } catch {
        /* ignore */
      }
    },
    [sessionTabId],
  )

  /* ---- tree load ---- */
  const loadRootDir = useCallback(
    async (path: string, sendCd = false): Promise<boolean> => {
      setLoading(true)
      setError('')
      try {
        const result = await fsListFiles(target, path)
        setTree(result.map(toNode))
        setCurrentPath(path)
        if (sendCd) cdToTerminal(path)
        return true
      } catch (e) {
        setError(String(e))
        return false
      } finally {
        setLoading(false)
      }
    },
    [target, cdToTerminal],
  )

  // Refresh: re-load root + re-load any previously expanded directories
  const refresh = useCallback(async () => {
    setLoading(true)
    setError('')
    const reloadDir = async (
      path: string,
      prevMap?: Map<string, TreeNode>,
    ): Promise<TreeNode[]> => {
      const result = await fsListFiles(target, path)
      const nodes: TreeNode[] = result.map(toNode)
      if (prevMap) {
        for (const n of nodes) {
          const old = prevMap.get(n.path)
          // Only re-expand directories the user had expanded; keep collapsed
          // ones collapsed (and don't re-load their children).
          if (old && old.isDir && old.expanded && old.loaded) {
            n.expanded = true
            n.loaded = true
            const childMap = new Map<string, TreeNode>()
            for (const c of old.children ?? []) childMap.set(c.path, c)
            n.children = await reloadDir(n.path, childMap)
          }
        }
      }
      return nodes
    }
    try {
      const prevMap = new Map<string, TreeNode>()
      for (const n of tree) prevMap.set(n.path, n)
      const newTree = await reloadDir(currentPath, prevMap)
      setTree(newTree)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [target, currentPath, tree])

  useImperativeHandle(ref, () => ({ refresh }), [refresh])

  // Load the local drive list once for the location dropdown (Windows only;
  // returns empty on other platforms).
  useEffect(() => {
    let active = true
    listLocalDrives()
      .then((d) => {
        if (active) setDrives(d)
      })
      .catch(() => {
        if (active) setDrives([])
      })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    if (isConnected) {
      // Restore the directory the user left when they last browsed this
      // filesystem (targetKey), so switching to another terminal and back does
      // not reset the file list to home. A fresh/unvisited target falls back to
      // the target's home directory.
      const cached = filePanelBrowseCache[targetKey]
      const startPath = cached ? cached.currentPath : defaultPath
      const startRoot = cached ? cached.rootPath : defaultPath
      setCurrentPath(startPath)
      setRootPath(startRoot)
      // Non-session targets (jump/docker) can be addressed through a freshly
      // opened SSH session whose handle is not ready yet; retry the first list
      // until it succeeds so the panel fills in instead of showing an error.
      let cancelled = false
      let attempt = 0
      let timer: ReturnType<typeof setTimeout> | undefined
      const attemptLoad = async () => {
        if (cancelled) return
        const ok = await loadRootDir(startPath)
        if (cancelled) return
        if (!ok && attempt < 30) {
          attempt++
          timer = setTimeout(attemptLoad, 250)
        }
      }
      attemptLoad()
      if (sessionTabId != null) {
        getSftpUser(sessionTabId)
          .then(setSftpUser)
          .catch(() => {})
      }
      return () => {
        cancelled = true
        if (timer) clearTimeout(timer)
      }
    }
  }, [isConnected, sessionTabId, targetKey, defaultPath])

  // Persist the browse state per target so switching back restores it. Runs
  // whenever the user navigates (currentPath/rootPath change). On the render
  // right after a target switch, currentPath is still the PREVIOUS target's
  // value — skip that write (guard below) so the new target's cached path is
  // never seeded with a stale path from the old target.
  useEffect(() => {
    if (!isConnected) return
    if (lastTargetKeyRef.current !== targetKey) {
      lastTargetKeyRef.current = targetKey
      return
    }
    filePanelBrowseCache[targetKey] = { currentPath, rootPath }
  }, [isConnected, currentPath, rootPath, targetKey])

  // Shell → FilePanel sync (main session only)
  useEffect(() => {
    if (!syncEnabled || !isConnected || sessionTabId == null) return
    let active = true
    const poll = async () => {
      if (!active) return
      try {
        const remotePath = await pollWorkingDir(sessionTabId)
        if (!active || !remotePath) return
        if (remotePath !== lastPolledPath.current) {
          lastPolledPath.current = remotePath
          if (rootPathRef.current === '.' || isWithinRoot(remotePath, rootPathRef.current)) {
            loadRootDir(remotePath, false)
          }
        }
      } catch {
        /* ignore */
      }
    }
    poll()
    const interval = setInterval(poll, 5000)
    return () => {
      active = false
      clearInterval(interval)
    }
  }, [syncEnabled, isConnected, sessionTabId, loadRootDir])

  // Transfer progress events (main session only). Each event carries the
  // filename, so we can route it to the matching per-file row in the list.
  useEffect(() => {
    if (sessionTabId == null) return
    const unlisten = listen<TransferProgress>('transfer-progress', (event) => {
      const p = event.payload
      if (p.tabId !== sessionTabId) return
      const elapsed = p.elapsed > 0 ? p.elapsed / 1000 : 0.001

      // Backend events carry only the *basename* (e.g. `a.txt`) while rows are
      // keyed by unique full paths, so match candidates by basename/suffix.
      // Uploads now run concurrently, so several rows may be in flight with the
      // same basename: prefer the active row whose transferred count still
      // trails the event (per-row progress is monotonic), then the sole
      // candidate. Done/error rows are skipped so late events can't resurrect
      // a finished row.
      const findTarget = (rows: TransferRow[], op: TransferRow['op'], base: string) => {
        if (base.length === 0) return null
        const candidates = rows.filter(
          (r) =>
            r.op === op &&
            r.status !== 'done' &&
            r.status !== 'error' &&
            (r.filename === base || r.filename.endsWith(`/${base}`)),
        )
        return (
          candidates.find((r) => r.status === 'active' && r.transferred < p.transferred) ??
          candidates.find((r) => r.status === 'active') ??
          (candidates.length === 1 ? candidates[0] : null)
        )
      }

      if (p.op === 'directory') {
        // A directory download streams many files; the row is keyed by the
        // remote directory path and shows aggregate bytes + the current
        // relative path.
        const dirName = p.dirName ?? ''
        const bytesPerSec = (p.doneBytes ?? 0) / elapsed
        setTransferRows((prev) => {
          if (dirName.length === 0) return prev
          const candidates = prev.filter(
            (r) =>
              r.op === 'directory' &&
              r.status !== 'done' &&
              r.status !== 'error' &&
              (r.key === `directory:${dirName}` || r.key.endsWith(`/${dirName}`)),
          )
          const target =
            candidates.find((r) => r.status === 'active') ??
            (candidates.length === 1 ? candidates[0] : null)
          if (!target) return prev
          return prev.map((r) =>
            r.key === target.key
              ? {
                  ...r,
                  filename: p.relativePath || p.filename,
                  transferred: p.doneBytes ?? r.transferred,
                  total: p.totalBytes ?? r.total,
                  speed: formatSpeed(bytesPerSec),
                  status: 'active',
                }
              : r,
          )
        })
        return
      }
      if (p.op === 'delete') {
        // A recursive directory delete streams one event per removed file; the
        // row is keyed by the remote directory path and shows the aggregate
        // file count as progress.
        const dirName = p.dirName ?? ''
        setTransferRows((prev) => {
          if (dirName.length === 0) return prev
          const candidates = prev.filter(
            (r) =>
              r.op === 'delete' &&
              r.status !== 'done' &&
              r.status !== 'error' &&
              (r.key === `delete:${dirName}` || r.key.endsWith(`/${dirName}`)),
          )
          const target =
            candidates.find((r) => r.status === 'active') ??
            (candidates.length === 1 ? candidates[0] : null)
          if (!target) return prev
          return prev.map((r) =>
            r.key === target.key
              ? {
                  ...r,
                  transferred: p.doneFiles ?? r.transferred,
                  total: p.totalFiles ?? r.total,
                  status: 'active',
                }
              : r,
          )
        })
        return
      }
      const bytesPerSec = p.transferred / elapsed
      setTransferRows((prev) => {
        const target = findTarget(prev, p.op, p.filename)
        if (!target) return prev
        return prev.map((r) =>
          r.key === target.key
            ? {
                ...r,
                transferred: p.transferred,
                total: p.total,
                speed: formatSpeed(bytesPerSec),
                status: 'active',
              }
            : r,
        )
      })
    })
    return () => {
      unlisten.then((fn) => fn())
    }
  }, [sessionTabId])

  // Close context menu
  useEffect(() => {
    if (!contextMenu) return
    const handler = () => setContextMenu(null)
    document.addEventListener('click', handler)
    return () => document.removeEventListener('click', handler)
  }, [contextMenu])

  // Close the location dropdown on outside click / Escape.
  useEffect(() => {
    if (!jumpOpen) return
    const onDocClick = () => setJumpOpen(false)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setJumpOpen(false)
    }
    document.addEventListener('click', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('click', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [jumpOpen])

  useLayoutEffect(() => {
    if (!contextMenu || !contextMenuRef.current) return
    const menu = contextMenuRef.current
    const rect = menu.getBoundingClientRect()
    const overflowY = contextMenu.y + rect.height - window.innerHeight
    const overflowX = contextMenu.x + rect.width - window.innerWidth
    setContextMenuStyle({
      left: overflowX > 0 ? contextMenu.x - overflowX - 4 : contextMenu.x,
      top: overflowY > 0 ? contextMenu.y - rect.height : contextMenu.y,
    })
  }, [contextMenu])

  /* ---- tree actions ---- */

  const toggleDir = useCallback(
    async (node: TreeNode) => {
      if (node.expanded) {
        setTree((t) => updateNode(t, node.path, (n) => ({ ...n, expanded: false })))
      } else {
        if (!node.loaded) {
          setTree((t) => updateNode(t, node.path, (n) => ({ ...n, loading: true })))
          try {
            const result = await fsListFiles(target, node.path)
            setTree((t) =>
              updateNode(t, node.path, (n) => ({
                ...n,
                expanded: true,
                loaded: true,
                loading: false,
                children: result.map(toNode),
              })),
            )
          } catch {
            setTree((t) => updateNode(t, node.path, (n) => ({ ...n, loading: false })))
          }
        } else {
          setTree((t) => updateNode(t, node.path, (n) => ({ ...n, expanded: true })))
        }
      }
    },
    [target],
  )

  /* ---- transfer list helpers ---- */
  /**
   * Append new transfer rows while keeping in-flight ones. Rows whose key
   * already exists are replaced (avoids duplicate React keys).
   */
  const mergeRows = (prev: TransferRow[], next: TransferRow[]): TransferRow[] => {
    const nextKeys = new Set(next.map((r) => r.key))
    // A fresh batch supersedes any previous cancel state for those keys.
    for (const k of nextKeys) cancelledKeysRef.current.delete(k)
    return [...prev.filter((r) => !nextKeys.has(r.key)), ...next]
  }

  /* ---- upload ---- */
  const uploadFiles = useCallback(
    async (paths: string[], baseDir?: string) => {
      setError('')
      setPaused(false)
      // `baseDir` is the directory the files should be uploaded into; when
      // omitted the currently browsed directory is used.
      const targetDir = baseDir && baseDir.length > 0 ? baseDir : currentPath
      const rows: TransferRow[] = paths.map((localPath) => {
        // Key by the normalized full local path so same-named files from
        // different folders each get their own row (React keys must be unique).
        const normalizedPath = localPath.replace(/\\/g, '/')
        const fileName = normalizedPath.split('/').pop() || 'uploaded_file'
        return {
          key: `upload:${normalizedPath}`,
          filename: fileName,
          op: 'upload',
          status: 'queued',
          transferred: 0,
          total: 0,
          speed: '',
        }
      })
      setTransferRows((prev) => mergeRows(prev, rows))
      // Each file opens its own SFTP session on the backend; uploading several
      // in parallel lets the SSH handshakes overlap and keeps the pipe full.
      let firstError: string | null = null
      await runConcurrent(paths, UPLOAD_CONCURRENCY, async (localPath, i) => {
        // Skip files the user cancelled while they were still queued.
        if (cancelledKeysRef.current.has(rows[i].key)) return
        const fileName = rows[i].filename
        const remotePath = join(targetDir, fileName)
        setTransferRows((prev) =>
          prev.map((r) => (r.key === rows[i].key ? { ...r, status: 'active' } : r)),
        )
        try {
          await fsUploadFile(target, localPath, remotePath)
          setTransferRows((prev) =>
            prev.map((r) =>
              r.key === rows[i].key ? { ...r, status: 'done', transferred: r.total } : r,
            ),
          )
        } catch (e) {
          const cancelled = cancelledKeysRef.current.has(rows[i].key)
          setTransferRows((prev) =>
            prev.map((r) =>
              r.key === rows[i].key ? { ...r, status: cancelled ? 'cancelled' : 'error' } : r,
            ),
          )
          if (!cancelled && !firstError) firstError = `Upload ${fileName} failed: ${e}`
        }
      })
      if (firstError) setError(firstError)
      setPaused(false)
      refresh()
    },
    [target, currentPath, refresh],
  )

  /** A file resolved from a dropped entry, with its path relative to the drop root. */
  const handleDropUpload = useCallback(
    async (itemList: DataTransferItemList | null, baseDir?: string) => {
      if (!itemList || itemList.length === 0) return
      // `baseDir` is the directory the item was dropped *on*; blank-area drops
      // fall back to the currently browsed directory.
      const targetDir = baseDir && baseDir.length > 0 ? baseDir : currentPath
      // Use the File System Access API so dropped *directories* are enumerated
      // recursively instead of the browser flattening them into a file list.
      const entries: FileSystemEntry[] = []
      for (let i = 0; i < itemList.length; i++) {
        const entry = itemList[i].webkitGetAsEntry?.()
        if (entry) entries.push(entry)
      }
      if (entries.length === 0) return

      interface DroppedFile {
        relPath: string
        file: File
      }
      const files: DroppedFile[] = []
      const dirs: string[] = []

      const readEntries = (reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> =>
        new Promise((resolve, reject) => {
          reader.readEntries(
            (batch) => resolve(batch),
            (err) => reject(err),
          )
        })
      const readFileEntry = (entry: FileSystemFileEntry): Promise<File | null> =>
        new Promise((resolve) => entry.file(resolve, () => resolve(null)))

      const walkEntry = async (entry: FileSystemEntry, base: string): Promise<void> => {
        const rel = base ? `${base}/${entry.name}` : entry.name
        if (entry.isFile) {
          const file = await readFileEntry(entry as FileSystemFileEntry)
          if (file) files.push({ relPath: rel, file })
        } else if (entry.isDirectory) {
          dirs.push(rel)
          const reader = (entry as FileSystemDirectoryEntry).createReader()
          // `readEntries` returns batches (usually 100); keep draining until empty.
          for (;;) {
            const batch = await readEntries(reader)
            if (batch.length === 0) break
            for (const child of batch) await walkEntry(child, rel)
          }
        }
      }
      for (const e of entries) await walkEntry(e, '')

      setError('')
      setPaused(false)
      const rows: TransferRow[] = [
        ...dirs.map((d) => ({
          key: `mkdir:${d}`,
          filename: `${d}/`,
          op: 'upload' as const,
          status: 'queued' as const,
          transferred: 0,
          total: 0,
          speed: '',
        })),
        ...files.map((f) => ({
          key: `upload:${f.relPath}`,
          filename: f.relPath,
          op: 'upload' as const,
          status: 'queued' as const,
          transferred: 0,
          total: 0,
          speed: '',
        })),
      ]
      setTransferRows((prev) => mergeRows(prev, rows))

      // Create remote directories first. DFS pre-order lists parents before
      // children; parallelize each depth level so siblings go together while a
      // child never races its own parent (mkdir -p isn't guaranteed).
      const byDepth: string[][] = []
      for (const d of dirs) {
        const depth = d.split('/').length
        ;(byDepth[depth] ??= []).push(d)
      }
      for (const layer of byDepth) {
        if (!layer) continue
        await runConcurrent(layer, UPLOAD_CONCURRENCY, async (d) => {
          const mkKey = `mkdir:${d}`
          if (cancelledKeysRef.current.has(mkKey)) return
          setTransferRows((prev) =>
            prev.map((r) => (r.key === mkKey ? { ...r, status: 'active' } : r)),
          )
          try {
            await fsCreateDirectory(target, join(targetDir, d))
            setTransferRows((prev) =>
              prev.map((r) => (r.key === mkKey ? { ...r, status: 'done' } : r)),
            )
          } catch {
            // Directory likely already exists — treat as done so the row isn't
            // stuck in "uploading" forever.
            setTransferRows((prev) =>
              prev.map((r) => (r.key === mkKey ? { ...r, status: 'done' } : r)),
            )
          }
        })
      }

      // Upload the files themselves, several at a time. Each file streams in
      // ~256KB chunks (browser reads are buffered up inside fsUploadFileStream);
      // the whole file is never serialized through the Tauri JSON IPC at once.
      let firstError: string | null = null
      await runConcurrent(files, UPLOAD_CONCURRENCY, async (f) => {
        const remotePath = join(targetDir, f.relPath)
        const key = `upload:${f.relPath}`
        if (cancelledKeysRef.current.has(key)) return
        setTransferRows((prev) => prev.map((r) => (r.key === key ? { ...r, status: 'active' } : r)))
        try {
          await fsUploadFileStream(target, remotePath, f.file, (transferred) => {
            setTransferRows((prev) =>
              prev.map((r) => (r.key === key ? { ...r, transferred } : r)),
            )
          })
          setTransferRows((prev) =>
            prev.map((r) => (r.key === key ? { ...r, status: 'done', transferred: r.total } : r)),
          )
        } catch (e) {
          const cancelled = cancelledKeysRef.current.has(key)
          setTransferRows((prev) =>
            prev.map((r) =>
              r.key === key ? { ...r, status: cancelled ? 'cancelled' : 'error' } : r,
            ),
          )
          if (!cancelled && !firstError) firstError = `Upload ${f.relPath} failed: ${e}`
        }
      })
      if (firstError) setError(firstError)
      setPaused(false)
      refresh()
    },
    [target, currentPath, refresh],
  )

  // HTML5 drag-drop
  useEffect(() => {
    const panel = panelRef.current
    if (!panel) return
    const onDragOver = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
      setDragOver(true)
      // Highlight the directory row currently under the cursor. The row's React
      // handlers can't run here: this native listener stops propagation, so the
      // event never reaches React's delegated root listener.
      const row = (e.target as HTMLElement | null)?.closest?.('[data-dir-path]')
      setDropTargetPath(row?.getAttribute('data-dir-path') ?? null)
    }
    const onDragLeave = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (!panel.contains(e.relatedTarget as Node)) {
        setDragOver(false)
        setDropTargetPath(null)
      }
    }
    const onDrop = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setDragOver(false)
      setDropTargetPath(null)
      // If the drop landed on a directory row, upload into that directory
      // (read from the row's data attribute); otherwise fall back to the
      // currently browsed directory. This runs in the panel's native listener,
      // which fires before React's delegated handlers, so it must be the single
      // place that decides the target.
      const row = (e.target as HTMLElement | null)?.closest?.('[data-dir-path]')
      const baseDir = row?.getAttribute('data-dir-path') ?? undefined
      // Pass the item list (not just `.files`) so directories survive the drop
      // and can be enumerated recursively by the entry API.
      if (e.dataTransfer?.items && e.dataTransfer.items.length > 0) {
        handleDropUpload(e.dataTransfer.items, baseDir)
      }
    }
    panel.addEventListener('dragover', onDragOver)
    panel.addEventListener('dragleave', onDragLeave)
    panel.addEventListener('drop', onDrop)
    return () => {
      panel.removeEventListener('dragover', onDragOver)
      panel.removeEventListener('dragleave', onDragLeave)
      panel.removeEventListener('drop', onDrop)
    }
  }, [handleDropUpload])

  const handleUpload = async () => {
    setContextMenu(null)
    try {
      const selected = await open({ multiple: true, title: 'Select files to upload' })
      if (!selected) return
      const paths = Array.isArray(selected) ? selected : [selected]
      if (paths.length > 0) await uploadFiles(paths)
    } catch (e) {
      setError(String(e))
    }
  }

  /**
   * "Paste" context-menu action: uploads the files currently copied to the
   * system clipboard (Windows Explorer Ctrl+C). A right-click on a directory
   * pastes into that directory; a right-click on a file or blank area pastes
   * into the currently browsed directory.
   */
  const handlePaste = async (node: TreeNode | null) => {
    setContextMenu(null)
    let paths: string[]
    try {
      paths = await getClipboardFiles()
    } catch (e) {
      setError(String(e))
      return
    }
    if (!paths || paths.length === 0) {
      setError('Clipboard contains no files. Copy files in Explorer first (Ctrl+C).')
      return
    }
    // Right-clicking a directory pastes into it; right-clicking a non-directory
    // (file or blank area) pastes into the currently browsed directory.
    const baseDir = node && node.isDir ? node.path : currentPath
    await uploadFiles(paths, baseDir)
  }

  /* ---- context-menu actions ---- */

  // All selected non-directory nodes (used for multi-file download).
  const selectedFiles = useMemo(() => {
    const out: TreeNode[] = []
    const collect = (ns: TreeNode[]) => {
      for (const n of ns) {
        if (selPaths.has(n.path) && !n.isDir) out.push(n)
        if (n.children) collect(n.children)
      }
    }
    collect(tree)
    return out
  }, [selPaths, tree])

  const newFile = async (baseNode: TreeNode | null) => {
    setContextMenu(null)
    const baseDir = baseNode
      ? baseNode.isDir
        ? baseNode.path
        : getParentDir(baseNode.path)
      : currentPath
    const name = window.prompt('File name:')
    if (!name) return
    try {
      await fsWriteFileContent(target, join(baseDir, name), '', 'utf-8')
      refresh()
    } catch (e) {
      setError(String(e))
    }
  }

  const newFolder = async (baseNode: TreeNode | null) => {
    setContextMenu(null)
    const baseDir = baseNode
      ? baseNode.isDir
        ? baseNode.path
        : getParentDir(baseNode.path)
      : currentPath
    const name = window.prompt('Folder name:')
    if (!name) return
    try {
      await fsCreateDirectory(target, join(baseDir, name))
      refresh()
    } catch (e) {
      setError(String(e))
    }
  }

  const handleRename = (node: TreeNode) => {
    setContextMenu(null)
    setRenameValue(node.name)
    setRenameTarget(node)
  }

  const confirmRename = async () => {
    if (!renameTarget) return
    const newName = renameValue.trim()
    const node = renameTarget
    setRenameTarget(null)
    if (!newName || newName === node.name) return
    const parent = getParentDir(node.path)
    try {
      await fsRenameFile(target, node.path, join(parent, newName))
      refresh()
    } catch (e) {
      setError(String(e))
    }
  }

  const handleDelete = (node: TreeNode) => {
    setContextMenu(null)
    setDeleteTarget(node)
  }

  const confirmDelete = async () => {
    if (!deleteTarget) return
    const node = deleteTarget
    setDeleteTarget(null)
    if (node.isDir && sessionTabId != null) {
      // Recursive directory delete: show a per-file progress row (only the
      // main session streams `transfer-progress` delete events).
      setPaused(false)
      const key = `delete:${node.path}`
      setTransferRows((prev) =>
        mergeRows(prev, [
          {
            key,
            filename: node.name + '/',
            op: 'delete',
            status: 'active',
            transferred: 0,
            total: 0,
            speed: '',
          },
        ]),
      )
      try {
        await fsDeleteFile(target, node.path, true)
        setTransferRows((prev) =>
          prev.map((r) => (r.key === key ? { ...r, status: 'done' } : r)),
        )
        refresh()
      } catch (e) {
        const cancelled = cancelledKeysRef.current.has(key)
        setTransferRows((prev) =>
          prev.map((r) =>
            r.key === key ? { ...r, status: cancelled ? 'cancelled' : 'error' } : r,
          ),
        )
        if (!cancelled) setError(String(e))
        refresh()
      }
      return
    }
    try {
      await fsDeleteFile(target, node.path, node.isDir)
      refresh()
    } catch (e) {
      setError(String(e))
    }
  }

  const handleDownload = async (node: TreeNode) => {
    setContextMenu(null)
    if (node.isDir) {
      // Recursive directory download: pick a local target folder, then stream
      // the whole tree into it (backend walks once, emits per-file progress).
      try {
        const folder = await open({
          directory: true,
          title: t('selectDownloadFolder'),
          defaultPath: node.name,
        })
        if (!folder) return
        setPaused(false)
        setTransferRows((prev) =>
          mergeRows(prev, [
            {
              key: `directory:${node.path}`,
              filename: node.name + '/',
              op: 'directory',
              status: 'queued',
              transferred: 0,
              total: 0,
              speed: '',
            },
          ]),
        )
        try {
          const summary = await fsDownloadDirectory(target, node.path, folder as string)
          setTransferRows((prev) =>
            prev.map((r) =>
              r.key === `directory:${node.path}`
                ? {
                    ...r,
                    status: 'done',
                    transferred: summary.doneBytes,
                    total: summary.totalBytes,
                  }
                : r,
            ),
          )
        } catch (e) {
          const key = `directory:${node.path}`
          const cancelled = cancelledKeysRef.current.has(key)
          setTransferRows((prev) =>
            prev.map((r) =>
              r.key === key ? { ...r, status: cancelled ? 'cancelled' : 'error' } : r,
            ),
          )
          if (!cancelled) setError(String(e))
        }
      } catch (e) {
        setError(String(e))
      }
      return
    }
    try {
      const filePath = await save({ title: 'Save file as', defaultPath: node.name })
      if (filePath) {
        setPaused(false)
        setTransferRows((prev) =>
          mergeRows(prev, [
            {
              key: `download:${node.path}`,
              filename: node.name,
              op: 'download',
              status: 'queued',
              transferred: 0,
              total: 0,
              speed: '',
            },
          ]),
        )
        try {
          await fsDownloadFile(target, node.path, filePath as string)
          setTransferRows((prev) =>
            prev.map((r) =>
              r.key === `download:${node.path}`
                ? { ...r, status: 'done', transferred: r.total }
                : r,
            ),
          )
        } catch (e) {
          const key = `download:${node.path}`
          const cancelled = cancelledKeysRef.current.has(key)
          setTransferRows((prev) =>
            prev.map((r) =>
              r.key === key ? { ...r, status: cancelled ? 'cancelled' : 'error' } : r,
            ),
          )
          if (!cancelled) setError(String(e))
        }
      }
    } catch (e) {
      setError(String(e))
    }
  }

  /** Download several files (from multi-select) into a chosen local folder. */
  const downloadFiles = async (files: TreeNode[]) => {
    setContextMenu(null)
    const targets = files.filter((n) => !n.isDir)
    if (targets.length === 0) {
      setError('Downloading directories is not supported yet')
      return
    }
    let folder: string | null = null
    if (targets.length === 1) {
      const filePath = await save({ title: 'Save file as', defaultPath: targets[0].name })
      if (!filePath) return
      await downloadFilesInto([{ file: targets[0], localPath: filePath as string }])
      return
    }
    folder = await open({ directory: true, title: 'Select folder to download into' })
    if (!folder) return
    const sep = (folder as string).includes('\\') ? '\\' : '/'
    await downloadFilesInto(
      targets.map((n) => ({
        file: n,
        localPath: `${(folder as string).replace(/[\\/]+$/, '')}${sep}${n.name}`,
      })),
    )
  }

  const downloadFilesInto = async (items: { file: TreeNode; localPath: string }[]) => {
    setError('')
    setPaused(false)
    const rows: TransferRow[] = items.map(({ file }) => ({
      // Key by the remote path so same-named files from different directories
      // each get their own row.
      key: `download:${file.path}`,
      filename: file.name,
      op: 'download',
      status: 'queued',
      transferred: 0,
      total: 0,
      speed: '',
    }))
    setTransferRows((prev) => mergeRows(prev, rows))
    for (let i = 0; i < items.length; i++) {
      const { file, localPath } = items[i]
      // Skip files the user cancelled while they were still queued.
      if (cancelledKeysRef.current.has(rows[i].key)) continue
      setTransferRows((prev) =>
        prev.map((r) => (r.key === rows[i].key ? { ...r, status: 'active' } : r)),
      )
      try {
        await fsDownloadFile(target, file.path, localPath)
        setTransferRows((prev) =>
          prev.map((r) =>
            r.key === rows[i].key ? { ...r, status: 'done', transferred: r.total } : r,
          ),
        )
      } catch (e) {
        const cancelled = cancelledKeysRef.current.has(rows[i].key)
        setTransferRows((prev) =>
          prev.map((r) =>
            r.key === rows[i].key ? { ...r, status: cancelled ? 'cancelled' : 'error' } : r,
          ),
        )
        if (cancelled) continue
        setError(`Download ${file.name} failed: ${e}`)
      }
    }
    setPaused(false)
  }

  const handleEdit = (node: TreeNode) => {
    setContextMenu(null)
    onEditFile?.(target, node.path)
  }

  /* ---- SFTP user (main session only) ---- */
  const handleSwitchUser = async () => {
    if (sessionTabId == null) return
    const name = switchUsername.trim()
    const pw = switchPassword
    if (!name || !pw) {
      setError('Username and password are required')
      return
    }
    try {
      await switchSftpUser(sessionTabId, name, pw)
      setSftpUser(name)
      setShowSwitchUser(false)
      setSwitchUsername('')
      setSwitchPassword('')
      setError('')
    } catch (e) {
      setError(String(e))
    }
  }
  const handleRevertUser = async () => {
    if (sessionTabId == null) return
    try {
      await revertSftpUser(sessionTabId)
      setSftpUser(null)
      setError('')
    } catch (e) {
      setError(String(e))
    }
  }

  /* ---- header actions ---- */
  const navigateUp = () => {
    if (currentPath === rootPath) return
    if (currentPath === '/' || currentPath === '.') return
    const parent = normalizePath(getParentDir(currentPath))
    // Windows drive root (e.g. "D:/") has no parent — stay put.
    if (parent === currentPath) return
    loadRootDir(parent, true)
  }
  const setRoot = (path: string) => {
    const p = normalizePath(path)
    setRootPath(p)
    loadRootDir(p, true)
  }
  const goHome = () => {
    setRootPath('.')
    loadRootDir('.', true)
  }

  const startEditPath = () => {
    setEditPathValue(currentPath === '.' ? '' : currentPath)
    setEditingPath(true)
  }
  const commitEditPath = () => {
    setEditingPath(false)
    const trimmed = editPathValue.trim()
    if (!trimmed) return
    const norm = normalizePath(trimmed)
    if (norm === (currentPath === '.' ? '' : currentPath)) return
    if (isWithinRoot(norm, rootPath)) {
      loadRootDir(norm, true)
    } else if (
      window.confirm(`"${norm}" is outside the current root directory.\nSet it as the new root?`)
    ) {
      setRoot(norm)
    }
  }
  const cancelEditPath = () => setEditingPath(false)
  const handlePathKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') commitEditPath()
    else if (e.key === 'Escape') cancelEditPath()
  }

  const togglePause = async () => {
    if (sessionTabId == null) return
    if (paused) {
      setPaused(false)
      await resumeTransfer(sessionTabId)
    } else {
      setPaused(true)
      await pauseTransfer(sessionTabId)
    }
  }

  /** Cancel a transfer row: abort the in-flight transfer in the backend (if
      this is the active row) and stop any queued loop from starting it. */
  const cancelTransferRow = async (row: TransferRow) => {
    cancelledKeysRef.current.add(row.key)
    if (row.status === 'active' && sessionTabId != null) {
      // The backend aborts every in-flight transfer for the tab, so mark the
      // other active rows as cancelled too — otherwise they'd surface as
      // spurious errors.
      for (const r of transferRows) {
        if (r.status === 'active') cancelledKeysRef.current.add(r.key)
      }
      try {
        await cancelTransfer(sessionTabId)
      } catch {
        /* ignore — the loop will mark the row as cancelled/error itself */
      }
    }
    setPaused(false)
    setTransferRows((prev) =>
      prev.map((r) =>
        r.key === row.key || (row.status === 'active' && r.status === 'active')
          ? { ...r, status: 'cancelled', speed: '' }
          : r,
      ),
    )
  }

  /* ---- scrollbar ---- */
  const {
    listRef: fileListRef,
    thumbHeight: fileThumbHeight,
    thumbTop: fileThumbTop,
    showThumb: fileShowThumb,
    onScroll: onFileScroll,
    onThumbMouseDown: onFileThumbMouseDown,
    onMouseEnter: onFileMouseEnter,
    onMouseLeave: onFileMouseLeave,
  } = useCustomScrollbar()
  // Second instance for the transfer list body (internal scrollbar).
  const {
    listRef: transfersListRef,
    thumbHeight: transfersThumbHeight,
    thumbTop: transfersThumbTop,
    showThumb: transfersShowThumb,
    onScroll: onTransfersScroll,
    onThumbMouseDown: onTransfersThumbMouseDown,
    onMouseEnter: onTransfersMouseEnter,
    onMouseLeave: onTransfersMouseLeave,
  } = useCustomScrollbar()

  // Auto-clear the panel a few seconds after every row has finished, so the
  // transfer list doesn't linger after the work is done.
  useEffect(() => {
    if (transferRows.length === 0) return
    if (transferRows.some((r) => r.status === 'queued' || r.status === 'active')) return
    const t = window.setTimeout(() => setTransferRows([]), 2500)
    return () => window.clearTimeout(t)
  }, [transferRows])

  /* ---- transfers panel drag-to-resize ---- */
  const transfersDragRef = useRef<{ startY: number; startH: number } | null>(null)
  const onTransfersDragStart = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    transfersDragRef.current = { startY: e.clientY, startH: transfersPanelHeight }
    const onMove = (ev: MouseEvent) => {
      const drag = transfersDragRef.current
      if (!drag) return
      // Dragging up (negative delta) grows the panel; clamp to a sane range.
      const h = Math.max(48, Math.min(320, drag.startH + (drag.startY - ev.clientY)))
      setTransfersPanelHeight(h)
    }
    const onUp = () => {
      transfersDragRef.current = null
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  /* ---- node click ---- */
  // Anchor for Shift+click range selection (last clicked / selected path).
  const lastClickedRef = useRef<string | null>(null)
  const handleNodeClick = (node: TreeNode, e: React.MouseEvent) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey) {
      // Multi-select: Ctrl/Cmd toggles a node, Shift extends the selection.
      setSelPaths((prev) => {
        const next = new Set(prev)
        if (e.shiftKey && prev.size > 0 && lastClickedRef.current) {
          // Range-select all nodes between the last clicked node and this one.
          const all: string[] = []
          const collect = (ns: TreeNode[]) => {
            for (const n of ns) {
              all.push(n.path)
              if (n.expanded && n.children) collect(n.children)
            }
          }
          collect(tree)
          const last = lastClickedRef.current
          const i1 = all.indexOf(last)
          const i2 = all.indexOf(node.path)
          if (i1 >= 0 && i2 >= 0) {
            const [a, b] = i1 < i2 ? [i1, i2] : [i2, i1]
            const range = new Set(next)
            for (let i = a; i <= b; i++) range.add(all[i])
            return range
          }
        }
        if (next.has(node.path)) next.delete(node.path)
        else next.add(node.path)
        return next
      })
      lastClickedRef.current = node.path
      return
    }
    setSelPaths(new Set([node.path]))
    lastClickedRef.current = node.path
    if (node.isDir) {
      toggleDir(node)
    } else {
      onEditFile?.(target, node.path)
    }
  }

  /* ---- recursive render ---- */
  const renderNodes = (nodes: TreeNode[], depth: number): ReactNode[] => {
    return nodes.map((node) => (
      <div key={node.path}>
        <div
          className={`tree-row ${selPaths.has(node.path) ? 'selected' : ''} ${node.isDir ? 'dir' : 'file'} ${dropTargetPath === node.path ? 'drop-target' : ''}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={(e) => handleNodeClick(node, e)}
          onContextMenu={(e) => {
            e.preventDefault()
            e.stopPropagation()
            // Right-click on a node: select it (if not already selected) so
            // "Download N files" always targets the right-clicked item too.
            setSelPaths((prev) => (prev.has(node.path) ? prev : new Set([node.path])))
            setContextMenu({ x: e.clientX, y: e.clientY, node })
          }}
          // Drop-target resolution lives in the panel's native dragover/drop
          // listeners (React synthetic events never reach here because the
          // native listener stops propagation). Only the data attribute is used.
          data-dir-path={node.isDir ? node.path : undefined}
          title={node.path}
        >
          <span className="tree-icon">
            {node.isDir ? (
              <Icon name={node.expanded ? 'folderOpen' : 'folder'} />
            ) : (
              <Icon name="file" />
            )}
          </span>
          <span className="tree-name">{node.name}</span>
          {node.isDir ? null : <span className="tree-size">{formatSize(node.size)}</span>}
          {node.loading && (
            <span className="tree-spinner">
              <Icon name="refresh" className="spin" />
            </span>
          )}
        </div>
        {node.expanded && node.children && renderNodes(node.children, depth + 1)}
      </div>
    ))
  }

  const pathDisplay = currentPath === '.' ? '~ (home)' : currentPath

  return (
    <div ref={panelRef} className={`file-panel${dragOver ? ' drag-over' : ''}`}>
      {/* header */}
      <div className="file-panel-header">
        <span
          className={`collapse-chevron${expanded ? ' expanded' : ''}`}
          onClick={onToggleExpanded}
          title={expanded ? 'Collapse' : 'Expand'}
        />
        <span style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          Files
          {/* Mode switcher: browse the local SSH session, a ProxyJump remote, or a
              Docker container's filesystem. */}
          {fileMode !== 'local' && (
            <span className="file-mode-switch" role="tablist">
              <button
                className={fileMode === 'ssh' ? 'active' : ''}
                title={t('localSshSession')}
                onClick={() => handleModeClick('ssh')}
              >
                {t('modeSsh')}
              </button>
              <button
                className={fileMode === 'jump' ? 'active' : ''}
                title={t('proxyJumpRemote')}
                onClick={() => handleModeClick('jump')}
              >
                {t('modeJump')}
              </button>
              <button
                className={fileMode === 'docker' ? 'active' : ''}
                title={t('dockerContainer')}
                onClick={() => handleModeClick('docker')}
              >
                {t('modeDocker')}
              </button>
            </span>
          )}
        </span>
        {expanded && (
          <div className="file-toolbar">
            {onToggleSync && sessionTabId != null && (
              <button
                title={syncEnabled ? t('disableShellSync') : t('enableShellSync')}
                onClick={onToggleSync}
                className={syncEnabled ? 'sync-active' : ''}
              >
                <Icon name="link" />
              </button>
            )}
            {sessionTabId != null &&
              (sftpUser ? (
                <>
                  <span className="file-sftp-user" title={t('sftpAs', { user: sftpUser })}>
                    <Icon name="lock" />
                    {sftpUser}
                  </span>
                  <button title={t('restoreOriginalUser')} onClick={handleRevertUser}>
                    <Icon name="undo" />
                  </button>
                </>
              ) : (
                <button
                  title={t('switchSftpUser')}
                  onClick={() => setShowSwitchUser(!showSwitchUser)}
                >
                  <Icon name="user" />
                </button>
              ))}
            <button title={t('uploadFile')} onClick={handleUpload}>
              <Icon name="upload" />
            </button>
            <button
              title={t('newItem')}
              onClick={(e) => {
                e.stopPropagation()
                const r = e.currentTarget.getBoundingClientRect()
                setContextMenu({ x: r.left, y: r.bottom + 4, node: null })
              }}
            >
              <Icon name="plus" />
            </button>
            <button title={t('refresh')} onClick={refresh} disabled={loading}>
              <Icon name="refresh" />
            </button>
          </div>
        )}
      </div>

      {expanded && showTree && (
        <>
          {/* Connected server banner shown INSIDE the panel (above the path bar). */}
          <div className="file-server-banner">
            <Icon name="terminal" size={12} />
            <span className="file-server-label" title={serverLabel ?? targetLabel(target)}>
              {serverLabel ?? targetLabel(target)}
            </span>
          </div>
          <div className="file-path-bar">
          <div className="file-path-jump-wrap">
            <button
              ref={jumpBtnRef}
              className={`file-path-jump${jumpOpen ? ' open' : ''}`}
              title={t('jumpTo')}
              onClick={(e) => {
                e.stopPropagation()
                if (!jumpOpen && jumpBtnRef.current) {
                  const r = jumpBtnRef.current.getBoundingClientRect()
                  setJumpPos({ x: r.left, y: r.bottom + 4 })
                }
                setJumpOpen((o) => !o)
              }}
            >
              <Icon name="chevronDown" size={12} />
            </button>
            {jumpOpen && jumpPos && (
              <div className="file-path-jump-menu" style={{ left: jumpPos.x, top: jumpPos.y }}>
                <div className="file-path-jump-group">
                  <div className="file-path-jump-label">{t('home')}</div>
                  <div
                    className="file-path-jump-item"
                    onClick={() => {
                      setJumpOpen(false)
                      goHome()
                    }}
                  >
                    <Icon name="home" size={12} />
                    {t('home')}
                  </div>
                  <div
                    className="file-path-jump-item"
                    onClick={() => {
                      setJumpOpen(false)
                      loadRootDir('/', true)
                    }}
                  >
                    <Icon name="folderOpen" size={12} />
                    {t('rootDir')} (/)
                  </div>
                </div>
                {fileMode === 'local' && drives.length > 0 && (
                  <div className="file-path-jump-group">
                    <div className="file-path-jump-label">{t('localDrives')}</div>
                    {drives.map((d) => (
                      <div
                        key={d}
                        className="file-path-jump-item"
                        onClick={() => {
                          setJumpOpen(false)
                          loadRootDir(d, true)
                        }}
                      >
                        <Icon name="desktop" size={12} />
                        {d}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
            {editingPath ? (
              <input
                className="file-path-input"
                type="text"
                value={editPathValue}
                onChange={(e) => setEditPathValue(e.target.value)}
                onBlur={commitEditPath}
                onKeyDown={handlePathKeyDown}
                placeholder={t('enterPath')}
                autoFocus
              />
            ) : (
              <span className="file-path-text" title={pathDisplay} onClick={startEditPath}>
                {pathDisplay}
              </span>
            )}
            {/* Set the current browsed directory as the SSH connection's startup
                directory (main session only; pin icon next to the path). */}
            {sessionTabId != null && onSetStartupDir && (
              <span
                className="file-path-pin"
                onClick={() => onSetStartupDir(normalizePath(currentPath))}
                title={t('setAsStartupDir')}
              >
                <Icon name="pin" />
              </span>
            )}
            <span
              className={`file-path-up${currentPath === rootPath ? ' disabled' : ''}`}
              onClick={currentPath === rootPath ? undefined : navigateUp}
              title={t('parentDir')}
            >
              <Icon name="arrowUp" />
            </span>
          </div>

          {showSwitchUser && (
            <div className="file-switch-user">
              <input
                type="text"
                placeholder={t('enterUsername')}
                value={switchUsername}
                onChange={(e) => setSwitchUsername(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSwitchUser()
                }}
              />
              <input
                type="password"
                placeholder={t('enterPassword')}
                value={switchPassword}
                onChange={(e) => setSwitchPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSwitchUser()
                }}
              />
              <button onClick={handleSwitchUser}>{t('switchUser')}</button>
              <button onClick={() => setShowSwitchUser(false)}>✕</button>
            </div>
          )}

          <div
            className="file-list-wrapper"
            onMouseEnter={onFileMouseEnter}
            onMouseLeave={onFileMouseLeave}
          >
            <div
              className="file-list"
              ref={fileListRef}
              onScroll={onFileScroll}
              onContextMenu={(e) => {
                // Right-click on blank space inside the panel: show the context
                // menu with the currently browsed directory as the target.
                e.preventDefault()
                setContextMenu({ x: e.clientX, y: e.clientY, node: null })
              }}
            >
              {error && <div className="file-error">{error}</div>}
              {!loading && renderNodes(tree, 0)}
              {!loading && tree.length === 0 && !error && (
                <div className="file-empty">{t('emptyDirectory')}</div>
              )}
            </div>

            {fileThumbHeight > 0 && (
              <div className={`sidebar-scrollbar${fileShowThumb ? ' show' : ''}`}>
                <div
                  className="sidebar-scrollbar-thumb"
                  style={{ height: fileThumbHeight, top: fileThumbTop }}
                  onMouseDown={onFileThumbMouseDown}
                />
              </div>
            )}
          </div>

          {loading && (
            <div className="file-loading">
              <span>Loading...</span>
            </div>
          )}

          {/* Multi-file transfer progress list. Height is user-adjustable via the
              drag handle on its top edge; rows scroll internally when they overflow. */}
          {transferRows.length > 0 && (
            <div className="file-transfers" style={{ height: transfersPanelHeight }}>
              <div
                className="file-transfers-drag"
                onMouseDown={onTransfersDragStart}
                title={t('dragToResize')}
              />
              <div className="file-transfers-head">
                <span className="file-transfers-title">
                  {transferRows.some((r) => r.status === 'active' || r.status === 'queued')
                    ? t('transfers')
                    : t('transfersComplete')}
                </span>
                {sessionTabId != null &&
                  transferRows.some(
                    (r) => r.op !== 'delete' && (r.status === 'active' || r.status === 'queued'),
                  ) && (
                    <button
                      className="file-pause-btn"
                      onClick={togglePause}
                      title={paused ? 'Resume' : 'Pause'}
                    >
                      {paused ? <Icon name="play" /> : <Icon name="pause" />}
                    </button>
                  )}
              </div>
              <div className="file-transfers-body-wrap">
                <div
                  className="file-transfers-body"
                  ref={transfersListRef}
                  onScroll={onTransfersScroll}
                  onMouseEnter={onTransfersMouseEnter}
                  onMouseLeave={onTransfersMouseLeave}
                >
                  {transferRows.map((row) => (
                    <div key={row.key} className={`file-transfer-row ${row.status}`}>
                      <div className="file-transfer-info">
                        <div className="file-transfer-name" title={row.filename}>
                          {row.filename}
                        </div>
                        <div className="file-transfer-bar">
                          <div
                            className="file-transfer-fill"
                            style={
                              row.total > 0
                                ? {
                                    width: `${Math.min(100, (row.transferred / row.total) * 100)}%`,
                                    animation: 'none',
                                  }
                                : row.status === 'active'
                                  ? undefined
                                  : undefined
                            }
                          />
                        </div>
                        <div className="file-transfer-meta">
                          {row.status === 'error' && (
                            <span className="file-transfer-error">✗ {t('failed')}</span>
                          )}
                          {row.status === 'cancelled' && (
                            <span className="file-transfer-cancelled">✕ {t('cancelled')}</span>
                          )}
                          {row.status === 'done' && <span>✓</span>}
                          {row.status === 'queued' && <span>· · ·</span>}
                          {row.total > 0 && (
                            <span>
                              {' '}
                              {row.op === 'delete'
                                ? t('deleteProgress', {
                                    done: row.transferred,
                                    total: row.total,
                                  })
                                : `${formatSize(row.transferred)} / ${formatSize(row.total)} · ${row.speed}`}
                            </span>
                          )}
                        </div>
                      </div>
                      {(row.status === 'active' || row.status === 'queued') && (
                        <button
                          className="file-transfer-cancel"
                          title={t('cancelTransfer')}
                          onClick={() => cancelTransferRow(row)}
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                {transfersThumbHeight > 0 && (
                  <div className={`sidebar-scrollbar${transfersShowThumb ? ' show' : ''}`}>
                    <div
                      className="sidebar-scrollbar-thumb"
                      style={{ height: transfersThumbHeight, top: transfersThumbTop }}
                      onMouseDown={onTransfersThumbMouseDown}
                    />
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      )}

      {/* Jump (ProxyJump remote) connection form — shown in `jump` mode before a
          target is chosen. The connected host acts as the jump proxy. */}
      {expanded && showJumpForm && (
        <div className="file-jump-form">
          <div className="file-jump-title">{t('connectViaProxyJump')}</div>
          <label>
            {t('host')}
            <input
              type="text"
              value={jumpHost}
              placeholder={t('remoteHost')}
              onChange={(e) => setJumpHost(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleConnectJump()
              }}
            />
          </label>
          <label>
            {t('port')}
            <input
              type="number"
              value={jumpPort}
              onChange={(e) => setJumpPort(Number(e.target.value) || 22)}
            />
          </label>
          <label>
            {t('username')}
            <input
              type="text"
              value={jumpUser}
              placeholder={t('enterUsername')}
              onChange={(e) => setJumpUser(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleConnectJump()
              }}
            />
          </label>
          <div className="file-auth-type">
            <button
              className={jumpAuthType === 'password' ? 'active' : ''}
              onClick={() => setJumpAuthType('password')}
            >
              {t('authPassword')}
            </button>
            <button
              className={jumpAuthType === 'key' ? 'active' : ''}
              onClick={() => setJumpAuthType('key')}
            >
              {t('authKey')}
            </button>
          </div>
          {jumpAuthType === 'password' ? (
            <label>
              {t('password')}
              <input
                type="password"
                value={jumpPassword}
                onChange={(e) => setJumpPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleConnectJump()
                }}
              />
            </label>
          ) : (
            <>
              <label>
                {t('keyPath')}
                <input
                  type="text"
                  value={jumpKeyPath}
                  placeholder="/path/to/key"
                  onChange={(e) => setJumpKeyPath(e.target.value)}
                />
              </label>
              <label>
                {t('passphrase')}
                <input
                  type="password"
                  value={jumpPassphrase}
                  onChange={(e) => setJumpPassphrase(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleConnectJump()
                  }}
                />
              </label>
            </>
          )}
          {jumpError && <div className="file-error">{jumpError}</div>}
          <button
            className="file-jump-connect"
            onClick={handleConnectJump}
            disabled={jumpConnecting}
          >
            {t('connectTo')}
          </button>
          <div className="file-hint">Reached through the current host as a jump proxy.</div>
        </div>
      )}

      {/* Docker container picker — shown in `docker` mode before a container is
          chosen. */}
      {expanded && showDockerPicker && (
        <div className="file-docker-picker">
          <div className="file-docker-head">
            <span>{t('dockerContainers')}</span>
            <button title={t('refresh')} onClick={loadDockerContainers} disabled={dockerLoading}>
              <Icon name="refresh" />
            </button>
          </div>
          {dockerError && <div className="file-error">{dockerError}</div>}
          {dockerLoading && <div className="file-empty">{t('loading')}</div>}
          {!dockerLoading && !dockerError && dockerContainers.length === 0 && (
            <div className="file-empty">{t('noContainers')}</div>
          )}
          {dockerContainers.map((c) => (
            <div
              key={c.id}
              className="docker-item"
              onClick={() => handlePickContainer(c)}
              title={`${c.name}\n${c.image}\n${c.status}`}
            >
              <span className="docker-icon">
                <Icon name="container" />
              </span>
              <div className="docker-info">
                <div className="docker-name">{c.name}</div>
                <div className="docker-image">{c.image}</div>
              </div>
              <span className={`docker-state ${c.state}`}>{c.state}</span>
            </div>
          ))}
        </div>
      )}

      {/* context menu */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="context-menu"
          style={contextMenuStyle}
          onClick={(e) => e.stopPropagation()}
        >
          {contextMenu.node && contextMenu.node.isDir && (
            <div
              className="context-menu-item"
              onClick={() => {
                setContextMenu(null)
                loadRootDir(contextMenu.node!.path, true)
              }}
            >
              <Icon name="folderOpen" /> Enter directory
            </div>
          )}
          {contextMenu.node && !contextMenu.node.isDir && (
            <div className="context-menu-item" onClick={() => handleEdit(contextMenu.node!)}>
              <Icon name="edit" /> Open
            </div>
          )}
          {contextMenu.node && (
            <div className="context-menu-item" onClick={() => handleDownload(contextMenu.node!)}>
              <Icon name="download" /> Download
            </div>
          )}
          {selectedFiles.length > 1 && (
            <div className="context-menu-item" onClick={() => downloadFiles(selectedFiles)}>
              <Icon name="download" /> Download {selectedFiles.length} files
            </div>
          )}
          {/* Set-as-root temporarily disabled.
          {contextMenu.node && contextMenu.node.isDir && (
            <div className="context-menu-item" onClick={() => setRoot(contextMenu.node!.path)}>
              <Icon name="pin" /> Set as root
            </div>
          )}
          */}
          {contextMenu.node && <div className="context-menu-divider" />}
          <div className="context-menu-item" onClick={() => newFile(contextMenu.node)}>
            <Icon name="file" /> New File
          </div>
          <div className="context-menu-item" onClick={() => newFolder(contextMenu.node)}>
            <Icon name="folder" /> New Folder
          </div>
          {contextMenu.node && <div className="context-menu-divider" />}
          {contextMenu.node && (
            <div className="context-menu-item" onClick={() => handleRename(contextMenu.node!)}>
              <Icon name="edit" /> Rename
            </div>
          )}
          {contextMenu.node && (
            <div className="context-menu-item" onClick={() => handleDelete(contextMenu.node!)}>
              <Icon name="trash" /> Delete
            </div>
          )}
          {!contextMenu.node && <div className="context-menu-divider" />}
          {!contextMenu.node && (
            <div className="context-menu-item" onClick={handleUpload}>
              <Icon name="upload" /> Upload here
            </div>
          )}
          <div className="context-menu-divider" />
          <div className="context-menu-item" onClick={() => handlePaste(contextMenu.node)}>
            <Icon name="paste" /> Paste
          </div>
        </div>
      )}

      {/* Custom rename dialog */}
      {renameTarget && (
        <div className="modal-overlay" onClick={() => setRenameTarget(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">Rename {renameTarget.isDir ? 'directory' : 'file'}</div>
            <div className="modal-body" style={{ padding: '12px 20px' }}>
              <input
                className="file-modal-input"
                type="text"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void confirmRename()
                  if (e.key === 'Escape') setRenameTarget(null)
                }}
                autoFocus
                onFocus={(e) => e.target.select()}
                placeholder="New name"
              />
            </div>
            <div className="modal-actions">
              <button onClick={() => setRenameTarget(null)}>Cancel</button>
              <button className="primary" onClick={() => void confirmRename()}>
                Rename
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Custom delete confirmation */}
      {deleteTarget && (
        <div className="modal-overlay" onClick={() => setDeleteTarget(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">Delete</div>
            <div className="modal-body" style={{ padding: '12px 20px' }}>
              {deleteTarget.isDir
                ? `Delete directory "${deleteTarget.name}" and all its contents?`
                : `Delete file "${deleteTarget.name}"?`}
            </div>
            <div className="modal-actions">
              <button onClick={() => setDeleteTarget(null)}>Cancel</button>
              <button className="danger" onClick={() => void confirmDelete()}>
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
})

// Keep default export for existing imports
export default FilePanel

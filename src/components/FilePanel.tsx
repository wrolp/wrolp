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
  fsUploadLocalDir,
  getClipboardFiles,
  listLocalDrives,
  fsDownloadFile,
  fsDownloadDirectory,
  fsDeleteFile,
  fsCreateDirectory,
  fsRenameFile,
  fsWriteFileContent,
  fsCopy,
  fsPathExists,
  pauseTransfer,
  resumeTransfer,
  cancelTransfer,
  switchSftpUser,
  revertSftpUser,
  getSftpUser,
  sendInput,
  listDockerContainers,
} from '../commands'
import { open, save } from '@tauri-apps/plugin-dialog'
import { useCustomScrollbar } from '../hooks/useCustomScrollbar'
import { Icon } from './Icon'
import { useI18n } from '../i18n'

/** How many file transfers run at once for a multi-file upload batch. */
const UPLOAD_CONCURRENCY = 8

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
  op: 'upload' | 'download' | 'directory' | 'delete' | 'upload-dir'
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
  /**
   * Current working directory of the associated terminal tab, reported by the
   * Terminal component. When provided, shell-sync follows this real (interactive)
   * directory instead of `pollWorkingDir`, which only returns the login/$HOME dir.
   */
  remoteCwd?: string | null
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
  /** Reload a single directory's listing (partial refresh), preserving the
   *  expansion state of subdirectories still present. */
  refreshDirectory: (path: string) => void
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

// Build a copy name for index `n`: "report.txt" -> "report copy.txt" (n=1) or
// "report copy 2.txt" (n=2+), preserving the extension. Mirrors the backend
// `with_copy_suffix` helper (n=1) and its ` copy N` uniquifier.
function copyNameWithIndex(name: string, n: number): string {
  const idx = name.lastIndexOf('.')
  const suffix = n > 1 ? ` copy ${n}` : ' copy'
  if (idx > 0) {
    return `${name.slice(0, idx)}${suffix}${name.slice(idx)}`
  }
  return `${name}${suffix}`
}

// First suggested copy name (index 1).
function withCopySuffix(name: string): string {
  return copyNameWithIndex(name, 1)
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

function findNode(nodes: TreeNode[], path: string): TreeNode | null {
  for (const n of nodes) {
    if (n.path === path) return n
    if (n.children) {
      const hit = findNode(n.children, path)
      if (hit) return hit
    }
  }
  return null
}

// Replace one level of a directory listing with freshly fetched nodes (`next`),
// but for directories still present keep the old node's expansion / loaded /
// children state — so a partial refresh never collapses the user's expanded
// subtree. Entries that no longer exist in `next` are dropped.
function mergePreservingExpansion(prev: TreeNode[], next: TreeNode[]): TreeNode[] {
  const prevMap = new Map(prev.map((n) => [n.path, n]))
  return next.map((n) => {
    const old = prevMap.get(n.path)
    if (old && old.isDir) {
      return { ...n, expanded: old.expanded, loaded: old.loaded, loading: false, children: old.children }
    }
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
const filePanelBrowseCache: Record<string, { currentPath: string; rootPath: string }> = {}

// Last non-session filesystem target (docker container / jump remote) selected
// per tab, kept at module scope so it survives the panel's unmount on tab
// switches. Without it, docker → ssh → docker would drop the target and show
// the container picker instead of the container's file list.
const lastNonSessionTarget: Record<number, TargetRef> = {}

export const FilePanel = forwardRef<FileTreeHandle, FilePanelProps>(function FilePanel(
  {
    tabId,
    isConnected,
    defaultPath = '.',
    expanded = true,
    onToggleExpanded,
    syncEnabled = false,
    onToggleSync,
    remoteCwd = null,
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
  // Tracks the last target the connect-load effect ran for, so we only restore a
  // previously browsed (cached) path when the target actually switches — not on
  // every `cd` in the same session (where we want to follow the shell instead).
  const lastConnectTargetRef = useRef<string | null>(null)
  // Target that has completed its initial directory load. Gates shell-following:
  // after the first load, a terminal `cd` only moves the panel when shell-sync is
  // on (handled by the sync effect below), never unconditionally.
  const targetInitRef = useRef<string | null>(null)

  // Keep the per-tab "last non-session target" in sync with the active target
  // (set via the container picker, the jump form, or App's docker-shell focus
  // sync), so re-entering docker/jump mode can restore the previously browsed
  // filesystem instead of dropping back to the picker/form.
  useEffect(() => {
    if (target.kind === 'docker' || target.kind === 'jumpRemote' || target.kind === 'dockerSsh') {
      lastNonSessionTarget[tabId] = target
    }
  }, [target, tabId])

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
      // Clicking the active mode clears the current target (and forgets it),
      // returning to the picker/form so a different remote/container can be chosen.
      delete lastNonSessionTarget[tabId]
      onSelectTarget?.(null)
      return
    }
    const remembered = lastNonSessionTarget[tabId]
    if (mode === 'docker') {
      loadDockerContainers()
      // Re-enter the previously browsed container filesystem (if any) instead of
      // dumping the user back on the container picker.
      if (remembered && remembered.kind === 'docker') onSelectTarget?.(remembered)
    } else if (mode === 'jump') {
      // Same for the ProxyJump remote: restore the last jump target if there is one.
      if (remembered && (remembered.kind === 'jumpRemote' || remembered.kind === 'dockerSsh')) {
        onSelectTarget?.(remembered)
      }
    } else if (mode === 'ssh') {
      // Switching to SSH always shows the local session, so drop any non-session
      // target that may still be set.
      onSelectTarget?.(null)
    }
    onFileModeChange?.(mode)
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
  // Source node of the in-progress remote-internal copy (set by the "Copy"
  // context-menu action). Consumed by "Paste" to copy it into the target dir.
  const [copiedNode, setCopiedNode] = useState<TreeNode | null>(null)
  // Local toast shown near the panel title bar (not the global app toast).
  const [fileToast, setFileToast] = useState<{
    kind: 'info' | 'success' | 'error'
    text: string
  } | null>(null)

  useEffect(() => {
    if (!fileToast) return
    const id = setTimeout(() => setFileToast(null), 3000)
    return () => clearTimeout(id)
  }, [fileToast])
  // New-file / new-folder custom dialog state (replaces the native window.prompt).
  const [createModal, setCreateModal] = useState<{
    baseDir: string
    kind: 'file' | 'folder'
  } | null>(null)
  const [createValue, setCreateValue] = useState('')
  const [createError, setCreateError] = useState('')
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
  // Copy/rename prompt: shown when a remote-internal paste lands on a name
  // that already exists in the destination folder. Stores the pending copy so
  // the user can pick a new name instead of silently auto-suffixing.
  const [copyRename, setCopyRename] = useState<{
    srcPath: string
    baseDir: string
    defaultName: string
  } | null>(null)
  const [copyRenameValue, setCopyRenameValue] = useState('')
  const [copyRenameError, setCopyRenameError] = useState('')
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

  // Partial refresh: reload a single directory's listing instead of the whole
  // tree. When `path` is the currently browsed directory the root listing is
  // replaced; any other directory is located in the tree (if it's visible) and
  // its children are replaced. mergePreservingExpansion keeps the expansion /
  // loaded / children state of subdirectories still present, so a write
  // operation never collapses the user's expanded subtree. Directories not
  // currently in the visible tree are skipped — they'll be fetched fresh when
  // expanded.
  const reloadDirectory = useCallback(
    async (path: string) => {
      try {
        const result = await fsListFiles(target, path)
        const fresh = result.map(toNode)
        const norm = normalizePath(path)
        if (norm === normalizePath(currentPath)) {
          // Top-level listing: merge, preserving expansion of surviving dirs.
          setTree((t) => mergePreservingExpansion(t, fresh))
        } else {
          const node = findNode(tree, norm)
          if (node && node.isDir) {
            // The directory is visible in the tree: swap only its children.
            // `getParentDir` returns a trailing slash (`/a/b/`) while tree node
            // paths never carry one, so match against the normalized path —
            // otherwise deletes/renames deep inside an expanded subtree would
            // silently fail to refresh the listing.
            setTree((t) =>
              updateNode(t, norm, (n) => ({
                ...n,
                loaded: true,
                loading: false,
                children: mergePreservingExpansion(n.children ?? [], fresh),
              })),
            )
          } else {
            // The target directory isn't in the visible tree (e.g. the panel
            // is rooted at home '.' where the absolute parent has no tree node,
            // or the directory was never expanded). Fall back to a full refresh
            // so the change still shows up.
            await refresh()
          }
        }
      } catch (e) {
        setError(String(e))
      }
    },
    [target, currentPath, tree, refresh],
  )

  useImperativeHandle(
    ref,
    () => ({ refresh, refreshDirectory: reloadDirectory }),
    [refresh, reloadDirectory],
  )

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
      // filesystem (targetKey) so switching to another terminal and back does
      // not reset the file list. BUT only when the *target* actually switches —
      // on a `cd` in the same session we keep following the shell via
      // `remoteCwd` (the Terminal-reported real working directory), which is far
      // more accurate than the backend's `$HOME` fallback. A fresh/unvisited
      // target (no cache) also uses `remoteCwd` when available.
      const targetChanged = lastConnectTargetRef.current !== targetKey
      lastConnectTargetRef.current = targetKey
      // Same target, already initialized: following the shell's `cd` is the
      // shell-sync effect's job (gated on syncEnabled). Return here so a
      // terminal `cd` with sync disabled leaves the panel completely untouched —
      // neither the browsed path nor the listing is yanked.
      if (!targetChanged && targetInitRef.current === targetKey) return
      const cached = filePanelBrowseCache[targetKey]
      // Docker container filesystems uniformly open at the root "/" — the
      // shell-reported cwd (remoteCwd) describes the container shell's working
      // directory, and a cached browse path from an earlier visit is not
      // restored either; the container's file list always starts at "/".
      const startPath = target.kind === 'docker' ? '/' : targetChanged && cached ? cached.currentPath : remoteCwd ?? defaultPath
      const startRoot = target.kind === 'docker' ? '/' : targetChanged && cached ? cached.rootPath : remoteCwd ?? defaultPath
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
        if (ok) {
          targetInitRef.current = targetKey
        } else if (attempt < 30) {
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
  }, [isConnected, sessionTabId, targetKey, defaultPath, remoteCwd])

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

  // Shell → FilePanel sync (main session only). Follow the real working
  // directory reported by the Terminal (`remoteCwd`, which tracks `cd` in the
  // interactive shell). We deliberately do NOT fall back to `poll_working_dir`:
  // that command opens a fresh exec channel whose `pwd` returns the login/$HOME
  // directory, which is wrong as soon as the shell has `cd`'d anywhere else.
  useEffect(() => {
    if (!syncEnabled || !isConnected || sessionTabId == null) return
    if (!expanded) return
    let active = true
    const poll = async () => {
      if (!active || document.hidden) return
      try {
        const remotePath = remoteCwd
        if (!active || !remotePath) return
        if (remotePath !== lastPolledPath.current) {
          lastPolledPath.current = remotePath
          // Always follow the shell's real cwd. The `lastPolledPath` check above
          // already prevents redundant reloads when the directory is unchanged,
          // so there's no need to gate on `isWithinRoot` — that guard would leave
          // the panel stuck at an ancestor (e.g. `$HOME`) after the shell `cd`s
          // into a sibling/descendant directory, breaking click resolution.
          loadRootDir(remotePath, false)
        }
      } catch {
        /* ignore */
      }
    }
    poll()
    const interval = setInterval(poll, 5000)
    // Resume promptly when the panel/window becomes visible again.
    const onVisible = () => {
      if (!document.hidden && active && expanded) void poll()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      active = false
      clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [syncEnabled, isConnected, sessionTabId, loadRootDir, expanded, remoteCwd])

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
      if (p.op === 'upload-dir') {
        // A local-directory upload streams many files on the Rust side; the
        // row is keyed by the full normalized local path (the event's
        // `dirName`) and shows aggregate bytes + the current relative path.
        const dirName = p.dirName ?? ''
        const bytesPerSec = (p.doneBytes ?? 0) / elapsed
        setTransferRows((prev) => {
          if (dirName.length === 0) return prev
          const candidates = prev.filter(
            (r) =>
              r.op === 'upload' &&
              r.status !== 'done' &&
              r.status !== 'error' &&
              r.key === `upload-dir:${dirName}`,
          )
          const target =
            candidates.find((r) => r.status === 'active') ??
            (candidates.length === 1 ? candidates[0] : null)
          if (!target) return prev
          return prev.map((r) =>
            r.key === target.key
              ? {
                  ...r,
                  filename: p.relativePath || r.filename,
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
      const bytesPerSec = p.transferred / elapsed
      setTransferRows((prev) => {
        // `upload-dir` is handled above; the cast is safe because of the early
        // return (TS doesn't narrow `p.op` into this callback).
        const target = findTarget(prev, p.op as TransferRow['op'], p.filename)
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
      reloadDirectory(targetDir)
    },
    [target, currentPath, reloadDirectory],
  )

  /**
   * Upload one or more local files/folders (real filesystem paths from the
   * native picker, clipboard paste, or Tauri drag-drop) into `baseDir` (or the
   * currently browsed directory). Each path gets ONE aggregate progress row
   * and is uploaded by the Rust backend, which walks directories once with
   * walkdir and streams every file over a shared SFTP connection — no
   * per-chunk IPC.
   */
  const uploadLocalPaths = useCallback(
    async (localPaths: string[], baseDir?: string) => {
      setError('')
      setPaused(false)
      const targetDir = baseDir && baseDir.length > 0 ? baseDir : currentPath
      const rows: TransferRow[] = localPaths.map((localPath) => {
        const normalizedPath = localPath.replace(/\\/g, '/')
        const name = normalizedPath.split('/').pop() || 'upload'
        return {
          key: `upload-dir:${normalizedPath}`,
          filename: name + '/',
          op: 'upload',
          status: 'queued',
          transferred: 0,
          total: 0,
          speed: '',
        }
      })
      setTransferRows((prev) => mergeRows(prev, rows))
      let firstError: string | null = null
      await runConcurrent(localPaths, UPLOAD_CONCURRENCY, async (localPath, i) => {
        const key = rows[i].key
        if (cancelledKeysRef.current.has(key)) return
        setTransferRows((prev) => prev.map((r) => (r.key === key ? { ...r, status: 'active' } : r)))
        try {
          const summary = await fsUploadLocalDir(target, localPath, targetDir)
          setTransferRows((prev) =>
            prev.map((r) =>
              r.key === key
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
          const cancelled = cancelledKeysRef.current.has(key)
          setTransferRows((prev) =>
            prev.map((r) =>
              r.key === key ? { ...r, status: cancelled ? 'cancelled' : 'error' } : r,
            ),
          )
          if (!cancelled && !firstError) firstError = `Upload ${rows[i].filename} failed: ${e}`
        }
      })
      if (firstError) setError(firstError)
      setPaused(false)
      reloadDirectory(targetDir)
    },
    [target, currentPath, reloadDirectory],
  )

  // Drag-drop: `dragDropEnabled: false` keeps WebView2's external drops enabled,
  // so the panel receives normal HTML5 drag events (used for the cursor and the
  // target-folder highlight). On drop we deliberately do NOT call preventDefault
  // on the drop event, so the browser's default action (navigate to the dropped
  // file/folder) fires `NavigationStarting`/`NewWindowRequested` in Rust, which
  // cancels it and emits `native-drag-drop` carrying the REAL local path — the
  // frontend then uploads it via `uploadLocalPaths` (Rust walkdir, one aggregate
  // progress row per item, exactly like the Upload folder button).
  const pendingDropRef = useRef<{ x: number; y: number } | null>(null)
  const rowAt = (el: Element | null): string | null =>
    el?.closest?.('[data-dir-path]')?.getAttribute('data-dir-path') ?? null

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    const el = document.elementFromPoint(e.clientX, e.clientY)
    const inPanel = panelRef.current?.contains(el) ?? false
    setDragOver(inPanel)
    setDropTargetPath(inPanel ? rowAt(el) : null)
  }

  // Clear the drag highlight (panel box + folder drop-target). Safe to call
  // from any drag-related event; idempotent.
  const clearDragHighlight = useCallback(() => {
    setDragOver(false)
    setDropTargetPath(null)
  }, [])

  const handleDragLeave = (e: React.DragEvent) => {
    // On leaving the panel for a sibling element, relatedTarget is that
    // element; when the drag leaves the window entirely, relatedTarget is null.
    // Only keep the highlight while the pointer is genuinely still inside.
    const rel = e.relatedTarget as Node | null
    if (rel === null || !panelRef.current?.contains(rel)) {
      setDragOver(false)
      setDropTargetPath(null)
    }
  }

  const handleDrop = (e: React.DragEvent) => {
    // Record the drop position for the async Rust event. Do NOT preventDefault:
    // the browser's default action navigates to the dropped file, which is how
    // Rust recovers the real local path. Clear the highlight immediately — the
    // actual upload is triggered asynchronously by the `native-drag-drop` event.
    const el = document.elementFromPoint(e.clientX, e.clientY)
    pendingDropRef.current = panelRef.current?.contains(el) ? { x: e.clientX, y: e.clientY } : null
    clearDragHighlight()
  }

  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | null = null

    // Safety net: whenever a drag operation ends anywhere in the document
    // (dropped, cancelled, or released outside the panel), clear the highlight.
    // This covers native OS drags whose `dragend`/`dragleave` never reach the
    // panel element.
    const onDragEnd = () => clearDragHighlight()
    document.addEventListener('dragend', onDragEnd)
    document.addEventListener('drop', onDragEnd)

    listen<{ type: string; paths: string[] }>('native-drag-drop', (event) => {
      const payload = event.payload
      console.log('[native-drag-drop]', payload.type, payload.paths)
      if (payload.type !== 'drop' || !payload.paths || payload.paths.length === 0) return
      // Only upload if the drop was over the panel (position recorded in the
      // HTML5 drop handler); drops elsewhere are ignored.
      const pos = pendingDropRef.current
      pendingDropRef.current = null
      if (!pos) return
      const baseDir = rowAt(document.elementFromPoint(pos.x, pos.y)) ?? undefined
      uploadLocalPaths(payload.paths, baseDir)
      clearDragHighlight()
    }).then((fn) => {
      if (disposed) fn()
      else unlisten = fn
    })
    return () => {
      disposed = true
      document.removeEventListener('dragend', onDragEnd)
      document.removeEventListener('drop', onDragEnd)
      unlisten?.()
    }
  }, [uploadLocalPaths, clearDragHighlight])

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

  /** Pick a local folder and upload its whole tree (walkdir scan on the Rust side). */
  const handleUploadFolder = async () => {
    setContextMenu(null)
    try {
      const folder = await open({ directory: true, title: t('selectUploadFolder') })
      if (!folder) return
      await uploadLocalPaths([folder])
    } catch (e) {
      setError(String(e))
    }
  }

  /**
   * Perform the actual remote-internal copy once a final name is decided.
   */
  const doRemoteCopy = async (srcPath: string, baseDir: string, destName: string) => {
    try {
      await fsCopy(target, srcPath, baseDir, destName)
      setCopiedNode(null)
      setCopyRename(null)
      setFileToast({ kind: 'success', text: `Copied to ${join(baseDir, destName)}` })
      reloadDirectory(baseDir)
    } catch (e) {
      setError(String(e))
      setFileToast({ kind: 'error', text: String(e) })
    }
  }

  /**
   * Remote-internal paste: copy the currently `copiedNode` (set by the "Copy"
   * action) into `node`'s directory, or the browsed directory when pasting on a
   * file / blank area. If the destination already contains an item with the
   * same name, a rename prompt is shown instead of silently auto-suffixing.
   */
  const handleRemotePaste = async (node: TreeNode | null) => {
    if (!copiedNode) return
    const baseDir = node && node.isDir ? node.path : currentPath
    const src = copiedNode
    const srcName = src.path.split('/').pop() || src.name || 'copy'
    const dest = join(baseDir, srcName)

    let exists = false
    try {
      exists = await fsPathExists(target, dest)
    } catch {
      exists = false
    }
    if (exists) {
      // Find a guaranteed-free default name ("report copy.txt", then
      // "report copy 2.txt", ...) so the first "Copy" click always works even
      // when the suggested name itself already exists in the destination.
      let n = 1
      let candidate = copyNameWithIndex(srcName, n)
      try {
        while (await fsPathExists(target, join(baseDir, candidate))) {
          n += 1
          candidate = copyNameWithIndex(srcName, n)
        }
      } catch {
        candidate = withCopySuffix(srcName)
      }
      setCopyRename({ srcPath: src.path, baseDir, defaultName: candidate })
      setCopyRenameValue(candidate)
      setCopyRenameError('')
      setContextMenu(null)
      return
    }
    await doRemoteCopy(src.path, baseDir, srcName)
  }

  /**
   * Confirm the copy-rename prompt: validate the entered name and, if it still
   * clashes, keep the dialog open with an error; otherwise perform the copy.
   */
  const confirmCopyRename = async () => {
    if (!copyRename) return
    const name = copyRenameValue.trim()
    if (!name) {
      setCopyRenameError('Please enter a name')
      return
    }
    const dest = join(copyRename.baseDir, name)
    try {
      const exists = await fsPathExists(target, dest)
      if (exists) {
        setCopyRenameError(`'${name}' already exists`)
        return
      }
    } catch {
      // If the existence check fails, proceed and let the backend reject.
    }
    await doRemoteCopy(copyRename.srcPath, copyRename.baseDir, name)
  }

  /**
   * "Paste" context-menu action. If a remote node was copied via the "Copy"
   * action, this performs a remote-internal copy into the target directory.
   * Otherwise it uploads the files currently in the system clipboard
   * (Windows Explorer Ctrl+C). A right-click on a directory targets that
   * directory; a right-click on a file or blank area targets the browsed dir.
   */
  const handlePaste = async (node: TreeNode | null) => {
    setContextMenu(null)
    if (copiedNode) {
      await handleRemotePaste(node)
      return
    }
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

  const resolveBaseDir = (baseNode: TreeNode | null): string => {
    if (baseNode) return baseNode.isDir ? baseNode.path : getParentDir(baseNode.path)
    return currentPath
  }

  const newFile = (baseNode: TreeNode | null) => {
    setContextMenu(null)
    setCreateModal({ baseDir: resolveBaseDir(baseNode), kind: 'file' })
    setCreateValue('')
    setCreateError('')
  }

  const newFolder = (baseNode: TreeNode | null) => {
    setContextMenu(null)
    setCreateModal({ baseDir: resolveBaseDir(baseNode), kind: 'folder' })
    setCreateValue('')
    setCreateError('')
  }

  /**
   * Confirm the New File / New Folder dialog: validate the name, refuse to
   * overwrite an existing entry, then create it.
   */
  const confirmCreate = async () => {
    if (!createModal) return
    const name = createValue.trim()
    if (!name) {
      setCreateError('Please enter a name')
      return
    }
    const dest = join(createModal.baseDir, name)
    try {
      if (await fsPathExists(target, dest)) {
        setCreateError(`'${name}' already exists`)
        return
      }
    } catch {
      // If the existence check fails, proceed and let the backend reject.
    }
    try {
      if (createModal.kind === 'folder') {
        await fsCreateDirectory(target, dest)
      } else {
        await fsWriteFileContent(target, dest, '', 'utf-8')
      }
      setCreateModal(null)
      reloadDirectory(createModal.baseDir)
      setFileToast({
        kind: 'success',
        text: `${createModal.kind === 'folder' ? 'Folder' : 'File'} created: ${dest}`,
      })
    } catch (e) {
      setError(String(e))
      setCreateError(String(e))
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
      reloadDirectory(parent)
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
        setTransferRows((prev) => prev.map((r) => (r.key === key ? { ...r, status: 'done' } : r)))
        reloadDirectory(getParentDir(node.path))
      } catch (e) {
        const cancelled = cancelledKeysRef.current.has(key)
        setTransferRows((prev) =>
          prev.map((r) =>
            r.key === key ? { ...r, status: cancelled ? 'cancelled' : 'error' } : r,
          ),
        )
        if (!cancelled) setError(String(e))
        reloadDirectory(getParentDir(node.path))
      }
      return
    }
    try {
      await fsDeleteFile(target, node.path, node.isDir)
      reloadDirectory(getParentDir(node.path))
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
          className={`tree-row ${selPaths.has(node.path) ? 'selected' : ''} ${node.isDir ? 'dir' : 'file'} ${dropTargetPath === node.path ? 'drop-target' : ''} ${copiedNode && copiedNode.path === node.path ? 'copied' : ''}`}
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
          {copiedNode && copiedNode.path === node.path && (
            <span className="tree-copied-badge" title="Copied — ready to paste">
              copied
            </span>
          )}
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
    <div
      ref={panelRef}
      className={`file-panel${dragOver ? ' drag-over' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
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
            <button title={t('uploadFolder')} onClick={handleUploadFolder}>
              <Icon name="folderUp" />
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

      {fileToast && (
        <div
          className={`panel-toast panel-toast-${fileToast.kind}`}
          onClick={() => setFileToast(null)}
        >
          <span className="panel-toast-icon">
            {fileToast.kind === 'success' ? '✓' : fileToast.kind === 'error' ? '✕' : 'ℹ'}
          </span>
          <span className="panel-toast-text">{fileToast.text}</span>
        </div>
      )}

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
          {!dockerLoading &&
            !dockerError &&
            dockerContainers.filter((c) => c.state === 'running').length === 0 && (
              <div className="file-empty">{t('noContainers')}</div>
            )}
          {dockerContainers
            .filter((c) => c.state === 'running')
            .map((c) => (
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
          {contextMenu.node && contextMenu.node.isDir && (
            <div
              className="context-menu-item"
              onClick={() => {
                setContextMenu(null)
                reloadDirectory(contextMenu.node!.path)
              }}
            >
              <Icon name="refresh" /> {t('refreshThisFolder')}
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
          {!contextMenu.node && (
            <div className="context-menu-item" onClick={handleUploadFolder}>
              <Icon name="folderUp" /> Upload folder here
            </div>
          )}
          <div className="context-menu-divider" />
          <div
            className="context-menu-item"
            onClick={() => {
              if (contextMenu.node) {
                setCopiedNode(contextMenu.node)
                setFileToast({
                  kind: 'info',
                  text: `Copied "${contextMenu.node.name}". Right-click a folder and choose Paste.`,
                })
              }
              setContextMenu(null)
            }}
          >
            <Icon name="copy" /> {t('copy')}
          </div>
          <div
            className={`context-menu-item${copiedNode ? '' : ' disabled'}`}
            onClick={() => handlePaste(contextMenu.node)}
          >
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

      {/* Custom copy-rename prompt (name clash on remote-internal paste) */}
      {copyRename && (
        <div className="modal-overlay" onClick={() => setCopyRename(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">Name conflict</div>
            <div className="modal-body" style={{ padding: '12px 20px' }}>
              <div style={{ marginBottom: 8 }}>
                An item with this name already exists. Enter a new name:
              </div>
              <input
                className="file-modal-input"
                type="text"
                value={copyRenameValue}
                onChange={(e) => {
                  setCopyRenameValue(e.target.value)
                  setCopyRenameError('')
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void confirmCopyRename()
                  if (e.key === 'Escape') setCopyRename(null)
                }}
                autoFocus
                onFocus={(e) => e.target.select()}
                placeholder="New name"
              />
              {copyRenameError && (
                <div style={{ color: '#e5484d', marginTop: 6, fontSize: 12 }}>
                  {copyRenameError}
                </div>
              )}
            </div>
            <div className="modal-actions">
              <button onClick={() => setCopyRename(null)}>Cancel</button>
              <button className="primary" onClick={() => void confirmCopyRename()}>
                Copy
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Custom New File / New Folder dialog */}
      {createModal && (
        <div className="modal-overlay" onClick={() => setCreateModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">
              {createModal.kind === 'folder' ? 'New Folder' : 'New File'}
            </div>
            <div className="modal-body" style={{ padding: '12px 20px' }}>
              <div style={{ marginBottom: 8 }}>Enter a name:</div>
              <input
                className="file-modal-input"
                type="text"
                value={createValue}
                onChange={(e) => {
                  setCreateValue(e.target.value)
                  setCreateError('')
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void confirmCreate()
                  if (e.key === 'Escape') setCreateModal(null)
                }}
                autoFocus
              />
              {createError && (
                <div style={{ color: '#e5484d', marginTop: 6, fontSize: 12 }}>
                  {createError}
                </div>
              )}
            </div>
            <div className="modal-actions">
              <button onClick={() => setCreateModal(null)}>Cancel</button>
              <button className="primary" onClick={() => void confirmCreate()}>
                Create
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

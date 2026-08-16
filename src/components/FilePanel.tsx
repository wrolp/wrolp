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
  fsDownloadFile,
  fsDownloadDirectory,
  fsDeleteFile,
  fsCreateDirectory,
  fsRenameFile,
  fsWriteFileContent,
  pauseTransfer,
  resumeTransfer,
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

/* ---------- types ---------- */

interface TransferProgress {
  tabId: number
  op: 'upload' | 'download' | 'directory'
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
  /** Stable unique key: `up:`/`down:` + filename. */
  key: string
  filename: string
  op: 'upload' | 'download' | 'directory'
  status: 'queued' | 'active' | 'done' | 'error'
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
  const trimmed = p.replace(/\/$/, '')
  const i = trimmed.lastIndexOf('/')
  return i <= 0 ? '/' : trimmed.slice(0, i + 1)
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

// Normalize: drop a single trailing slash (keep '/' itself).
function normalizePath(p: string): string {
  if (p === '/' || p === '.') return p
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

export const FilePanel = forwardRef<FileTreeHandle, FilePanelProps>(function FilePanel(
  {
    tabId,
    isConnected,
    defaultPath = '.',
    expanded = true,
    onToggleExpanded,
    syncEnabled = false,
    onToggleSync,
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
          if (old && old.isDir && old.loaded) {
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

  useEffect(() => {
    if (isConnected) {
      // Reset to the target's home directory so that switching to a different
      // split pane / connection shows that connection's correct root rather
      // than a stale path carried over from the previous connection.
      setCurrentPath(defaultPath)
      setRootPath(defaultPath)
      // Non-session targets (jump/docker) can be addressed through a freshly
      // opened SSH session whose handle is not ready yet; retry the first list
      // until it succeeds so the panel fills in instead of showing an error.
      let cancelled = false
      let attempt = 0
      let timer: ReturnType<typeof setTimeout> | undefined
      const attemptLoad = async () => {
        if (cancelled) return
        const ok = await loadRootDir(defaultPath)
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
      if (p.op === 'directory') {
        // A directory download streams many files; the row is keyed by the
        // base directory and shows aggregate bytes + the current relative path.
        const key = `directory:${p.dirName ?? ''}`
        const bytesPerSec = (p.doneBytes ?? 0) / elapsed
        setTransferRows((prev) =>
          prev.map((r) =>
            r.key === key
              ? {
                  ...r,
                  filename: p.relativePath || p.filename,
                  transferred: p.doneBytes ?? r.transferred,
                  total: p.totalBytes ?? r.total,
                  speed: formatSpeed(bytesPerSec),
                  status: 'active',
                }
              : r,
          ),
        )
        return
      }
      const bytesPerSec = p.transferred / elapsed
      const key = `${p.op}:${p.filename}`
      setTransferRows((prev) =>
        prev.map((r) => {
          // Directory-drop uploads are keyed by the relative path (e.g.
          // `upload:sub/dir/a.txt`) while the backend emits only the basename
          // (`a.txt`); fall back to a basename suffix match on the active row.
          const matchKey = r.key === key
          const matchSuffix =
            !matchKey &&
            r.op === 'upload' &&
            r.status === 'active' &&
            p.filename.length > 0 &&
            r.filename.endsWith(`/${p.filename}`)
          return matchKey || matchSuffix
            ? {
                ...r,
                transferred: p.transferred,
                total: p.total,
                speed: formatSpeed(bytesPerSec),
                status: 'active',
              }
            : r
        }),
      )
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

  /* ---- upload ---- */
  const uploadFiles = useCallback(
    async (paths: string[]) => {
      setError('')
      setPaused(false)
      const rows: TransferRow[] = paths.map((localPath) => {
        const fileName = localPath.replace(/\\/g, '/').split('/').pop() || 'uploaded_file'
        return {
          key: `upload:${fileName}`,
          filename: fileName,
          op: 'upload',
          status: 'queued',
          transferred: 0,
          total: 0,
          speed: '',
        }
      })
      setTransferRows(rows)
      for (let i = 0; i < paths.length; i++) {
        const localPath = paths[i]
        const fileName = rows[i].filename
        const remotePath = join(currentPath, fileName)
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
          setTransferRows((prev) =>
            prev.map((r) => (r.key === rows[i].key ? { ...r, status: 'error' } : r)),
          )
          setError(`Upload ${fileName} failed: ${e}`)
          break
        }
      }
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
      setTransferRows(rows)

      // Create remote directories first (DFS pre-order = shallow → deep), so
      // empty directories are preserved and nested uploads always have parents.
      for (const d of dirs) {
        const mkKey = `mkdir:${d}`
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
      }

      for (const f of files) {
        const remotePath = join(targetDir, f.relPath)
        const key = `upload:${f.relPath}`
        setTransferRows((prev) => prev.map((r) => (r.key === key ? { ...r, status: 'active' } : r)))
        try {
          // Stream the file in ~64KB chunks. Loading it fully into a byte array
          // and shipping it through the Tauri JSON IPC is what made large
          // drag&drop uploads fail (memory + WebView message size limits).
          await fsUploadFileStream(target, remotePath, f.file, (transferred) => {
            setTransferRows((prev) =>
              prev.map((r) => (r.key === key ? { ...r, transferred } : r)),
            )
          })
          setTransferRows((prev) =>
            prev.map((r) => (r.key === key ? { ...r, status: 'done', transferred: r.total } : r)),
          )
        } catch (e) {
          setTransferRows((prev) =>
            prev.map((r) => (r.key === key ? { ...r, status: 'error' } : r)),
          )
          setError(`Upload ${f.relPath} failed: ${e}`)
          break
        }
      }
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
        setTransferRows([
          {
            key: `directory:${node.name}`,
            filename: node.name + '/',
            op: 'directory',
            status: 'queued',
            transferred: 0,
            total: 0,
            speed: '',
          },
        ])
        try {
          const summary = await fsDownloadDirectory(target, node.path, folder as string)
          setTransferRows((prev) =>
            prev.map((r) =>
              r.key === `directory:${node.name}`
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
          setTransferRows((prev) =>
            prev.map((r) => (r.key === `directory:${node.name}` ? { ...r, status: 'error' } : r)),
          )
          setError(String(e))
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
        setTransferRows([
          {
            key: `download:${node.name}`,
            filename: node.name,
            op: 'download',
            status: 'queued',
            transferred: 0,
            total: 0,
            speed: '',
          },
        ])
        try {
          await fsDownloadFile(target, node.path, filePath as string)
          setTransferRows((prev) =>
            prev.map((r) =>
              r.key === `download:${node.name}`
                ? { ...r, status: 'done', transferred: r.total }
                : r,
            ),
          )
        } catch (e) {
          setTransferRows((prev) =>
            prev.map((r) => (r.key === `download:${node.name}` ? { ...r, status: 'error' } : r)),
          )
          setError(String(e))
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
      key: `download:${file.name}`,
      filename: file.name,
      op: 'download',
      status: 'queued',
      transferred: 0,
      total: 0,
      speed: '',
    }))
    setTransferRows(rows)
    for (let i = 0; i < items.length; i++) {
      const { file, localPath } = items[i]
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
        setTransferRows((prev) =>
          prev.map((r) => (r.key === rows[i].key ? { ...r, status: 'error' } : r)),
        )
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
    const parts = currentPath.replace(/\/$/, '').split('/')
    parts.pop()
    const parent = parts.join('/') || '/'
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
              onClick={() => {
                const btn = document.activeElement as HTMLElement
                const r = btn?.getBoundingClientRect()
                setContextMenu({ x: r?.left ?? 0, y: (r?.bottom ?? 0) + 4, node: null })
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
            <span
              className={`file-path-up${currentPath === rootPath ? ' disabled' : ''}`}
              onClick={currentPath === rootPath ? undefined : navigateUp}
              title={t('parentDir')}
            >
              <Icon name="arrowUp" />
            </span>
            <span className="file-path-home" onClick={goHome} title={t('home')}>
              <Icon name="home" />
            </span>
            <span
              className="file-path-pin"
              onClick={() => setRoot(currentPath)}
              title={t('setAsRoot')}
            >
              <Icon name="pin" />
            </span>
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
            {rootPath !== '.' && (
              <span className="file-path-root" title={`Root directory: ${rootPath}`}>
                <Icon name="pin" /> {rootPath}
              </span>
            )}
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
            <div className="file-list" ref={fileListRef} onScroll={onFileScroll}>
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
                {sessionTabId != null && (
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
                        {row.status === 'done' && <span>✓</span>}
                        {row.status === 'queued' && <span>· · ·</span>}
                        {row.total > 0 && (
                          <span>
                            {' '}
                            {formatSize(row.transferred)} / {formatSize(row.total)} · {row.speed}
                          </span>
                        )}
                      </div>
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
            <div className="context-menu-item" onClick={() => setRoot(contextMenu.node!.path)}>
              <Icon name="pin" /> Set as root
            </div>
          )}
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

import React, { useState, useEffect, useCallback, useRef, useLayoutEffect, useImperativeHandle, useMemo, forwardRef, type ReactNode } from 'react'
import { listen } from '@tauri-apps/api/event'
import type { FileEntry, TargetRef } from '../types'
import { targetLabel } from '../types'
import { fsListFiles, fsUploadFile, fsUploadFileBytes, fsDownloadFile, fsDeleteFile, fsCreateDirectory, fsRenameFile, fsWriteFileContent, pauseTransfer, resumeTransfer, switchSftpUser, revertSftpUser, getSftpUser, sendInput, pollWorkingDir } from '../commands'
import { open, save } from '@tauri-apps/plugin-dialog'
import { useCustomScrollbar } from '../hooks/useCustomScrollbar'

/* ---------- types ---------- */

interface TransferProgress {
  tabId: number
  op: 'upload' | 'download'
  filename: string
  transferred: number
  total: number
  elapsed: number
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
  /**
   * Which remote filesystem this panel operates on. Defaults to the tab's main
   * session (`{ kind: 'session', tabId }`). Non-session targets disable
   * session-only features (shell sync, SFTP user switch, transfer pause).
   */
  targetRef?: TargetRef
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

function updateNode(nodes: TreeNode[], path: string, updater: (n: TreeNode) => TreeNode): TreeNode[] {
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

export const FilePanel = forwardRef<FileTreeHandle, FilePanelProps>(function FilePanel({
  tabId,
  isConnected,
  defaultPath = '.',
  expanded = true,
  onToggleExpanded,
  syncEnabled = false,
  onToggleSync,
  onEditFile,
  targetRef,
}, ref) {
  // The remote filesystem this panel operates on (defaults to the tab session).
  // Memoized by its serialized form so callbacks/effects get a stable identity.
  const targetKey = JSON.stringify(targetRef ?? { kind: 'session' as const, tabId })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const target: TargetRef = useMemo(() => JSON.parse(targetKey) as TargetRef, [targetKey])
  // Session-only tab id (null for jump/docker targets) — gates shell sync, SFTP
  // user switching and transfer pause, which only apply to the main connection.
  const sessionTabId = target.kind === 'session' ? target.tabId : null

  const [currentPath, setCurrentPath] = useState(defaultPath)
  const [rootPath, setRootPath] = useState(defaultPath)
  const [tree, setTree] = useState<TreeNode[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [selPath, setSelPath] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<{
    x: number; y: number; node: TreeNode | null
  } | null>(null)
  const [uploading, setUploading] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [paused, setPaused] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [transferStatus, setTransferStatus] = useState('')
  const [transferProgress, setTransferProgress] = useState<{
    transferred: number; total: number; speed: string
  } | null>(null)
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

  const cdToTerminal = useCallback(async (path: string) => {
    if (!syncRef.current || sessionTabId == null) return
    const cmd = path === '.' ? 'cd\n' : `cd "${path}"\n`
    try { await sendInput(sessionTabId, cmd) } catch { /* ignore */ }
  }, [sessionTabId])

  /* ---- tree load ---- */
  const loadRootDir = useCallback(async (path: string, sendCd = false) => {
    setLoading(true)
    setError('')
    setTransferProgress(null)
    try {
      const result = await fsListFiles(target, path)
      setTree(result.map(toNode))
      setCurrentPath(path)
      if (sendCd) cdToTerminal(path)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [target, cdToTerminal])

  // Refresh: re-load root + re-load any previously expanded directories
  const refresh = useCallback(async () => {
    setLoading(true)
    setError('')
    const reloadDir = async (path: string, prevMap?: Map<string, TreeNode>): Promise<TreeNode[]> => {
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
      loadRootDir(currentPath)
      if (sessionTabId != null) {
        getSftpUser(sessionTabId).then(setSftpUser).catch(() => {})
      }
    }
  }, [isConnected, sessionTabId, targetKey])

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
      } catch { /* ignore */ }
    }
    poll()
    const interval = setInterval(poll, 5000)
    return () => { active = false; clearInterval(interval) }
  }, [syncEnabled, isConnected, sessionTabId, loadRootDir])

  // Transfer progress events (main session only)
  useEffect(() => {
    if (sessionTabId == null) return
    const unlisten = listen<TransferProgress>('transfer-progress', (event) => {
      const p = event.payload
      if (p.tabId !== sessionTabId) return
      const elapsed = p.elapsed > 0 ? p.elapsed / 1000 : 0.001
      const bytesPerSec = p.transferred / elapsed
      setTransferProgress({
        transferred: p.transferred,
        total: p.total,
        speed: formatSpeed(bytesPerSec),
      })
    })
    return () => { unlisten.then(fn => fn()) }
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

  const toggleDir = useCallback(async (node: TreeNode) => {
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
  }, [target])

  /* ---- upload ---- */
  const uploadFiles = useCallback(async (paths: string[]) => {
    setUploading(true); setError(''); setPaused(false); setTransferProgress(null)
    const total = paths.length
    for (let i = 0; i < paths.length; i++) {
      const localPath = paths[i]
      const fileName = localPath.replace(/\\/g, '/').split('/').pop() || 'uploaded_file'
      const remotePath = join(currentPath, fileName)
      setTransferStatus(`Uploading ${i + 1}/${total}: ${fileName}`)
      try {
        await fsUploadFile(target, localPath, remotePath)
      } catch (e) {
        setError(`Upload ${fileName} failed: ${e}`); break
      }
    }
    setUploading(false); setPaused(false); setTransferStatus('')
    refresh()
  }, [target, currentPath, refresh])

  const handleDropUpload = useCallback(async (fileList: FileList) => {
    setUploading(true); setError(''); setPaused(false); setTransferProgress(null)
    const total = fileList.length
    for (let i = 0; i < fileList.length; i++) {
      const file = fileList[i]
      const remotePath = join(currentPath, file.name)
      setTransferStatus(`Uploading ${i + 1}/${total}: ${file.name}`)
      try {
        const buf = await file.arrayBuffer()
        const bytes = Array.from(new Uint8Array(buf))
        await fsUploadFileBytes(target, remotePath, bytes)
      } catch (e) {
        setError(`Upload ${file.name} failed: ${e}`); break
      }
    }
    setUploading(false); setPaused(false); setTransferStatus('')
    refresh()
  }, [target, currentPath, refresh])

  // HTML5 drag-drop
  useEffect(() => {
    const panel = panelRef.current; if (!panel) return
    const onDragOver = (e: DragEvent) => {
      e.preventDefault(); e.stopPropagation()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
      setDragOver(true)
    }
    const onDragLeave = (e: DragEvent) => {
      e.preventDefault(); e.stopPropagation()
      if (!panel.contains(e.relatedTarget as Node)) setDragOver(false)
    }
    const onDrop = (e: DragEvent) => {
      e.preventDefault(); e.stopPropagation()
      setDragOver(false)
      if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
        handleDropUpload(e.dataTransfer.files)
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
    } catch (e) { setError(String(e)) }
  }

  /* ---- context-menu actions ---- */

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
    } catch (e) { setError(String(e)) }
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
    } catch (e) { setError(String(e)) }
  }

  const handleRename = async (node: TreeNode) => {
    setContextMenu(null)
    const newName = window.prompt('New name:', node.name)
    if (!newName || newName === node.name) return
    const parent = getParentDir(node.path)
    try {
      await fsRenameFile(target, node.path, join(parent, newName))
      refresh()
    } catch (e) { setError(String(e)) }
  }

  const handleDelete = async (node: TreeNode) => {
    setContextMenu(null)
    const msg = node.isDir
      ? `Delete directory "${node.name}" and all its contents?`
      : `Delete file "${node.name}"?`
    if (!window.confirm(msg)) return
    try {
      await fsDeleteFile(target, node.path, node.isDir)
      refresh()
    } catch (e) { setError(String(e)) }
  }

  const handleDownload = async (node: TreeNode) => {
    setContextMenu(null)
    if (node.isDir) { setError('Downloading directories is not supported yet'); return }
    try {
      const filePath = await save({ title: 'Save file as', defaultPath: node.name })
      if (filePath) {
        setDownloading(true); setPaused(false)
        setTransferStatus(`Downloading: ${node.name}`)
        setTransferProgress(null)
        await fsDownloadFile(target, node.path, filePath as string)
        setDownloading(false); setPaused(false); setTransferStatus('')
      }
    } catch (e) { setDownloading(false); setTransferStatus(''); setError(String(e)) }
  }

  const handleEdit = (node: TreeNode) => {
    setContextMenu(null)
    onEditFile?.(target, node.path)
  }

  /* ---- SFTP user (main session only) ---- */
  const handleSwitchUser = async () => {
    if (sessionTabId == null) return
    const name = switchUsername.trim(); const pw = switchPassword
    if (!name || !pw) { setError('Username and password are required'); return }
    try {
      await switchSftpUser(sessionTabId, name, pw)
      setSftpUser(name); setShowSwitchUser(false)
      setSwitchUsername(''); setSwitchPassword(''); setError('')
    } catch (e) { setError(String(e)) }
  }
  const handleRevertUser = async () => {
    if (sessionTabId == null) return
    try { await revertSftpUser(sessionTabId); setSftpUser(null); setError('') }
    catch (e) { setError(String(e)) }
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
  const goHome = () => { setRootPath('.'); loadRootDir('.', true) }

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
    } else if (window.confirm(`"${norm}" is outside the current root directory.\nSet it as the new root?`)) {
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
    if (paused) { setPaused(false); await resumeTransfer(sessionTabId) }
    else { setPaused(true); await pauseTransfer(sessionTabId) }
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

  /* ---- node click ---- */
  const handleNodeClick = (node: TreeNode) => {
    setSelPath(node.path)
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
          className={`tree-row ${selPath === node.path ? 'selected' : ''} ${node.isDir ? 'dir' : 'file'}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => handleNodeClick(node)}
          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setContextMenu({ x: e.clientX, y: e.clientY, node }) }}
          title={node.path}
        >
          <span className="tree-icon">
            {node.isDir ? (node.expanded ? '📂' : '📁') : '📄'}
          </span>
          <span className="tree-name">{node.name}</span>
          {node.isDir ? null : <span className="tree-size">{formatSize(node.size)}</span>}
          {node.loading && <span className="tree-spinner">⏳</span>}
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
          {sessionTabId == null && (
            <span
              className={`file-target-chip ${target.kind === 'docker' ? 'docker' : ''}${target.kind === 'dockerSsh' ? 'docker-ssh' : ''}`}
              title={targetLabel(target)}
            >{targetLabel(target)}</span>
          )}
        </span>
        {expanded && (
          <div className="file-toolbar">
            {onToggleSync && sessionTabId != null && (
              <button
                title={syncEnabled ? 'Disable shell sync' : 'Enable shell sync (cd terminal ↔ files)'}
                onClick={onToggleSync}
                className={syncEnabled ? 'sync-active' : ''}
              >🔗</button>
            )}
            {sessionTabId != null && (sftpUser ? (
              <>
                <span className="file-sftp-user" title={`SFTP as: ${sftpUser}`}>🔒{sftpUser}</span>
                <button title="Restore original user" onClick={handleRevertUser}>↩</button>
              </>
            ) : (
              <button title="Switch SFTP user" onClick={() => setShowSwitchUser(!showSwitchUser)}>👤</button>
            ))}
            <button title="Upload" onClick={handleUpload}>📤</button>
            <button title="New item" onClick={() => {
              const btn = document.activeElement as HTMLElement
              const r = btn?.getBoundingClientRect()
              setContextMenu({ x: r?.left ?? 0, y: (r?.bottom ?? 0) + 4, node: null })
            }}>＋</button>
            <button title="Refresh" onClick={refresh} disabled={loading}>🔄</button>
          </div>
        )}
      </div>

      {expanded && (
        <>
          <div className="file-path-bar">
            <span
              className={`file-path-up${currentPath === rootPath ? ' disabled' : ''}`}
              onClick={currentPath === rootPath ? undefined : navigateUp}
              title="Parent"
            >⬆</span>
            <span className="file-path-home" onClick={goHome} title="Home">🏠</span>
            <span className="file-path-pin" onClick={() => setRoot(currentPath)} title="Set current directory as root">📌</span>
            {editingPath ? (
              <input className="file-path-input" type="text" value={editPathValue}
                onChange={(e) => setEditPathValue(e.target.value)}
                onBlur={commitEditPath} onKeyDown={handlePathKeyDown}
                placeholder="Enter path..." autoFocus />
            ) : (
              <span className="file-path-text" title={pathDisplay} onClick={startEditPath}>
                {pathDisplay}
              </span>
            )}
            {rootPath !== '.' && (
              <span className="file-path-root" title={`Root directory: ${rootPath}`}>📌 {rootPath}</span>
            )}
          </div>

          {showSwitchUser && (
            <div className="file-switch-user">
              <input type="text" placeholder="Username" value={switchUsername}
                onChange={(e) => setSwitchUsername(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleSwitchUser() }} />
              <input type="password" placeholder="Password" value={switchPassword}
                onChange={(e) => setSwitchPassword(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleSwitchUser() }} />
              <button onClick={handleSwitchUser}>Switch</button>
              <button onClick={() => setShowSwitchUser(false)}>✕</button>
            </div>
          )}

          <div className="file-list-wrapper"
            onMouseEnter={onFileMouseEnter} onMouseLeave={onFileMouseLeave}>
            <div className="file-list" ref={fileListRef} onScroll={onFileScroll}>
              {error && <div className="file-error">{error}</div>}
              {!loading && renderNodes(tree, 0)}
              {!loading && tree.length === 0 && !error && (
                <div className="file-empty">Empty directory</div>
              )}
            </div>

            {fileThumbHeight > 0 && (
              <div className={`sidebar-scrollbar${fileShowThumb ? ' show' : ''}`}>
                <div className="sidebar-scrollbar-thumb"
                  style={{ height: fileThumbHeight, top: fileThumbTop }}
                  onMouseDown={onFileThumbMouseDown} />
              </div>
            )}
          </div>

          {(loading || uploading || downloading || transferProgress) && (
            <div className="file-loading">
              {transferStatus ? (
                <>
                  <div className="file-progress-bar">
                    <div className="file-progress-fill" style={
                      transferProgress && transferProgress.total > 0
                        ? { width: `${(transferProgress.transferred / transferProgress.total) * 100}%`, animation: 'none' }
                        : undefined
                    } />
                  </div>
                  <span>{transferStatus}</span>
                  {sessionTabId != null && (
                    <button className="file-pause-btn" onClick={togglePause} title={paused ? 'Resume' : 'Pause'}>
                      {paused ? '▶' : '⏸'}
                    </button>
                  )}
                  {transferProgress && transferProgress.total > 0 && (
                    <span className="file-progress-detail">
                      {formatSize(transferProgress.transferred)} / {formatSize(transferProgress.total)} · {transferProgress.speed}
                    </span>
                  )}
                </>
              ) : (
                <span>{uploading ? 'Uploading...' : downloading ? 'Downloading...' : 'Loading...'}</span>
              )}
            </div>
          )}
        </>
      )}

      {/* context menu */}
      {contextMenu && (
        <div ref={contextMenuRef} className="context-menu" style={contextMenuStyle}
          onClick={(e) => e.stopPropagation()}>
          {contextMenu.node && !contextMenu.node.isDir && (
            <div className="context-menu-item" onClick={() => handleEdit(contextMenu.node!)}>
              ✏️ Open
            </div>
          )}
          {contextMenu.node && !contextMenu.node.isDir && (
            <div className="context-menu-item" onClick={() => handleDownload(contextMenu.node!)}>
              📥 Download
            </div>
          )}
          {contextMenu.node && contextMenu.node.isDir && (
            <div className="context-menu-item" onClick={() => setRoot(contextMenu.node!.path)}>
              📌 Set as root
            </div>
          )}
          {contextMenu.node && <div className="context-menu-divider" />}
          <div className="context-menu-item" onClick={() => newFile(contextMenu.node)}>
            📄 New File
          </div>
          <div className="context-menu-item" onClick={() => newFolder(contextMenu.node)}>
            📁 New Folder
          </div>
          {contextMenu.node && <div className="context-menu-divider" />}
          {contextMenu.node && (
            <div className="context-menu-item" onClick={() => handleRename(contextMenu.node!)}>
              ✏️ Rename
            </div>
          )}
          {contextMenu.node && (
            <div className="context-menu-item" onClick={() => handleDelete(contextMenu.node!)}>
              🗑️ Delete
            </div>
          )}
          {(!contextMenu.node) && <div className="context-menu-divider" />}
          {(!contextMenu.node) && (
            <div className="context-menu-item" onClick={handleUpload}>📤 Upload here</div>
          )}
        </div>
      )}
    </div>
  )
})

// Keep default export for existing imports
export default FilePanel

import { useState, useEffect, useCallback, useRef, useLayoutEffect } from 'react'
import { listen } from '@tauri-apps/api/event'
import type { FileEntry } from '../types'
import { listFiles, uploadFile, uploadFileBytes, downloadFile, deleteFile, createDirectory, renameFile, pauseTransfer, resumeTransfer, switchSftpUser, revertSftpUser, getSftpUser } from '../commands'
import { open, save } from '@tauri-apps/plugin-dialog'

interface TransferProgress {
  tabId: number
  op: 'upload' | 'download'
  filename: string
  transferred: number
  total: number
  elapsed: number
}

interface FilePanelProps {
  tabId: number
  isConnected: boolean
  defaultPath?: string
  expanded?: boolean
  onToggleExpanded?: () => void
}

export const FilePanel: React.FC<FilePanelProps> = ({ tabId, isConnected, defaultPath = '.', expanded = true, onToggleExpanded }) => {
  const [currentPath, setCurrentPath] = useState(defaultPath)
  const [files, setFiles] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    entry: FileEntry | null
  } | null>(null)
  const [uploading, setUploading] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [paused, setPaused] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [transferStatus, setTransferStatus] = useState('')
  const [transferProgress, setTransferProgress] = useState<{ transferred: number; total: number; speed: string } | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const [contextMenuStyle, setContextMenuStyle] = useState<React.CSSProperties>({})
  const [sftpUser, setSftpUser] = useState<string | null>(null)
  const [showSwitchUser, setShowSwitchUser] = useState(false)
  const [switchUsername, setSwitchUsername] = useState('')
  const [switchPassword, setSwitchPassword] = useState('')

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

  const loadDir = useCallback(async (path: string) => {
    setLoading(true)
    setError('')
    setTransferProgress(null)
    try {
      const result = await listFiles(tabId, path)
      setFiles(result)
      setCurrentPath(path)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [tabId])

  useEffect(() => {
    if (isConnected) {
      loadDir(currentPath)
      getSftpUser(tabId).then(setSftpUser).catch(() => {})
    }
  }, [isConnected, tabId])

  // Listen for transfer progress events from Rust
  useEffect(() => {
    const unlisten = listen<TransferProgress>('transfer-progress', (event) => {
      const p = event.payload
      if (p.tabId !== tabId) return
      const elapsed = p.elapsed > 0 ? p.elapsed / 1000 : 0.001
      const bytesPerSec = p.transferred / elapsed
      const speed = formatSpeed(bytesPerSec)
      setTransferProgress({ transferred: p.transferred, total: p.total, speed })
    })
    return () => { unlisten.then(fn => fn()) }
  }, [tabId])

  // Close context menu on click outside
  useEffect(() => {
    const handler = () => setContextMenu(null)
    document.addEventListener('click', handler)
    return () => document.removeEventListener('click', handler)
  }, [])

  // Adjust context menu position to avoid clipping at window edges
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

  // Upload files to current remote directory
  const uploadFiles = useCallback(async (paths: string[]) => {
    console.log('[FilePanel] uploadFiles called with paths:', paths)
    setUploading(true)
    setError('')
    setPaused(false)
    setTransferProgress(null)

    const total = paths.length
    for (let i = 0; i < paths.length; i++) {
      const localPath = paths[i]
      const fileName = localPath.replace(/\\/g, '/').split('/').pop() || 'uploaded_file'
      const remotePath = currentPath === '/' || currentPath.endsWith('/')
        ? `${currentPath}${fileName}`
        : `${currentPath}/${fileName}`
      
      setTransferStatus(`Uploading ${i + 1}/${total}: ${fileName}`)
      console.log('[FilePanel] Uploading:', localPath, '->', remotePath)
      
      try {
        await uploadFile(tabId, localPath, remotePath)
        console.log('[FilePanel] Upload success:', fileName)
      } catch (e) {
        console.error('[FilePanel] Upload failed:', e)
        setError(`Upload ${fileName} failed: ${e}`)
        break
      }
    }
    
    setUploading(false)
    setPaused(false)
    setTransferStatus('')
    // Keep last progress visible so user can see final speed/size
    loadDir(currentPath)
  }, [tabId, currentPath, loadDir])

  // Upload files from HTML5 drop (FileList → read bytes → uploadFileBytes)
  const handleDropUpload = useCallback(async (fileList: FileList) => {
    console.log('[FilePanel] handleDropUpload:', fileList.length, 'files')
    setUploading(true)
    setError('')
    setPaused(false)
    setTransferProgress(null)
    setTransferProgress(null)

    const total = fileList.length
    for (let i = 0; i < fileList.length; i++) {
      const file = fileList[i]
      const remotePath = currentPath === '/' || currentPath.endsWith('/')
        ? `${currentPath}${file.name}`
        : `${currentPath}/${file.name}`

      setTransferStatus(`Uploading ${i + 1}/${total}: ${file.name}`)
      console.log('[FilePanel] Drop uploading:', file.name, '->', remotePath, `(${file.size} bytes)`)

      try {
        const buf = await file.arrayBuffer()
        const bytes = Array.from(new Uint8Array(buf))
        await uploadFileBytes(tabId, remotePath, bytes)
        console.log('[FilePanel] Drop upload success:', file.name)
      } catch (e) {
        console.error('[FilePanel] Drop upload failed:', e)
        setError(`Upload ${file.name} failed: ${e}`)
        break
      }
    }

    setUploading(false)
    setPaused(false)
    setTransferStatus('')
    loadDir(currentPath)
  }, [tabId, currentPath, loadDir])

  // HTML5 native drag-drop listeners
  useEffect(() => {
    const panel = panelRef.current
    if (!panel) return

    console.log('[FilePanel] Setting up HTML5 drag-drop listeners...')

    const onDragOver = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'copy'
      }
      setDragOver(true)
    }

    const onDragLeave = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      // Only set false if actually leaving the panel (not entering a child element)
      if (!panel.contains(e.relatedTarget as Node)) {
        setDragOver(false)
      }
    }

    const onDrop = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setDragOver(false)
      console.log('[FilePanel] HTML5 drop event, dataTransfer:', !!e.dataTransfer)
      if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
        console.log('[FilePanel] Got', e.dataTransfer.files.length, 'file(s) from drop')
        handleDropUpload(e.dataTransfer.files)
      } else {
        console.log('[FilePanel] No files in drop event')
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

  const navigateUp = () => {
    if (currentPath === '/' || currentPath === '.') return
    const parts = currentPath.replace(/\/$/, '').split('/')
    parts.pop()
    const parent = parts.join('/') || '/'
    loadDir(parent)
  }

  const goHome = () => {
    loadDir('.')
  }

  const handleEntryClick = (entry: FileEntry) => {
    if (entry.isDir) {
      loadDir(entry.path)
    }
  }

  const handleEntryContextMenu = (e: React.MouseEvent, entry: FileEntry) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY, entry })
  }

  // Upload via button or context menu
  const handleUpload = async () => {
    setContextMenu(null)
    try {
      const selected = await open({
        multiple: true,
        title: 'Select files to upload',
      })
      if (!selected) return

      const paths = Array.isArray(selected) ? selected : [selected]
      if (paths.length > 0) {
        await uploadFiles(paths)
      }
    } catch (e) {
      setError(String(e))
    }
  }

  const handleDownload = async (entry: FileEntry) => {
    setContextMenu(null)
    if (entry.isDir) {
      setError('Downloading directories is not supported yet')
      return
    }
    try {
      const filePath = await save({
        title: 'Save file as',
        defaultPath: entry.name,
      })
      if (filePath) {
        setDownloading(true)
        setPaused(false)
        setTransferStatus(`Downloading: ${entry.name}`)
        setTransferProgress(null)
        await downloadFile(tabId, entry.path, filePath as string)
        setDownloading(false)
        setPaused(false)
        setTransferStatus('')
      }
    } catch (e) {
      setDownloading(false)
      setTransferStatus('')
      setError(String(e))
    }
  }

  const handleDelete = async (entry: FileEntry) => {
    setContextMenu(null)
    const msg = entry.isDir
      ? `Delete directory "${entry.name}" and all its contents?`
      : `Delete file "${entry.name}"?`
    if (!confirm(msg)) return
    try {
      await deleteFile(tabId, entry.path, entry.isDir)
      loadDir(currentPath)
    } catch (e) {
      setError(String(e))
    }
  }

  const handleNewDir = async () => {
    setContextMenu(null)
    const name = prompt('Directory name:')
    if (!name) return
    try {
      const path = currentPath === '/' || currentPath.endsWith('/')
        ? `${currentPath}${name}`
        : `${currentPath}/${name}`
      await createDirectory(tabId, path)
      loadDir(currentPath)
    } catch (e) {
      setError(String(e))
    }
  }

  const togglePause = async () => {
    if (paused) {
      setPaused(false)
      await resumeTransfer(tabId)
    } else {
      setPaused(true)
      await pauseTransfer(tabId)
    }
  }

  const handleSwitchUser = async () => {
    const name = switchUsername.trim()
    const pw = switchPassword
    if (!name || !pw) {
      setError('Username and password are required')
      return
    }
    try {
      await switchSftpUser(tabId, name, pw)
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
    try {
      await revertSftpUser(tabId)
      setSftpUser(null)
      setError('')
    } catch (e) {
      setError(String(e))
    }
  }

  const handleRename = async (entry: FileEntry) => {
    setContextMenu(null)
    const newName = prompt('New name:', entry.name)
    if (!newName || newName === entry.name) return
    try {
      const parent = currentPath === '/' || currentPath.endsWith('/') ? currentPath : `${currentPath}/`
      await renameFile(tabId, entry.path, `${parent}${newName}`)
      loadDir(currentPath)
    } catch (e) {
      setError(String(e))
    }
  }

  const [editingPath, setEditingPath] = useState(false)
  const [editPathValue, setEditPathValue] = useState('')
  const [listHovered, setListHovered] = useState(false)

  const pathDisplay = currentPath === '.' ? '~ (home)' : currentPath

  const startEditPath = () => {
    setEditPathValue(currentPath === '.' ? '' : currentPath)
    setEditingPath(true)
  }

  const commitEditPath = () => {
    setEditingPath(false)
    const trimmed = editPathValue.trim()
    if (trimmed && trimmed !== (currentPath === '.' ? '' : currentPath)) {
      loadDir(trimmed)
    }
  }

  const cancelEditPath = () => {
    setEditingPath(false)
  }

  const handlePathKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      commitEditPath()
    } else if (e.key === 'Escape') {
      cancelEditPath()
    }
  }

  return (
    <div
      ref={panelRef}
      className={`file-panel ${dragOver ? 'drag-over' : ''}`}
    >
      <div className="file-panel-header">
        <span
          className="collapse-chevron"
          onClick={onToggleExpanded}
          title={expanded ? 'Collapse' : 'Expand'}
        >
          {expanded ? '▼' : '▶'}
        </span>
        <span style={{ flex: 1 }}>Files</span>
        {expanded && (
          <div className="file-toolbar">
            {sftpUser ? (
              <>
                <span className="file-sftp-user" title={`SFTP operations as: ${sftpUser}`}>🔒{sftpUser}</span>
                <button title="Restore original user" onClick={handleRevertUser}>↩</button>
              </>
            ) : (
              <button title="Switch SFTP user" onClick={() => setShowSwitchUser(!showSwitchUser)}>👤</button>
            )}
            <button title="Upload file" onClick={handleUpload}>📤</button>
            <button title="New folder" onClick={handleNewDir}>📁+</button>
            <button title="Refresh" onClick={() => loadDir(currentPath)} disabled={loading}>
              🔄
            </button>
          </div>
        )}
      </div>

      {expanded && (
        <>
          <div className="file-path-bar">
            <span className="file-path-up" onClick={navigateUp} title="Parent directory">⬆</span>
            <span className="file-path-home" onClick={goHome} title="Home directory">🏠</span>
            {editingPath ? (
              <input
                className="file-path-input"
                type="text"
                value={editPathValue}
                onChange={(e) => setEditPathValue(e.target.value)}
                onBlur={commitEditPath}
                onKeyDown={handlePathKeyDown}
                placeholder="Enter path..."
                autoFocus
              />
            ) : (
              <span className="file-path-text" title={pathDisplay} onClick={startEditPath}>
                {pathDisplay}
              </span>
            )}
          </div>

          {showSwitchUser && (
            <div className="file-switch-user">
              <input
                type="text"
                placeholder="Username"
                value={switchUsername}
                onChange={(e) => setSwitchUsername(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleSwitchUser() }}
              />
              <input
                type="password"
                placeholder="Password"
                value={switchPassword}
                onChange={(e) => setSwitchPassword(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleSwitchUser() }}
              />
              <button onClick={handleSwitchUser}>Switch</button>
              <button onClick={() => setShowSwitchUser(false)}>✕</button>
            </div>
          )}

          <div
            className={`file-list${listHovered ? ' show-scrollbar' : ''}`}
            onMouseEnter={() => setListHovered(true)}
            onMouseLeave={() => setListHovered(false)}
          >
            {error && <div className="file-error">{error}</div>}
            {!loading &&
              files.map((f) => (
                <div
                  key={f.path}
                  className={`file-entry ${f.isDir ? 'is-dir' : ''}`}
                  onClick={() => handleEntryClick(f)}
                  onContextMenu={(e) => handleEntryContextMenu(e, f)}
                >
                  <span className="file-icon">{f.isDir ? '📁' : '📄'}</span>
                  <span className="file-name" title={f.name}>{f.name}</span>
                  <span className="file-size">{f.isDir ? '' : formatSize(f.size)}</span>
                </div>
              ))}
            {!loading && files.length === 0 && !error && (
              <div className="file-empty">Empty directory</div>
            )}
          </div>

          {(loading || uploading || downloading || transferProgress) && (
            <div className="file-loading">
              {transferStatus ? (
                <>
                  <div className="file-progress-bar">
                    <div
                      className="file-progress-fill"
                      style={
                        transferProgress && transferProgress.total > 0
                          ? { width: `${(transferProgress.transferred / transferProgress.total) * 100}%`, animation: 'none' }
                          : undefined
                      }
                    />
                  </div>
                  <span>{transferStatus}</span>
                  <button
                    className="file-pause-btn"
                    onClick={togglePause}
                    title={paused ? 'Resume' : 'Pause'}
                  >
                    {paused ? '▶' : '⏸'}
                  </button>
                  {transferProgress && transferProgress.total > 0 && (
                    <span className="file-progress-detail">
                      {formatSize(transferProgress.transferred)} / {formatSize(transferProgress.total)} · {transferProgress.speed}
                    </span>
                  )}
                </>
              ) : transferProgress && transferProgress.total > 0 ? (
                <>
                  <div className="file-progress-bar">
                    <div className="file-progress-fill" style={{ width: '100%', animation: 'none' }} />
                  </div>
                  <span className="file-progress-detail">
                    Completed · {formatSize(transferProgress.transferred)} · {transferProgress.speed}
                  </span>
                </>
              ) : (
                <span>{uploading ? 'Uploading...' : downloading ? 'Downloading...' : 'Loading...'}</span>
              )}
            </div>
          )}
        </>
      )}

      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="context-menu"
          style={contextMenuStyle}
          onClick={(e) => e.stopPropagation()}
        >
          {contextMenu.entry && !contextMenu.entry.isDir && (
            <div className="context-menu-item" onClick={() => handleDownload(contextMenu.entry!)}>
              📥 Download
            </div>
          )}
          {contextMenu.entry && (
            <>
              <div className="context-menu-item" onClick={() => handleRename(contextMenu.entry!)}>
                ✏️ Rename
              </div>
              <div className="context-menu-item" onClick={() => handleDelete(contextMenu.entry!)}>
                🗑️ Delete
              </div>
            </>
          )}
          <div className="context-menu-divider" />
          <div className="context-menu-item" onClick={handleUpload}>
            📤 Upload here
          </div>
          <div className="context-menu-item" onClick={handleNewDir}>
            📁 New folder
          </div>
        </div>
      )}
    </div>
  )
}

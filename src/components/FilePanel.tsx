import { useState, useEffect, useCallback, useRef } from 'react'
import type { FileEntry } from '../types'
import { listFiles, uploadFile, uploadFileBytes, downloadFile, deleteFile, createDirectory, renameFile } from '../commands'
import { open } from '@tauri-apps/plugin-dialog'

interface FilePanelProps {
  tabId: number
  isConnected: boolean
  defaultPath?: string
}

export const FilePanel: React.FC<FilePanelProps> = ({ tabId, isConnected, defaultPath = '.' }) => {
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
  const [dragOver, setDragOver] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)

  const loadDir = useCallback(async (path: string) => {
    setLoading(true)
    setError('')
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
    }
  }, [isConnected, tabId])

  // Close context menu on click outside
  useEffect(() => {
    const handler = () => setContextMenu(null)
    document.addEventListener('click', handler)
    return () => document.removeEventListener('click', handler)
  }, [])

  // Upload files to current remote directory
  const uploadFiles = useCallback(async (paths: string[]) => {
    console.log('[FilePanel] uploadFiles called with paths:', paths)

    for (const localPath of paths) {
      const fileName = localPath.replace(/\\/g, '/').split('/').pop() || 'uploaded_file'
      const remotePath = currentPath === '/' || currentPath.endsWith('/')
        ? `${currentPath}${fileName}`
        : `${currentPath}/${ fileName}`
      
      console.log('[FilePanel] Uploading:', localPath, '->', remotePath)
      
      try {
        setUploading(true)
        setError('')
        await uploadFile(tabId, localPath, remotePath)
        console.log('[FilePanel] Upload success:', fileName)
      } catch (e) {
        console.error('[FilePanel] Upload failed:', e)
        setError(`Upload ${fileName} failed: ${e}`)
        break
      }
    }
    
    setUploading(false)
    loadDir(currentPath)
  }, [tabId, currentPath, loadDir])

  // Upload files from HTML5 drop (FileList → read bytes → uploadFileBytes)
  const handleDropUpload = useCallback(async (fileList: FileList) => {
    console.log('[FilePanel] handleDropUpload:', fileList.length, 'files')
    setUploading(true)
    setError('')

    for (let i = 0; i < fileList.length; i++) {
      const file = fileList[i]
      const remotePath = currentPath === '/' || currentPath.endsWith('/')
        ? `${currentPath}${file.name}`
        : `${currentPath}/${file.name}`

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
      const filePath = await open({
        title: 'Save file as',
        defaultPath: entry.name,
      })
      if (filePath) {
        const path = typeof filePath === 'string' ? filePath : (filePath as { path: string }).path
        await downloadFile(tabId, entry.path, path)
      }
    } catch (e) {
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

  const [editingPath, setEditingPath] = useState(false)
  const [editPathValue, setEditPathValue] = useState('')

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
        <span>Files</span>
        <div className="file-toolbar">
          <button title="Upload file" onClick={handleUpload}>📤</button>
          <button title="New folder" onClick={handleNewDir}>📁+</button>
          <button title="Refresh" onClick={() => loadDir(currentPath)} disabled={loading}>
            🔄
          </button>
        </div>
      </div>

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

      <div className="file-list">
        {loading && <div className="file-loading">{uploading ? 'Uploading...' : 'Loading...'}</div>}
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

      {contextMenu && (
        <div
          className="context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
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

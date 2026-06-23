import { useState, useEffect, useCallback } from 'react'
import type { FileEntry } from '../types'
import { listFiles, uploadFile, downloadFile, deleteFile, createDirectory, renameFile } from '../commands'
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

  const navigateTo = (path: string) => {
    loadDir(path)
  }

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

  const handleUpload = async () => {
    setContextMenu(null)
    try {
      const selected = await open({
        multiple: true,
        title: 'Select files to upload',
      })
      if (!selected) return

      const paths = Array.isArray(selected) ? selected : [selected]
      if (paths.length === 0) return

      for (const localPath of paths) {
        const fileName = localPath.replace(/\\/g, '/').split('/').pop() || 'uploaded_file'
        const remotePath = currentPath.endsWith('/')
          ? `${currentPath}${fileName}`
          : `${currentPath}/${fileName}`
        try {
          await uploadFile(tabId, localPath, remotePath)
        } catch (e) {
          setError(`Upload ${fileName} failed: ${e}`)
        }
      }
      loadDir(currentPath)
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
        const path = typeof filePath === 'string' ? filePath : filePath.path
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
      const path = currentPath.endsWith('/')
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
      const parent = currentPath.endsWith('/') ? currentPath : `${currentPath}/`
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

  const pathDisplay = currentPath === '.' ? '~ (home)' : currentPath

  return (
    <div className="file-panel">
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
        <span className="file-path-up" onClick={navigateUp} title="Parent directory">
          ⬆
        </span>
        <span className="file-path-home" onClick={goHome} title="Home directory">
          🏠
        </span>
        <span className="file-path-text" title={pathDisplay}>
          {pathDisplay}
        </span>
      </div>

      <div className="file-list">
        {loading && <div className="file-loading">Loading...</div>}
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

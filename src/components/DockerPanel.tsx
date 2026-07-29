import React, { useCallback, useEffect, useState } from 'react'
import type { ContainerInfo } from '../types'
import { listDockerContainers } from '../commands'
import { Icon } from './Icon'

interface DockerPanelProps {
  /** Connected (jump host) tab used to run `docker ps` / `docker exec`. */
  jumpTabId: number
  expanded?: boolean
  onToggleExpanded?: () => void
  /** Currently-opened container name (its filesystem is shown in the Files panel). */
  activeContainer?: string | null
  onOpenContainer: (container: ContainerInfo) => void
  /** Enter a shell inside the container (opens new terminal tab). */
  onEnterShell?: (container: ContainerInfo) => void
}

/**
 * Lists Docker containers reachable from the connected host. Clicking a
 * container opens its filesystem in the Files panel via a `docker` TargetRef.
 * Right-clicking a running container shows a context menu to open a shell.
 */
export const DockerPanel: React.FC<DockerPanelProps> = ({
  jumpTabId,
  expanded = true,
  onToggleExpanded,
  activeContainer,
  onOpenContainer,
  onEnterShell,
}) => {
  const [containers, setContainers] = useState<ContainerInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; container: ContainerInfo } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setContainers(await listDockerContainers(jumpTabId))
    } catch (e) {
      setError(String(e))
      setContainers([])
    } finally {
      setLoading(false)
    }
  }, [jumpTabId])

  useEffect(() => {
    load()
  }, [load])

  // Close context menu on click elsewhere
  useEffect(() => {
    const close = () => setCtxMenu(null)
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [])

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, container: ContainerInfo) => {
      e.preventDefault()
      e.stopPropagation()
      // Only show the menu for running containers
      if (container.state !== 'running') return
      setCtxMenu({ x: e.clientX, y: e.clientY, container })
    },
    [],
  )

  const handleEnterShell = useCallback(() => {
    if (!ctxMenu || !onEnterShell) return
    onEnterShell(ctxMenu.container)
    setCtxMenu(null)
  }, [ctxMenu, onEnterShell])

  return (
    <div className="docker-panel">
      <div className="docker-panel-header">
        <span
          className={`collapse-chevron${expanded ? ' expanded' : ''}`}
          onClick={onToggleExpanded}
          title={expanded ? 'Collapse' : 'Expand'}
        />
        <span style={{ flex: 1 }}>Docker</span>
        {expanded && (
          <button className="docker-refresh" title="Refresh containers" onClick={load} disabled={loading}>
            <Icon name="refresh" />
          </button>
        )}
      </div>
      {expanded && (
        <div className="docker-list">
          {error && <div className="file-error">{error}</div>}
          {loading && <div className="file-empty">Loading…</div>}
          {!loading && !error && containers.length === 0 && (
            <div className="file-empty">No containers (or docker not available)</div>
          )}
          {containers.map((c) => (
            <div
              key={c.id}
              className={`docker-item${activeContainer === c.name ? ' active' : ''}`}
              onClick={() => onOpenContainer(c)}
              onContextMenu={(e) => handleContextMenu(e, c)}
              title={`${c.name}\n${c.image}\n${c.status}${c.state === 'running' ? '\n\nRight-click → Enter shell' : ''}\n\nClick to ${activeContainer === c.name ? 'close' : 'browse'} files`}
            >
              <span className="docker-icon"><Icon name="container" /></span>
              <div className="docker-info">
                <div className="docker-name">{c.name}</div>
                <div className="docker-image">{c.image}</div>
              </div>
              <span className={`docker-state ${c.state}`}>{c.state}</span>
            </div>
          ))}
        </div>
      )}

      {/* Context menu */}
      {ctxMenu && (
        <div
          className="context-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="context-menu-item" onClick={handleEnterShell}>
            <Icon name="terminal" size={14} />
            Enter Shell
          </div>
        </div>
      )}
    </div>
  )
}

export default DockerPanel

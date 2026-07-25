import React, { useCallback, useEffect, useState } from 'react'
import type { ContainerInfo } from '../types'
import { listDockerContainers } from '../commands'

interface DockerPanelProps {
  /** Connected (jump host) tab used to run `docker ps` / `docker exec`. */
  jumpTabId: number
  expanded?: boolean
  onToggleExpanded?: () => void
  /** Currently-opened container name (its filesystem is shown in the Files panel). */
  activeContainer?: string | null
  onOpenContainer: (container: ContainerInfo) => void
}

/**
 * Lists Docker containers reachable from the connected host. Clicking a
 * container opens its filesystem in the Files panel via a `docker` TargetRef.
 */
export const DockerPanel: React.FC<DockerPanelProps> = ({
  jumpTabId,
  expanded = true,
  onToggleExpanded,
  activeContainer,
  onOpenContainer,
}) => {
  const [containers, setContainers] = useState<ContainerInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

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
            🔄
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
              title={`${c.name}\n${c.image}\n${c.status}\n\nClick to ${activeContainer === c.name ? 'close' : 'browse'} files`}
            >
              <span className="docker-icon">🐳</span>
              <div className="docker-info">
                <div className="docker-name">{c.name}</div>
                <div className="docker-image">{c.image}</div>
              </div>
              <span className={`docker-state ${c.state}`}>{c.state}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default DockerPanel

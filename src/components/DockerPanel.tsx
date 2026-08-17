import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ContainerInfo } from '../types'
import {
  listDockerContainers,
  restartDockerContainer,
  startDockerContainer,
  stopDockerContainer,
} from '../commands'
import { Icon } from './Icon'
import { useI18n } from '../i18n'

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
  /** Analyse a Docker container (opens report in BottomPanel). */
  onAnalyzeContainer?: (container: ContainerInfo) => void
  /** View container logs (opens in a new tab). */
  onViewLogs?: (container: ContainerInfo) => void
  /** Restart a running container. */
  onRestartContainer?: (container: ContainerInfo) => void
  /** Stop a running container. */
  onStopContainer?: (container: ContainerInfo) => void
  /** Start a stopped container. */
  onStartContainer?: (container: ContainerInfo) => void
  /** Label of the host machine whose containers are listed (shown in header). */
  serverLabel?: string
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
  onAnalyzeContainer,
  onViewLogs,
  onRestartContainer,
  onStopContainer,
  onStartContainer,
  serverLabel,
}) => {
  const { t } = useI18n()
  const [containers, setContainers] = useState<ContainerInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [showAll, setShowAll] = useState(false)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; container: ContainerInfo } | null>(null)
  const [menuStyle, setMenuStyle] = useState<{ left: number; top: number }>({ left: 0, top: 0 })
  const menuRef = useRef<HTMLDivElement>(null)

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
      setCtxMenu({ x: e.clientX, y: e.clientY, container })
      setMenuStyle({ left: e.clientX, top: e.clientY })
    },
    [],
  )

  // Adjust menu position when it would overflow the viewport
  useLayoutEffect(() => {
    if (!ctxMenu || !menuRef.current) return
    const menu = menuRef.current
    const rect = menu.getBoundingClientRect()
    const overflowY = ctxMenu.y + rect.height - window.innerHeight
    const overflowX = ctxMenu.x + rect.width - window.innerWidth
    setMenuStyle({
      left: overflowX > 0 ? ctxMenu.x - overflowX - 4 : ctxMenu.x,
      top: overflowY > 0 ? ctxMenu.y - rect.height : ctxMenu.y,
    })
  }, [ctxMenu])

  const handleEnterShell = useCallback(() => {
    if (!ctxMenu || !onEnterShell) return
    onEnterShell(ctxMenu.container)
    setCtxMenu(null)
  }, [ctxMenu, onEnterShell])

  const handleAnalyzeContainer = useCallback(() => {
    if (!ctxMenu || !onAnalyzeContainer) return
    onAnalyzeContainer(ctxMenu.container)
    setCtxMenu(null)
  }, [ctxMenu, onAnalyzeContainer])

  const handleViewLogs = useCallback(() => {
    if (!ctxMenu || !onViewLogs) return
    onViewLogs(ctxMenu.container)
    setCtxMenu(null)
  }, [ctxMenu, onViewLogs])

  const handleRestart = useCallback(() => {
    if (!ctxMenu) return
    const container = ctxMenu.container
    if (onRestartContainer) {
      onRestartContainer(container)
    } else {
      // Fallback: restart directly and refresh the list
      restartDockerContainer(jumpTabId, container.name)
        .then(() => load())
        .catch((e) => setError(String(e)))
    }
    setCtxMenu(null)
  }, [ctxMenu, jumpTabId, load, onRestartContainer])

  const handleStop = useCallback(() => {
    if (!ctxMenu) return
    const container = ctxMenu.container
    if (onStopContainer) {
      onStopContainer(container)
    } else {
      // Fallback: stop directly and refresh the list
      stopDockerContainer(jumpTabId, container.name)
        .then(() => load())
        .catch((e) => setError(String(e)))
    }
    setCtxMenu(null)
  }, [ctxMenu, jumpTabId, load, onStopContainer])

  const handleStart = useCallback(() => {
    if (!ctxMenu) return
    const container = ctxMenu.container
    if (onStartContainer) {
      onStartContainer(container)
    } else {
      // Fallback: start directly and refresh the list
      startDockerContainer(jumpTabId, container.name)
        .then(() => load())
        .catch((e) => setError(String(e)))
    }
    setCtxMenu(null)
  }, [ctxMenu, jumpTabId, load, onStartContainer])

  const visible = showAll ? containers : containers.filter((c) => c.state === 'running')

  return (
    <div className="docker-panel">
      <div className="docker-panel-header">
        <span
          className={`collapse-chevron${expanded ? ' expanded' : ''}`}
          onClick={onToggleExpanded}
          title={expanded ? t('collapse') : t('expand')}
        />
        <span style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          {t('docker')}
          {serverLabel && (
            <span className="file-server-banner" style={{ margin: 0 }} title={serverLabel}>
              <Icon name="terminal" size={11} />
              <span className="file-server-label">{serverLabel}</span>
            </span>
          )}
        </span>
        {expanded && (
          <>
            <label className="docker-filter-toggle" title={t('showAllContainersHint')}>
              <input
                type="checkbox"
                checked={showAll}
                onChange={(e) => setShowAll(e.target.checked)}
              />
              <span className="docker-filter-toggle-text">{t('showAllContainers')}</span>
            </label>
            <button className="docker-refresh" title="Refresh containers" onClick={load} disabled={loading}>
              <Icon name="refresh" />
            </button>
          </>
        )}
      </div>
      {expanded && (
        <div className="docker-list">
          {error && <div className="file-error">{error}</div>}
          {loading && <div className="file-empty">{t('loading')}</div>}
          {!loading && !error && visible.length === 0 && (
            <div className="file-empty">
              {showAll ? t('noContainers') : t('noRunningContainers')}
            </div>
          )}
          {visible.map((c) => {
            const isRunning = c.state === 'running'
            return (
              <div
                key={c.id}
                className={`docker-item${activeContainer === c.name ? ' active' : ''}${isRunning ? '' : ' stopped'}`}
                onClick={() => {
                  if (isRunning) onOpenContainer(c)
                }}
                onContextMenu={(e) => handleContextMenu(e, c)}
                title={`${c.name}\n${c.image}\n${c.status}${
                  isRunning ? '\n\n' + t('rightClickShell') : '\n\n' + t('rightClickStart')
                }${isRunning ? `\n\n${t('clickTo')} ${activeContainer === c.name ? t('close') : t('browse')} ${t('files')}` : ''}`}
              >
                <span className="docker-icon"><Icon name="container" /></span>
                <div className="docker-info">
                  <div className="docker-name">{c.name}</div>
                  <div className="docker-image">{c.image}</div>
                </div>
                <span className={`docker-state ${c.state}`}>{c.state}</span>
              </div>
            )
          })}
        </div>
      )}

      {/* Context menu */}
      {ctxMenu && (
        <div
          ref={menuRef}
          className="context-menu"
          style={{ left: menuStyle.left, top: menuStyle.top }}
          onClick={(e) => e.stopPropagation()}
        >
          {ctxMenu.container.state === 'running' ? (
            <>
              <div className="context-menu-item" onClick={handleEnterShell}>
                <Icon name="terminal" size={14} />
                {t('enterShell')}
              </div>
              {onAnalyzeContainer && (
                <div className="context-menu-item" onClick={handleAnalyzeContainer}>
                  <Icon name="search" size={14} />
                  {t('analyzeContainer')}
                </div>
              )}
              <div className="context-menu-item" onClick={handleRestart}>
                <Icon name="refresh" size={14} />
                {t('dockerRestart')}
              </div>
              <div className="context-menu-item ctx-danger" onClick={handleStop}>
                <Icon name="stop" size={14} />
                {t('dockerStop')}
              </div>
            </>
          ) : (
            <div className="context-menu-item" onClick={handleStart}>
              <Icon name="play" size={14} />
              {t('dockerStart')}
            </div>
          )}
          {onViewLogs && (
            <div className="context-menu-item" onClick={handleViewLogs}>
              <Icon name="file" size={14} />
              {t('viewLogs')}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default DockerPanel

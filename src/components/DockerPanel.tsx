import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ContainerInfo, DockerHostRef, ImageInfo } from '../types'
import {
  listDockerContainers,
  listDockerImages,
  removeDockerContainer,
  removeDockerImage,
  restartDockerContainer,
  startDockerContainer,
  stopDockerContainer,
} from '../commands'
import { Icon, type IconName } from './Icon'
import { ConfirmDialog } from './ConfirmDialog'
import { useI18n } from '../i18n'
import type { TranslationKey } from '../i18n/en'
import { copyText } from '../lib/clipboard'

interface DockerPanelProps {
  /** Host identity is compared by value: callers may pass a fresh literal each render. */
  host: DockerHostRef
  activeContainer?: string | null
  onOpenContainer?: (container: ContainerInfo) => void
  onEnterShell?: (container: ContainerInfo) => void
  onAnalyzeContainer?: (container: ContainerInfo) => void
  onViewLogs?: (container: ContainerInfo) => void
  onRestartContainer?: (container: ContainerInfo) => void
  onStopContainer?: (container: ContainerInfo) => void
  onStartContainer?: (container: ContainerInfo) => void
  onDeleteContainer?: (container: ContainerInfo) => Promise<void> | void
  /** The parent reports progress/success/errors and rejects on failure. */
  onDeleteImage?: (imageRef: string) => Promise<void>
  serverLabel?: string
  /** Reload the current view after a parent action. */
  refreshSignal?: number
  /** The nav column's single filter box. */
  filter?: string
}

type View = 'containers' | 'images'
type ContextMenu = {
  x: number
  y: number
  host: DockerHostRef
  scope: string
} & ({ kind: 'container'; container: ContainerInfo } | { kind: 'image'; image: ImageInfo })
type PendingDelete = {
  kind: 'container' | 'image'
  name: string
  tagged?: boolean
  scope: string
  remove: () => Promise<void> | void
}

const STATES: Record<string, { icon: IconName; label: TranslationKey }> = {
  running: { icon: 'play', label: 'dockerStateRunning' },
  restarting: { icon: 'refresh', label: 'dockerStateRestarting' },
  paused: { icon: 'pause', label: 'dockerStatePaused' },
  exited: { icon: 'stop', label: 'dockerStateExited' },
  dead: { icon: 'x', label: 'dockerStateDead' },
  created: { icon: 'plus', label: 'dockerStateCreated' },
}
const imageRef = (image: ImageInfo) => `${image.repository}:${image.tag}`
const isTagged = (image: ImageInfo) =>
  !!image.repository && image.repository !== '<none>' && !!image.tag && image.tag !== '<none>'
const shortImageId = (id: string) => id.replace(/^sha256:/, '').slice(0, 12)

/** One daemon, following the focused terminal; only container rows browse files. */
export const DockerPanel: React.FC<DockerPanelProps> = ({
  host,
  activeContainer,
  onOpenContainer,
  onEnterShell,
  onAnalyzeContainer,
  onViewLogs,
  onRestartContainer,
  onStopContainer,
  onStartContainer,
  onDeleteContainer,
  onDeleteImage,
  serverLabel,
  refreshSignal,
  filter = '',
}) => {
  const { t } = useI18n()
  const [view, setView] = useState<View>('containers')
  const [containers, setContainers] = useState<ContainerInfo[]>([])
  const [images, setImages] = useState<ImageInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [showAll, setShowAll] = useState(false)
  const [ctxMenu, setCtxMenu] = useState<ContextMenu | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<PendingDelete | null>(null)
  const [removing, setRemoving] = useState(false)
  const removingRef = useRef(false)
  const [menuStyle, setMenuStyle] = useState({ left: 0, top: 0 })
  const menuRef = useRef<HTMLDivElement>(null)
  const requestsRef = useRef({ latest: 0 })

  const hostKey = host.kind === 'ssh' ? `ssh:${host.jumpTabId}` : 'local'
  const scope = `${hostKey}/${view}`
  const scopeRef = useRef(scope)
  scopeRef.current = scope
  const hostRef = useRef(host)
  hostRef.current = host

  const load = useCallback(async () => {
    const requests = requestsRef.current
    const id = ++requests.latest
    const requestHost = hostRef.current
    const isCurrent = () => id === requests.latest && scopeRef.current === scope
    setLoading(true)
    setError('')
    try {
      if (view === 'images') {
        const rows = await listDockerImages(requestHost)
        if (isCurrent()) setImages(rows)
      } else {
        const rows = await listDockerContainers(requestHost)
        if (isCurrent()) setContainers(rows)
      }
    } catch (e) {
      if (isCurrent()) setError(String(e))
    } finally {
      if (isCurrent()) setLoading(false)
    }
  }, [scope, view])

  // Invalidate before paint so old-host rows and destructive callbacks cannot survive.
  useLayoutEffect(() => {
    const requests = requestsRef.current
    scopeRef.current = scope
    setContainers([])
    setImages([])
    setError('')
    setCtxMenu(null)
    setConfirmDelete(null)
    return () => {
      scopeRef.current = ''
      requests.latest++
    }
  }, [scope])

  useEffect(() => {
    void load()
  }, [load, refreshSignal])

  useEffect(() => {
    const close = () => setCtxMenu(null)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('click', close)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('click', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [])

  const openMenu = (
    e: React.MouseEvent,
    item: { kind: 'container'; container: ContainerInfo } | { kind: 'image'; image: ImageInfo },
  ) => {
    e.preventDefault()
    e.stopPropagation()
    setCtxMenu({ ...item, x: e.clientX, y: e.clientY, host, scope })
    setMenuStyle({ left: e.clientX, top: e.clientY })
  }

  useLayoutEffect(() => {
    if (!ctxMenu || !menuRef.current) return
    const rect = menuRef.current.getBoundingClientRect()
    setMenuStyle({
      left: Math.max(4, Math.min(ctxMenu.x, window.innerWidth - rect.width - 4)),
      top: Math.max(4, Math.min(ctxMenu.y, window.innerHeight - rect.height - 4)),
    })
  }, [ctxMenu])

  const runContainerAction = async (verb: 'start' | 'stop' | 'restart') => {
    if (ctxMenu?.kind !== 'container') return
    const action = ctxMenu
    setCtxMenu(null)
    const spec = {
      start: { callback: onStartContainer, command: startDockerContainer },
      stop: { callback: onStopContainer, command: stopDockerContainer },
      restart: { callback: onRestartContainer, command: restartDockerContainer },
    }[verb]
    try {
      if (spec.callback) {
        spec.callback(action.container)
      } else {
        await spec.command(action.host, action.container.name)
        if (scopeRef.current === action.scope) await load()
      }
    } catch (e) {
      if (scopeRef.current === action.scope) setError(String(e))
    }
  }

  const requestDelete = () => {
    if (!ctxMenu || removingRef.current) return
    const action = ctxMenu
    if (action.kind === 'container') {
      if (action.container.state === 'running') return
      setConfirmDelete({
        kind: 'container',
        name: action.container.name,
        scope: action.scope,
        remove: () =>
          onDeleteContainer
            ? onDeleteContainer(action.container)
            : removeDockerContainer(action.host, action.container.name),
      })
    } else {
      const tagged = isTagged(action.image)
      const name = tagged ? imageRef(action.image) : action.image.id
      // Capture both host and parent callback now, not after an await/focus change.
      setConfirmDelete({
        kind: 'image',
        name,
        tagged,
        scope: action.scope,
        remove: () => (onDeleteImage ? onDeleteImage(name) : removeDockerImage(action.host, name)),
      })
    }
    setCtxMenu(null)
  }

  const confirmRemove = async () => {
    if (!confirmDelete || removingRef.current) return
    const action = confirmDelete
    removingRef.current = true
    setRemoving(true)
    // Closing the dialog and a ref guard prevent duplicate submissions in one frame.
    setConfirmDelete(null)
    try {
      await action.remove()
      if (scopeRef.current === action.scope) await load()
    } catch (e) {
      // Keep refused rows visible even when the parent has already toasted the error.
      if (scopeRef.current === action.scope) setError(String(e))
    } finally {
      removingRef.current = false
      setRemoving(false)
    }
  }

  const copyField = (value: string) => {
    setCtxMenu(null)
    // copyText resolves even when both clipboard paths fail; don't claim success.
    void copyText(value)
  }

  const q = filter.toLowerCase()
  const visible = (showAll ? containers : containers.filter((c) => c.state === 'running')).filter(
    (c) => !q || c.name.toLowerCase().includes(q) || c.image.toLowerCase().includes(q),
  )
  const visibleImages = images.filter(
    (image) =>
      !q || imageRef(image).toLowerCase().includes(q) || image.id.toLowerCase().includes(q),
  )
  const count = view === 'containers' ? visible.length : visibleImages.length
  const menuContainer = ctxMenu?.kind === 'container' ? ctxMenu.container : null
  const menuImage = ctxMenu?.kind === 'image' ? ctxMenu.image : null

  return (
    <div className="docker-panel">
      <div className="panel-head sec docker-head">
        <div className="docker-head-summary">
          <span className="panel-title">{t('docker')}</span>
          <span className="cnt" title={serverLabel}>
            {serverLabel ? `${count} · ${serverLabel}` : count}
          </span>
          {view === 'containers' && (
            <label className="docker-filter-toggle" title={t('showAllContainersHint')}>
              <input
                type="checkbox"
                checked={showAll}
                onChange={(e) => setShowAll(e.target.checked)}
              />
              <span className="docker-filter-toggle-text">{t('showAllContainers')}</span>
            </label>
          )}
          <button
            type="button"
            className="icon-btn"
            title={t('refresh')}
            aria-label={t('refresh')}
            onClick={() => void load()}
            disabled={loading}
          >
            <Icon name="refresh" size={13} />
          </button>
        </div>
        <div className="docker-view-seg" role="group" aria-label={t('docker')}>
          {(['containers', 'images'] as const).map((option) => (
            <button
              key={option}
              type="button"
              className={`docker-view-btn${view === option ? ' active' : ''}`}
              aria-pressed={view === option}
              onClick={() => setView(option)}
            >
              {t(option === 'containers' ? 'dockerViewContainers' : 'dockerViewImages')}
            </button>
          ))}
        </div>
      </div>
      <div className="docker-list" aria-busy={loading}>
        {error && <div className="file-error">{error}</div>}
        {loading && <div className="file-empty">{t('loading')}</div>}
        {!loading && !error && count === 0 && (
          <div className="file-empty">
            {view === 'images'
              ? t('noImages')
              : showAll
                ? t('noContainers')
                : t('noRunningContainers')}
          </div>
        )}
        {view === 'containers' &&
          visible.map((c) => {
            const isRunning = c.state === 'running'
            const state = Object.prototype.hasOwnProperty.call(STATES, c.state)
              ? STATES[c.state]
              : undefined
            const label = state ? t(state.label) : c.state.trim() || t('dockerStateUnknown')
            return (
              <div
                key={c.id}
                className={`docker-item${activeContainer === c.name ? ' active' : ''}${isRunning ? '' : ' stopped'}`}
                onClick={() => {
                  if (isRunning) onOpenContainer?.(c)
                }}
                onContextMenu={(e) => openMenu(e, { kind: 'container', container: c })}
                title={`${c.name}\n${c.image}\n${c.status}${
                  isRunning ? '\n\n' + t('rightClickShell') : '\n\n' + t('rightClickStart')
                }${
                  isRunning && onOpenContainer
                    ? `\n\n${t('clickTo')} ${activeContainer === c.name ? t('close') : t('browse')} ${t('files')}`
                    : ''
                }`}
              >
                <span className="docker-icon">
                  <Icon name="container" />
                </span>
                <div className="docker-info">
                  <div className="docker-name">{c.name}</div>
                  {/* The ID sits on its own line between the name and the image
                      rather than sharing the image line. */}
                  {c.id && (
                    <span
                      className="docker-id"
                      title={`${t('containerId')}: ${c.id}`}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {c.id.slice(0, 12)}
                    </span>
                  )}
                  <div className="docker-meta">
                    <span className="docker-image">{c.image}</span>
                  </div>
                </div>
                <span
                  className={`docker-state-mark ${c.state}`}
                  role="img"
                  title={label}
                  aria-label={label}
                >
                  <Icon name={state?.icon ?? 'container'} size={13} />
                </span>
              </div>
            )
          })}
        {view === 'images' &&
          visibleImages.map((image) => (
            <div
              key={JSON.stringify([image.repository, image.tag, image.id])}
              className="docker-item image"
              title={`${imageRef(image)}\n${image.id}\n${image.size} · ${image.created}`}
              onContextMenu={(e) => openMenu(e, { kind: 'image', image })}
            >
              <span className="docker-icon">
                <Icon name="image" />
              </span>
              <div className="docker-info">
                <div className="docker-name">{imageRef(image)}</div>
                <div className="docker-meta">
                  <span className="docker-id" title={`${t('imageId')}: ${image.id}`}>
                    {shortImageId(image.id)}
                  </span>
                  <span className="docker-size">{image.size}</span>
                </div>
                <div className="docker-age" title={image.created}>
                  {image.created}
                </div>
              </div>
            </div>
          ))}
      </div>

      {ctxMenu && (
        <div
          ref={menuRef}
          className="context-menu docker-context-menu"
          style={menuStyle}
          onClick={(e) => e.stopPropagation()}
        >
          {menuContainer && (
            <>
              {menuContainer.state === 'running' ? (
                <>
                  {onEnterShell && (
                    <div
                      className="context-menu-item"
                      onClick={() => {
                        onEnterShell(menuContainer)
                        setCtxMenu(null)
                      }}
                    >
                      <Icon name="terminal" size={14} />
                      {t('enterShell')}
                    </div>
                  )}
                  {onAnalyzeContainer && (
                    <div
                      className="context-menu-item"
                      onClick={() => {
                        onAnalyzeContainer(menuContainer)
                        setCtxMenu(null)
                      }}
                    >
                      <Icon name="search" size={14} />
                      {t('analyzeContainer')}
                    </div>
                  )}
                  <div
                    className="context-menu-item"
                    onClick={() => void runContainerAction('restart')}
                  >
                    <Icon name="refresh" size={14} />
                    {t('dockerRestart')}
                  </div>
                  <div
                    className="context-menu-item ctx-danger"
                    onClick={() => void runContainerAction('stop')}
                  >
                    <Icon name="stop" size={14} />
                    {t('dockerStop')}
                  </div>
                </>
              ) : (
                <>
                  <div
                    className="context-menu-item"
                    onClick={() => void runContainerAction('start')}
                  >
                    <Icon name="play" size={14} />
                    {t('dockerStart')}
                  </div>
                  <div
                    className="context-menu-item ctx-danger"
                    aria-disabled={removing}
                    onClick={requestDelete}
                  >
                    <Icon name="trash" size={14} />
                    {t('dockerDelete')}
                  </div>
                </>
              )}
              {onViewLogs && (
                <div
                  className="context-menu-item"
                  onClick={() => {
                    onViewLogs(menuContainer)
                    setCtxMenu(null)
                  }}
                >
                  <Icon name="file" size={14} />
                  {t('viewLogs')}
                </div>
              )}
              <div className="context-menu-divider" />
              <div className="context-menu-item" onClick={() => copyField(menuContainer.name)}>
                <Icon name="copy" size={14} />
                {t('copyContainerName')}
              </div>
              <div className="context-menu-item" onClick={() => copyField(menuContainer.id)}>
                <Icon name="copy" size={14} />
                {t('copyContainerId')}
              </div>
            </>
          )}
          {menuImage && (
            <>
              <div className="context-menu-item" onClick={() => copyField(imageRef(menuImage))}>
                <Icon name="copy" size={14} />
                {t('copyImageRef')}
              </div>
              <div className="context-menu-item" onClick={() => copyField(menuImage.id)}>
                <Icon name="copy" size={14} />
                {t('copyImageId')}
              </div>
              <div className="context-menu-divider" />
              <div
                className="context-menu-item ctx-danger"
                aria-disabled={removing}
                onClick={requestDelete}
              >
                <Icon name="trash" size={14} />
                {t('dockerDeleteImage')}
              </div>
            </>
          )}
        </div>
      )}

      {confirmDelete && (
        <ConfirmDialog
          danger
          title={t(confirmDelete.kind === 'image' ? 'dockerDeleteImageTitle' : 'dockerDeleteTitle')}
          message={t(
            confirmDelete.kind === 'container'
              ? 'dockerDeleteConfirm'
              : confirmDelete.tagged
                ? 'dockerDeleteImageConfirm'
                : 'dockerDeleteDanglingImageConfirm',
            { name: confirmDelete.name },
          )}
          confirmLabel={t('delete')}
          cancelLabel={t('cancel')}
          onConfirm={() => void confirmRemove()}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  )
}

export default DockerPanel

import React, { type ReactNode } from 'react'
import type { ConnectionConfig, DockSide, InspectorTab } from '../types'
import { HostAnalysisPanel } from './HostAnalysisPanel'
import { DockerAnalysisPanel } from './DockerAnalysisPanel'
import { Icon } from './Icon'
import { useI18n } from '../i18n'
import { FLOAT_RESIZE_DIRS, useFloatResize } from '../hooks/useFloatResize'

/** Where the popped-out column sits. `null` means docked, i.e. a normal row. */
export interface InspectorFloatState {
  x: number
  y: number
  w: number
  h: number
  z: number
}

interface Props {
  connections: ConnectionConfig[]
  activeTabId: number | null
  width: number
  tab: InspectorTab
  /** Which edge the docked column hugs. */
  side: DockSide
  /** Geometry while the column is popped out; `null` when docked. */
  float: InspectorFloatState | null
  onTabChange: (tab: InspectorTab) => void
  onClose: () => void
  onToggleFloat: () => void
  /** Move the column to the other edge, docking it back if it is floating. */
  onDockSide: (side: DockSide) => void
  onFloatMove: (x: number, y: number) => void
  onFloatResize: (w: number, h: number) => void
  onFloatFocus: () => void
  /** Pointer-down on the column's workspace-facing edge, while docked. */
  onColumnResizeStart: (e: React.MouseEvent) => void
  /** Container to analyse — set by DockerPanel's context menu. */
  dockerAnalysisTarget?: string | null
  onDockerAnalyzed?: () => void
  /**
   * The AI surface, built by `App` because `AiChatPanel` takes its conversation,
   * config and callbacks from there. `null` when there is nothing to talk to.
   */
  ai?: ReactNode
  /** The subnet scan, likewise composed in `App` (it needs the connection list
   * to offer groups, and the refresh callback that follows a save). */
  network?: ReactNode
}

/**
 * The third region: read-outs about the *focused* target, plus the two tools
 * that belong next to a live terminal rather than in a modal over it — the
 * assistant and the subnet scan. The bottom drawer keeps the lists that span
 * every target.
 *
 * The column has two states and renders as **one element in both of them**. That
 * is the whole reason this is not hosted by `FloatingWindow`: the subtree holds
 * mounted panels whose work would be stranded by an unmount (the assistant's
 * in-flight reply polls from a closure, the scan accumulates `scan-progress`
 * rows). Toggling float therefore changes this node's own positioning —
 * `position: fixed` and a set of resize grips — instead of moving the children
 * into another parent.
 */
export const InspectorPanel: React.FC<Props> = ({
  connections,
  activeTabId,
  width,
  tab,
  side,
  float,
  onTabChange,
  onClose,
  onToggleFloat,
  onDockSide,
  onFloatMove,
  onFloatResize,
  onFloatFocus,
  onColumnResizeStart,
  dockerAnalysisTarget,
  onDockerAnalyzed,
  ai,
  network,
}) => {
  const { t } = useI18n()
  const floating = float != null

  // Read at gesture start only, so a resize stays correct while the panels
  // re-render underneath it. When docked no gesture can begin — the grips and the
  // draggable header exist solely in the floated state.
  const { startDrag, startResize } = useFloatResize({
    geometry: () => float ?? { x: 0, y: 0, w: width, h: 0 },
    onMove: onFloatMove,
    onResize: onFloatResize,
  })

  const floatLabel = floating ? t('inspDockBack') : t('inspFloat')
  const sideLabel = side === 'right' ? t('inspDockLeft') : t('inspDockRight')

  return (
    <aside
      className={`inspector${floating ? ' is-floating' : ''}${side === 'left' ? ' is-left' : ''}`}
      style={
        floating
          ? { left: float.x, top: float.y, width: float.w, height: float.h, zIndex: float.z }
          : { width }
      }
      onMouseDown={floating ? onFloatFocus : undefined}
    >
      <div className="panel-head inspector-head" onMouseDown={floating ? startDrag : undefined}>
        <span className="panel-title">{t('inspector')}</span>
        {/* Plain "Close", not "Close inspector": the tab-bar toggle already
          carries the region name, and two buttons with one accessible name give
          a screen reader nothing to choose between. Inside the column, the
          button's position already says what it closes. */}
        <button
          type="button"
          className="icon-btn"
          onClick={onToggleFloat}
          aria-label={floatLabel}
          title={floatLabel}
        >
          <Icon name={floating ? 'dockBack' : 'float'} size={12} />
        </button>
        <button
          type="button"
          className="icon-btn"
          onClick={() => onDockSide(side === 'right' ? 'left' : 'right')}
          aria-label={sideLabel}
          title={sideLabel}
        >
          <Icon name={side === 'right' ? 'panelLeft' : 'panelRight'} size={12} />
        </button>
        <button
          type="button"
          className="icon-btn x"
          onClick={onClose}
          aria-label={t('close')}
          title={t('close')}
        >
          <Icon name="x" size={12} />
        </button>
      </div>

      {/* The grab zone lives on the column itself rather than as a sibling in the
        row, so the column stays one flex item and can change edge by `order`
        alone. Not rendered while floated — the eight grips at the bottom then
        cover every edge. */}
      {!floating && (
        <div className="inspector-resize" onMouseDown={onColumnResizeStart} title={t('resize')} />
      )}

      <div className="inspector-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'analysis'}
          className={`tab-btn${tab === 'analysis' ? ' active' : ''}`}
          onClick={() => onTabChange('analysis')}
        >
          <Icon name="search" /> {t('analysis')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'docker'}
          className={`tab-btn${tab === 'docker' ? ' active' : ''}`}
          onClick={() => onTabChange('docker')}
        >
          <Icon name="container" /> {t('docker')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'ai'}
          className={`tab-btn${tab === 'ai' ? ' active' : ''}`}
          onClick={() => onTabChange('ai')}
        >
          <Icon name="sparkles" /> {t('aiChatTitle')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'network'}
          className={`tab-btn${tab === 'network' ? ' active' : ''}`}
          onClick={() => onTabChange('network')}
        >
          <Icon name="network" /> {t('inspNetwork')}
        </button>
      </div>

      <div className="inspector-body">
        {tab === 'analysis' && (
          <HostAnalysisPanel connections={connections} activeTabId={activeTabId} />
        )}
        {tab === 'docker' && (
          <DockerAnalysisPanel
            activeTabId={activeTabId}
            targetContainer={dockerAnalysisTarget ?? null}
            onAnalyzed={onDockerAnalyzed}
          />
        )}
        {/* Both panels below stay mounted and are hidden rather than unmounted.
          The AI panel's agent run polls the backend from a closure inside
          `AiChatPanel` and its unmount cleanup cancels that chain; the scan
          accumulates rows from `scan-progress` events. Unmounting either one
          mid-run would strand it. Same trick `terminalContent` uses when a file
          editor takes over the pane. */}
        {ai != null && (
          <div className="inspector-pane" hidden={tab !== 'ai'}>
            {ai}
          </div>
        )}
        {network != null && (
          <div className="inspector-pane" hidden={tab !== 'network'}>
            {network}
          </div>
        )}
      </div>

      {floating &&
        FLOAT_RESIZE_DIRS.map((dir) => (
          <div
            key={dir}
            className={`floating-window-resize fw-rh-${dir}`}
            onMouseDown={(e) => {
              onFloatFocus()
              startResize(e, dir)
            }}
            title={t('resize')}
          />
        ))}
    </aside>
  )
}

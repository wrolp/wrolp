import React, { useState } from 'react'
import type { ConnectionConfig, SessionSummary, DockPos } from '../types'
import { DEFAULT_DRAWER_HEIGHT } from '../types'
import { SessionListPanel } from './SessionListPanel'
import { CommandSetPanel } from './CommandSetPanel'
import { SessionViewer } from './SessionViewer'
import { Icon } from './Icon'
import { useI18n } from '../i18n'

interface BottomPanelProps {
  connections: ConnectionConfig[]
  activeTabId: number | null
  expanded: boolean
  pos?: DockPos
  size?: number
  onToggleExpanded: () => void
  onDockDragStart?: () => void
  onDockDragEnd?: () => void
}

type PanelTab = 'sessions' | 'cmdsets'

export const BottomPanel: React.FC<BottomPanelProps> = ({
  connections,
  activeTabId,
  expanded,
  pos = 'bottom',
  size = DEFAULT_DRAWER_HEIGHT,
  onToggleExpanded,
  onDockDragStart,
  onDockDragEnd,
}) => {
  const { t } = useI18n()
  const [activeTab, setActiveTab] = useState<PanelTab>('sessions')
  const [viewingSession, setViewingSession] = useState<SessionSummary | null>(null)
  const [prefillCommands, setPrefillCommands] = useState<string[] | null>(null)

  const handleExtractCommands = (commands: string[]) => {
    setPrefillCommands(commands)
    setActiveTab('cmdsets')
  }

  // If viewing a session, show the viewer full-screen in the bottom panel
  if (viewingSession && expanded) {
    return (
      <div
        className={`bottom-panel expanded${pos === 'right' ? ' right' : ''}`}
        style={pos === 'right' ? { width: size } : { height: size }}
      >
        <SessionViewer
          sessionId={viewingSession.id}
          sessionTitle={viewingSession.title || viewingSession.connectionName || 'Session'}
          onClose={() => setViewingSession(null)}
        />
      </div>
    )
  }

  return (
    <div
      className={`bottom-panel${expanded ? ' expanded' : ''}${pos === 'right' ? ' right' : ''}`}
      style={expanded ? (pos === 'right' ? { width: size } : { height: size }) : undefined}
    >
      <div className="bottom-panel-tabs">
        <span
          className="panel-drag-handle"
          title={t('dragToRedock')}
          draggable
          onMouseDown={(e) => e.stopPropagation()}
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = 'move'
            e.dataTransfer.setData('text/plain', 'bottomPanel')
            onDockDragStart?.()
          }}
          onDragEnd={() => onDockDragEnd?.()}
        >
          <Icon name="drag" size={12} />
        </span>
        <button
          type="button"
          className="icon-btn drawer-toggle"
          aria-expanded={expanded}
          aria-label={expanded ? t('collapse') : t('expand')}
          title={expanded ? t('collapse') : t('expand')}
          onClick={onToggleExpanded}
        >
          <Icon name="chevronDown" size={12} />
        </button>
        <button
          className={`tab-btn${activeTab === 'sessions' ? ' active' : ''}`}
          onClick={() => setActiveTab('sessions')}
        >
          <Icon name="record" /> {t('sessions')}
        </button>
        <button
          className={`tab-btn${activeTab === 'cmdsets' ? ' active' : ''}`}
          onClick={() => setActiveTab('cmdsets')}
        >
          <Icon name="clipboard" /> {t('commandSets')}
        </button>
      </div>
      {expanded && (
        <div className="bottom-panel-content">
          {activeTab === 'sessions' && (
            <SessionListPanel
              connections={connections}
              onPlaySession={(s) => setViewingSession(s)}
              onExtractCommands={handleExtractCommands}
            />
          )}
          {activeTab === 'cmdsets' && (
            <CommandSetPanel
              connections={connections}
              activeTabId={activeTabId}
              prefillCommands={prefillCommands}
              onPrefillConsumed={() => setPrefillCommands(null)}
            />
          )}
        </div>
      )}
    </div>
  )
}

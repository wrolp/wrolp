import React, { useState } from 'react'
import type { ConnectionConfig, SessionSummary, DockPos } from '../types'
import { SessionListPanel } from './SessionListPanel'
import { CommandSetPanel } from './CommandSetPanel'
import { HostAnalysisPanel } from './HostAnalysisPanel'
import { SessionViewer } from './SessionViewer'
import { Icon } from './Icon'

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

type PanelTab = 'sessions' | 'cmdsets' | 'analysis'

export const BottomPanel: React.FC<BottomPanelProps> = ({
  connections,
  activeTabId,
  expanded,
  pos = 'bottom',
  size = 240,
  onToggleExpanded,
  onDockDragStart,
  onDockDragEnd,
}) => {
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
      <div className="bottom-panel expanded">
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
      style={
        expanded
          ? pos === 'right'
            ? { width: size }
            : { height: size }
          : undefined
      }
    >
      <div className="bottom-panel-tabs">
        <span
          className="panel-drag-handle"
          title="Drag to re-dock panel (right / bottom)"
          draggable
          onMouseDown={(e) => e.stopPropagation()}
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = 'move'
            e.dataTransfer.setData('text/plain', 'bottomPanel')
            onDockDragStart?.()
          }}
          onDragEnd={() => onDockDragEnd?.()}
        >
          ⠿
        </span>
        <span
          className={`collapse-chevron${expanded ? ' expanded' : ''}`}
          onClick={onToggleExpanded}
          title={expanded ? 'Collapse' : 'Expand'}
        />
        <button
          className={`tab-btn${activeTab === 'sessions' ? ' active' : ''}`}
          onClick={() => setActiveTab('sessions')}
        >
          <Icon name="record" /> Sessions
        </button>
        <button
          className={`tab-btn${activeTab === 'cmdsets' ? ' active' : ''}`}
          onClick={() => setActiveTab('cmdsets')}
        >
          <Icon name="clipboard" /> Command Sets
        </button>
        <button
          className={`tab-btn${activeTab === 'analysis' ? ' active' : ''}`}
          onClick={() => setActiveTab('analysis')}
        >
          <Icon name="search" /> Analysis
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
          {activeTab === 'analysis' && (
            <HostAnalysisPanel
              connections={connections}
              activeTabId={activeTabId}
            />
          )}
        </div>
      )}
    </div>
  )
}

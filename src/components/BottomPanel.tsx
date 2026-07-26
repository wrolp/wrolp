import React, { useState } from 'react'
import type { ConnectionConfig, SessionSummary, DockPos } from '../types'
import { SessionListPanel } from './SessionListPanel'
import { CommandSetPanel } from './CommandSetPanel'
import { SessionViewer } from './SessionViewer'

interface BottomPanelProps {
  connections: ConnectionConfig[]
  activeTabId: number | null
  expanded: boolean
  pos?: DockPos
  size?: number
  onToggleExpanded: () => void
}

type PanelTab = 'sessions' | 'cmdsets'

export const BottomPanel: React.FC<BottomPanelProps> = ({
  connections,
  activeTabId,
  expanded,
  pos = 'bottom',
  size = 240,
  onToggleExpanded,
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
          className={`collapse-chevron${expanded ? ' expanded' : ''}`}
          onClick={onToggleExpanded}
          title={expanded ? 'Collapse' : 'Expand'}
        />
        <button
          className={`tab-btn${activeTab === 'sessions' ? ' active' : ''}`}
          onClick={() => setActiveTab('sessions')}
        >
          📹 Sessions
        </button>
        <button
          className={`tab-btn${activeTab === 'cmdsets' ? ' active' : ''}`}
          onClick={() => setActiveTab('cmdsets')}
        >
          📋 Command Sets
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

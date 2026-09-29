import React, { useEffect, useRef, useState } from 'react'
import type { ConnectionConfig, SessionSummary, DockPos } from '../types'
import { DEFAULT_DRAWER_HEIGHT } from '../types'
import { SessionListPanel } from './SessionListPanel'
import { CommandSetPanel } from './CommandSetPanel'
import { TransferQueue } from './TransferQueue'
import { SessionViewer } from './SessionViewer'
import { Icon } from './Icon'
import { useI18n } from '../i18n'
import { useTransferRows } from '../lib/transferQueue'

interface BottomPanelProps {
  connections: ConnectionConfig[]
  activeTabId: number | null
  expanded: boolean
  pos?: DockPos
  size?: number
  onToggleExpanded: () => void
  /**
   * A session the rail's session list asked to replay. The list now lives in the
   * mode column, outside this component, so the request is handed in as a prop
   * instead of the panel owning both halves.
   */
  pendingSession?: SessionSummary | null
  onPendingSessionConsumed?: () => void
  /** Commands extracted from a session for the command-set tab to prefill. */
  prefillCommands?: string[] | null
  onPrefillConsumed?: () => void
}

type PanelTab = 'sessions' | 'cmdsets' | 'transfers'

export const BottomPanel: React.FC<BottomPanelProps> = ({
  connections,
  activeTabId,
  expanded,
  pos = 'bottom',
  size = DEFAULT_DRAWER_HEIGHT,
  onToggleExpanded,
  pendingSession,
  onPendingSessionConsumed,
  prefillCommands: prefillFromProps,
  onPrefillConsumed,
}) => {
  const { t } = useI18n()
  const [activeTab, setActiveTab] = useState<PanelTab>('sessions')
  const [viewingSession, setViewingSession] = useState<SessionSummary | null>(null)
  const [prefillCommands, setPrefillCommands] = useState<string[] | null>(null)
  const transferRows = useTransferRows()
  // A transfer starting anywhere in the app is what the queue tab exists for, so
  // the first row of a batch brings it forward — the way a download bar does.
  const hadTransfers = useRef(false)
  useEffect(() => {
    const has = transferRows.length > 0
    if (has && !hadTransfers.current) setActiveTab('transfers')
    hadTransfers.current = has
  }, [transferRows])

  useEffect(() => {
    if (!pendingSession) return
    setViewingSession(pendingSession)
    setActiveTab('sessions')
    onPendingSessionConsumed?.()
  }, [pendingSession, onPendingSessionConsumed])

  useEffect(() => {
    if (!prefillFromProps) return
    setPrefillCommands(prefillFromProps)
    setActiveTab('cmdsets')
    onPrefillConsumed?.()
  }, [prefillFromProps, onPrefillConsumed])

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
        <button
          className={`tab-btn${activeTab === 'transfers' ? ' active' : ''}`}
          onClick={() => setActiveTab('transfers')}
        >
          <Icon name="transfer" /> {t('transferQueue')}
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
          {activeTab === 'transfers' && <TransferQueue />}
        </div>
      )}
    </div>
  )
}

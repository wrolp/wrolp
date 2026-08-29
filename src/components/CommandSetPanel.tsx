import React, { useState, useEffect, useCallback } from 'react'
import { v4 as uuidv4 } from 'uuid'
import type { ConnectionConfig, CommandSetDto } from '../types'
import { listCommandSets, saveCommandSet, deleteCommandSet, sendInput } from '../commands'
import { Icon } from './Icon'
import { useI18n } from '../i18n'

interface CommandSetPanelProps {
  connections: ConnectionConfig[]
  activeTabId: number | null
  prefillCommands?: string[] | null
  onPrefillConsumed?: () => void
}

export const CommandSetPanel: React.FC<CommandSetPanelProps> = ({
  connections,
  activeTabId,
  prefillCommands,
  onPrefillConsumed,
}) => {
  const { t } = useI18n()
  const [cmdSets, setCmdSets] = useState<CommandSetDto[]>([])
  const [loading, setLoading] = useState(true)
  const [showEditor, setShowEditor] = useState(false)
  const [editing, setEditing] = useState<CommandSetDto | null>(null)
  const [executing, setExecuting] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const result = await listCommandSets()
      setCmdSets(result)
    } catch (e) {
      console.error('Failed to load command sets:', e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  // Handle prefilled commands from session extraction
  useEffect(() => {
    if (prefillCommands && prefillCommands.length > 0) {
      setEditing({
        id: uuidv4(),
        name: '',
        connectionId: null,
        commands: prefillCommands,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      setShowEditor(true)
      onPrefillConsumed?.()
    }
  }, [prefillCommands, onPrefillConsumed])

  const handleDelete = async (id: string) => {
    if (confirm(t('deleteCommandSetConfirm'))) {
      await deleteCommandSet(id)
      reload()
    }
  }

  const handleExecute = async (cmdSet: CommandSetDto) => {
    if (activeTabId === null) {
      alert(t('noActiveTerminal'))
      return
    }
    setExecuting(cmdSet.id)
    try {
      for (const cmd of cmdSet.commands) {
        await sendInput(activeTabId, cmd + '\n')
        await new Promise((r) => setTimeout(r, 150))
      }
    } catch (e) {
      console.error('Batch execute failed:', e)
      alert(t('batchExecuteFailed') + e)
    } finally {
      setExecuting(null)
    }
  }

  const formatDate = (iso: string) => {
    return new Date(iso).toLocaleDateString(undefined, {
      month: '2-digit',
      day: '2-digit',
    })
  }

  return (
    <div className="cmd-set-panel">
      <div className="panel-toolbar">
        <span className="cmd-set-count">{t('cmdSetCount', { n: cmdSets.length })}</span>
        <button
          onClick={() => {
            setEditing(null)
            setShowEditor(true)
          }}
          className="add-btn"
        >
          {t('new')}
        </button>
      </div>

      {loading ? (
        <div className="panel-empty">{t('loading')}</div>
      ) : cmdSets.length === 0 ? (
        <div className="panel-empty">{t('noCommandSets')}</div>
      ) : (
        <div className="cmd-set-table">
          {cmdSets.map((cs) => (
            <div key={cs.id} className="cmd-set-row">
              <div className="cmd-set-row-info">
                <span className="cmd-set-name">{cs.name}</span>
                <span className="cmd-set-meta">
                  {cs.commands.length} {t('cmds')} ·{' '}
                  {cs.connectionId
                    ? connections.find((c) => c.id === cs.connectionId)?.name || t('unknown')
                    : t('general')}{' '}
                  · {formatDate(cs.updatedAt)}
                </span>
              </div>
              <div className="cmd-set-row-actions">
                <button
                  onClick={() => handleExecute(cs)}
                  title={t('executeInTerminal')}
                  disabled={executing !== null || activeTabId === null}
                >
                  {executing === cs.id ? (
                    <Icon name="refresh" className="spin" />
                  ) : (
                    <Icon name="play" />
                  )}
                </button>
                <button
                  onClick={() => {
                    setEditing(cs)
                    setShowEditor(true)
                  }}
                  title={t('edit')}
                >
                  <Icon name="edit" />
                </button>
                <button onClick={() => handleDelete(cs.id)} title={t('delete')}>
                  <Icon name="trash" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {showEditor && (
        <CommandSetEditor
          cmdSet={editing}
          connections={connections}
          onClose={() => {
            setShowEditor(false)
            setEditing(null)
          }}
          onSave={async (saved) => {
            await saveCommandSet(saved)
            setShowEditor(false)
            setEditing(null)
            reload()
          }}
        />
      )}
    </div>
  )
}

// ===== Editor Dialog =====

interface CommandSetEditorProps {
  cmdSet: CommandSetDto | null
  connections: ConnectionConfig[]
  onClose: () => void
  onSave: (cmdSet: CommandSetDto) => void
}

const CommandSetEditor: React.FC<CommandSetEditorProps> = ({
  cmdSet,
  connections,
  onClose,
  onSave,
}) => {
  const { t } = useI18n()
  const [name, setName] = useState(cmdSet?.name || '')
  const [connectionId, setConnectionId] = useState(cmdSet?.connectionId || '')
  const [commandsText, setCommandsText] = useState(cmdSet?.commands.join('\n') || '')

  const handleSave = () => {
    const commands = commandsText
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)

    if (!name.trim()) {
      alert(t('cmdSetAlertName'))
      return
    }
    if (commands.length === 0) {
      alert(t('cmdSetAlertCommands'))
      return
    }

    onSave({
      id: cmdSet?.id || uuidv4(),
      name: name.trim(),
      connectionId: connectionId || null,
      commands,
      createdAt: cmdSet?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
  }

  return (
    <div className="modal-overlay">
      <div className="modal">
        <div className="modal-header">
          <h3>{cmdSet ? t('editCommandSet') : t('newCommandSetDialog')}</h3>
          <span
            onClick={onClose}
            style={{ cursor: 'pointer', fontSize: '18px', color: '#888' }}
            title={t('close')}
          >
            ✕
          </span>
        </div>
        <div className="modal-body">
          <div className="form-group">
            <label>{t('cmdSetName')}</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('cmdSetNamePlaceholder')}
              autoFocus
            />
          </div>
          <div className="form-group">
            <label>{t('cmdSetConnection')}</label>
            <select value={connectionId} onChange={(e) => setConnectionId(e.target.value)}>
              <option value="">{t('cmdSetGeneral')}</option>
              {connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label>{t('cmdSetCommands')}</label>
            <textarea
              value={commandsText}
              onChange={(e) => setCommandsText(e.target.value)}
              placeholder={t('cmdSetCommandsPlaceholder')}
              rows={10}
              className="commands-textarea"
            />
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn-cancel" onClick={onClose}>
            {t('cancel')}
          </button>
          <button className="btn-primary" onClick={handleSave}>
            {cmdSet ? t('update') : t('create')}
          </button>
        </div>
      </div>
    </div>
  )
}

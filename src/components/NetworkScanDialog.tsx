import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { v4 as uuidv4 } from 'uuid'
import type { ConnectionConfig, ScanResult } from '../types'
import { scanNetwork, saveConnection } from '../commands'
import { useI18n } from '../i18n'

interface NetworkScanDialogProps {
  onClose: () => void
  /** Called after at least one connection was saved (refreshes the sidebar list). */
  onSaved: () => void
  /** Group pre-filled into the group field of added connections. */
  defaultGroup?: string
  /** Existing groups offered by the group dropdown. */
  existingGroups?: string[]
}

const resultKey = (r: ScanResult) => `${r.ip}:${r.port}`

/** Merge `incoming` into `prev`, replacing rows with the same `ip:port`. */
function upsertResults(prev: ScanResult[], incoming: ScanResult[]): ScanResult[] {
  if (incoming.length === 0) return prev
  const map = new Map(prev.map((r) => [resultKey(r), r]))
  for (const r of incoming) map.set(resultKey(r), r)
  return Array.from(map.values())
}

function parsePorts(text: string): number[] {
  const ports = text
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0 && n <= 65535)
  return Array.from(new Set(ports)).sort((a, b) => a - b)
}

export const NetworkScanDialog: React.FC<NetworkScanDialogProps> = ({
  onClose,
  onSaved,
  defaultGroup = '',
  existingGroups = [],
}) => {
  const { t } = useI18n()
  const [target, setTarget] = useState('')
  const [portsText, setPortsText] = useState('22')
  const [group, setGroup] = useState(defaultGroup)
  const [groupMode, setGroupMode] = useState<'select' | 'new'>(
    defaultGroup && !existingGroups.includes(defaultGroup) ? 'new' : 'select',
  )
  const [timeoutMs, setTimeoutMs] = useState('600')
  const [concurrency, setConcurrency] = useState('200')
  const [showAdvanced, setShowAdvanced] = useState(false)

  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<ScanResult[]>([])
  const [total, setTotal] = useState(0)
  const [done, setDone] = useState(0)
  const [added, setAdded] = useState<Set<string>>(new Set())

  // Lets the event listeners know whether a scan is active (events arriving
  // after a scan was closed/reset are ignored).
  const activeRef = useRef(false)

  useEffect(() => {
    let unlisteners: UnlistenFn[] = []
    let mounted = true
    const setup = async () => {
      unlisteners.push(
        await listen<{ total: number }>('scan-start', (e) => {
          if (mounted && activeRef.current) setTotal(e.payload.total)
        }),
      )
      unlisteners.push(
        await listen<ScanResult>('scan-progress', (e) => {
          if (!mounted || !activeRef.current) return
          setResults((prev) => upsertResults(prev, [e.payload]))
          setDone((d) => d + 1)
        }),
      )
    }
    void setup()
    return () => {
      mounted = false
      unlisteners.forEach((u) => u())
    }
  }, [])

  const openResults = useMemo(() => results.filter((r) => r.open), [results])

  const handleScan = async () => {
    if (scanning) return
    const trimmed = target.trim()
    if (!trimmed) {
      setError(t('scanTargetRequired'))
      return
    }
    const ports = parsePorts(portsText)
    if (ports.length === 0) {
      setError(t('scanPortsInvalid'))
      return
    }
    setError(null)
    setResults([])
    setAdded(new Set())
    setTotal(0)
    setDone(0)
    activeRef.current = true
    setScanning(true)
    try {
      const all = await scanNetwork({
        target: trimmed,
        ports,
        timeoutMs: Number(timeoutMs) || 600,
        concurrency: Number(concurrency) || 200,
      })
      if (!activeRef.current) return // a newer scan took over
      setResults((prev) => upsertResults(prev, all))
      setDone(all.length)
      setTotal((prev) => prev || all.length)
    } catch (e) {
      if (activeRef.current) setError(t('scanErrorPrefix', { err: String(e) }))
    } finally {
      activeRef.current = false
      setScanning(false)
    }
  }

  const buildConfig = useCallback(
    (r: ScanResult): ConnectionConfig => {
      const isTelnet = r.service === 'telnet'
      return {
        id: uuidv4(),
        name: `${r.ip}:${r.port}`,
        host: r.ip,
        port: r.port,
        username: isTelnet ? '' : 'root',
        kind: isTelnet ? 'telnet' : 'ssh',
        group: group.trim() || undefined,
      }
    },
    [group],
  )

  const handleAdd = async (r: ScanResult) => {
    try {
      await saveConnection(buildConfig(r))
      setAdded((prev) => new Set(prev).add(resultKey(r)))
      onSaved()
    } catch (e) {
      setError(t('scanErrorPrefix', { err: String(e) }))
    }
  }

  const handleAddAll = async () => {
    const targets = openResults.filter((r) => !added.has(resultKey(r)))
    if (targets.length === 0) return
    let failed = false
    for (const r of targets) {
      try {
        await saveConnection(buildConfig(r))
      } catch (e) {
        console.error('Failed to save connection:', e)
        failed = true
      }
    }
    if (!failed) setError(null)
    setAdded((prev) => {
      const next = new Set(prev)
      for (const r of targets) next.add(resultKey(r))
      return next
    })
    onSaved()
  }

  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal scan-dialog"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
      >
        <div className="modal-header">
          <h3>{t('scanNetwork')}</h3>
          <span onClick={onClose} style={{ cursor: 'pointer', fontSize: '18px', color: '#888' }}>
            ✕
          </span>
        </div>

        <div className="modal-body">
          <div className="form-row">
            <div className="form-group" style={{ flex: 2 }}>
              <label>{t('scanTarget')}</label>
              <input
                className="form-input"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                placeholder={t('scanTargetPlaceholder')}
                spellCheck={false}
                autoComplete="off"
                onKeyDown={(e) => e.key === 'Enter' && void handleScan()}
              />
            </div>
          </div>

          <div className="form-row">
            <div className="form-group" style={{ flex: 1 }}>
              <label>{t('scanPorts')}</label>
              <input
                className="form-input"
                value={portsText}
                onChange={(e) => setPortsText(e.target.value)}
                placeholder={t('scanPortsPlaceholder')}
                spellCheck={false}
                autoComplete="off"
              />
            </div>
            <div className="form-group" style={{ flex: 1 }}>
              <label>{t('scanGroupOptional')}</label>
              <select
                className="form-select"
                value={groupMode === 'new' ? '__new__' : group}
                onChange={(e) => {
                  const v = e.target.value
                  if (v === '__new__') {
                    setGroupMode('new')
                    if (!group) setGroup('')
                  } else {
                    setGroupMode('select')
                    setGroup(v)
                  }
                }}
              >
                <option value="">{t('noGroup')}</option>
                {existingGroups.map((g) => (
                  <option key={g} value={g}>
                    {g}
                  </option>
                ))}
                <option value="__new__">{t('newGroup')}</option>
              </select>
              {groupMode === 'new' && (
                <input
                  className="form-input"
                  style={{ marginTop: '6px' }}
                  value={group}
                  onChange={(e) => setGroup(e.target.value)}
                  placeholder={t('newGroupName')}
                  spellCheck={false}
                  autoComplete="off"
                />
              )}
            </div>
          </div>

          {showAdvanced && (
            <div className="form-row">
              <div className="form-group">
                <label>{t('scanTimeout')}</label>
                <input
                  className="form-input"
                  type="number"
                  min={50}
                  max={10000}
                  value={timeoutMs}
                  onChange={(e) => setTimeoutMs(e.target.value)}
                />
              </div>
              <div className="form-group">
                <label>{t('scanConcurrency')}</label>
                <input
                  className="form-input"
                  type="number"
                  min={1}
                  max={1000}
                  value={concurrency}
                  onChange={(e) => setConcurrency(e.target.value)}
                />
              </div>
            </div>
          )}

          <div className="scan-actions">
            <button className="btn-primary" disabled={scanning} onClick={() => void handleScan()}>
              {scanning ? t('scanning') : t('scanStart')}
            </button>
            <button
              className="btn-secondary"
              disabled={scanning || openResults.length === 0}
              onClick={() => void handleAddAll()}
            >
              {t('scanAddAll')}
            </button>
            <span className="scan-advanced-toggle" onClick={() => setShowAdvanced((s) => !s)}>
              {showAdvanced ? t('hideAdvanced') : t('showAdvanced')}
            </span>
          </div>

          <div className="scan-hint">{t('scanHint')}</div>

          {error && <div className="scan-error">{error}</div>}

          {scanning && (
            <div className="scan-progress">
              <span className="scan-spinner" />
              <span>{t('scanProgress', { done, total })}</span>
              <div className="scan-progress-bar">
                <div className="scan-progress-fill" style={{ width: `${percent}%` }} />
              </div>
            </div>
          )}

          {(results.length > 0 || !scanning) && (
            <div className="scan-results">
              <div className="scan-results-title">
                {t('scanResults')}
                {openResults.length > 0 && (
                  <span className="scan-results-count">{openResults.length}</span>
                )}
              </div>
              {openResults.length === 0 ? (
                <div className="scan-empty">{t('scanEmpty')}</div>
              ) : (
                <div className="scan-table-wrap">
                  <table className="scan-table">
                    <thead>
                      <tr>
                        <th>{t('scanOpen')}</th>
                        <th>IP</th>
                        <th>Port</th>
                        <th>{t('scanService')}</th>
                        <th>{t('scanBanner')}</th>
                        <th>{t('scanLatency')}</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {openResults.map((r) => {
                        const key = resultKey(r)
                        const isAdded = added.has(key)
                        return (
                          <tr key={key}>
                            <td className="scan-open-cell">
                              <span className="scan-dot" />
                            </td>
                            <td>{r.ip}</td>
                            <td>{r.port}</td>
                            <td>
                              <span className={`scan-service service-${r.service}`}>
                                {r.service === 'ssh'
                                  ? t('serviceSsh')
                                  : r.service === 'telnet'
                                    ? t('serviceTelnet')
                                    : t('serviceUnknown')}
                              </span>
                            </td>
                            <td className="scan-banner" title={r.banner}>
                              {r.banner || '—'}
                            </td>
                            <td>{r.latencyMs !== undefined ? `${r.latencyMs}ms` : '—'}</td>
                            <td>
                              {isAdded ? (
                                <span className="scan-added">{t('scanAdded')}</span>
                              ) : (
                                <button className="scan-add-btn" onClick={() => void handleAdd(r)}>
                                  {t('scanAdd')}
                                </button>
                              )}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="modal-actions">
          <button className="btn-secondary" onClick={onClose}>
            {t('close')}
          </button>
        </div>
      </div>
    </div>
  )
}

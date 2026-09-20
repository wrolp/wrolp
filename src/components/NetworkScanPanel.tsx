import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { v4 as uuidv4 } from 'uuid'
import type { ConnectionConfig, ScanResult } from '../types'
import { scanNetwork, saveConnection } from '../commands'
import { useI18n } from '../i18n'
import { Icon } from './Icon'

interface NetworkScanPanelProps {
  /** Groups offered by the group dropdown. */
  existingGroups?: string[]
  /** Called after at least one connection was saved (refreshes the nav list). */
  onSaved: () => void
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

/** Subnet scan, living in the inspector's Network tab.
 *
 * It used to be a modal, which is why the whole point of this one is that the
 * terminal keeps working underneath it: `scan_network` runs for as long as the
 * CIDR does, and its progress arrives as `scan-start` / `scan-progress` events
 * the panel listens for while the user carries on with the shell. */
export const NetworkScanPanel: React.FC<NetworkScanPanelProps> = ({
  existingGroups = [],
  onSaved,
}) => {
  const { t } = useI18n()
  const [target, setTarget] = useState('')
  const [portsText, setPortsText] = useState('22')
  const [group, setGroup] = useState('')
  const [groupMode, setGroupMode] = useState<'select' | 'new'>('select')
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
    const unlisteners: UnlistenFn[] = []
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
    <div className="netscan-panel">
      <div className="netscan-form">
        <div className="form-group">
          <label htmlFor="netscan-target">{t('scanTarget')}</label>
          <input
            id="netscan-target"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder={t('scanTargetPlaceholder')}
            spellCheck={false}
            autoComplete="off"
            onKeyDown={(e) => e.key === 'Enter' && void handleScan()}
          />
        </div>

        <div className="netscan-form-row">
          <div className="form-group">
            <label htmlFor="netscan-ports">{t('scanPorts')}</label>
            <input
              id="netscan-ports"
              value={portsText}
              onChange={(e) => setPortsText(e.target.value)}
              placeholder={t('scanPortsPlaceholder')}
              spellCheck={false}
              autoComplete="off"
            />
          </div>
          <div className="form-group">
            <label htmlFor="netscan-group">{t('scanGroupOptional')}</label>
            <select
              id="netscan-group"
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
          </div>
        </div>

        {groupMode === 'new' && (
          <div className="form-group">
            <label htmlFor="netscan-newgroup">{t('newGroup')}</label>
            <input
              id="netscan-newgroup"
              value={group}
              onChange={(e) => setGroup(e.target.value)}
              placeholder={t('newGroupName')}
              spellCheck={false}
              autoComplete="off"
            />
          </div>
        )}

        {showAdvanced && (
          <div className="netscan-form-row">
            <div className="form-group">
              <label htmlFor="netscan-timeout">{t('scanTimeout')}</label>
              <input
                id="netscan-timeout"
                type="number"
                min={50}
                max={10000}
                value={timeoutMs}
                onChange={(e) => setTimeoutMs(e.target.value)}
              />
            </div>
            <div className="form-group">
              <label htmlFor="netscan-concurrency">{t('scanConcurrency')}</label>
              <input
                id="netscan-concurrency"
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
          <button
            type="button"
            className="scan-advanced-toggle"
            aria-expanded={showAdvanced}
            onClick={() => setShowAdvanced((s) => !s)}
          >
            {showAdvanced ? t('hideAdvanced') : t('showAdvanced')}
          </button>
        </div>
        <div className="scan-hint">{t('scanHint')}</div>
      </div>

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
          // A list, not the modal's seven-column table: at the column's default
          // width every cell would have ellipsised into uselessness. The address
          // gets the first line, the banner — the only field that needs room — a
          // second line of its own.
          <ul className="scan-list">
            {openResults.map((r) => {
              const key = resultKey(r)
              const isAdded = added.has(key)
              return (
                <li key={key} className="scan-item">
                  <div className="scan-item-head">
                    <span className="scan-dot" aria-hidden="true" />
                    <span className="scan-item-addr">
                      {r.ip}:{r.port}
                    </span>
                    <span className={`scan-service service-${r.service}`}>
                      {r.service === 'ssh'
                        ? t('serviceSsh')
                        : r.service === 'telnet'
                          ? t('serviceTelnet')
                          : t('serviceUnknown')}
                    </span>
                    <span className="scan-item-rtt">
                      {r.latencyMs !== undefined ? `${r.latencyMs}ms` : '—'}
                    </span>
                  </div>
                  {r.banner && (
                    <div className="scan-banner" title={r.banner}>
                      {r.banner}
                    </div>
                  )}
                  <div className="scan-item-foot">
                    {isAdded ? (
                      <span className="scan-added">
                        <Icon name="check" size={11} /> {t('scanAdded')}
                      </span>
                    ) : (
                      <button className="scan-add-btn" onClick={() => void handleAdd(r)}>
                        {t('scanAdd')}
                      </button>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}

export default NetworkScanPanel

import React, { useCallback, useEffect, useState } from 'react'
import type {
  DockerAnalysis,
  PackageInfo,
  ToolInfo,
  PortMapping,
  MountInfo,
  EnvEntry,
  ProcessInfo,
  ResourceUsage,
} from '../types'
import { analyzeDockerContainer, dockerContainerLogs } from '../commands'
import { useI18n } from '../i18n'

interface Props {
  activeTabId: number | null
  /** Set by parent when user triggers "Analyze Container". */
  targetContainer: string | null
  /** Called after analysis result is received. */
  onAnalyzed?: () => void
}

/** One-click Docker container analysis report. */
export const DockerAnalysisPanel: React.FC<Props> = ({
  activeTabId,
  targetContainer,
  onAnalyzed,
}) => {
  const { t } = useI18n()
  const [data, setData] = useState<DockerAnalysis | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const [pkgSearch, setPkgSearch] = useState('')

  // Logs viewer state
  const [logs, setLogs] = useState('')
  const [logsLoading, setLogsLoading] = useState(false)
  const [logsError, setLogsError] = useState('')
  const [logsTail, setLogsTail] = useState(200)
  const [logsAutoScroll, setLogsAutoScroll] = useState(true)
  const logsRef = React.useRef<HTMLPreElement>(null)

  const runAnalysis = useCallback(async () => {
    if (activeTabId == null || !targetContainer) return
    setLoading(true)
    setError('')
    setData(null)
    try {
      const result = await analyzeDockerContainer(activeTabId, targetContainer)
      setData(result)
      onAnalyzed?.()
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [activeTabId, targetContainer, onAnalyzed])

  useEffect(() => {
    if (targetContainer) {
      runAnalysis()
    }
  }, [targetContainer, runAnalysis])

  // Manual re-run
  const handleRefresh = () => runAnalysis()

  // Fetch container logs
  const fetchLogs = useCallback(async () => {
    if (activeTabId == null || !targetContainer) return
    setLogsLoading(true)
    setLogsError('')
    try {
      const output = await dockerContainerLogs(activeTabId, targetContainer, logsTail)
      setLogs(output)
    } catch (e) {
      setLogsError(String(e))
      setLogs('')
    } finally {
      setLogsLoading(false)
    }
  }, [activeTabId, targetContainer, logsTail])

  // Auto-scroll logs when new content arrives
  useEffect(() => {
    if (logsAutoScroll && logsRef.current) {
      logsRef.current.scrollTop = logsRef.current.scrollHeight
    }
  }, [logs, logsAutoScroll])

  // Fetch logs when container/tail lines change
  useEffect(() => {
    if (targetContainer) {
      fetchLogs()
    }
  }, [targetContainer, fetchLogs])

  if (loading) {
    return (
      <div className="docker-analysis-panel">
        <div className="analysis-loading">
          <p>{t('analyzingContainer')} <strong>{targetContainer}</strong>…</p>
          <div className="spinner" />
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="docker-analysis-panel">
        <div className="file-error">{error}</div>
      </div>
    )
  }

  if (!data) {
    return (
      <div className="docker-analysis-panel">
        <div className="file-empty">
          {targetContainer
            ? t('noDataForContainer', { container: targetContainer })
            : t('dockerAnalyzeHint')}
        </div>
      </div>
    )
  }

  const filteredPkgs = data.packages.filter(
    (p) => !pkgSearch || p.name.toLowerCase().includes(pkgSearch.toLowerCase()),
  )

  return (
    <div className="docker-analysis-panel">
      {/* ---- Header ---- */}
      <div className="analysis-header">
        <h3>
          <span className="docker-state-badge" title={data.state}>
            {data.state === 'running' ? '\u25CF' : '\u25CB'}
          </span>{' '}
          {data.containerName}
        </h3>
        <button className="analysis-refresh-btn" onClick={handleRefresh} title={t('reAnalyze')}>
          {t('reAnalyze')}
        </button>
        <div className="analysis-meta">
          Image: {data.image}:{data.imageTag} &middot; ID: {data.containerId}
        </div>
      </div>

      {/* ---- Orchestration (docker-compose vs direct run) ---- */}
      <div className="analysis-section analysis-orchestration">
        <h4>{data.orchestration.isCompose ? `☰ ${t('dockerCompose')}` : `⚙ ${t('directRun')}`}</h4>
        {/* Inferred compose file — shown for both compose & mount-detected containers */}
        {data.orchestration.inferredComposeFile && (
          <div className="orch-inferred-file">
            <span className="orch-inferred-icon">{'\u{1F4C4}'}</span>
            <span className="orch-inferred-path" title="compose.yml or docker-compose.yml">{data.orchestration.inferredComposeFile}</span>
            <span className="orch-inferred-tag">{t('composeFile')}</span>
          </div>
        )}
        {data.orchestration.isCompose ? (
          <div className="orch-compose">
            {data.orchestration.project && (
              <div className="orch-row">
                <span className="orch-label">{t('orchProject')}</span>
                <span className="orch-value">{data.orchestration.project}</span>
              </div>
            )}
            {data.orchestration.service && (
              <div className="orch-row">
                <span className="orch-label">{t('orchService')}</span>
                <span className="orch-value">{data.orchestration.service}</span>
              </div>
            )}
            {data.orchestration.configFiles && (
              <div className="orch-row">
                <span className="orch-label">{t('orchConfig')}</span>
                <span className="orch-value" style={{ wordBreak: 'break-all' }}>
                  {data.orchestration.configFiles}
                </span>
              </div>
            )}
            {data.orchestration.workingDir && (
              <div className="orch-row">
                <span className="orch-label">{t('orchWorkDir')}</span>
                <span className="orch-value">{data.orchestration.workingDir}</span>
              </div>
            )}
          </div>
        ) : (
          <div className="orch-direct">
            <div className="orch-row">
              <span className="orch-label">{t('orchImage')}</span>
              <span className="orch-value">{data.image}:{data.imageTag}</span>
            </div>
            {data.orchestration.startCommand ? (
              <div className="orch-row">
                <span className="orch-label">{t('orchCommand')}</span>
                <span className="orch-value" style={{ wordBreak: 'break-all', fontFamily: "'Cascadia Code', Consolas, monospace" }}>
                  {data.orchestration.startCommand}
                </span>
              </div>
            ) : (
              <div className="orch-row">
                <span className="orch-label">{t('orchCommand')}</span>
                <span className="orch-value" style={{ color: 'var(--text-dim, #999)' }}>
                  {t('builtinEntrypoint')}
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ---- Overview ---- */}
      <div className="analysis-section">
        <h4>{t('overview')}</h4>
        <div className="analysis-overview">
          {card(t('cardOs'), data.os)}
          {card(t('cardKernel'), data.kernel)}
          {card(t('cardArch'), data.arch)}
          {card(t('cardHostname'), data.hostname)}
          {card(t('cardPkgMgr'), data.packageManager)}
          {card(t('installedPackages', { n: data.packages.length }), String(data.packages.length))}
          {card(t('toolsDetected', { n: data.tools.length }), String(data.tools.length))}
          {card(t('ports', { n: data.ports.length }), String(data.ports.length))}
          {card(t('mounts', { n: data.mounts.length }), String(data.mounts.length))}
          {card(t('environment', { n: data.envKeys.length }), String(data.envKeys.length))}
          {card(t('processes', { n: data.processes.length }), String(data.processes.length))}
        </div>
      </div>

      {/* ---- Resource Usage ---- */}
      {data.resource && <ResourceSection resource={data.resource} />}

      {/* ---- Container Logs ---- */}
      <div className="analysis-section">
        <h4>{t('logs')}</h4>
        <div className="danalysis-logs-controls">
          <label>
            {t('logsTail')}
            <input
              type="number"
              className="logs-tail-input"
              min={10}
              max={10000}
              step={10}
              value={logsTail}
              onChange={(e) => setLogsTail(Math.max(10, Number(e.target.value) || 200))}
            />
            {t('logsLines')}
          </label>
          <button className="logs-fetch-btn" onClick={fetchLogs} disabled={logsLoading}>
            {logsLoading ? t('loading') : t('logsRefresh')}
          </button>
          <label className="logs-autoscroll-label">
            <input
              type="checkbox"
              checked={logsAutoScroll}
              onChange={(e) => setLogsAutoScroll(e.target.checked)}
            />
            {t('logsAutoScroll')}
          </label>
        </div>
        {logsError ? (
          <div className="logs-error">{logsError}</div>
        ) : logs ? (
          <pre className="danalysis-logs-output" ref={logsRef}>{logs}</pre>
        ) : (
          <div className="logs-empty">
            {logsLoading ? t('loading') : t('logsClickRefresh')}
          </div>
        )}
      </div>

      {/* ---- Ports ---- */}
      {data.ports.length > 0 && (
        <div className="analysis-section">
          <h4>{t('ports', { n: data.ports.length })}</h4>
          <table className="danalysis-table">
            <thead>
              <tr>
                <th>{t('containerPort')}</th>
                <th>{t('published')}</th>
              </tr>
            </thead>
            <tbody>
              {data.ports.map((p, i) => (
                <tr key={i}>
                  <td>{p.containerPort}</td>
                  <td>{p.hostPort ? `${p.hostIp || '0.0.0.0'}:${p.hostPort}` : '\u2014'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ---- Mounts ---- */}
      {data.mounts.length > 0 && (
        <div className="analysis-section">
          <h4>{t('mounts', { n: data.mounts.length })}</h4>
          <table className="danalysis-table">
            <thead>
              <tr>
                <th>{t('source')}</th>
                <th>{t('destination')}</th>
                <th>{t('mode')}</th>
              </tr>
            </thead>
            <tbody>
              {data.mounts.map((m, i) => (
                <tr key={i}>
                  <td title={m.source} className="cell-truncate">{m.source}</td>
                  <td>{m.destination}</td>
                  <td>{m.mode}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ---- Environment ---- */}
      {data.envKeys.length > 0 && (
        <div className="analysis-section">
          <h4>{t('environment', { n: data.envKeys.length })}</h4>
          <div className="env-chips">
            {data.envKeys.map((e, i) => (
              <span key={i} className="env-chip">{e.key}</span>
            ))}
          </div>
        </div>
      )}

      {/* ---- Processes ---- */}
      {data.processes.length > 0 && (
        <div className="analysis-section">
          <h4>{t('processes', { n: data.processes.length })}</h4>
          <table className="danalysis-table">
            <thead>
              <tr>
                <th>{t('pid')}</th>
                <th>{t('user')}</th>
                <th>{t('pcpu')}</th>
                <th>{t('pmem')}</th>
                <th>{t('command')}</th>
              </tr>
            </thead>
            <tbody>
              {data.processes.map((p, i) => (
                <tr key={i}>
                  <td>{p.pid}</td>
                  <td>{p.user}</td>
                  <td>{p.cpu}</td>
                  <td>{p.mem}</td>
                  <td title={p.command} className="cell-truncate">{p.command}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ---- Tools ---- */}
      {data.tools.length > 0 && (
        <div className="analysis-section">
          <h4>{t('toolsDetected', { n: data.tools.length })}</h4>
          <div className="tool-chips">
            {data.tools.map((t, i) => (
              <span key={i} className="tool-chip">{t.name}</span>
            ))}
          </div>
        </div>
      )}

      {/* ---- Packages ---- */}
      {data.packages.length > 0 && (
        <div className="analysis-section">
          <h4>{t('installedPackages', { n: filteredPkgs.length })}{pkgSearch ? ` / ${data.packages.length}` : ''}</h4>
          <input
            className="pkg-search"
            type="text"
            placeholder={t('searchPackages')}
            value={pkgSearch}
            onChange={(e) => setPkgSearch(e.target.value)}
          />
          <div className="pkg-list-container">
            <table className="pkg-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Version</th>
                </tr>
              </thead>
              <tbody>
                {filteredPkgs.slice(0, 200).map((p, i) => (
                  <tr key={i}>
                    <td>{p.name}</td>
                    <td>{p.version}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

/** Small overview card. */
function card(label: string, value: string) {
  return (
    <div className="analysis-card">
      <div className="card-label">{label}</div>
      <div className="card-value" title={value}>{value}</div>
    </div>
  )
}

/** Resource usage bars. */
function ResourceSection({ resource }: { resource: ResourceUsage }) {
  const { t } = useI18n()
  const cpuVal = parseFloat(resource.cpuPercent) || 0
  return (
    <div className="analysis-section">
      <h4>{t('resourceUsage')}</h4>
      <div className="danalysis-resource">
        <div className="resource-row">
          <span className="resource-label">{t('resCpu')}</span>
          <div className="resource-bar-bg">
            <div className="resource-bar-fill" style={{ width: `${Math.min(cpuVal, 100)}%` }} />
          </div>
          <span className="resource-val">{resource.cpuPercent}</span>
        </div>
        <div className="resource-row">
          <span className="resource-label">{t('resMem')}</span>
          <span className="resource-val">{resource.memUsage} / {resource.memLimit}</span>
        </div>
        <div className="resource-row">
          <span className="resource-label">{t('resNetIo')}</span>
          <span className="resource-val">{resource.netIO}</span>
        </div>
        <div className="resource-row">
          <span className="resource-label">{t('resBlockIo')}</span>
          <span className="resource-val">{resource.blockIO}</span>
        </div>
        <div className="resource-row">
          <span className="resource-label">{t('resPids')}</span>
          <span className="resource-val">{resource.pidCount}</span>
        </div>
      </div>
    </div>
  )
}

export default DockerAnalysisPanel

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
import { analyzeDockerContainer } from '../commands'

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
  const [data, setData] = useState<DockerAnalysis | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const [pkgSearch, setPkgSearch] = useState('')

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

  if (loading) {
    return (
      <div className="docker-analysis-panel">
        <div className="analysis-loading">
          <p>Analysing container <strong>{targetContainer}</strong>…</p>
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
            ? `No data for "${targetContainer}"`
            : 'Right-click a running container in the Docker panel and choose "Analyze Container".'}
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
        <button className="analysis-refresh-btn" onClick={handleRefresh} title="Re-analyse">
          Refresh
        </button>
        <div className="analysis-meta">
          Image: {data.image}:{data.imageTag} &middot; ID: {data.containerId}
        </div>
      </div>

      {/* ---- Orchestration (docker-compose vs direct run) ---- */}
      <div className="analysis-section analysis-orchestration">
        <h4>
          {data.orchestration.isCompose
            ? '\u2630 Docker Compose'
            : '\u2699 Direct Run'}
        </h4>
        {/* Inferred compose file — shown for both compose & mount-detected containers */}
        {data.orchestration.inferredComposeFile && (
          <div className="orch-inferred-file">
            <span className="orch-inferred-icon">{'\u{1F4C4}'}</span>
            <span className="orch-inferred-path" title="compose.yml or docker-compose.yml">{data.orchestration.inferredComposeFile}</span>
            <span className="orch-inferred-tag">compose file</span>
          </div>
        )}
        {data.orchestration.isCompose ? (
          <div className="orch-compose">
            {data.orchestration.project && (
              <div className="orch-row">
                <span className="orch-label">Project</span>
                <span className="orch-value">{data.orchestration.project}</span>
              </div>
            )}
            {data.orchestration.service && (
              <div className="orch-row">
                <span className="orch-label">Service</span>
                <span className="orch-value">{data.orchestration.service}</span>
              </div>
            )}
            {data.orchestration.configFiles && (
              <div className="orch-row">
                <span className="orch-label">Config</span>
                <span className="orch-value" style={{ wordBreak: 'break-all' }}>
                  {data.orchestration.configFiles}
                </span>
              </div>
            )}
            {data.orchestration.workingDir && (
              <div className="orch-row">
                <span className="orch-label">WorkDir</span>
                <span className="orch-value">{data.orchestration.workingDir}</span>
              </div>
            )}
          </div>
        ) : (
          <div className="orch-direct">
            <div className="orch-row">
              <span className="orch-label">Image</span>
              <span className="orch-value">{data.image}:{data.imageTag}</span>
            </div>
            {data.orchestration.startCommand ? (
              <div className="orch-row">
                <span className="orch-label">Command</span>
                <span className="orch-value" style={{ wordBreak: 'break-all', fontFamily: "'Cascadia Code', Consolas, monospace" }}>
                  {data.orchestration.startCommand}
                </span>
              </div>
            ) : (
              <div className="orch-row">
                <span className="orch-label">Command</span>
                <span className="orch-value" style={{ color: 'var(--text-dim, #999)' }}>
                  (built-in entrypoint / default CMD)
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ---- Overview ---- */}
      <div className="analysis-section">
        <h4>Overview</h4>
        <div className="analysis-overview">
          {card('OS', data.os)}
          {card('Kernel', data.kernel)}
          {card('Arch', data.arch)}
          {card('Hostname', data.hostname)}
          {card('PKG Mgr', data.packageManager)}
          {card('Packages', String(data.packages.length))}
          {card('Tools', String(data.tools.length))}
          {card('Ports', String(data.ports.length))}
          {card('Mounts', String(data.mounts.length))}
          {card('Env Keys', String(data.envKeys.length))}
          {card('Processes', String(data.processes.length))}
        </div>
      </div>

      {/* ---- Resource Usage ---- */}
      {data.resource && <ResourceSection resource={data.resource} />}

      {/* ---- Ports ---- */}
      {data.ports.length > 0 && (
        <div className="analysis-section">
          <h4>Ports ({data.ports.length})</h4>
          <table className="danalysis-table">
            <thead>
              <tr>
                <th>Container Port</th>
                <th>Published</th>
              </tr>
            </thead>
            <tbody>
              {data.ports.map((p, i) => (
                <tr key={i}>
                  <td>{p.containerPort}</td>
                  <td>
                    {p.hostPort
                      ? `${p.hostIp || '0.0.0.0'}:${p.hostPort}`
                      : '\u2014'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ---- Mounts ---- */}
      {data.mounts.length > 0 && (
        <div className="analysis-section">
          <h4>Mounts ({data.mounts.length})</h4>
          <table className="danalysis-table">
            <thead>
              <tr>
                <th>Source</th>
                <th>Destination</th>
                <th>Mode</th>
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
          <h4>Environment ({data.envKeys.length} keys)</h4>
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
          <h4>Processes ({data.processes.length})</h4>
          <table className="danalysis-table">
            <thead>
              <tr>
                <th>PID</th>
                <th>User</th>
                <th>CPU%</th>
                <th>MEM%</th>
                <th>Command</th>
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
          <h4>Tools ({data.tools.length})</h4>
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
          <h4>Packages ({filteredPkgs.length}{pkgSearch ? ` / ${data.packages.length}` : ''})</h4>
          <input
            className="pkg-search"
            type="text"
            placeholder="Search packages…"
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
  const cpuVal = parseFloat(resource.cpuPercent) || 0
  return (
    <div className="analysis-section">
      <h4>Resource Usage</h4>
      <div className="danalysis-resource">
        <div className="resource-row">
          <span className="resource-label">CPU</span>
          <div className="resource-bar-bg">
            <div className="resource-bar-fill" style={{ width: `${Math.min(cpuVal, 100)}%` }} />
          </div>
          <span className="resource-val">{resource.cpuPercent}</span>
        </div>
        <div className="resource-row">
          <span className="resource-label">Mem</span>
          <span className="resource-val">{resource.memUsage} / {resource.memLimit}</span>
        </div>
        <div className="resource-row">
          <span className="resource-label">Net IO</span>
          <span className="resource-val">{resource.netIO}</span>
        </div>
        <div className="resource-row">
          <span className="resource-label">Block IO</span>
          <span className="resource-val">{resource.blockIO}</span>
        </div>
        <div className="resource-row">
          <span className="resource-label">PIDs</span>
          <span className="resource-val">{resource.pidCount}</span>
        </div>
      </div>
    </div>
  )
}

export default DockerAnalysisPanel

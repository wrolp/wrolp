import React, { useState, useCallback, useEffect } from 'react'
import { analyzeHost, commandHelp } from '../commands'
import type { HostAnalysis, PackageInfo, ToolInfo, ConnectionConfig } from '../types'
import { Icon } from './Icon'
import { useI18n } from '../i18n'

interface HostAnalysisPanelProps {
  activeTabId: number | null
  connections: ConnectionConfig[]
}

export const HostAnalysisPanel: React.FC<HostAnalysisPanelProps> = ({ activeTabId, connections }) => {
  const { t } = useI18n()
  const [analysis, setAnalysis] = useState<HostAnalysis | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pkgSearch, setPkgSearch] = useState('')
  const [selectedTool, setSelectedTool] = useState<string | null>(null)
  const [helpText, setHelpText] = useState<string | null>(null)
  const [helpLoading, setHelpLoading] = useState(false)

  // Reset when tab changes
  useEffect(() => {
    setAnalysis(null)
    setError(null)
    setSelectedTool(null)
    setHelpText(null)
  }, [activeTabId])

  const handleAnalyze = useCallback(async () => {
    if (activeTabId === null) return
    setLoading(true)
    setError(null)
    setAnalysis(null)
    setHelpText(null)
    try {
      const result = await analyzeHost(activeTabId)
      setAnalysis(result)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [activeTabId])

  const handleToolClick = useCallback(async (toolName: string) => {
      if (activeTabId === null) return
      setSelectedTool(toolName)
      setHelpLoading(true)
      setHelpText(null)
      try {
        const text = await commandHelp(activeTabId, toolName)
        setHelpText(text)
      } catch (e) {
        setHelpText(`Error: ${e}`)
      } finally {
        setHelpLoading(false)
      }
  }, [activeTabId])

  const filteredPackages = (analysis?.packages ?? []).filter((p) =>
    p.name.toLowerCase().includes(pkgSearch.toLowerCase()),
  )

  const conn = activeTabId !== null
      ? connections.find((c) => c.id === analysis?.tabId?.toString() || analysis)
      : null

  const connectionName = activeTabId !== null
    ? connections.find(c => analysis && c.id.toString() === String(analysis.tabId))?.name ?? `Tab ${activeTabId}`
      : '—'

  return (
    <div className="host-analysis-panel">
      {/* Toolbar */}
      <div className="analysis-toolbar">
        <button
          className="analyze-btn"
          onClick={handleAnalyze}
          disabled={loading || activeTabId === null}
        >
          <Icon name="refresh" />
          {loading ? t('analyzing') : t('analyzeHost')}
        </button>
        {activeTabId === null && <span className="analysis-hint">{t('connectToHostFirst')}</span>}
      </div>

      {error && <div className="analysis-error">{error}</div>}

      {loading && (
        <div className="analysis-loading">
          <div className="spinner" />
          <span>{t('runningAnalysis')}</span>
        </div>
      )}

      {analysis && !loading && (
        <>
          {/* Overview cards */}
          <div className="analysis-overview">
            <div className="analysis-card">
              <span className="card-label">{t('cardOs')}</span>
              <span className="card-value">{analysis.os}</span>
            </div>
            <div className="analysis-card">
              <span className="card-label">{t('cardKernel')}</span>
              <span className="card-value">{analysis.kernel}</span>
            </div>
            <div className="analysis-card">
              <span className="card-label">{t('cardArch')}</span>
              <span className="card-value">{analysis.arch}</span>
            </div>
            <div className="analysis-card">
              <span className="card-label">{t('cardHostname')}</span>
              <span className="card-value">{analysis.hostname}</span>
            </div>
            <div className="analysis-card">
              <span className="card-label">{t('cardPkgMgr')}</span>
              <span className="card-value">{analysis.packageManager}</span>
            </div>
            <div className="analysis-card">
              <span className="card-label">{t('cardTools')}</span>
              <span className="card-value">{analysis.tools.length}</span>
            </div>
          </div>

          {/* Tools section */}
          <div className="analysis-section">
            <h3>{t('toolsDetected', { n: analysis.tools.length })}</h3>
            <div className="tools-chips">
              {analysis.tools.map((tool) => (
                <button
                  key={tool.name}
                  className={`tool-chip${selectedTool === tool.name ? ' active' : ''}`}
                  onClick={() => handleToolClick(tool.name)}
                  title={t('helpOutputFor') + ' ' + tool.name}
                >
                  {tool.name}
                </button>
              ))}
              {analysis.tools.length === 0 && (
                <span className="analysis-empty">{t('noCommonTools')}</span>
              )}
            </div>
          </div>

          {/* Help output */}
          {selectedTool && (
            <div className="analysis-help">
              <div className="help-header">
                <span className="help-title">
                  <code>{selectedTool}</code> {t('helpOutputFor')}
                </span>
                <button
                  className="help-close"
                  onClick={() => {
                    setSelectedTool(null)
                    setHelpText(null)
                  }}
                  title={t('close')}
                >
                  <Icon name="x" size={14} />
                </button>
              </div>
              <pre className="help-content">
                {helpLoading ? t('loading') : (helpText ?? t('noHelpAvailable'))}
              </pre>
            </div>
          )}

          {/* Packages section */}
          <div className="analysis-section">
            <h3>{t('installedPackages', { n: analysis.packages.length })}</h3>
            <input
              type="text"
              className="pkg-search"
              placeholder={t('searchPackages')}
              value={pkgSearch}
              onChange={(e) => setPkgSearch(e.target.value)}
            />
            <div className="pkg-table-wrap">
              <table className="pkg-table">
                <thead>
                  <tr>
                    <th>{t('pkgName')}</th>
                    <th>{t('pkgVersion')}</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredPackages.slice(0, 200).map((pkg, i) => (
                    <tr key={`${pkg.name}-${i}`}>
                      <td>{pkg.name}</td>
                      <td>{pkg.version}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {filteredPackages.length > 200 && (
                <div className="pkg-more">{t('pkgShowingFirst', { shown: 200, total: filteredPackages.length })}</div>
              )}
              {filteredPackages.length === 0 && (
                <div className="analysis-empty">{t('pkgNoMatch')}</div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

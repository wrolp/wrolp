import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  dockerContainerLogs,
  dockerLogsStreamStart,
  pollDockerLogs,
  stopDockerLogsStream,
} from '../commands'

interface DockerLogViewerProps {
  tabId: number
  jumpTabId: number
  containerName: string
  containerImage?: string
  initialTail?: number
}

const MAX_LOG_CHARS = 200_000 // ~5000 lines — trim head when exceeded

export const DockerLogViewer: React.FC<DockerLogViewerProps> = ({
  tabId,
  jumpTabId,
  containerName,
  containerImage,
  initialTail = 200,
}) => {
  const [logs, setLogs] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [tail, setTail] = useState(initialTail)
  const [autoScroll, setAutoScroll] = useState(true)
  const [wordWrap, setWordWrap] = useState(false)
  const [follow, setFollow] = useState(false)
  const logsRef = useRef<HTMLPreElement>(null)

  // Track active stream so we can stop it on unmount / toggle-off
  const streamIdRef = useRef<string | null>(null)
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // ---- one-shot fetch (non-follow mode) ----
  const fetchLogs = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const output = await dockerContainerLogs(jumpTabId, containerName, tail)
      setLogs(trimHead(output))
    } catch (e) {
      setError(String(e))
      setLogs('')
    } finally {
      setLoading(false)
    }
  }, [jumpTabId, containerName, tail])

  // ---- start / stop streaming ----
  const startStream = useCallback(async () => {
    // Stop any existing stream first
    if (streamIdRef.current) {
      await stopDockerLogsStream(streamIdRef.current).catch(() => {})
      streamIdRef.current = null
    }
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current)
      pollTimerRef.current = null
    }

    setError('')
    setLoading(true)
    try {
      const sid = await dockerLogsStreamStart(jumpTabId, containerName, tail)
      streamIdRef.current = sid

      // Start polling — 500ms is fast enough for real-time feel
      pollTimerRef.current = setInterval(async () => {
        try {
          const chunks = await pollDockerLogs(sid)
          if (chunks.length > 0) {
            setLogs((prev) => trimHead(prev + chunks.join('')))
          }
        } catch {
          // ignore poll errors — stream may have ended
        }
      }, 500)
    } catch (e) {
      setError(String(e))
      setFollow(false)
    } finally {
      setLoading(false)
    }
  }, [jumpTabId, containerName, tail])

  const stopStream = useCallback(async () => {
    if (streamIdRef.current) {
      await stopDockerLogsStream(streamIdRef.current).catch(() => {})
      streamIdRef.current = null
    }
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current)
      pollTimerRef.current = null
    }
  }, [])

  // ---- follow toggle ----
  const toggleFollow = useCallback(() => {
    setFollow((prev) => {
      const next = !prev
      if (next) {
        startStream()
      } else {
        stopStream().then(() => {
          // Re-fetch fresh complete logs when leaving follow mode
          fetchLogs()
        })
      }
      return next
    })
  }, [startStream, stopStream, fetchLogs])

  // Auto-scroll when new logs arrive
  useEffect(() => {
    if (autoScroll && logsRef.current) {
      logsRef.current.scrollTop = logsRef.current.scrollHeight
    }
  }, [logs, autoScroll])

  // Fetch on mount (non-follow)
  useEffect(() => {
    fetchLogs()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Cleanup stream on unmount
  useEffect(() => {
    return () => {
      if (streamIdRef.current) {
        stopDockerLogsStream(streamIdRef.current).catch(() => {})
      }
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current)
      }
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="docker-log-viewer">
      <div className="dlv-header">
        <div className="dlv-header-info">
          <span className="dlv-container-name">{containerName}</span>
          {containerImage && <span className="dlv-container-image">{containerImage}</span>}
        </div>
        <div className="dlv-controls">
          {!follow && (
            <label className="dlv-control-item">
              Tail
              <input
                type="number"
                className="dlv-tail-input"
                min={10}
                max={100000}
                step={10}
                value={tail}
                onChange={(e) => setTail(Math.max(10, Number(e.target.value) || 200))}
              />
              lines
            </label>
          )}
          {!follow && (
            <button className="dlv-refresh-btn" onClick={fetchLogs} disabled={loading}>
              {loading ? 'Loading\u2026' : 'Refresh'}
            </button>
          )}
          <button className="dlv-clear-btn" onClick={() => { setLogs(''); setError('') }}>
            Clear
          </button>
          <button
            className={'dlv-follow-btn' + (follow ? ' dlv-follow-active' : '')}
            onClick={toggleFollow}
            disabled={loading}
            title={follow ? 'Stop following logs' : 'Follow logs (docker logs -f)'}
          >
            {follow ? 'Following\u2026' : 'Follow'}
          </button>
          <label className="dlv-control-item dlv-checkbox">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
            />
            Auto-scroll
          </label>
          <label className="dlv-control-item dlv-checkbox">
            <input
              type="checkbox"
              checked={wordWrap}
              onChange={(e) => setWordWrap(e.target.checked)}
            />
            Wrap
          </label>
        </div>
      </div>

      <div className="dlv-body">
        {error ? (
          <div className="dlv-error">{error}</div>
        ) : logs ? (
          <pre
            className={'dlv-output' + (wordWrap ? ' dlv-output-wrap' : '')}
            ref={logsRef}
          >
            {logs}
          </pre>
        ) : (
          <div className="dlv-empty">
            {loading ? 'Loading logs\u2026' : 'No log output'}
          </div>
        )}
      </div>
    </div>
  )
}

/// Drop oldest chars when the buffer exceeds `MAX_LOG_CHARS`,
/// keeping complete lines from the first newline boundary.
function trimHead(text: string): string {
  if (text.length <= MAX_LOG_CHARS) return text
  const cut = text.length - MAX_LOG_CHARS
  const nl = text.indexOf('\n', cut)
  return nl >= 0 ? text.slice(nl + 1) : text.slice(cut)
}

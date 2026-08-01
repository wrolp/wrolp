import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  dockerContainerLogs,
  dockerLogsStreamStart,
  pollDockerLogs,
  stopDockerLogsStream,
} from '../commands'
import { parseAnsiToHtml } from '../ansi'

interface DockerLogViewerProps {
  tabId: number
  jumpTabId: number
  containerName: string
  containerImage?: string
  initialTail?: number
  onAskAi?: (text: string) => void
}

const MAX_LOG_CHARS = 200_000 // ~5000 lines — trim head when exceeded

export const DockerLogViewer: React.FC<DockerLogViewerProps> = ({
  tabId,
  jumpTabId,
  containerName,
  containerImage,
  initialTail = 200,
  onAskAi,
}) => {
  const [logs, setLogs] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [tail, setTail] = useState(initialTail)
  const [autoScroll, setAutoScroll] = useState(true)
  const [wordWrap, setWordWrap] = useState(false)
  const [color, setColor] = useState(true)
  const [follow, setFollow] = useState(false)
  const [showJumpToBottom, setShowJumpToBottom] = useState(false)
  const logsRef = useRef<HTMLPreElement>(null)
  const userAtBottomRef = useRef(true)

  // ---- right-click context menu (Ask AI Assistant) ----
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null)
  const ctxMenuRef = useRef<HTMLDivElement>(null)

  const handleLogContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (!onAskAi) return
      e.preventDefault()
      e.stopPropagation()
      setCtxMenu({ x: e.clientX, y: e.clientY })
    },
    [onAskAi],
  )

  // Close the menu on outside click / Escape
  useEffect(() => {
    if (!ctxMenu) return
    const onDown = (e: MouseEvent) => {
      if (ctxMenuRef.current && !ctxMenuRef.current.contains(e.target as Node)) {
        setCtxMenu(null)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCtxMenu(null)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [ctxMenu])

  const handleAskAiFromMenu = useCallback(() => {
    setCtxMenu(null)
    if (!onAskAi) return
    // Prefer the user's current text selection; fall back to the full log buffer.
    const selection = window.getSelection()?.toString().trim()
    const text = selection || logs
    if (!text) return
    const prefix = `The following are logs from Docker container "${containerName}":\n\n`
    onAskAi(prefix + text)
  }, [onAskAi, logs, containerName])

  // Track active stream so we can stop it on unmount / toggle-off
  const streamIdRef = useRef<string | null>(null)
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // ---- detect whether user is scrolled to the bottom ----
  const handleScroll = useCallback(() => {
    const el = logsRef.current
    if (!el) return
    // 5px threshold — tiny enough to not miss the real bottom
    userAtBottomRef.current = el.scrollTop + el.clientHeight + 5 >= el.scrollHeight
    setShowJumpToBottom(!userAtBottomRef.current)
  }, [])

  // Bind scroll listener on the pre element (re-bind when ref changes)
  useEffect(() => {
    const el = logsRef.current
    if (!el) return
    el.addEventListener('scroll', handleScroll, { passive: true })
    // re-evaluate in case the element was already scrolled
    handleScroll()
    return () => el.removeEventListener('scroll', handleScroll)
  }, [handleScroll, logs /* re-bind when content changes so scrollHeight is fresh */])

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

  // ---- ANSI → coloured HTML (memoized — parsing is O(n)) ----
  const logsHtml = useMemo(() => {
    if (!logs) return ''
    return color ? parseAnsiToHtml(logs) : escapeLogs(logs)
  }, [logs, color])

  // Auto-scroll only when user is at the bottom
  useEffect(() => {
    if (autoScroll && userAtBottomRef.current && logsRef.current) {
      logsRef.current.scrollTop = logsRef.current.scrollHeight
    }
  }, [logsHtml, autoScroll])

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
          <label className="dlv-control-item dlv-checkbox">
            <input
              type="checkbox"
              checked={color}
              onChange={(e) => setColor(e.target.checked)}
            />
            Color
          </label>
        </div>
      </div>

      <div className="dlv-body">
        {error ? (
          <div className="dlv-error">{error}</div>
        ) : logs ? (
          <>
            <pre
              className={'dlv-output' + (wordWrap ? ' dlv-output-wrap' : '')}
              ref={logsRef}
              onContextMenu={handleLogContextMenu}
              dangerouslySetInnerHTML={{ __html: logsHtml }}
            />
            {ctxMenu && (
              <div
                ref={ctxMenuRef}
                className="context-menu dlv-ctx-menu"
                style={{ left: ctxMenu.x, top: ctxMenu.y }}
                onContextMenu={(e) => e.preventDefault()}
              >
                <div className="context-menu-item" onClick={handleAskAiFromMenu}>
                  Ask AI Assistant
                </div>
              </div>
            )}
            {showJumpToBottom && (
              <button
                className="dlv-jump-bottom"
                onClick={() => {
                  const el = logsRef.current
                  if (el) {
                    el.scrollTop = el.scrollHeight
                    userAtBottomRef.current = true
                    setShowJumpToBottom(false)
                  }
                }}
                title="Jump to latest logs"
              >
                ↓
              </button>
            )}
          </>
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

/// Plain HTML-escaped text (no colour parsing) — used when the Color toggle is off.
function escapeLogs(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  dockerContainerLogs,
  dockerLogsStreamStart,
  pollDockerLogs,
  stopDockerLogsStream,
} from '../commands'
import { parseAnsiToHtml } from '../ansi'
import { useI18n } from '../i18n'

interface DockerLogViewerProps {
  tabId: number
  jumpTabId: number
  containerName: string
  containerImage?: string
  initialTail?: number
  onAskAi?: (text: string) => void
  defaultWordWrap?: boolean
  defaultFollow?: boolean
  maxLines?: number
}

const MAX_LOG_CHARS = 200_000 // ~5000 lines — trim head when exceeded

// Measure the rendered pixel height of a text fragment as it would appear inside
// `source` (same font, padding, border, white-space, width). Used to keep the view
// anchored when the head of the log buffer is trimmed while the user is scrolled up.
function measureRemovedHeight(source: HTMLElement, text: string): number {
  const cs = getComputedStyle(source)
  const clone = document.createElement('pre')
  clone.style.cssText = cs.cssText
  clone.style.position = 'fixed'
  clone.style.left = '-99999px'
  clone.style.top = '0'
  clone.style.visibility = 'hidden'
  clone.style.height = 'auto'
  clone.style.width = source.getBoundingClientRect().width + 'px'
  clone.style.boxSizing = 'border-box'
  clone.textContent = text
  document.body.appendChild(clone)
  const h = clone.scrollHeight
  document.body.removeChild(clone)
  return h
}

export const DockerLogViewer: React.FC<DockerLogViewerProps> = ({
  tabId,
  jumpTabId,
  containerName,
  containerImage,
  initialTail = 200,
  onAskAi,
  defaultWordWrap = true,
  defaultFollow = true,
  maxLines = 5000,
}) => {
  const { t } = useI18n()
  const [logs, setLogs] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [tail, setTail] = useState(initialTail)
  const [autoScroll, setAutoScroll] = useState(true)
  const [wordWrap, setWordWrap] = useState(defaultWordWrap)
  const [color, setColor] = useState(true)
  const [follow, setFollow] = useState(defaultFollow)
  const [showJumpToBottom, setShowJumpToBottom] = useState(false)
  const logsRef = useRef<HTMLPreElement>(null)
  const userAtBottomRef = useRef(true)

  // When new logs arrive while the user is scrolled up, we anchor the view so the
  // content the user is reading stays put. If the head was trimmed (buffer limit),
  // we record the removed head text + the pre-trim scrollTop here, then adjust
  // scrollTop in a layout effect by the removed head's rendered height.
  const preUpdateRef = useRef<{ scrollTop: number; removedHead: string } | null>(null)

  // ---- right-click context menu (Ask AI Assistant) ----
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null)
  const ctxMenuRef = useRef<HTMLDivElement>(null)
  // Capture the selection at right-click time so it isn't lost before the click.
  const selectedTextRef = useRef<string>('')

  const handleLogContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (!onAskAi) return
      e.preventDefault()
      e.stopPropagation()
      const selection = window.getSelection()?.toString() ?? ''
      selectedTextRef.current = selection.trim()
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
    // Use the captured selection if present; otherwise fall back to the full log buffer.
    const text = selectedTextRef.current || logs
    if (!text) return
    const scope = selectedTextRef.current ? 'selected lines' : 'full log'
    const prefix = `The following are ${scope} from Docker container "${containerName}":\n\n`
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

  // The <pre> is only rendered once logs exist, so we attach the scroll listener
  // via a callback ref — exactly when the element mounts/unmounts. This avoids
  // re-binding on every log update (which drops scroll events mid-gesture) while
  // still binding the moment the element first appears.
  const setLogsEl = useCallback(
    (el: HTMLPreElement | null) => {
      const prev = logsRef.current
      if (prev && prev !== el) {
        prev.removeEventListener('scroll', handleScroll)
      }
      logsRef.current = el
      if (el) {
        el.addEventListener('scroll', handleScroll, { passive: true })
        handleScroll()
      }
    },
    [handleScroll],
  )

  // ---- one-shot fetch (non-follow mode) ----
  const fetchLogs = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const output = await dockerContainerLogs(jumpTabId, containerName, tail)
      setLogs(trimToMaxLines(trimHead(output), maxLines))
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
            const el = logsRef.current
            const prevTop = el ? el.scrollTop : 0
            setLogs((prev) => {
              const appended = chunks.join('')
              const next = trimToMaxLines(trimHead(prev + appended), maxLines)
              // Amount removed from the head (buffer limit). Record it so the
              // layout effect can keep the user's view anchored.
              const removedChars = prev.length + appended.length - next.length
              const removedHead = removedChars > 0 ? prev.substring(0, removedChars) : ''
              preUpdateRef.current = { scrollTop: prevTop, removedHead }
              return next
            })
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

  // Auto-scroll only when the user is at (or very near) the bottom. When the user
  // has scrolled up, we leave the page still — new logs won't yank the view.
  useEffect(() => {
    const el = logsRef.current
    if (!el) return
    if (autoScroll && userAtBottomRef.current) {
      el.scrollTop = el.scrollHeight
      // Keep the "at bottom" state authoritative after a programmatic scroll.
      userAtBottomRef.current = true
      setShowJumpToBottom(false)
    }
  }, [logsHtml, autoScroll])

  // When the user is scrolled up, keep their view anchored. Appending at the
  // bottom alone leaves scrollTop unchanged (content stays, only the scrollbar
  // reflects more content). But if the head was trimmed (buffer limit), the
  // browser keeps scrollTop constant and the visible text shifts down — so we
  // subtract the removed head's rendered height before paint.
  useLayoutEffect(() => {
    const el = logsRef.current
    const upd = preUpdateRef.current
    preUpdateRef.current = null
    if (!el || !upd || userAtBottomRef.current) return
    if (!upd.removedHead) return
    const removedH = measureRemovedHeight(el, upd.removedHead)
    el.scrollTop = Math.max(0, upd.scrollTop - removedH)
  }, [logsHtml])

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
              ref={setLogsEl}
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
                  {selectedTextRef.current ? t('askAiSelectedText') : t('askAiAllLogs')}
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

/// Drop oldest lines so the buffer never exceeds `maxLines`.
function trimToMaxLines(text: string, maxLines: number): string {
  if (maxLines <= 0) return text
  let nlCount = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) nlCount++
  }
  if (nlCount <= maxLines) return text
  // Count newlines from the end to find the cut point that keeps `maxLines` lines.
  let dropped = 0
  let idx = -1
  for (let i = text.length - 1; i >= 0 && dropped < maxLines; i--) {
    if (text.charCodeAt(i) === 10) {
      dropped++
      if (dropped === maxLines) {
        idx = i + 1
      }
    }
  }
  return idx > 0 ? text.slice(idx) : text
}

/// Plain HTML-escaped text (no colour parsing) — used when the Color toggle is off.
function escapeLogs(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

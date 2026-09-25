import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  dockerContainerLogs,
  dockerLogsStreamStart,
  pollDockerLogs,
  stopDockerLogsStream,
} from '../commands'
import { parseAnsiToHtmlLines, highlightPlainLogLines, stripInvisible } from '../ansi'
import { useI18n } from '../i18n'
import { useScrollbarGrabZone } from '../hooks/useScrollbarGrabZone'
import { copyText } from '../lib/clipboard'
import { Icon } from './Icon'

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
  const [lineNumbers, setLineNumbers] = useState(false)
  const [follow, setFollow] = useState(defaultFollow)
  const [showJumpToBottom, setShowJumpToBottom] = useState(false)
  const logsRef = useRef<HTMLPreElement>(null)
  // Widens the log scrollbar while the pointer is near it (see `.sb-grab` styles).
  const bodyRef = useRef<HTMLDivElement>(null)
  const nearScrollbar = useScrollbarGrabZone(bodyRef)
  const userAtBottomRef = useRef(true)

  // When new logs arrive while the user is scrolled up, we anchor the view so the
  // content the user is reading stays put. If the head was trimmed (buffer limit),
  // we record the removed head text + the pre-trim scrollTop here, then adjust
  // scrollTop in a layout effect by the removed head's rendered height.
  const preUpdateRef = useRef<{ scrollTop: number; removedHead: string } | null>(null)

  // ---- right-click context menu (copy / Ask AI Assistant) ----
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; hasSelection: boolean } | null>(
    null,
  )
  const ctxMenuRef = useRef<HTMLDivElement>(null)
  // What the menu acts on, captured while the right press is still being dispatched. Two
  // things can take the highlight away before the item is clicked: a press that lands
  // outside the selection collapses it (native behaviour), and the stream replacing the
  // <pre>'s text nodes takes a range with them. The text is kept even when the range can
  // no longer be restored, so the copy still has something to copy.
  const selectedTextRef = useRef<string>('')
  const savedRangeRef = useRef<Range | null>(null)
  const selectionSnapshottedRef = useRef(false)
  // > 0 while the menu is open: how many more times the highlight may be put back. The
  // budget is what stops an `addRange` → engine clears → `addRange` standoff from spinning
  // forever, and it closes the guard the moment the menu goes away.
  const restoreBudgetRef = useRef(0)

  // Refresh what the menu acts on from the live selection — but only when that selection
  // is a non-blank one lying entirely inside the log (one left over in another pane would
  // otherwise be copied or sent to the AI). Anything else leaves the memory alone: the
  // engine may have *just* cleared the selection, and this memory is what puts it back.
  const rememberLogSelection = useCallback((el: HTMLElement) => {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return
    const range = sel.getRangeAt(0)
    const text = sel.toString()
    if (!text.trim()) return
    if (!el.contains(range.startContainer) || !el.contains(range.endContainer)) return
    selectedTextRef.current = text
    savedRangeRef.current = range.cloneRange()
  }, [])

  const forgetLogSelection = useCallback(() => {
    selectedTextRef.current = ''
    savedRangeRef.current = null
  }, [])

  const restoreLogSelection = useCallback(() => {
    const el = logsRef.current
    const saved = savedRangeRef.current
    const sel = window.getSelection()
    if (!el || !saved || !sel || restoreBudgetRef.current <= 0) return
    if (sel.rangeCount > 0 && !sel.isCollapsed) return // nothing was lost
    if (!el.contains(saved.startContainer) || !el.contains(saved.endContainer)) return
    restoreBudgetRef.current -= 1
    sel.removeAllRanges()
    sel.addRange(saved)
  }, [])

  const handleLogMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 2) return
      // Read the selection before this press gets a chance to collapse it, then cancel
      // the press's default action so a right-click that lands just outside the highlight
      // does not eat it. Start from an empty memory: a press on nothing selected is none.
      forgetLogSelection()
      const el = logsRef.current
      if (el) rememberLogSelection(el)
      selectionSnapshottedRef.current = true
      e.preventDefault()
    },
    [rememberLogSelection, forgetLogSelection],
  )

  const handleLogContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      // A contextmenu with no preceding press of our own (the Menu key, a long press)
      // still gets a fresh read.
      if (!selectionSnapshottedRef.current) {
        forgetLogSelection()
        const el = logsRef.current
        if (el) rememberLogSelection(el)
      }
      selectionSnapshottedRef.current = false
      setCtxMenu({
        x: e.clientX,
        y: e.clientY,
        hasSelection: selectedTextRef.current !== '',
      })
      // Opening the menu re-renders, and the press may yet be answered by a clear, so put
      // the highlight back now, after the frame settles, and on any later selectionchange
      // while the menu is up.
      restoreBudgetRef.current = 5
      restoreLogSelection()
      requestAnimationFrame(restoreLogSelection)
    },
    [rememberLogSelection, forgetLogSelection, restoreLogSelection],
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
      // The menu is gone: stop defending the highlight, whatever the engine does next.
      restoreBudgetRef.current = 0
    }
  }, [ctxMenu])

  // Keep the menu on screen when the click landed near an edge.
  useLayoutEffect(() => {
    if (!ctxMenu) return
    const el = ctxMenuRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    el.style.top = `${Math.max(8, Math.min(ctxMenu.y, vh - rect.height - 8))}px`
    el.style.left = `${Math.max(8, Math.min(ctxMenu.x, vw - rect.width - 8))}px`
  }, [ctxMenu])

  const handleCopyFromMenu = useCallback(async () => {
    setCtxMenu(null)
    const text = selectedTextRef.current || logs
    if (!text) return
    await copyText(text)
  }, [logs])

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

  // ---- keep a dragged selection inside the log, and remembered across a right-click ----
  // Dragging out of the <pre> — over the header, the tab bar or a neighbouring pane —
  // used to extend the highlight there too, so copy/Ask AI picked up chrome text.
  // While the drag started inside the log we clamp the range back to its edges.
  useEffect(() => {
    let dragging = false
    const onMouseDown = (e: MouseEvent) => {
      const el = logsRef.current
      dragging = !!el && e.button === 0 && el.contains(e.target as Node)
      // Any left press that starts a new selection (or none at all) makes what was
      // remembered stale — except on the menu itself, whose press must not wipe the text
      // its own items are about to copy. The right press refreshes it on the <pre>.
      if (e.button === 0 && !ctxMenuRef.current?.contains(e.target as Node)) {
        forgetLogSelection()
      }
    }
    const endDrag = (e: MouseEvent) => {
      const el = logsRef.current
      if (dragging && el) {
        // Clamp once more on release: Chromium can leave the last mousemove's range
        // outside the log even though every intermediate change was pulled back.
        clampSelectionTo(el)
        rememberLogSelection(el)
      }
      // Some Blink builds answer the right press with a clear on release rather than on
      // press — the menu is already open by then, so put the highlight back.
      if (e.button === 2) restoreLogSelection()
      dragging = false
    }
    const onSelectionChange = () => {
      const el = logsRef.current
      if (!el) return
      if (dragging) clampSelectionTo(el)
      rememberLogSelection(el)
      // While the menu is open the highlight is ours to keep: if the engine cleared it
      // (before or after our own events), put it back so the user still sees the target.
      if (restoreBudgetRef.current > 0) restoreLogSelection()
    }
    document.addEventListener('mousedown', onMouseDown, true)
    document.addEventListener('mouseup', endDrag)
    document.addEventListener('selectionchange', onSelectionChange)
    return () => {
      document.removeEventListener('mousedown', onMouseDown, true)
      document.removeEventListener('mouseup', endDrag)
      document.removeEventListener('selectionchange', onSelectionChange)
    }
  }, [rememberLogSelection, forgetLogSelection, restoreLogSelection])

  // Track active stream so we can stop it on unmount / toggle-off
  const streamIdRef = useRef<string | null>(null)
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

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
        // The <pre> mounts only once logs become non-empty. At that moment the
        // buffer is already tall and scrollTop is 0 (top), so handleScroll above
        // would mark us as "not at bottom". Force a snap-to-bottom on this first
        // mount so the user lands on the latest log when entering the view.
        el.scrollTop = el.scrollHeight
        userAtBottomRef.current = true
        setShowJumpToBottom(false)
      }
    },
    [handleScroll],
  )

  // ---- force the view to the latest log line ----
  const scrollToBottom = useCallback(() => {
    const el = logsRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    userAtBottomRef.current = true
    setShowJumpToBottom(false)
  }, [])

  // ---- one-shot fetch (non-follow mode) ----
  const fetchLogs = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const output = await dockerContainerLogs(jumpTabId, containerName, tail)
      setLogs(trimToMaxLines(trimHead(output), maxLines))
      // Snap to the bottom once the initial content is in.
      requestAnimationFrame(scrollToBottom)
    } catch (e) {
      setError(String(e))
      setLogs('')
    } finally {
      setLoading(false)
    }
  }, [jumpTabId, containerName, tail, scrollToBottom])

  // ---- start / stop streaming ----
  const startStream = useCallback(async () => {
    // Stop any existing stream first
    if (streamIdRef.current) {
      await stopDockerLogsStream(streamIdRef.current).catch(() => {})
      streamIdRef.current = null
    }
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current)
      pollTimerRef.current = null
    }

    setError('')
    setLoading(true)
    try {
      const sid = await dockerLogsStreamStart(jumpTabId, containerName, tail)
      streamIdRef.current = sid

      // Start polling — 500ms is fast enough for real-time feel. A recursive
      // setTimeout (not setInterval) is used so each tick awaits the previous
      // fetch: a slow pollDockerLogs can no longer overlap the next one and
      // deliver out-of-order log chunks.
      const tick = async () => {
        // Bail if the stream was stopped / replaced while this tick was queued.
        if (streamIdRef.current !== sid) return
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
        // Reschedule only if this stream is still the active one.
        if (streamIdRef.current === sid) {
          pollTimerRef.current = setTimeout(tick, 500)
        }
      }
      pollTimerRef.current = setTimeout(tick, 500)
      // Snap to the bottom once the stream's initial tail is loaded.
      requestAnimationFrame(scrollToBottom)
    } catch (e) {
      setError(String(e))
      setFollow(false)
    } finally {
      setLoading(false)
    }
  }, [jumpTabId, containerName, tail, scrollToBottom])

  const stopStream = useCallback(async () => {
    if (streamIdRef.current) {
      await stopDockerLogsStream(streamIdRef.current).catch(() => {})
      streamIdRef.current = null
    }
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current)
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

  // ---- ANSI → coloured HTML, per line (memoized — parsing is O(n)) ----
  // When Color is on we first try ANSI parsing. If the log contains no ANSI
  // escape codes, we fall back to heuristic plain-log highlighting (timestamps,
  // log levels, JSON) so uncoloured container output is still readable.
  const logsLines = useMemo(() => {
    if (!logs) return ['']
    if (!color) return escapeLogs(logs).split('\n')
    const plain = highlightPlainLogLines(logs)
    return plain ?? parseAnsiToHtmlLines(logs)
  }, [logs, color])

  // Line numbers need a box per *logical* line, so a wrapped line keeps its number beside
  // the whole block instead of drifting onto the continuation rows. Without them the
  // joined HTML is exactly what the <pre> rendered before.
  const logsHtml = useMemo(() => {
    if (!lineNumbers) return logsLines.join('\n')
    const last = logsLines.length - 1
    return logsLines
      .map((html, i) => {
        // The newline stays inside the line's own text rather than being left to the block
        // boundary: a boundary between two blocks contributes one line break no matter how
        // many empty lines sit there, so copying a selection would silently drop them.
        const eol = i === last ? '' : '\n'
        return `<div class="dlv-line"><span class="dlv-ln">${i + 1}</span><span class="dlv-line-body">${html}${eol}</span></div>`
      })
      .join('')
  }, [logsLines, lineNumbers])

  // The wrapper object has to be stable across renders: React re-applies
  // `dangerouslySetInnerHTML` — a wholesale replace of the <pre>'s children — whenever the
  // prop *object* differs, so a fresh `{ __html }` literal per render detached every text
  // node the user had just selected, which is what killed the highlight on right-click.
  const logsHtmlPayload = useMemo(() => ({ __html: logsHtml }), [logsHtml])

  // How wide the gutter has to be for the largest number on screen. One value for every
  // row, so the log text starts at the same column whether the line is numbered 7 or 5000.
  const lnStyle = useMemo(
    () =>
      lineNumbers
        ? ({ '--dlv-ln-digits': String(logsLines.length).length } as React.CSSProperties)
        : undefined,
    [lineNumbers, logsLines.length],
  )

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

  // Initial load on mount. When follow mode is on we start the live stream
  // (which already tails the latest logs); otherwise do a one-shot fetch.
  useEffect(() => {
    if (follow) {
      startStream()
    } else {
      fetchLogs()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Cleanup stream on unmount
  useEffect(() => {
    return () => {
      if (streamIdRef.current) {
        stopDockerLogsStream(streamIdRef.current).catch(() => {})
      }
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current)
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
          <button
            className="dlv-clear-btn"
            onClick={() => {
              setLogs('')
              setError('')
            }}
          >
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
            <input type="checkbox" checked={color} onChange={(e) => setColor(e.target.checked)} />
            Color
          </label>
          <label className="dlv-control-item dlv-checkbox">
            <input
              type="checkbox"
              checked={lineNumbers}
              onChange={(e) => setLineNumbers(e.target.checked)}
            />
            {t('dlvLineNumbers')}
          </label>
        </div>
      </div>

      <div className={'dlv-body' + (nearScrollbar ? ' sb-grab' : '')} ref={bodyRef}>
        {error ? (
          <div className="dlv-error">{error}</div>
        ) : logs ? (
          <>
            <pre
              className={
                'dlv-output' +
                (wordWrap ? ' dlv-output-wrap' : '') +
                (lineNumbers ? ' dlv-output-ln' : '')
              }
              ref={setLogsEl}
              style={lnStyle}
              onMouseDown={handleLogMouseDown}
              onContextMenu={handleLogContextMenu}
              dangerouslySetInnerHTML={logsHtmlPayload}
            />
            {ctxMenu && (
              <div
                ref={ctxMenuRef}
                className="context-menu dlv-ctx-menu"
                style={{ left: ctxMenu.x, top: ctxMenu.y }}
                onMouseDown={(e) => e.preventDefault()}
                onContextMenu={(e) => e.preventDefault()}
              >
                <div className="context-menu-item" onClick={handleCopyFromMenu}>
                  <Icon name="copy" size={14} />
                  {ctxMenu.hasSelection ? t('copySelectedText') : t('copyAllLogs')}
                </div>
                {onAskAi && (
                  <div className="context-menu-item" onClick={handleAskAiFromMenu}>
                    {ctxMenu.hasSelection ? t('askAiSelectedText') : t('askAiAllLogs')}
                  </div>
                )}
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
          <div className="dlv-empty">{loading ? 'Loading logs\u2026' : 'No log output'}</div>
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
/// Invisible bytes are still stripped: `docker logs` output carries ANSI escapes
/// and control characters that must never reach the DOM as raw text.
function escapeLogs(text: string): string {
  return stripInvisible(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/// Shrink the DOM selection back to `el`'s text when a drag has run past its edges.
/// Whichever end left the log is re-anchored to the nearest log boundary.
function clampSelectionTo(el: HTMLElement): void {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return
  const range = sel.getRangeAt(0)
  const startIn = el.contains(range.startContainer)
  const endIn = el.contains(range.endContainer)
  if (startIn && endIn) return
  const next = document.createRange()
  if (startIn) {
    next.setStart(range.startContainer, range.startOffset)
    next.setEnd(el, el.childNodes.length)
  } else if (endIn) {
    next.setStart(el, 0)
    next.setEnd(range.endContainer, range.endOffset)
  } else if (range.intersectsNode(el)) {
    // Both ends ran past the log but it sits between them: keep the whole log.
    next.selectNodeContents(el)
  } else {
    // Neither end touches the log — this is not a drag that ran out of it (a log
    // refresh detached the anchor, most likely), so leave the selection alone
    // rather than wiping out something the user made elsewhere.
    return
  }
  sel.removeAllRanges()
  sel.addRange(next)
}

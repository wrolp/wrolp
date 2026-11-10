import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/** How long the pointer must rest on the element before the tooltip appears. */
const SHOW_DELAY = 300
/** Gap between the pointer and the tooltip, so it never sits under the cursor. */
const OFFSET = 12
/** Minimum clearance from the viewport edges after clamping. */
const EDGE_PAD = 4

/**
 * App-wide tooltip system.
 *
 * Native `title` tooltips take the OS chrome and cannot be styled (no rounded
 * corners, no theme colours). This listens for hover over any element carrying a
 * `title` (or a `data-tooltip`, for tooltips that are computed at hover time),
 * suppresses the browser's own tooltip, and renders a themed one instead, so every
 * existing `title` usage across the app gets the custom look without per-site
 * changes. A removed `title` is restored on leave so the label stays for assistive
 * tech and the next hover.
 */
export function TooltipProvider() {
  const tooltipRef = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  const [text, setText] = useState('')
  // The element under the pointer and the `title` we removed from it (null when the
  // tooltip came from `data-tooltip`, which needs no suppression).
  const anchorRef = useRef<{ el: Element; title: string | null } | null>(null)
  const cursorRef = useRef({ x: 0, y: 0 })
  const sizeRef = useRef({ w: 0, h: 0 })
  const timerRef = useRef<number | null>(null)

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  /** Position the tooltip next to the cursor, flipping to the other side near an edge. */
  const place = useCallback(() => {
    const el = tooltipRef.current
    if (!el) return
    const { x, y } = cursorRef.current
    const { w, h } = sizeRef.current
    let left = x + OFFSET
    let top = y + OFFSET
    if (left + w > window.innerWidth - EDGE_PAD) left = x - OFFSET - w
    if (top + h > window.innerHeight - EDGE_PAD) top = y - OFFSET - h
    if (left < EDGE_PAD) left = EDGE_PAD
    if (top < EDGE_PAD) top = EDGE_PAD
    el.style.left = `${left}px`
    el.style.top = `${top}px`
  }, [])

  const hide = useCallback(() => {
    clearTimer()
    const anchor = anchorRef.current
    if (anchor && anchor.title !== null) anchor.el.setAttribute('title', anchor.title)
    anchorRef.current = null
    setVisible(false)
  }, [clearTimer])

  const onMouseOver = useCallback(
    (e: MouseEvent) => {
      const target = e.target as Element | null
      const el =
        target && typeof target.closest === 'function'
          ? target.closest('[title], [data-tooltip]')
          : null
      if (!el) return
      const text = el.getAttribute('data-tooltip') ?? el.getAttribute('title')
      if (!text || !text.trim()) return
      // A child of the same element re-fired the event: keep what we already show.
      if (anchorRef.current && anchorRef.current.el === el) return

      hide()
      // Only a real `title` must be removed to suppress the native tooltip; a
      // `data-tooltip` never triggers one.
      const title = el.getAttribute('title')
      anchorRef.current = { el, title }
      if (title !== null) el.removeAttribute('title')
      cursorRef.current = { x: e.clientX, y: e.clientY }
      timerRef.current = window.setTimeout(() => {
        setText(text)
        setVisible(true)
      }, SHOW_DELAY)
    },
    [hide],
  )

  const onMouseOut = useCallback(
    (e: MouseEvent) => {
      const anchor = anchorRef.current
      if (!anchor) return
      const related = e.relatedTarget as Element | null
      // Moving onto a descendant still counts as inside the element.
      if (related && anchor.el.contains(related)) return
      hide()
    },
    [hide],
  )

  const onMouseMove = useCallback(
    (e: MouseEvent) => {
      cursorRef.current = { x: e.clientX, y: e.clientY }
      if (anchorRef.current) place()
    },
    [place],
  )

  useEffect(() => {
    document.addEventListener('mouseover', onMouseOver, true)
    document.addEventListener('mouseout', onMouseOut, true)
    document.addEventListener('mousemove', onMouseMove, true)
    // Scrolling under a hover leaves the tooltip pointing at the wrong spot.
    document.addEventListener('scroll', hide, true)
    return () => {
      document.removeEventListener('mouseover', onMouseOver, true)
      document.removeEventListener('mouseout', onMouseOut, true)
      document.removeEventListener('mousemove', onMouseMove, true)
      document.removeEventListener('scroll', hide, true)
      clearTimer()
    }
  }, [onMouseOver, onMouseOut, onMouseMove, hide, clearTimer])

  // Measure once it has text, then place it — before paint, so it never flashes at (0,0).
  useLayoutEffect(() => {
    if (!visible) return
    const el = tooltipRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    sizeRef.current = { w: rect.width, h: rect.height }
    place()
  }, [visible, text, place])

  return createPortal(
    <div
      ref={tooltipRef}
      className="wl-tooltip"
      role="tooltip"
      aria-hidden={!visible}
      data-visible={visible}
    >
      {text}
    </div>,
    document.body,
  )
}

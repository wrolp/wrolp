import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/** How long the pointer must rest on the element before the tooltip appears. */
const SHOW_DELAY = 300
/** Gap between the pointer and the tooltip, so it never sits under the cursor. */
const OFFSET = 12
/** Minimum clearance from the viewport edges after clamping. */
const EDGE_PAD = 4

/** One element whose `title` we removed, so it can be put back later. */
interface SuppressedTitle {
  el: Element
  /** The removed attribute; `null` when the text came from `data-tooltip`. */
  title: string | null
  /**
   * Text captured when the element entered the chain. Coming back to it reads
   * nothing from the DOM — its `title` is still removed at that point.
   */
  text: string
}

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
 *
 * Nested titles (a row with a long title that also has buttons with their own)
 * are handled as a chain: the innermost element wins, and an ancestor's `title`
 * stays removed for as long as the pointer is anywhere inside it — restoring it
 * early is what used to make the browser show the row's native tooltip *next to*
 * the button's custom one.
 */
export function TooltipProvider() {
  const tooltipRef = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  const [text, setText] = useState('')
  /**
   * The hover chain, outermost first. Every entry's `title` is currently removed;
   * the last one is the element whose text is being shown.
   */
  const chainRef = useRef<SuppressedTitle[]>([])
  const visibleRef = useRef(false)
  const cursorRef = useRef({ x: 0, y: 0 })
  const sizeRef = useRef({ w: 0, h: 0 })
  const timerRef = useRef<number | null>(null)

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const restore = useCallback((item: SuppressedTitle) => {
    if (item.title !== null) item.el.setAttribute('title', item.title)
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
    for (const item of chainRef.current) restore(item)
    chainRef.current = []
    visibleRef.current = false
    setVisible(false)
  }, [clearTimer, restore])

  const onMouseOver = useCallback(
    (e: MouseEvent) => {
      const target = e.target as Element | null
      if (!target || typeof target.closest !== 'function') return

      const chain = chainRef.current
      // The pointer may be over an element whose `title` WE removed, which the
      // attribute selector can no longer see (it would skip to an outer ancestor
      // or miss entirely). The innermost chain entry containing the target is the
      // real hit; a deeper element that still carries its own title wins over it.
      const titled = target.closest('[title], [data-tooltip]')
      const inChain = chain.filter((item) => item.el === target || item.el.contains(target)).pop()
      const el = inChain && (!titled || titled.contains(inChain.el)) ? inChain.el : titled
      if (!el) return

      const current = chain[chain.length - 1]
      // A child of the same element re-fired the event: keep what we already show.
      if (current && current.el === el) return

      const existing = chain.findIndex((item) => item.el === el)
      let text: string
      if (existing >= 0) {
        // Back on an element already in the chain: everything deeper is left,
        // and the text comes from the captured entry. Reading the DOM here would
        // return nothing — the element's `title` is still removed.
        text = chain[existing].text
        for (const item of chain.splice(existing + 1)) restore(item)
      } else {
        const found = el.getAttribute('data-tooltip') ?? el.getAttribute('title')
        if (!found || !found.trim()) return
        text = found
        // Descending into a child keeps the ancestors' titles suppressed; only
        // entries that no longer contain the pointer are restored.
        const keep: SuppressedTitle[] = []
        for (const item of chain) {
          if (item.el.contains(el)) keep.push(item)
          else restore(item)
        }
        // Only a real `title` must be removed to suppress the native tooltip; a
        // `data-tooltip` never triggers one.
        const title = el.getAttribute('title')
        if (title !== null) el.removeAttribute('title')
        keep.push({ el, title, text })
        chainRef.current = keep
      }

      cursorRef.current = { x: e.clientX, y: e.clientY }
      if (visibleRef.current) {
        // Already showing: swap the text in place instead of blinking out for
        // another SHOW_DELAY when moving between a row and its buttons.
        setText(text)
        return
      }
      clearTimer()
      timerRef.current = window.setTimeout(() => {
        setText(text)
        visibleRef.current = true
        setVisible(true)
      }, SHOW_DELAY)
    },
    [clearTimer, restore],
  )

  const onMouseOut = useCallback(
    (e: MouseEvent) => {
      const chain = chainRef.current
      if (!chain.length) return
      const related = e.relatedTarget as Node | null
      // Moving between elements of the same chain (a row and its buttons) must
      // not tear the tooltip down — only leaving the outermost one ends it.
      if (related && chain.some((item) => item.el === related || item.el.contains(related))) return
      hide()
    },
    [hide],
  )

  const onMouseMove = useCallback(
    (e: MouseEvent) => {
      cursorRef.current = { x: e.clientX, y: e.clientY }
      if (chainRef.current.length) place()
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

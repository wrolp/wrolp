import { useRef, useState, useCallback, useEffect } from 'react'

/**
 * Custom overlay scrollbar hook.
 *
 * Hides the native scrollbar so list items can span full width (no 4px gap
 * between hover background and the right border), and renders a thin custom
 * thumb on top.
 *
 * Usage:
 *   const { listRef, thumbHeight, thumbTop, showThumb, updateThumb,
 *           onScroll, onThumbMouseDown, onMouseEnter, onMouseLeave } = useCustomScrollbar()
 */
export function useCustomScrollbar() {
  const listRef = useRef<HTMLDivElement>(null)
  const [thumbHeight, setThumbHeight] = useState(0)
  const [thumbTop, setThumbTop] = useState(0)
  const [showThumb, setShowThumb] = useState(false)
  const isDragging = useRef(false)
  const dragStart = useRef({ y: 0, scrollTop: 0 })

  const updateThumb = useCallback(() => {
    const el = listRef.current
    if (!el) return
    const { scrollTop, scrollHeight, clientHeight } = el
    // A scrollport can report one pixel more content than it can show — rounded
    // `scrollHeight` against a fractional layout height. That is not an overflow,
    // and a full-height bar for it reads as a permanently stuck scrollbar.
    if (scrollHeight - clientHeight <= 1) {
      setThumbHeight(0)
      return
    }
    const h = Math.max(20, (clientHeight / scrollHeight) * clientHeight)
    const maxTop = clientHeight - h
    const t = (scrollTop / (scrollHeight - clientHeight)) * maxTop
    setThumbHeight(h)
    setThumbTop(t)
  }, [])

  const onScroll = useCallback(() => {
    updateThumb()
  }, [updateThumb])

  const onThumbMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      isDragging.current = true
      dragStart.current = { y: e.clientY, scrollTop: listRef.current?.scrollTop || 0 }

      const onMove = (ev: MouseEvent) => {
        if (!isDragging.current || !listRef.current) return
        const el = listRef.current
        const delta = ev.clientY - dragStart.current.y
        const maxScroll = el.scrollHeight - el.clientHeight
        const maxThumb = el.clientHeight - thumbHeight
        if (maxThumb <= 0) return
        const ratio = maxScroll / maxThumb
        el.scrollTop = dragStart.current.scrollTop + delta * ratio
      }

      const onUp = () => {
        isDragging.current = false
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
      }

      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    },
    [thumbHeight],
  )

  const onMouseEnter = useCallback(() => setShowThumb(true), [])
  const onMouseLeave = useCallback(() => {
    if (!isDragging.current) setShowThumb(false)
  }, [])

  useEffect(() => {
    const el = listRef.current
    if (!el) return
    updateThumb()
    // The scrollport's own size is only half the story: content arrives after the
    // first paint, a refresh can return fewer rows, and collapsing a connection
    // group shrinks the list without touching the element's height. A ResizeObserver
    // alone leaves the thumb at the *previous* content's height — which is how a
    // short list ends up with a full-height bar (and a long one gets none).
    const ro = new ResizeObserver(updateThumb)
    ro.observe(el)
    const mo = new MutationObserver(updateThumb)
    mo.observe(el, { childList: true, subtree: true })
    return () => {
      ro.disconnect()
      mo.disconnect()
    }
  }, [updateThumb])

  return {
    listRef,
    thumbHeight,
    thumbTop,
    showThumb,
    /** Recompute after content height changes without a scroll event. */
    updateThumb,
    onScroll,
    onThumbMouseDown,
    onMouseEnter,
    onMouseLeave,
  }
}

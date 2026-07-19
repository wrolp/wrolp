import { useRef, useState, useCallback, useEffect } from 'react'

/**
 * Custom overlay scrollbar hook.
 *
 * Hides the native scrollbar so list items can span full width (no 4px gap
 * between hover background and the right border), and renders a thin custom
 * thumb on top.
 *
 * Usage:
 *   const { listRef, thumbHeight, thumbTop, showThumb,
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
    if (scrollHeight <= clientHeight) {
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
    const ro = new ResizeObserver(updateThumb)
    ro.observe(el)
    return () => ro.disconnect()
  }, [updateThumb])

  return {
    listRef,
    thumbHeight,
    thumbTop,
    showThumb,
    onScroll,
    onThumbMouseDown,
    onMouseEnter,
    onMouseLeave,
  }
}

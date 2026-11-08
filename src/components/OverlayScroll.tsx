import { useEffect, type ReactNode } from 'react'
import { useCustomScrollbar } from '../hooks/useCustomScrollbar'

interface OverlayScrollProps {
  className?: string
  children: ReactNode
}

/**
 * A scroll container whose native bar is replaced by the app's overlay thumb.
 * The zero-height sticky ruler keeps the thumb pinned to the scrollport while
 * the content moves; the MutationObserver refreshes it when a payload arrives
 * after the first paint (a diff or blame row set).
 */
export function OverlayScroll({ className, children }: OverlayScrollProps) {
  const {
    listRef,
    thumbHeight,
    thumbTop,
    showThumb,
    updateThumb,
    onScroll,
    onThumbMouseDown,
    onMouseEnter,
    onMouseLeave,
  } = useCustomScrollbar()

  useEffect(() => {
    const el = listRef.current
    if (!el) return
    const observer = new MutationObserver(updateThumb)
    observer.observe(el, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [listRef, updateThumb])

  return (
    <div
      className={['has-overlay-scroll', className].filter(Boolean).join(' ')}
      ref={listRef}
      onScroll={onScroll}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {thumbHeight > 0 && (
        <div className={`overlay-scrollbar${showThumb ? ' show' : ''}`}>
          <div
            className="sidebar-scrollbar-thumb"
            style={{ height: thumbHeight, top: thumbTop }}
            onMouseDown={onThumbMouseDown}
          />
        </div>
      )}
      {children}
    </div>
  )
}

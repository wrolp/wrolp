import type { ReactNode } from 'react'
import { useCustomScrollbar } from '../hooks/useCustomScrollbar'

interface OverlayScrollProps {
  className?: string
  children: ReactNode
}

/**
 * A scroll container whose native bar is replaced by the app's overlay thumb.
 * The zero-height sticky ruler keeps the thumb pinned to the scrollport while
 * the content moves; `useCustomScrollbar` watches the content itself, so a
 * payload arriving after the first paint (a diff or blame row set) resizes the
 * thumb without this component having to observe anything.
 */
export function OverlayScroll({ className, children }: OverlayScrollProps) {
  const {
    listRef,
    thumbHeight,
    thumbTop,
    showThumb,
    onScroll,
    onThumbMouseDown,
    onMouseEnter,
    onMouseLeave,
  } = useCustomScrollbar()

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

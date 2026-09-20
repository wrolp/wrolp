import type { ReactNode } from 'react'
import type { TranslationKey } from '../i18n/en'
import { Icon } from './Icon'
import { FLOAT_RESIZE_DIRS, useFloatResize } from '../hooks/useFloatResize'

const MIN_W = 320
const MIN_H = 200

interface FloatingWindowProps {
  item: {
    floatId: string
    title: string
    x: number
    y: number
    w: number
    h: number
    z: number
  }
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string
  onClose: () => void
  onFocus: () => void
  onMove: (x: number, y: number) => void
  onResize: (w: number, h: number) => void
  children: ReactNode
}

/**
 * A draggable, resizable, top-most overlay panel used to host a "popped out"
 * shell / file-editor / docker-log pane. Dragging is initiated from the header
 * bar; every edge and corner resizes (not just the bottom-right). All geometry
 * is reported back to the parent via callbacks so it survives re-renders.
 */
export default function FloatingWindow({
  item,
  t,
  onClose,
  onFocus,
  onMove,
  onResize,
  children,
}: FloatingWindowProps) {
  const { startDrag, startResize } = useFloatResize({
    geometry: () => ({ x: item.x, y: item.y, w: item.w, h: item.h }),
    onMove,
    onResize,
    minW: MIN_W,
    minH: MIN_H,
  })

  return (
    <div
      className="floating-window"
      style={{ left: item.x, top: item.y, width: item.w, height: item.h, zIndex: item.z }}
      onMouseDown={onFocus}
    >
      <div
        className="floating-window-header"
        onMouseDown={(e) => {
          onFocus()
          startDrag(e)
        }}
      >
        <span className="floating-window-title">{item.title}</span>
        <button
          type="button"
          className="icon-btn floating-window-close"
          aria-label={t('close')}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            onClose()
          }}
          title={t('close')}
        >
          <Icon name="x" size={11} />
        </button>
      </div>
      <div className="floating-window-body">{children}</div>
      {FLOAT_RESIZE_DIRS.map((dir) => (
        <div
          key={dir}
          className={`floating-window-resize fw-rh-${dir}`}
          onMouseDown={(e) => {
            onFocus()
            startResize(e, dir)
          }}
          title={t('resize')}
        />
      ))}
    </div>
  )
}

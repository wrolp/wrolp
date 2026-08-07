import { useRef, type ReactNode } from 'react'
import type { TranslationKey } from '../i18n/en'

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
 * bar; the bottom-right corner resizes. All geometry is reported back to the
 * parent via callbacks so it survives re-renders.
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
  const dragRef = useRef<{ ox: number; oy: number; px: number; py: number } | null>(null)
  const resizeRef = useRef<{ ox: number; oy: number; pw: number; ph: number } | null>(null)

  const onHeaderMouseDown = (e: React.MouseEvent) => {
    onFocus()
    dragRef.current = { ox: e.clientX, oy: e.clientY, px: item.x, py: item.y }
    const move = (ev: MouseEvent) => {
      if (!dragRef.current) return
      const dx = ev.clientX - dragRef.current.ox
      const dy = ev.clientY - dragRef.current.oy
      onMove(dragRef.current.px + dx, dragRef.current.py + dy)
    }
    const up = () => {
      dragRef.current = null
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const onResizeMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation()
    onFocus()
    resizeRef.current = { ox: e.clientX, oy: e.clientY, pw: item.w, ph: item.h }
    const move = (ev: MouseEvent) => {
      if (!resizeRef.current) return
      const dw = ev.clientX - resizeRef.current.ox
      const dh = ev.clientY - resizeRef.current.oy
      onResize(Math.max(320, resizeRef.current.pw + dw), Math.max(200, resizeRef.current.ph + dh))
    }
    const up = () => {
      resizeRef.current = null
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  return (
    <div
      className="floating-window"
      style={{ left: item.x, top: item.y, width: item.w, height: item.h, zIndex: item.z }}
      onMouseDown={onFocus}
    >
      <div className="floating-window-header" onMouseDown={onHeaderMouseDown}>
        <span className="floating-window-title">{item.title}</span>
        <span
          className="floating-window-close"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            onClose()
          }}
          title={t('close')}
        >
          ×
        </span>
      </div>
      <div className="floating-window-body">{children}</div>
      <div className="floating-window-resize" onMouseDown={onResizeMouseDown} title={t('resize')} />
    </div>
  )
}

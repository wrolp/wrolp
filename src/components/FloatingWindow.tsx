import { useRef, type ReactNode } from 'react'
import type { TranslationKey } from '../i18n/en'

type ResizeDir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

const RESIZE_DIRS: ResizeDir[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']
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
  const dragRef = useRef<{ ox: number; oy: number; px: number; py: number } | null>(null)
  const resizeRef = useRef<{
    dir: ResizeDir
    ox: number
    oy: number
    px: number
    py: number
    pw: number
    ph: number
  } | null>(null)

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

  const onResizeMouseDown = (dir: ResizeDir) => (e: React.MouseEvent) => {
    e.stopPropagation()
    onFocus()
    resizeRef.current = {
      dir,
      ox: e.clientX,
      oy: e.clientY,
      px: item.x,
      py: item.y,
      pw: item.w,
      ph: item.h,
    }
    const move = (ev: MouseEvent) => {
      const d = resizeRef.current
      if (!d) return
      const dx = ev.clientX - d.ox
      const dy = ev.clientY - d.oy
      let w = d.pw
      let h = d.ph
      let x = d.px
      let y = d.py
      // E grows width rightwards (left edge fixed); W grows it leftwards, so the
      // left edge follows the cursor and `x` shifts by the same amount. The N/S
      // pair is the vertical analogue. `Math.max` keeps the opposite edge put
      // once the minimum size is hit.
      if (d.dir.includes('e')) {
        w = Math.max(MIN_W, d.pw + dx)
      } else if (d.dir.includes('w')) {
        w = Math.max(MIN_W, d.pw - dx)
        x = d.px + (d.pw - w)
      }
      if (d.dir.includes('s')) {
        h = Math.max(MIN_H, d.ph + dy)
      } else if (d.dir.includes('n')) {
        h = Math.max(MIN_H, d.ph - dy)
        y = d.py + (d.ph - h)
      }
      // Only move when a top/left edge is being dragged; a pure E/S resize keeps
      // the origin and is handled by onResize alone.
      if (x !== d.px || y !== d.py) onMove(x, y)
      onResize(w, h)
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
      {RESIZE_DIRS.map((dir) => (
        <div
          key={dir}
          className={`floating-window-resize fw-rh-${dir}`}
          onMouseDown={onResizeMouseDown(dir)}
          title={t('resize')}
        />
      ))}
    </div>
  )
}

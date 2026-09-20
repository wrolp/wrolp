import { useRef, type MouseEvent as ReactMouseEvent } from 'react'

export type FloatResizeDir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

/** Every edge and corner gets a grip; the order matches the `fw-rh-*` classes. */
export const FLOAT_RESIZE_DIRS: FloatResizeDir[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']

export interface FloatGeometry {
  x: number
  y: number
  w: number
  h: number
}

interface Options {
  /** Read once when a gesture starts, so the drag stays correct while the
   * component re-renders underneath it. */
  geometry: () => FloatGeometry
  onMove: (x: number, y: number) => void
  onResize: (w: number, h: number) => void
  minW?: number
  minH?: number
}

/**
 * The pointer maths behind a floating panel: drag it by its header, resize it
 * from any edge or corner. Deliberately geometry-only — it never touches state,
 * because who owns the numbers differs (a popped-out pane lives in App's
 * `floatingItems`, the floated inspector column in its own state), and because
 * the listeners live on `window` for the length of one gesture rather than on
 * the element.
 */
export function useFloatResize({ geometry, onMove, onResize, minW = 320, minH = 200 }: Options) {
  const dragRef = useRef<{ ox: number; oy: number; px: number; py: number } | null>(null)
  const resizeRef = useRef<{
    dir: FloatResizeDir
    ox: number
    oy: number
    px: number
    py: number
    pw: number
    ph: number
  } | null>(null)

  const startDrag = (e: ReactMouseEvent) => {
    // A header that carries its own controls drags from the space around them,
    // not from the button the pointer happens to be down on.
    if ((e.target as HTMLElement).closest('button')) return
    const g = geometry()
    dragRef.current = { ox: e.clientX, oy: e.clientY, px: g.x, py: g.y }
    const move = (ev: MouseEvent) => {
      if (!dragRef.current) return
      const d = dragRef.current
      onMove(d.px + (ev.clientX - d.ox), d.py + (ev.clientY - d.oy))
    }
    const up = () => {
      dragRef.current = null
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const startResize = (e: ReactMouseEvent, dir: FloatResizeDir) => {
    e.preventDefault()
    e.stopPropagation()
    const g = geometry()
    resizeRef.current = { dir, ox: e.clientX, oy: e.clientY, px: g.x, py: g.y, pw: g.w, ph: g.h }
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
        w = Math.max(minW, d.pw + dx)
      } else if (d.dir.includes('w')) {
        w = Math.max(minW, d.pw - dx)
        x = d.px + (d.pw - w)
      }
      if (d.dir.includes('s')) {
        h = Math.max(minH, d.ph + dy)
      } else if (d.dir.includes('n')) {
        h = Math.max(minH, d.ph - dy)
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

  return { startDrag, startResize }
}

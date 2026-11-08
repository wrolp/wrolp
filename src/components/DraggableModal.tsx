import { useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'

/** A dragged dialog keeps at least this much of itself inside the window. */
const MIN_VISIBLE = 120
/** Smallest a resizable dialog may become. */
const MIN_W = 360
const MIN_H = 220

type ResizeDir = 'e' | 's' | 'se'

interface DraggableModalProps {
  /** Extra classes on the dialog box, e.g. `k8s-modal`. */
  className?: string
  /** Pressing the backdrop closes the dialog. Omitted for dialogs that ignore it. */
  onClose?: () => void
  /** Show edge grips so the dialog can be resized; the SE corner stays visible. */
  resizable?: boolean
  children: ReactNode
}

/**
 * A modal the user can move by dragging its header. The box stays where the
 * overlay's flex centring puts it and the gesture only adds a translate, so the
 * dialog's width and `max-height` rules keep working — which is why this does not
 * reuse `useFloatResize`: that one reports absolute geometry to a parent that owns
 * it, while this offset belongs to the dialog and dies when it closes.
 *
 * Resizing sets an explicit width/height and recomputes the translate so the
 * gesture keeps the top-left anchored; without that, a centred box would grow
 * away from the pointer in both directions.
 */
export function DraggableModal({
  className,
  onClose,
  resizable = false,
  children,
}: DraggableModalProps) {
  const boxRef = useRef<HTMLDivElement>(null)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)

  const startDrag = (e: ReactMouseEvent) => {
    const box = boxRef.current
    if (!box) return
    const rect = box.getBoundingClientRect()
    const startX = e.clientX
    const startY = e.clientY
    // Where the box would sit with a zero offset. The clamp below is stated in
    // viewport coordinates, so the offset is always derived from this anchor.
    const anchorLeft = rect.left - offset.x
    const anchorTop = rect.top - offset.y
    const start = offset

    const move = (ev: MouseEvent) => {
      const x = clamp(
        start.x + (ev.clientX - startX),
        -(rect.width - MIN_VISIBLE) - anchorLeft,
        window.innerWidth - MIN_VISIBLE - anchorLeft,
      )
      // The header is the only grab handle, so the box may not go above the window.
      const y = clamp(
        start.y + (ev.clientY - startY),
        -anchorTop,
        window.innerHeight - MIN_VISIBLE - anchorTop,
      )
      setOffset({ x, y })
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const startResize = (e: ReactMouseEvent, dir: ResizeDir) => {
    e.preventDefault()
    e.stopPropagation()
    const box = boxRef.current
    if (!box) return
    const rect = box.getBoundingClientRect()
    const startX = e.clientX
    const startY = e.clientY
    // `.modal` caps at 90vw/90vh; never ask for a size the CSS will clamp,
    // or the re-centring maths below would disagree with the rendered box.
    const maxW = Math.max(MIN_W, window.innerWidth * 0.9)
    const maxH = Math.max(MIN_H, window.innerHeight * 0.9)

    const move = (ev: MouseEvent) => {
      const w = dir === 's' ? rect.width : clamp(rect.width + ev.clientX - startX, MIN_W, maxW)
      const h = dir === 'e' ? rect.height : clamp(rect.height + ev.clientY - startY, MIN_H, maxH)
      setSize({ w, h })
      setOffset({
        x: rect.left - (window.innerWidth - w) / 2,
        y: rect.top - (window.innerHeight - h) / 2,
      })
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const onBoxMouseDown = (e: ReactMouseEvent) => {
    e.stopPropagation()
    const el = e.target as HTMLElement
    if (!el.closest('.modal-header')) return
    // The header's own controls keep their click; the dialog moves from the title
    // and the space around them. `.modal-close` is how those dialogs draw close.
    if (el.closest('button, input, select, textarea, a, .modal-close')) return
    startDrag(e)
  }

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div
        ref={boxRef}
        className={`modal is-draggable${resizable ? ' is-resizable' : ''}${
          className ? ` ${className}` : ''
        }`}
        style={{
          width: size?.w,
          height: size?.h,
          transform: `translate(${offset.x}px, ${offset.y}px)`,
        }}
        onMouseDown={onBoxMouseDown}
      >
        {children}
        {resizable && (
          <>
            <div className="modal-resize-handle e" onMouseDown={(e) => startResize(e, 'e')} />
            <div className="modal-resize-handle s" onMouseDown={(e) => startResize(e, 's')} />
            <div className="modal-resize-handle se" onMouseDown={(e) => startResize(e, 'se')} />
          </>
        )}
      </div>
    </div>
  )
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)

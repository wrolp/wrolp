import { useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'

/** A dragged dialog keeps at least this much of itself inside the window. */
const MIN_VISIBLE = 120

interface DraggableModalProps {
  /** Extra classes on the dialog box, e.g. `k8s-modal`. */
  className?: string
  /** Pressing the backdrop closes the dialog. Omitted for dialogs that ignore it. */
  onClose?: () => void
  children: ReactNode
}

/**
 * A modal the user can move by dragging its header. The box stays where the
 * overlay's flex centring puts it and the gesture only adds a translate, so the
 * dialog's width and `max-height` rules keep working — which is why this does not
 * reuse `useFloatResize`: that one reports absolute geometry to a parent that owns
 * it, while this offset belongs to the dialog and dies when it closes.
 */
export function DraggableModal({ className, onClose, children }: DraggableModalProps) {
  const boxRef = useRef<HTMLDivElement>(null)
  const [offset, setOffset] = useState({ x: 0, y: 0 })

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

  const onBoxMouseDown = (e: ReactMouseEvent) => {
    e.stopPropagation()
    const el = e.target as HTMLElement
    if (!el.closest('.modal-header')) return
    // The header's own controls keep their click; the dialog moves from the title
    // and the space around them. `k8s-modal-close` is how those dialogs draw close.
    if (el.closest('button, input, select, textarea, a, .k8s-modal-close')) return
    startDrag(e)
  }

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div
        ref={boxRef}
        className={`modal is-draggable${className ? ` ${className}` : ''}`}
        style={{ transform: `translate(${offset.x}px, ${offset.y}px)` }}
        onMouseDown={onBoxMouseDown}
      >
        {children}
      </div>
    </div>
  )
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)

import { useEffect } from 'react'
import { isDismissKey } from '../lib/keybindings'
import { DraggableModal } from './DraggableModal'

interface ConfirmDialogProps {
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  /** Optional primary action button (shown left of the confirm button). */
  saveLabel?: string
  onSave?: () => void
  /** Move the dialog by its header. Off by default: most callers sit in flows
   * where the dialog is answered without ever needing to get out of the way. */
  draggable?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  saveLabel,
  onSave,
  draggable = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isDismissKey(e)) onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const body = (
    <>
      <div className="modal-header">
        <h3>{title}</h3>
      </div>
      <div className="modal-body">
        <p style={{ whiteSpace: 'pre-line' }}>{message}</p>
      </div>
      <div className="modal-footer">
        <button className="btn-cancel" onClick={onCancel}>
          {cancelLabel}
        </button>
        {onSave && (
          <button className="btn-primary" onClick={onSave}>
            {saveLabel}
          </button>
        )}
        <button className={danger ? 'btn-danger' : 'btn-primary'} onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </>
  )

  if (draggable) return <DraggableModal className="confirm-dialog">{body}</DraggableModal>

  return (
    <div className="modal-overlay">
      <div className="modal confirm-dialog">{body}</div>
    </div>
  )
}

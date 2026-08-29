import { useEffect } from 'react'

interface ConfirmDialogProps {
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  /** Optional primary action button (shown left of the confirm button). */
  saveLabel?: string
  onSave?: () => void
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
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  return (
    <div className="modal-overlay">
      <div className="modal confirm-dialog">
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
      </div>
    </div>
  )
}

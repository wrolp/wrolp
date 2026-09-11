import { useEffect, useRef } from 'react'
import { useI18n } from '../i18n'

interface PasteConfirmDialogProps {
  /** Number of lines in the paste (shown to the user). */
  lineCount: number
  /** First few lines of the paste, for a quick visual check. */
  preview: string[]
  /** True when `insert without executing` is possible for this session. */
  canInsert: boolean
  /** Shown (greyed) when `canInsert` is false, explaining why. */
  insertDisabledReason?: string
  /** How many non-final lines the insert action will terminate with `\`. */
  continuationAdded?: number
  filteredControls: number
  filteredSequences: number
  onInsert: () => void
  onExecute: () => void
  onCancel: () => void
}

/**
 * Confirmation for a multi-line paste into a session whose remote application
 * did NOT enable bracketed paste (so xterm cannot make the paste safe).
 *
 * Deliberately NOT dismissible by clicking the overlay (project convention:
 * modals only close via their buttons or Esc), and always offers a visible way
 * out. When `insert without executing` is unavailable the visual weight moves
 * to `execute line by line` so the dialog never looks stuck.
 */
export function PasteConfirmDialog({
  lineCount,
  preview,
  canInsert,
  insertDisabledReason,
  continuationAdded = 0,
  filteredControls,
  filteredSequences,
  onInsert,
  onExecute,
  onCancel,
}: PasteConfirmDialogProps) {
  const { t } = useI18n()
  const insertRef = useRef<HTMLButtonElement>(null)
  const executeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  // Focus the safest available action: insert when it is possible, otherwise
  // the line-by-line one (which is the only remaining way to proceed).
  useEffect(() => {
    if (canInsert) insertRef.current?.focus()
    else executeRef.current?.focus()
  }, [canInsert])

  const filteredNote =
    filteredControls > 0 || filteredSequences > 0
      ? t('pasteDialogFiltered', { controls: filteredControls, sequences: filteredSequences })
      : null

  return (
    <div className="modal-overlay">
      <div className="modal confirm-dialog paste-confirm-dialog">
        <div className="modal-header">
          <h3>{t('pasteDialogTitle')}</h3>
        </div>
        <div className="modal-body">
          <p>{t('pasteDialogMessage', { lines: lineCount })}</p>
          {preview.length > 0 && <pre className="paste-preview">{preview.join('\n')}</pre>}
          {!canInsert && insertDisabledReason && (
            <p className="paste-insert-unavailable">{insertDisabledReason}</p>
          )}
          {canInsert && continuationAdded > 0 && (
            <p className="paste-continuation-note">
              {t('pasteDialogContinuation', { count: continuationAdded })}
            </p>
          )}
          {filteredNote && <p className="paste-filtered-note">{filteredNote}</p>}
        </div>
        <div className="modal-footer">
          <button className="btn-cancel" onClick={onCancel}>
            {t('cancel')}
          </button>
          <button
            ref={executeRef}
            className={canInsert ? 'btn-cancel' : 'btn-primary'}
            onClick={onExecute}
          >
            {t('pasteExecuteLineByLine')}
          </button>
          <button
            ref={insertRef}
            className={canInsert ? 'btn-primary' : 'btn-cancel'}
            disabled={!canInsert}
            onClick={onInsert}
          >
            {t('pasteInsertNoExec')}
          </button>
        </div>
      </div>
    </div>
  )
}

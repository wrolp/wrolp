import { useEffect, useState } from 'react'
import { gitConflictFile } from '../commands'
import { useI18n } from '../i18n'
import { isDismissKey } from '../lib/keybindings'
import type { GitConflictStages, GitHostRef } from '../types'
import { DraggableModal } from './DraggableModal'

interface GitMergeViewProps {
  host: GitHostRef
  root: string
  path: string
  onResolve: (resolution: 'ours' | 'theirs' | 'resolved') => void
  onClose: () => void
}

/** One pane: a stage's text, line-numbered. `null` means the stage is absent. */
function StagePane({
  title,
  text,
  emptyLabel,
}: {
  title: string
  text: string | null
  emptyLabel: string
}) {
  return (
    <div className="git-merge-pane">
      <div className="git-merge-pane-head">{title}</div>
      {text === null ? (
        <div className="git-merge-empty">{emptyLabel}</div>
      ) : (
        <pre className="git-merge-pre">
          {text.split('\n').map((line, i) => (
            <div className="git-merge-line" key={`${i}-${line.length}`}>
              <span className="git-merge-no">{i + 1}</span>
              <span className="git-merge-text">{line}</span>
            </div>
          ))}
        </pre>
      )}
    </div>
  )
}

/**
 * Read-only three-way view of one conflict: base on the left, ours and theirs
 * beside it, with the same resolutions the row offers. No editing here — a real
 * merge editor is a separate feature; this exists so the user can *see* both
 * sides before choosing one, instead of guessing from a combined diff.
 */
export function GitMergeView({ host, root, path, onResolve, onClose }: GitMergeViewProps) {
  const { t } = useI18n()
  const [stages, setStages] = useState<GitConflictStages | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setStages(null)
    setError(null)
    void gitConflictFile(host, root, path)
      .then((s) => {
        if (alive) setStages(s)
      })
      .catch((e: unknown) => {
        if (alive) setError(String(e))
      })
    return () => {
      alive = false
    }
  }, [host, path, root])

  // Esc closes; the backdrop deliberately does not (dialogs in this app never
  // dismiss on a stray click — a resolution choice must be deliberate).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isDismissKey(e)) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <DraggableModal className="git-diff-modal git-merge-modal">
      <div className="modal-header">
        <h3 title={path}>{path}</h3>
        <button className="k8s-modal-close" onClick={onClose} title={t('gitClose')}>
          ×
        </button>
      </div>
      <div className="modal-body git-merge-body">
        {stages === null && !error && <div className="git-diff-note">{t('gitLoading')}</div>}
        {error && <div className="git-diff-error">{error}</div>}
        {stages?.binary && <div className="git-diff-note">{t('gitMergeBinary')}</div>}
        {stages && !stages.binary && (
          <div className="git-merge-columns">
            <StagePane
              title={t('gitMergeBase')}
              text={stages.base}
              emptyLabel={t('gitMergeStageMissing')}
            />
            <StagePane
              title={t('gitMergeOurs')}
              text={stages.ours}
              emptyLabel={t('gitMergeStageMissing')}
            />
            <StagePane
              title={t('gitMergeTheirs')}
              text={stages.theirs}
              emptyLabel={t('gitMergeStageMissing')}
            />
          </div>
        )}
        {stages?.truncated && <div className="git-diff-note">{t('gitDiffTruncated')}</div>}
      </div>
      <div className="git-merge-actions">
        <button type="button" className="git-link-btn" onClick={() => onResolve('ours')}>
          {t('gitResolveOurs')}
        </button>
        <button type="button" className="git-link-btn" onClick={() => onResolve('theirs')}>
          {t('gitResolveTheirs')}
        </button>
        <button type="button" className="btn-primary" onClick={() => onResolve('resolved')}>
          {t('gitMarkResolved')}
        </button>
      </div>
    </DraggableModal>
  )
}

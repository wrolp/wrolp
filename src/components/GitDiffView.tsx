import { useEffect, useState } from 'react'
import { gitDiff } from '../commands'
import { useI18n } from '../i18n'
import { isDismissKey } from '../lib/keybindings'
import type { GitDiff, GitHostRef } from '../types'
import { DraggableModal } from './DraggableModal'

interface GitDiffViewProps {
  host: GitHostRef
  root: string
  /** `null` means the whole change (used for a commit). */
  path: string | null
  scope: 'unstaged' | 'staged' | 'commit'
  oid?: string | null
  title: string
  onClose: () => void
}

function lineClass(line: string): string {
  if (line.startsWith('@@')) return 'git-diff-hunk'
  if (line.startsWith('diff --git') || line.startsWith('index ')) return 'git-diff-meta'
  if (line.startsWith('+++') || line.startsWith('---')) return 'git-diff-meta'
  if (line.startsWith('+')) return 'git-diff-add'
  if (line.startsWith('-')) return 'git-diff-del'
  return ''
}

/**
 * A unified diff for one path (or a whole commit). Read-only, so it is a separate
 * dialog rather than a file-editor tab: the user asked to *see* what changed,
 * and saving a diff would be meaningless.
 */
export function GitDiffView({ host, root, path, scope, oid, title, onClose }: GitDiffViewProps) {
  const { t } = useI18n()
  const [diff, setDiff] = useState<GitDiff | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(null)
    void gitDiff(host, root, path, scope, oid ?? null)
      .then((d) => {
        if (alive) setDiff(d)
      })
      .catch((e: unknown) => {
        if (alive) setError(String(e))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [host, oid, path, root, scope])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isDismissKey(e)) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const lines = diff && !diff.binary && !error ? diff.text.split('\n') : []

  return (
    // No backdrop dismissal: dialogs in this app close from their own button or
    // Esc, so a stray click cannot throw away what the user is reading.
    <DraggableModal className="git-diff-modal">
      <div className="modal-header">
        <h3 title={path ?? undefined}>{title}</h3>
        <button className="k8s-modal-close" onClick={onClose} title={t('gitClose')}>
          ×
        </button>
      </div>
      <div className="modal-body git-diff-body">
        {loading && <div className="git-diff-note">{t('gitLoading')}</div>}
        {!loading && error && <div className="git-diff-error">{error}</div>}
        {!loading && !error && diff?.binary && (
          <div className="git-diff-note">{t('gitDiffBinary')}</div>
        )}
        {!loading && !error && diff && !diff.binary && lines.length === 0 && (
          <div className="git-diff-note">{t('gitDiffEmpty')}</div>
        )}
        {!loading && !error && diff && !diff.binary && lines.length > 0 && (
          <pre className="git-diff-pre">
            {lines.map((line, i) => (
              <div key={`${i}-${line.length}`} className={lineClass(line)}>
                {line || '\u00a0'}
              </div>
            ))}
          </pre>
        )}
        {diff?.truncated && <div className="git-diff-note">{t('gitDiffTruncated')}</div>}
      </div>
    </DraggableModal>
  )
}

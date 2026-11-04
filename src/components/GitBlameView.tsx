import { useEffect, useState } from 'react'
import { gitBlame } from '../commands'
import { useI18n } from '../i18n'
import { isDismissKey } from '../lib/keybindings'
import type { GitBlameLine, GitHostRef } from '../types'
import { DraggableModal } from './DraggableModal'

interface GitBlameViewProps {
  host: GitHostRef
  root: string
  path: string
  /** Blame the working tree by default; a commit pins the history read. */
  oid?: string | null
  onClose: () => void
}

function formatWhen(ts: number): string {
  if (!ts) return ''
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'short' }).format(new Date(ts * 1000))
  } catch {
    return new Date(ts * 1000).toLocaleDateString()
  }
}

/**
 * Read-only blame for one file: one row per line, with the commit that last
 * touched it. Like the diff view it fetches on open, so the panel stays a pure
 * renderer and a slow host never blocks the list.
 */
export function GitBlameView({ host, root, path, oid, onClose }: GitBlameViewProps) {
  const { t } = useI18n()
  const [rows, setRows] = useState<GitBlameLine[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setRows(null)
    setError(null)
    void gitBlame(host, root, path, oid ?? null)
      .then((r) => {
        if (alive) setRows(r)
      })
      .catch((e: unknown) => {
        if (alive) setError(String(e))
      })
    return () => {
      alive = false
    }
  }, [host, oid, path, root])

  // Esc closes; the backdrop deliberately does not (a stray click must not
  // dismiss the dialog in this app).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isDismissKey(e)) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <DraggableModal className="git-diff-modal git-blame-modal">
      <div className="modal-header">
        <h3 title={path}>{path}</h3>
        <button className="k8s-modal-close" onClick={onClose} title={t('gitClose')}>
          ×
        </button>
      </div>
      <div className="modal-body git-diff-body">
        {rows === null && !error && <div className="git-diff-note">{t('gitLoading')}</div>}
        {error && <div className="git-diff-error">{error}</div>}
        {rows !== null && rows.length === 0 && (
          <div className="git-diff-note">{t('gitBlameEmpty')}</div>
        )}
        {rows !== null && rows.length > 0 && (
          <div className="git-blame-list">
            {rows.map((r) => (
              <div className="git-blame-row" key={`${r.line}-${r.oid}`}>
                <span className="git-blame-line">{r.line}</span>
                <span className="git-blame-oid" title={r.summary}>
                  {r.shortOid}
                </span>
                <span className="git-blame-author" title={r.summary}>
                  {r.author}
                </span>
                <span className="git-blame-date">{formatWhen(r.timestamp)}</span>
                <span className="git-blame-text">{r.text}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </DraggableModal>
  )
}

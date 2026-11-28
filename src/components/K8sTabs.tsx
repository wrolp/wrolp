import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  helmReleaseHistory,
  helmReleaseValues,
  helmRollback,
  k8sApplyYaml,
  k8sLogsStreamStart,
  k8sPodLogs,
  k8sResourceYaml,
  pollK8sLogs,
  stopK8sLogsStream,
} from '../commands'
import type { HelmRevision, K8sHelmRef, K8sHostRef, K8sTabRef } from '../types'
import { LogViewer, type LogSource } from './LogViewer'
import { Icon } from './Icon'
import { useI18n } from '../i18n'
import { copyText } from '../lib/clipboard'
import { statusTone } from './K8sPanel'

interface K8sTabProps {
  /** Where kubectl runs, captured when the tab opened. */
  host: K8sHostRef
  /** The object the tab was opened for. */
  target: K8sTabRef
}

interface K8sHelmTabProps {
  host: K8sHostRef
  helm: K8sHelmRef
}

/**
 * A pod's logs as a tab body. The same `LogViewer` the panel's dialog used, but
 * the rail can keep listing resources while the stream runs, and the target is
 * frozen on the tab — moving the rail's scope cannot retarget a running stream.
 */
export const K8sLogTab: React.FC<K8sTabProps & { onAskAi?: (text: string) => void }> = ({
  host,
  target,
  onAskAi,
}) => {
  const { t } = useI18n()
  const containers = useMemo(() => target.containers ?? [], [target])
  const [container, setContainer] = useState<string | null>(
    target.container ?? containers[0] ?? null,
  )

  // One transport bundle per container: a switch is a different stream, and the
  // viewer is keyed by the container below so the old one stops on unmount.
  const source = useMemo<LogSource>(
    () => ({
      fetchTail: (tail) =>
        k8sPodLogs(host, target.context, target.namespace, target.name, container, tail),
      startStream: (tail) =>
        k8sLogsStreamStart(host, target.context, target.namespace, target.name, container, tail),
      pollStream: async (streamId) => {
        const poll = await pollK8sLogs(streamId)
        return { chunks: poll.chunks, ended: poll.ended }
      },
      stopStream: (streamId) => stopK8sLogsStream(streamId),
    }),
    [host, target.context, target.namespace, target.name, container],
  )

  return (
    <div className="k8s-tab-body">
      {containers.length > 1 && (
        <div className="k8s-tab-toolbar">
          <label className="k8s-inline k8s-log-container">
            <span>{t('k8sContainer')}</span>
            <select
              className="k8s-select"
              value={container ?? ''}
              onChange={(e) => setContainer(e.target.value)}
            >
              {containers.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      <LogViewer
        // A different container is a different stream: remount with a clean buffer.
        key={container ?? ''}
        title={t('k8sLogsTitle', { name: target.name })}
        subtitle={`${target.context} / ${target.namespace}`}
        source={source}
        initialTail={500}
        endedLabel={t('k8sStreamEnded')}
        onAskAi={onAskAi}
        className="k8s-tab-log"
      />
    </div>
  )
}

interface K8sYamlTabProps extends K8sTabProps {
  /**
   * The in-progress edit, owned by App: the tab body unmounts whenever another
   * tab is selected, and a draft kept here would vanish on that switch.
   */
  draft: string | null
  onDraftChange: (draft: string | null) => void
  /** Whether the draft differs from the loaded manifest, for App's close guard. */
  onDirtyChange?: (dirty: boolean) => void
}

/**
 * A resource's manifest as a tab body: readable, copyable, and editable in place.
 * Applying goes through the same `k8s_apply_yaml` the panel's dialog used, then
 * the tab re-reads the object so the view shows what the cluster accepted.
 */
export const K8sYamlTab: React.FC<K8sYamlTabProps> = ({
  host,
  target,
  draft,
  onDraftChange,
  onDirtyChange,
}) => {
  const { t } = useI18n()
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [copied, setCopied] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    k8sResourceYaml(host, target.context, target.namespace, target.kind, target.name)
      .then((yaml) => {
        if (cancelled) return
        setText(yaml)
        setLoading(false)
      })
      .catch((e) => {
        if (cancelled) return
        setError(String(e))
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [host, target.context, target.namespace, target.kind, target.name, reloadKey])

  useEffect(() => {
    if (!copied) return
    const id = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(id)
  }, [copied])

  useEffect(() => {
    if (!notice) return
    const id = setTimeout(() => setNotice(''), 2500)
    return () => clearTimeout(id)
  }, [notice])

  const editing = draft != null
  const dirty = editing && draft !== text
  // Report only transitions: App stores this to ask before the tab is closed, and
  // this component remounts whenever another tab is selected.
  const dirtyRef = useRef(dirty)
  const onDirtyChangeRef = useRef(onDirtyChange)
  onDirtyChangeRef.current = onDirtyChange
  useEffect(() => {
    if (dirtyRef.current === dirty) return
    dirtyRef.current = dirty
    onDirtyChangeRef.current?.(dirty)
  }, [dirty])

  const applyDraft = async () => {
    if (draft == null || busy) return
    setBusy(true)
    setError('')
    try {
      await k8sApplyYaml(host, target.context, target.namespace || null, draft)
      onDraftChange(null)
      setNotice(t('k8sYamlApplied'))
      setReloadKey((k) => k + 1)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="k8s-yaml-tab">
      <div className="k8s-tab-toolbar">
        <span className="k8s-tab-title">{target.name}</span>
        {dirty && <span className="k8s-tab-dirty" title={t('unsavedChanges')} />}
        <span className="k8s-tab-sub">
          {target.context} / {target.namespace} / {target.kind}
        </span>
        {editing ? (
          <>
            <button
              type="button"
              className="k8s-btn"
              disabled={busy}
              onClick={() => void applyDraft()}
            >
              {busy ? t('loading') : t('k8sApply')}
            </button>
            <button
              type="button"
              className="k8s-btn"
              disabled={busy}
              onClick={() => {
                onDraftChange(null)
                setError('')
              }}
            >
              {t('cancel')}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="k8s-btn k8s-tab-copy"
              disabled={loading || !!error}
              onClick={() => {
                void copyText(text).then(() => setCopied(true))
              }}
            >
              <Icon name="copy" size={12} />
              {copied ? t('k8sCopied') : t('k8sCopy')}
            </button>
            <button
              type="button"
              className="k8s-btn"
              disabled={loading || !!error}
              onClick={() => onDraftChange(text)}
            >
              <Icon name="edit" size={12} />
              {t('edit')}
            </button>
          </>
        )}
      </div>
      {notice && <div className="k8s-tab-notice">{notice}</div>}
      {error && <div className="file-error k8s-tab-error">{error}</div>}
      {editing ? (
        <textarea
          className="k8s-yaml-editor"
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          onKeyDown={(e) => {
            // Ctrl/Cmd+S applies, the same shortcut the editor uses to save.
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
              e.preventDefault()
              void applyDraft()
            }
            if (e.key === 'Escape') onDraftChange(null)
          }}
          spellCheck={false}
          autoFocus
        />
      ) : (
        <pre className="k8s-yaml">{loading ? t('k8sLoadingYaml') : text}</pre>
      )}
    </div>
  )
}

/** The values a Helm release was installed with, as a tab body. */
export const K8sHelmValuesTab: React.FC<K8sHelmTabProps> = ({ host, helm }) => {
  const { t } = useI18n()
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    helmReleaseValues(host, helm.context || null, helm.namespace, helm.release, false)
      .then((values) => {
        if (cancelled) return
        setText(values)
        setLoading(false)
      })
      .catch((e) => {
        if (cancelled) return
        setError(String(e))
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [host, helm.context, helm.namespace, helm.release])

  useEffect(() => {
    if (!copied) return
    const id = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(id)
  }, [copied])

  return (
    <div className="k8s-yaml-tab">
      <div className="k8s-tab-toolbar">
        <span className="k8s-tab-title">{helm.release}</span>
        <span className="k8s-tab-sub">
          {helm.context} / {helm.namespace}
        </span>
        <button
          type="button"
          className="k8s-btn k8s-tab-copy"
          disabled={loading || !!error}
          onClick={() => {
            void copyText(text).then(() => setCopied(true))
          }}
        >
          <Icon name="copy" size={12} />
          {copied ? t('k8sCopied') : t('k8sCopy')}
        </button>
      </div>
      {error && <div className="file-error k8s-tab-error">{error}</div>}
      <pre className="k8s-yaml">{loading ? t('loading') : text}</pre>
    </div>
  )
}

/**
 * A release's revision history, with the same per-row rollback the dialog had.
 * After a rollback the list is re-read, so the new revision is the deployed one.
 */
export const K8sHelmHistoryTab: React.FC<K8sHelmTabProps> = ({ host, helm }) => {
  const { t } = useI18n()
  const [rows, setRows] = useState<HelmRevision[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [busyRev, setBusyRev] = useState<number | null>(null)
  const [notice, setNotice] = useState('')
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    helmReleaseHistory(host, helm.context || null, helm.namespace, helm.release)
      .then((list) => {
        if (cancelled) return
        setRows(list)
        setLoading(false)
      })
      .catch((e) => {
        if (cancelled) return
        setError(String(e))
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [host, helm.context, helm.namespace, helm.release, reloadKey])

  useEffect(() => {
    if (!notice) return
    const id = setTimeout(() => setNotice(''), 2500)
    return () => clearTimeout(id)
  }, [notice])

  const doRollback = async (revision: number) => {
    setBusyRev(revision)
    setError('')
    try {
      await helmRollback(host, helm.context || null, helm.namespace, helm.release, revision)
      setNotice(t('k8sHelmRolledBack', { name: helm.release, revision }))
      setReloadKey((k) => k + 1)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusyRev(null)
    }
  }

  return (
    <div className="k8s-yaml-tab">
      <div className="k8s-tab-toolbar">
        <span className="k8s-tab-title">{helm.release}</span>
        <span className="k8s-tab-sub">
          {helm.context} / {helm.namespace}
        </span>
        <button
          type="button"
          className="k8s-btn"
          disabled={loading || busyRev != null}
          onClick={() => setReloadKey((k) => k + 1)}
        >
          <Icon name="refresh" size={12} />
          {t('refresh')}
        </button>
      </div>
      {notice && <div className="k8s-tab-notice">{notice}</div>}
      {error && <div className="file-error k8s-tab-error">{error}</div>}
      <div className="k8s-history">
        {loading && <div className="file-empty">{t('loading')}</div>}
        {!loading && rows.length === 0 && <div className="file-empty">{t('k8sHelmNoHistory')}</div>}
        {rows
          .slice()
          .reverse()
          .map((rev) => (
            <div key={rev.revision} className="k8s-history-row">
              <span className="k8s-history-rev">r{rev.revision}</span>
              <span className={`k8s-chip ${statusTone(rev.status)}`}>{rev.status}</span>
              <span className="k8s-history-desc">
                {rev.chart}
                {rev.description ? ` · ${rev.description}` : ''}
              </span>
              <button
                type="button"
                className="k8s-btn"
                disabled={rev.status === 'deployed' || busyRev != null}
                title={rev.updated}
                onClick={() => void doRollback(rev.revision)}
              >
                {busyRev === rev.revision ? t('loading') : t('k8sHelmRollback')}
              </button>
            </div>
          ))}
      </div>
    </div>
  )
}

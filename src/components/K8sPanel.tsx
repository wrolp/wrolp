import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type {
  K8sContext,
  K8sExecTarget,
  K8sHostRef,
  K8sNamespace,
  K8sPortForward,
  K8sResource,
} from '../types'
import {
  k8sApplyYaml,
  k8sDeleteResource,
  k8sListContexts,
  k8sListNamespaces,
  k8sListPortForwards,
  k8sListResources,
  k8sPodLogs,
  k8sPortForwardStart,
  k8sResourceYaml,
  k8sScaleResource,
  k8sStopPortForward,
} from '../commands'
import { Icon } from './Icon'
import { ConfirmDialog } from './ConfirmDialog'
import { useI18n } from '../i18n'
import type { TranslationKey } from '../i18n/en'

const KINDS = [
  'pods',
  'deployments',
  'statefulsets',
  'daemonsets',
  'services',
  'ingresses',
  'jobs',
  'cronjobs',
  'configmaps',
  'secrets',
] as const
type Kind = (typeof KINDS)[number]

const KIND_LABEL: Record<Kind, TranslationKey> = {
  pods: 'k8sKindPods',
  deployments: 'k8sKindDeployments',
  statefulsets: 'k8sKindStatefulsets',
  daemonsets: 'k8sKindDaemonsets',
  services: 'k8sKindServices',
  ingresses: 'k8sKindIngresses',
  jobs: 'k8sKindJobs',
  cronjobs: 'k8sKindCronjobs',
  configmaps: 'k8sKindConfigmaps',
  secrets: 'k8sKindSecrets',
}

const ALL_NAMESPACES = '*'

/**
 * The kinds `kubectl port-forward` accepts, mapped to the target prefix it wants.
 * ConfigMaps and the rest are absent, so the menu item never offers them.
 */
const FORWARD_PREFIX: Partial<Record<string, string>> = {
  pods: 'pod',
  services: 'service',
  deployments: 'deployment',
  statefulsets: 'statefulset',
}

/** Chip tone for a status word; unknown states stay neutral (`.warn`). */
function statusTone(status: string): 'ok' | 'warn' | 'bad' {
  const v = status.toLowerCase()
  if (
    ['running', 'ready', 'active', 'complete', 'completed', 'succeeded', 'scheduled'].includes(v)
  ) {
    return 'ok'
  }
  if (['failed', 'error', 'crashloopbackoff', 'stopped', 'suspended', 'terminating'].includes(v)) {
    return 'bad'
  }
  return 'warn'
}

interface K8sPanelProps {
  /** Where kubectl runs: the focused session's jump host, or this machine. */
  host: K8sHostRef
  /** The nav column's shared filter box. */
  filter?: string
  /** Bump to force a reload of the current resource list. */
  refreshSignal?: number
  /** Absent on a read-only panel. Opens a shell in the row's pod. */
  onExecPod?: (target: K8sExecTarget) => void
}

interface LogState {
  row: K8sResource
  context: string
  namespace: string
  container: string
  tail: number
  follow: boolean
  text: string
  error: string
  loading: boolean
}

interface YamlState {
  row: K8sResource
  context: string
  namespace: string
  text: string
  error: string
  loading: boolean
}

/**
 * Lists one kind in one namespace of the selected context, and offers the actions
 * that are meaningful for that row. Self-contained by design: logs, YAML, apply,
 * scale and delete all render as overlays here, so the App only supplies the host
 * and (optionally) a way to open a pod shell.
 */
export const K8sPanel: React.FC<K8sPanelProps> = ({
  host,
  filter = '',
  refreshSignal,
  onExecPod,
}) => {
  const { t } = useI18n()
  const [contexts, setContexts] = useState<K8sContext[]>([])
  const [context, setContext] = useState('')
  const [namespaces, setNamespaces] = useState<K8sNamespace[]>([])
  const [namespace, setNamespace] = useState('')
  const [kind, setKind] = useState<Kind>('pods')
  const [resources, setResources] = useState<K8sResource[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [localRefresh, setLocalRefresh] = useState(0)

  const [menu, setMenu] = useState<{ x: number; y: number; row: K8sResource } | null>(null)
  const [menuStyle, setMenuStyle] = useState<{ left: number; top: number }>({ left: 0, top: 0 })
  const menuRef = useRef<HTMLDivElement>(null)

  const [logs, setLogs] = useState<LogState | null>(null)
  const [yaml, setYaml] = useState<YamlState | null>(null)
  const [applyOpen, setApplyOpen] = useState(false)
  const [applyText, setApplyText] = useState('')
  const [applyBusy, setApplyBusy] = useState(false)
  const [applyError, setApplyError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<{ row: K8sResource; context: string } | null>(
    null,
  )
  const [scaleTarget, setScaleTarget] = useState<{ row: K8sResource; context: string } | null>(null)
  const [scaleValue, setScaleValue] = useState('1')
  const [scaleBusy, setScaleBusy] = useState(false)
  const [scaleError, setScaleError] = useState('')
  const [copied, setCopied] = useState(false)
  const logRef = useRef<HTMLPreElement>(null)

  // Port forwards are app-wide (they outlive this panel), so the list is polled rather
  // than kept in component state alongside the resource rows.
  const [forwards, setForwards] = useState<K8sPortForward[]>([])
  const [forwardDialog, setForwardDialog] = useState<{
    target: string
    context: string
    namespace: string
  } | null>(null)
  const [forwardLocal, setForwardLocal] = useState('')
  const [forwardRemote, setForwardRemote] = useState('')
  const [forwardLan, setForwardLan] = useState(false)
  const [forwardBusy, setForwardBusy] = useState(false)
  const [forwardError, setForwardError] = useState('')

  // Reload on the host's *shape*, not object identity: callers pass a fresh literal
  // per render, as they do for DockerPanel.
  const hostKey = host.kind === 'ssh' ? `ssh:${host.jumpTabId}` : 'local'
  const hostRef = useRef(host)
  hostRef.current = host
  // Which context the namespace list in state belongs to. Until it matches the
  // selected context, a resource fetch would pair the new context with the old
  // namespace (and briefly show an error), so it waits.
  const namespacesContextRef = useRef('')

  // Contexts first: the namespace list depends on the selected client config.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    setContexts([])
    setContext('')
    setNamespaces([])
    setNamespace('')
    setResources([])
    k8sListContexts(hostRef.current)
      .then((list) => {
        if (cancelled) return
        setContexts(list)
        const current = list.find((c) => c.current) ?? list[0]
        setContext(current?.name ?? '')
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
  }, [hostKey])

  // Namespaces for the chosen context; preselect the context's own default when it
  // names one, otherwise `default` when present.
  useEffect(() => {
    if (!context) return
    let cancelled = false
    const known = contexts.find((c) => c.name === context)?.namespace ?? null
    namespacesContextRef.current = ''
    setLoading(true)
    setError('')
    setNamespace('')
    k8sListNamespaces(hostRef.current, context)
      .then((list) => {
        if (cancelled) return
        namespacesContextRef.current = context
        setNamespaces(list)
        const preferred =
          (known && list.some((n) => n.name === known) ? known : null) ??
          (list.some((n) => n.name === 'default') ? 'default' : (list[0]?.name ?? 'default'))
        setNamespace(preferred)
        setLoading(false)
      })
      .catch((e) => {
        if (cancelled) return
        setError(String(e))
        setNamespaces([])
        setNamespace('')
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [context, contexts, hostKey])

  const loadResources = useCallback(() => {
    if (!context || !namespace || namespacesContextRef.current !== context) return
    let cancelled = false
    setLoading(true)
    setError('')
    k8sListResources(
      hostRef.current,
      context,
      namespace === ALL_NAMESPACES ? null : namespace,
      kind,
    )
      .then((rows) => {
        if (!cancelled) setResources(rows)
      })
      .catch((e) => {
        if (!cancelled) {
          setError(String(e))
          setResources([])
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [context, namespace, kind])

  // Load on every scope change, and when the App or a local action asks for a refresh.
  useEffect(() => loadResources(), [loadResources, localRefresh, refreshSignal])

  // Context menu dismissal + viewport clamping (the Docker panel's pattern).
  useEffect(() => {
    const close = () => setMenu(null)
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [])

  useLayoutEffect(() => {
    if (!menu || !menuRef.current) return
    const rect = menuRef.current.getBoundingClientRect()
    const overflowY = menu.y + rect.height - window.innerHeight
    const overflowX = menu.x + rect.width - window.innerWidth
    setMenuStyle({
      left: overflowX > 0 ? menu.x - overflowX - 4 : menu.x,
      top: overflowY > 0 ? menu.y - rect.height : menu.y,
    })
  }, [menu])

  // Auto-dismiss the action result; the panel is narrow and the line is transient.
  useEffect(() => {
    if (!notice) return
    const id = setTimeout(() => setNotice(''), 4000)
    return () => clearTimeout(id)
  }, [notice])

  // Escape closes whichever overlay is open. ConfirmDialog already handles its own,
  // so this only covers the five K8s-owned ones.
  useEffect(() => {
    if (!logs && !yaml && !applyOpen && !scaleTarget && !forwardDialog) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setLogs(null)
      setYaml(null)
      setApplyOpen(false)
      setScaleTarget(null)
      setForwardDialog(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [logs, yaml, applyOpen, scaleTarget, forwardDialog])

  // The namespace a row actually lives in — all-namespaces mode lists several.
  const rowNamespace = useCallback(
    (row: K8sResource, fallback: string) =>
      row.namespace || (fallback === ALL_NAMESPACES ? '' : fallback),
    [],
  )

  const openLogs = useCallback(
    (row: K8sResource) => {
      if (!context) return
      setLogs({
        row,
        context,
        namespace: rowNamespace(row, namespace),
        container: row.containers[0] ?? '',
        tail: 500,
        follow: true,
        text: '',
        error: '',
        loading: true,
      })
      setCopied(false)
    },
    [context, namespace, rowNamespace],
  )

  // Fetch (and, while Follow is on, poll) a pod's log tail. Polling instead of
  // `kubectl logs -f` keeps this panel free of another backend stream registry;
  // 2s is the viewer's refresh cadence, and the tail is bounded by the picker.
  useEffect(() => {
    if (!logs) return
    let cancelled = false
    const fetch = () => {
      k8sPodLogs(
        hostRef.current,
        logs.context,
        logs.namespace,
        logs.row.name,
        logs.container || null,
        logs.tail,
      )
        .then((text) => {
          if (cancelled) return
          setLogs((prev) => (prev ? { ...prev, text, error: '', loading: false } : prev))
        })
        .catch((e) => {
          if (cancelled) return
          setLogs((prev) => (prev ? { ...prev, error: String(e), loading: false } : prev))
        })
    }
    fetch()
    if (!logs.follow) {
      return () => {
        cancelled = true
      }
    }
    const id = setInterval(fetch, 2000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
    // `text`/`loading` are outputs, not inputs: depending on them would restart the
    // interval on every tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logs?.row.name, logs?.context, logs?.namespace, logs?.container, logs?.tail, logs?.follow])

  // Keep the newest lines in view while Follow is on. A user who scrolls back is
  // pulled forward on the next poll — the trade-off of a polling viewer, and the
  // reason Follow is a switch they can turn off.
  useEffect(() => {
    if (!logs?.follow || !logRef.current) return
    logRef.current.scrollTop = logRef.current.scrollHeight
  }, [logs?.text, logs?.follow])

  const openYaml = useCallback(
    (row: K8sResource) => {
      if (!context) return
      const ns = rowNamespace(row, namespace)
      setYaml({ row, context, namespace: ns, text: '', error: '', loading: true })
      k8sResourceYaml(hostRef.current, context, ns, row.kind, row.name)
        .then((text) => setYaml((prev) => (prev ? { ...prev, text, loading: false } : prev)))
        .catch((e) =>
          setYaml((prev) => (prev ? { ...prev, error: String(e), loading: false } : prev)),
        )
    },
    [context, namespace, rowNamespace],
  )

  const doDelete = useCallback(async () => {
    if (!confirmDelete) return
    const { row, context: ctx } = confirmDelete
    const ns = rowNamespace(row, namespace)
    try {
      await k8sDeleteResource(hostRef.current, ctx, ns, row.kind, row.name)
      setConfirmDelete(null)
      setLocalRefresh((k) => k + 1)
      setNotice(t('k8sDeleted', { kind: row.kind, name: row.name }))
    } catch (e) {
      setConfirmDelete(null)
      setError(t('k8sDeleteFailed', { kind: row.kind, name: row.name, err: String(e) }))
    }
  }, [confirmDelete, namespace, rowNamespace, t])

  const doScale = useCallback(async () => {
    if (!scaleTarget) return
    const n = Number(scaleValue)
    if (!Number.isInteger(n) || n < 0) return
    const { row, context: ctx } = scaleTarget
    setScaleBusy(true)
    setScaleError('')
    try {
      await k8sScaleResource(
        hostRef.current,
        ctx,
        rowNamespace(row, namespace),
        row.kind,
        row.name,
        n,
      )
      setScaleTarget(null)
      setLocalRefresh((k) => k + 1)
      setNotice(t('k8sScaleDone', { name: row.name, n }))
    } catch (e) {
      setScaleError(String(e))
    } finally {
      setScaleBusy(false)
    }
  }, [scaleTarget, scaleValue, namespace, rowNamespace, t])

  const doApply = useCallback(async () => {
    if (!context) return
    setApplyBusy(true)
    setApplyError('')
    try {
      const result = await k8sApplyYaml(
        hostRef.current,
        context,
        namespace === ALL_NAMESPACES ? null : namespace,
        applyText,
      )
      setApplyOpen(false)
      setApplyText('')
      setNotice(t('k8sApplyDone', { result }))
      setLocalRefresh((k) => k + 1)
    } catch (e) {
      setApplyError(String(e))
    } finally {
      setApplyBusy(false)
    }
  }, [context, namespace, applyText, t])

  const exec = useCallback(
    (row: K8sResource) => {
      if (!onExecPod) return
      onExecPod({
        context: context || null,
        namespace: rowNamespace(row, namespace),
        pod: row.name,
        container: row.containers[0] ?? null,
      })
      setMenu(null)
    },
    [context, namespace, onExecPod, rowNamespace],
  )

  const copyLogs = useCallback(async () => {
    if (!logs) return
    try {
      await navigator.clipboard.writeText(logs.text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard permission can be denied; the text is selectable either way.
    }
  }, [logs])

  const refreshForwards = useCallback(async () => {
    try {
      setForwards(await k8sListPortForwards())
    } catch {
      // A failed read leaves the last known rows on screen; the next tick retries.
    }
  }, [])

  useEffect(() => {
    void refreshForwards()
  }, [refreshForwards])

  // Poll only while something is actually running: an exited row is stable, and a
  // panel full of dead forwards needs no timer to keep telling the same story.
  const hasRunningForward = forwards.some((f) => f.running)
  useEffect(() => {
    if (!hasRunningForward) return
    const id = setInterval(() => void refreshForwards(), 2000)
    return () => clearInterval(id)
  }, [hasRunningForward, refreshForwards])

  const openForwardDialog = useCallback(
    (row: K8sResource) => {
      const prefix = FORWARD_PREFIX[row.kind]
      if (!prefix || !context) return
      setForwardDialog({
        target: `${prefix}/${row.name}`,
        context,
        namespace: rowNamespace(row, namespace),
      })
      // Prefill both halves with the object's own port: the common case is "expose
      // this port on the same number here".
      const port = row.ports[0] ? String(row.ports[0]) : ''
      setForwardLocal(port)
      setForwardRemote(port)
      setForwardLan(false)
      setForwardError('')
    },
    [context, namespace, rowNamespace],
  )

  const startForward = useCallback(async () => {
    if (!forwardDialog) return
    const local = Number(forwardLocal)
    if (!Number.isInteger(local) || local < 1 || local > 65535) {
      setForwardError(t('k8sForwardBadLocal'))
      return
    }
    const remote = forwardRemote.trim()
    if (!remote) {
      setForwardError(t('k8sForwardBadRemote'))
      return
    }
    setForwardBusy(true)
    setForwardError('')
    try {
      await k8sPortForwardStart(
        hostRef.current,
        forwardDialog.context || null,
        forwardDialog.namespace,
        forwardDialog.target,
        local,
        remote,
        forwardLan,
      )
      setForwardDialog(null)
      setNotice(
        t('k8sForwardStarted', {
          addr: `${forwardLan ? '0.0.0.0' : '127.0.0.1'}:${local}`,
          target: forwardDialog.target,
        }),
      )
      await refreshForwards()
    } catch (e) {
      setForwardError(String(e))
    } finally {
      setForwardBusy(false)
    }
  }, [forwardDialog, forwardLocal, forwardRemote, forwardLan, refreshForwards, t])

  const stopForward = useCallback(
    async (id: number) => {
      try {
        await k8sStopPortForward(id)
      } catch (e) {
        setError(String(e))
      }
      await refreshForwards()
    },
    [refreshForwards],
  )

  const q = filter.toLowerCase()
  const visible = resources.filter(
    (r) =>
      !q ||
      r.name.toLowerCase().includes(q) ||
      r.detail.toLowerCase().includes(q) ||
      r.status.toLowerCase().includes(q),
  )

  const menuRow = menu?.row
  const canScale =
    menuRow != null && (menuRow.kind === 'deployments' || menuRow.kind === 'statefulsets')
  // `kubectl port-forward` only speaks to workload-ish targets; the map is the list.
  const canForward = menuRow != null && FORWARD_PREFIX[menuRow.kind] != null

  return (
    <div className="k8s-panel">
      <div className="panel-head sec">
        <span className="panel-title">{t('railK8s')}</span>
        <span className="cnt" title={context}>
          {context ? `${visible.length} · ${context}` : visible.length}
        </span>
        <button
          type="button"
          className="icon-btn"
          title={t('k8sApply')}
          aria-label={t('k8sApply')}
          onClick={() => {
            setApplyError('')
            setApplyOpen(true)
          }}
          disabled={!context}
        >
          <Icon name="edit" size={13} />
        </button>
        <button
          type="button"
          className="icon-btn"
          title={t('refresh')}
          aria-label={t('refresh')}
          onClick={() => setLocalRefresh((k) => k + 1)}
          disabled={loading}
        >
          <Icon name="refresh" size={13} />
        </button>
      </div>

      <div className="k8s-filters">
        <label className="k8s-field k8s-field-wide">
          <span>{t('k8sContext')}</span>
          <select
            className="k8s-select"
            value={context}
            onChange={(e) => setContext(e.target.value)}
            disabled={contexts.length === 0}
            aria-label={t('k8sContext')}
          >
            {contexts.length === 0 && <option value="">—</option>}
            {contexts.map((c) => (
              <option key={c.name} value={c.name}>
                {c.current ? `● ${c.name}` : c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="k8s-field">
          <span>{t('k8sNamespace')}</span>
          <select
            className="k8s-select"
            value={namespace}
            onChange={(e) => setNamespace(e.target.value)}
            disabled={namespaces.length === 0}
            aria-label={t('k8sNamespace')}
          >
            <option value={ALL_NAMESPACES}>{t('k8sAllNamespaces')}</option>
            {namespaces.map((n) => (
              <option key={n.name} value={n.name}>
                {n.name}
              </option>
            ))}
          </select>
        </label>
        <label className="k8s-field">
          <span>{t('k8sResourceKind')}</span>
          <select
            className="k8s-select"
            value={kind}
            onChange={(e) => setKind(e.target.value as Kind)}
            aria-label={t('k8sResourceKind')}
          >
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {t(KIND_LABEL[k])}
              </option>
            ))}
          </select>
        </label>
      </div>

      {notice && <div className="k8s-notice">{notice}</div>}

      <div className="k8s-list">
        {error && <div className="file-error">{error}</div>}
        {loading && <div className="file-empty">{t('loading')}</div>}
        {!loading && !error && !context && contexts.length === 0 && (
          <div className="file-empty">{t('k8sNoContexts')}</div>
        )}
        {!loading && !error && context && visible.length === 0 && (
          <div className="file-empty">{t('k8sNoResources', { kind: t(KIND_LABEL[kind]) })}</div>
        )}
        {visible.map((r) => (
          <div
            key={`${r.namespace}/${r.name}`}
            className="k8s-item"
            onClick={() => openYaml(r)}
            onContextMenu={(e) => {
              e.preventDefault()
              e.stopPropagation()
              setMenu({ x: e.clientX, y: e.clientY, row: r })
              setMenuStyle({ left: e.clientX, top: e.clientY })
            }}
            title={`${r.name}${r.namespace ? `\n${r.namespace}` : ''}\n${r.status}${
              r.detail ? `\n${r.detail}` : ''
            }`}
          >
            <span className="k8s-icon">
              <Icon name="boxes" size={14} />
            </span>
            <div className="k8s-info">
              <div className="k8s-name">
                {r.name}
                {r.namespace && namespace === ALL_NAMESPACES && (
                  <span className="k8s-ns">{r.namespace}</span>
                )}
              </div>
              <div className="k8s-detail">{r.detail}</div>
            </div>
            <div className="k8s-chips">
              <span className={`k8s-chip ${statusTone(r.status)}`}>{r.status}</span>
              {r.ready && <span className="k8s-chip muted">{r.ready}</span>}
              {r.restarts > 0 && (
                <span className="k8s-chip bad" title={t('k8sRestarts', { n: r.restarts })}>
                  ↻{r.restarts}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Port forwards outlive this panel (and the resource list it was started from),
          so they get their own strip: address → target, with the row that stopped
          on its own kept until it is dismissed. */}
      {forwards.length > 0 && (
        <div className="k8s-forwards">
          <div className="k8s-forwards-head">
            <span>{t('k8sForwards')}</span>
            <span className="cnt">{forwards.length}</span>
          </div>
          {forwards.map((f) => (
            <div
              key={f.id}
              className={`k8s-forward${f.running ? '' : ' dead'}`}
              title={f.message || undefined}
            >
              <span className={`k8s-dot ${f.running ? 'on' : 'off'}`} />
              <span className="k8s-forward-addr">{f.listenAddr}</span>
              <span className="k8s-forward-arrow">→</span>
              <span className="k8s-forward-target">
                {f.target}:{f.remotePort}
              </span>
              <button
                type="button"
                className="icon-btn"
                title={f.running ? t('k8sForwardStop') : t('k8sForwardDismiss')}
                aria-label={f.running ? t('k8sForwardStop') : t('k8sForwardDismiss')}
                onClick={() => void stopForward(f.id)}
              >
                <Icon name={f.running ? 'stop' : 'x'} size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {menu && (
        <div
          ref={menuRef}
          className="context-menu"
          style={{ left: menuStyle.left, top: menuStyle.top }}
          onClick={(e) => e.stopPropagation()}
        >
          {menu.row.kind === 'pods' && (
            <>
              <div
                className="context-menu-item"
                onClick={() => {
                  openLogs(menu.row)
                  setMenu(null)
                }}
              >
                <Icon name="file" size={14} />
                {t('k8sLogs')}
              </div>
              {onExecPod && (
                <div className="context-menu-item" onClick={() => exec(menu.row)}>
                  <Icon name="terminal" size={14} />
                  {t('k8sExec')}
                </div>
              )}
            </>
          )}
          {canForward && (
            <div
              className="context-menu-item"
              onClick={() => {
                openForwardDialog(menu.row)
                setMenu(null)
              }}
            >
              <Icon name="link" size={14} />
              {t('k8sForward')}
            </div>
          )}
          {canScale && (
            <div
              className="context-menu-item"
              onClick={() => {
                setScaleError('')
                setScaleValue(menu.row.ready.split('/')[1] || '1')
                setScaleTarget({ row: menu.row, context })
                setMenu(null)
              }}
            >
              <Icon name="plus" size={14} />
              {t('k8sScale')}
            </div>
          )}
          <div
            className="context-menu-item"
            onClick={() => {
              openYaml(menu.row)
              setMenu(null)
            }}
          >
            <Icon name="file" size={14} />
            {t('k8sViewYaml')}
          </div>
          <div
            className="context-menu-item ctx-danger"
            onClick={() => {
              setConfirmDelete({ row: menu.row, context })
              setMenu(null)
            }}
          >
            <Icon name="trash" size={14} />
            {t('delete')}
          </div>
        </div>
      )}

      {/* Logs */}
      {logs && (
        <div className="modal-overlay" onMouseDown={() => setLogs(null)}>
          <div className="modal k8s-modal" onMouseDown={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{t('k8sLogsTitle', { name: logs.row.name })}</h3>
              <span className="k8s-modal-close" onClick={() => setLogs(null)}>
                <Icon name="x" size={14} />
              </span>
            </div>
            <div className="k8s-log-toolbar">
              {logs.row.containers.length > 1 && (
                <label className="k8s-inline">
                  <span>{t('k8sContainer')}</span>
                  <select
                    className="k8s-select"
                    value={logs.container}
                    onChange={(e) =>
                      setLogs((prev) =>
                        prev ? { ...prev, container: e.target.value, loading: true } : prev,
                      )
                    }
                  >
                    {logs.row.containers.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="k8s-inline">
                <span>{t('k8sTail')}</span>
                <select
                  className="k8s-select"
                  value={logs.tail}
                  onChange={(e) =>
                    setLogs((prev) =>
                      prev ? { ...prev, tail: Number(e.target.value), loading: true } : prev,
                    )
                  }
                >
                  {[200, 500, 2000, 5000].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
              <label className="k8s-inline k8s-check">
                <input
                  type="checkbox"
                  checked={logs.follow}
                  onChange={(e) =>
                    setLogs((prev) => (prev ? { ...prev, follow: e.target.checked } : prev))
                  }
                />
                <span>{t('k8sFollow')}</span>
              </label>
              <button type="button" className="k8s-btn" onClick={copyLogs}>
                {copied ? t('k8sCopied') : t('k8sCopy')}
              </button>
            </div>
            {logs.error && <div className="modal-error">{logs.error}</div>}
            <pre className="k8s-log-output" ref={logRef}>
              {logs.loading && !logs.text ? t('loading') : logs.text || t('k8sNoLogs')}
            </pre>
          </div>
        </div>
      )}

      {/* YAML */}
      {yaml && (
        <div className="modal-overlay" onMouseDown={() => setYaml(null)}>
          <div className="modal k8s-modal" onMouseDown={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{t('k8sYamlTitle', { name: yaml.row.name })}</h3>
              <span className="k8s-modal-close" onClick={() => setYaml(null)}>
                <Icon name="x" size={14} />
              </span>
            </div>
            {yaml.error && <div className="modal-error">{yaml.error}</div>}
            <pre className="k8s-yaml">
              {yaml.loading && !yaml.text ? t('k8sLoadingYaml') : yaml.text}
            </pre>
          </div>
        </div>
      )}

      {/* Apply */}
      {applyOpen && (
        <div className="modal-overlay" onMouseDown={() => setApplyOpen(false)}>
          <div className="modal k8s-modal" onMouseDown={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{t('k8sApplyTitle')}</h3>
              <span className="k8s-modal-close" onClick={() => setApplyOpen(false)}>
                <Icon name="x" size={14} />
              </span>
            </div>
            <div className="modal-body">
              <textarea
                className="k8s-apply-input"
                value={applyText}
                onChange={(e) => setApplyText(e.target.value)}
                placeholder={t('k8sApplyPlaceholder')}
                spellCheck={false}
                autoFocus
              />
              {applyError && <div className="modal-error">{applyError}</div>}
            </div>
            <div className="modal-footer">
              <button className="btn-cancel" onClick={() => setApplyOpen(false)}>
                {t('cancel')}
              </button>
              <button
                className="btn-primary"
                onClick={() => void doApply()}
                disabled={applyBusy || !applyText.trim()}
              >
                {t('k8sApply')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Scale */}
      {scaleTarget && (
        <div className="modal-overlay" onMouseDown={() => setScaleTarget(null)}>
          <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{t('k8sScaleTitle', { name: scaleTarget.row.name })}</h3>
            </div>
            <div className="modal-body">
              <label className="k8s-field">
                <span>{t('k8sReplicas')}</span>
                <input
                  type="number"
                  min={0}
                  className="k8s-input"
                  value={scaleValue}
                  onChange={(e) => setScaleValue(e.target.value)}
                  autoFocus
                />
              </label>
              {scaleError && <div className="modal-error">{scaleError}</div>}
            </div>
            <div className="modal-footer">
              <button className="btn-cancel" onClick={() => setScaleTarget(null)}>
                {t('cancel')}
              </button>
              <button className="btn-primary" onClick={() => void doScale()} disabled={scaleBusy}>
                {t('confirm')}
              </button>
            </div>
          </div>
        </div>
      )}

      {forwardDialog && (
        <div className="modal-overlay" onMouseDown={() => setForwardDialog(null)}>
          <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{t('k8sForwardTitle', { target: forwardDialog.target })}</h3>
            </div>
            <div className="modal-body">
              <div className="k8s-forward-fields">
                <label className="k8s-field">
                  <span>{t('k8sForwardLocal')}</span>
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    className="k8s-input"
                    value={forwardLocal}
                    onChange={(e) => setForwardLocal(e.target.value)}
                    placeholder="8080"
                    autoFocus
                  />
                </label>
                <label className="k8s-field">
                  <span>{t('k8sForwardRemote')}</span>
                  <input
                    className="k8s-input"
                    value={forwardRemote}
                    onChange={(e) => setForwardRemote(e.target.value)}
                    placeholder="8080"
                  />
                </label>
              </div>
              <label className="k8s-inline k8s-check">
                <input
                  type="checkbox"
                  checked={forwardLan}
                  onChange={(e) => setForwardLan(e.target.checked)}
                />
                <span>{t('k8sForwardLan')}</span>
              </label>
              {host.kind === 'ssh' && <div className="k8s-note">{t('k8sForwardViaJump')}</div>}
              {forwardError && <div className="modal-error">{forwardError}</div>}
            </div>
            <div className="modal-footer">
              <button className="btn-cancel" onClick={() => setForwardDialog(null)}>
                {t('cancel')}
              </button>
              <button
                className="btn-primary"
                onClick={() => void startForward()}
                disabled={forwardBusy}
              >
                {t('k8sForwardStart')}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmDelete && (
        <ConfirmDialog
          danger
          title={t('k8sDeleteTitle', { kind: confirmDelete.row.kind })}
          message={t('k8sDeleteConfirm', {
            kind: confirmDelete.row.kind,
            name: confirmDelete.row.name,
          })}
          confirmLabel={t('delete')}
          cancelLabel={t('cancel')}
          onConfirm={() => void doDelete()}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  )
}

export default K8sPanel

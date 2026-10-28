import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type {
  HelmProbe,
  HelmRelease,
  HelmRevision,
  K8sContext,
  K8sExecTarget,
  K8sForwardRule,
  K8sHostRef,
  K8sNamespace,
  K8sPortForward,
  K8sResource,
  K8sScope,
} from '../types'
import {
  helmListReleases,
  helmProbe,
  helmReleaseHistory,
  helmReleaseValues,
  helmRollback,
  helmUninstall,
  helmUpgradeInstall,
  k8sApplyYaml,
  k8sDeleteForwardRule,
  k8sDeleteResource,
  k8sListContexts,
  k8sListForwardRules,
  k8sListNamespaces,
  k8sListPortForwards,
  k8sListResources,
  k8sLogsStreamStart,
  k8sPodLogs,
  k8sPortForwardStart,
  k8sResourceYaml,
  k8sScaleResource,
  k8sStopPortForward,
  k8sSaveForwardRule,
  pollK8sLogs,
  stopK8sLogsStream,
} from '../commands'
import { Icon } from './Icon'
import { ConfirmDialog } from './ConfirmDialog'
import { DraggableModal } from './DraggableModal'
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

/**
 * Cap on the log viewer's buffer. A chatty pod can outrun the 500 ms poll, and the
 * text is held in React state — so the oldest content is dropped at a newline
 * boundary rather than growing without limit.
 */
const MAX_LOG_CHARS = 300_000

function trimToChars(text: string): string {
  if (text.length <= MAX_LOG_CHARS) return text
  const cut = text.length - MAX_LOG_CHARS
  const nl = text.indexOf('\n', cut)
  return nl >= 0 ? text.slice(nl + 1) : text.slice(cut)
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

/** Chip tone for a status word; unknown states stay neutral (`.warn`). Covers both
 * kubectl's phases and helm's release statuses (`deployed`, `pending-upgrade`, …). */
function statusTone(status: string): 'ok' | 'warn' | 'bad' {
  const v = status.toLowerCase()
  if (
    [
      'running',
      'ready',
      'active',
      'complete',
      'completed',
      'succeeded',
      'scheduled',
      'deployed',
    ].includes(v)
  ) {
    return 'ok'
  }
  if (
    [
      'failed',
      'error',
      'crashloopbackoff',
      'stopped',
      'suspended',
      'terminating',
      'uninstalled',
      'uninstalling',
    ].includes(v)
  ) {
    return 'bad'
  }
  return 'warn'
}

interface K8sPanelProps {
  /** Where kubectl runs: the focused session's jump host, or this machine. */
  host: K8sHostRef
  /** Owned by App per host; the panel must also be keyed by that host. */
  scope: K8sScope
  /** Merge only this patch into the host's latest scope, never a captured snapshot. */
  onScopeChange: (patch: Partial<K8sScope>) => void
  /** The nav column's shared filter box. */
  filter?: string
  /** Bump to force a reload of the current resource list. */
  refreshSignal?: number
  /** Absent on a read-only panel. Opens a shell in the row's pod. */
  onExecPod?: (target: K8sExecTarget) => void
  /** Opens the pod's filesystem in the Files panel. Absent for a read-only panel. */
  onBrowsePod?: (target: K8sExecTarget) => void
  /** Pod whose filesystem the Files panel is currently showing. */
  activePod?: string | null
  /** Saved connection behind `host`, recorded on a rule so it can be reopened later. */
  connectionId?: string | null
  /** Its display name, for the "open a session first" hint. */
  connectionName?: string | null
  /**
   * Where a saved rule would run right now, or null when its host is not reachable —
   * a jump-host rule needs an open session to that connection.
   */
  resolveRuleHost?: (rule: K8sForwardRule) => K8sHostRef | null
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
  /** The `kubectl logs -f` stream ran out (pod gone, session dropped). */
  ended: boolean
}

interface YamlState {
  row: K8sResource
  context: string
  namespace: string
  text: string
  error: string
  loading: boolean
}

// App retains choices per host; keyed remounts discard transient requests and dialogs.
export const K8sPanel: React.FC<K8sPanelProps> = ({
  host,
  scope,
  onScopeChange,
  filter = '',
  refreshSignal,
  onExecPod,
  onBrowsePod,
  activePod,
  connectionId,
  connectionName,
  resolveRuleHost,
}) => {
  const { t } = useI18n()
  const { mode, context, namespace } = scope
  const kind = KINDS.find((k) => k === scope.kind) ?? 'pods'
  // Read current preferences without reloading lists when unrelated choices change.
  const scopeRef = useRef(scope)
  scopeRef.current = scope
  const onScopeChangeRef = useRef(onScopeChange)
  onScopeChangeRef.current = onScopeChange
  const [contexts, setContexts] = useState<K8sContext[]>([])
  const [contextsHost, setContextsHost] = useState<string | null>(null)
  const [namespaces, setNamespaces] = useState<K8sNamespace[]>([])
  const [namespacesScope, setNamespacesScope] = useState<{
    hostKey: string
    context: string
  } | null>(null)
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
  // The live `kubectl logs -f` on screen, its next poll, and whether the viewer is
  // pinned to the bottom. All three are imperative handles, not render state.
  const streamIdRef = useRef<string | null>(null)
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const stickRef = useRef(true)
  const logsRef = useRef<LogState | null>(null)
  logsRef.current = logs

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
  // Saved rules outlive the running forwards, so they are a separate list: a rule
  // with no live forward is offered for restart, and one with a forward is hidden
  // (the running row already shows it).
  const [rules, setRules] = useState<K8sForwardRule[]>([])
  const [forwardSave, setForwardSave] = useState(true)

  // Resources and Helm releases share the scope pickers above (context, namespace)
  // but not the list, so one switch decides which of the two is on screen.
  const [releases, setReleases] = useState<HelmRelease[]>([])
  const [helmInfo, setHelmInfo] = useState<HelmProbe | null>(null)
  const [helmLoading, setHelmLoading] = useState(false)
  const [helmError, setHelmError] = useState('')
  const [helmMenu, setHelmMenu] = useState<{ x: number; y: number; rel: HelmRelease } | null>(null)
  const [helmText, setHelmText] = useState<{
    title: string
    text: string
    error: string
    loading: boolean
  } | null>(null)
  const [history, setHistory] = useState<{
    release: string
    rows: HelmRevision[]
    error: string
    loading: boolean
  } | null>(null)
  const [confirmUninstall, setConfirmUninstall] = useState<HelmRelease | null>(null)
  const [installOpen, setInstallOpen] = useState(false)
  const [installRelease, setInstallRelease] = useState('')
  const [installChart, setInstallChart] = useState('')
  const [installVersion, setInstallVersion] = useState('')
  const [installValues, setInstallValues] = useState('')
  const [installWait, setInstallWait] = useState(false)
  const [installCreateNs, setInstallCreateNs] = useState(false)
  const [installBusy, setInstallBusy] = useState(false)
  const [installError, setInstallError] = useState('')

  // Reload on the host's *shape*, not object identity: callers pass a fresh literal
  // per render, as they do for DockerPanel.
  const hostKey = host.kind === 'ssh' ? `ssh:${host.jumpTabId}` : 'local'
  const hostRef = useRef(host)
  hostRef.current = host
  const contextReady =
    contextsHost === hostKey && !!context && contexts.some((c) => c.name === context)
  // State readiness starts both lists even when validation leaves the selection unchanged.
  const namespaceListReady =
    contextReady && namespacesScope?.hostKey === hostKey && namespacesScope.context === context
  const scopeReady =
    namespaceListReady &&
    !!namespace &&
    (namespace === ALL_NAMESPACES || namespaces.some((n) => n.name === namespace))

  // Saved choices cannot drive requests until this host's context list validates them.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    setContexts([])
    setContextsHost(null)
    setNamespacesScope(null)
    setNamespaces([])
    setResources([])
    setHelmInfo(null)
    setReleases([])
    k8sListContexts(hostRef.current)
      .then((list) => {
        if (cancelled) return
        setContexts(list)
        setContextsHost(hostKey)
        const saved = scopeRef.current.context
        const chosen =
          list.find((c) => c.name && c.name === saved) ??
          list.find((c) => c.name && c.current) ??
          list.find((c) => c.name)
        if (chosen && chosen.name !== saved) {
          onScopeChangeRef.current({ context: chosen.name, namespace: '' })
        }
        setLoading(false)
      })
      .catch((e) => {
        if (cancelled) return
        // Transport failure (or an empty list) must not erase remembered choices.
        setError(String(e))
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [hostKey])

  // Explicit context changes clear the saved namespace; unchanged restored contexts keep it.
  useEffect(() => {
    setNamespacesScope(null)
    setNamespaces([])
    setResources([])
    setReleases([])
    setHelmLoading(false)
    if (!contextReady) return
    let cancelled = false
    const known = contexts.find((c) => c.name === context)?.namespace ?? null
    setLoading(true)
    setError('')
    k8sListNamespaces(hostRef.current, context)
      .then((list) => {
        if (cancelled || scopeRef.current.context !== context) return
        const saved = scopeRef.current.namespace
        const preferred =
          (saved === ALL_NAMESPACES || list.some((n) => n.name === saved) ? saved : null) ??
          (known && list.some((n) => n.name === known) ? known : null) ??
          (list.some((n) => n.name === 'default') ? 'default' : list[0]?.name)
        setNamespaces(list)
        if (preferred && preferred !== saved) {
          onScopeChangeRef.current({ namespace: preferred })
        }
        setNamespacesScope({ hostKey, context })
        setLoading(false)
      })
      .catch((e) => {
        if (cancelled || scopeRef.current.context !== context) return
        setError(String(e))
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [context, contextReady, contexts, hostKey])

  const loadResources = useCallback(() => {
    if (!scopeReady) return
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
  }, [context, namespace, kind, scopeReady])

  // Load on every scope change, and when the App or a local action asks for a refresh.
  useEffect(() => loadResources(), [loadResources, localRefresh, refreshSignal])

  // ---- Helm ----

  // Asking the host once whether helm exists keeps "no helm here" a statement about
  // the host rather than a broken-looking release list.
  useEffect(() => {
    if (mode !== 'helm' || helmInfo) return
    let cancelled = false
    helmProbe(hostRef.current)
      .then((p) => {
        if (!cancelled) setHelmInfo(p)
      })
      .catch((e) => {
        if (!cancelled) setHelmInfo({ installed: false, version: null, message: String(e) })
      })
    return () => {
      cancelled = true
    }
  }, [mode, helmInfo])

  const loadReleases = useCallback(() => {
    if (!scopeReady || !helmInfo?.installed) return
    let cancelled = false
    setHelmLoading(true)
    setHelmError('')
    helmListReleases(hostRef.current, context, namespace)
      .then((rows) => {
        if (!cancelled) setReleases(rows)
      })
      .catch((e) => {
        if (!cancelled) {
          setHelmError(String(e))
          setReleases([])
        }
      })
      .finally(() => {
        if (!cancelled) setHelmLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [context, namespace, helmInfo, scopeReady])

  useEffect(() => loadReleases(), [loadReleases, refreshSignal])

  const showValues = useCallback(
    async (rel: HelmRelease) => {
      const title = `${rel.name} — ${t('k8sHelmValues')}`
      setHelmText({ title, text: '', error: '', loading: true })
      try {
        const text = await helmReleaseValues(
          hostRef.current,
          context || null,
          rel.namespace,
          rel.name,
          false,
        )
        setHelmText((prev) => (prev ? { ...prev, text, loading: false } : prev))
      } catch (e) {
        setHelmText((prev) => (prev ? { ...prev, error: String(e), loading: false } : prev))
      }
    },
    [context, t],
  )

  const showHistory = useCallback(
    async (rel: HelmRelease) => {
      setHistory({ release: rel.name, rows: [], error: '', loading: true })
      try {
        const rows = await helmReleaseHistory(
          hostRef.current,
          context || null,
          rel.namespace,
          rel.name,
        )
        setHistory((prev) => (prev ? { ...prev, rows, loading: false } : prev))
      } catch (e) {
        setHistory((prev) => (prev ? { ...prev, error: String(e), loading: false } : prev))
      }
    },
    [context],
  )

  const doRollback = useCallback(
    async (rel: HelmRelease, revision: number) => {
      try {
        await helmRollback(hostRef.current, context || null, rel.namespace, rel.name, revision)
        setHistory(null)
        setNotice(t('k8sHelmRolledBack', { name: rel.name, revision }))
        setLocalRefresh((k) => k + 1)
      } catch (e) {
        setHistory((prev) => (prev ? { ...prev, error: String(e) } : prev))
      }
    },
    [context, t],
  )

  const doUninstall = useCallback(async () => {
    if (!confirmUninstall) return
    const rel = confirmUninstall
    try {
      await helmUninstall(hostRef.current, context || null, rel.namespace, rel.name)
      setConfirmUninstall(null)
      setNotice(t('k8sHelmUninstalled', { name: rel.name }))
      setLocalRefresh((k) => k + 1)
    } catch (e) {
      setConfirmUninstall(null)
      setHelmError(String(e))
    }
  }, [confirmUninstall, context, t])

  const doInstall = useCallback(async () => {
    const release = installRelease.trim()
    const chart = installChart.trim()
    if (!release) {
      setInstallError(t('k8sHelmNeedRelease'))
      return
    }
    if (!chart) {
      setInstallError(t('k8sHelmNeedChart'))
      return
    }
    if (namespace === ALL_NAMESPACES) {
      // `helm upgrade --install` has to be told where to put the release.
      setInstallError(t('k8sHelmNeedNamespace'))
      return
    }
    setInstallBusy(true)
    setInstallError('')
    try {
      await helmUpgradeInstall(hostRef.current, context || null, namespace, {
        release,
        chart,
        version: installVersion.trim() || null,
        values: installValues.trim() || null,
        wait: installWait,
        createNamespace: installCreateNs,
      })
      setInstallOpen(false)
      setNotice(t('k8sHelmInstalled', { name: release, chart }))
      setLocalRefresh((k) => k + 1)
    } catch (e) {
      setInstallError(String(e))
    } finally {
      setInstallBusy(false)
    }
  }, [
    installRelease,
    installChart,
    installVersion,
    installValues,
    installWait,
    installCreateNs,
    context,
    namespace,
    t,
  ])

  // Context menu dismissal + viewport clamping (the Docker panel's pattern).
  useEffect(() => {
    const close = () => {
      setMenu(null)
      setHelmMenu(null)
    }
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
  // so this covers the K8s-owned ones.
  useEffect(() => {
    const open =
      logs ||
      yaml ||
      applyOpen ||
      scaleTarget ||
      forwardDialog ||
      helmText ||
      history ||
      installOpen
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setLogs(null)
      setYaml(null)
      setApplyOpen(false)
      setScaleTarget(null)
      setForwardDialog(null)
      setHelmText(null)
      setHistory(null)
      setInstallOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [logs, yaml, applyOpen, scaleTarget, forwardDialog, helmText, history, installOpen])

  // The namespace a row actually lives in — all-namespaces mode lists several.
  const rowNamespace = useCallback(
    (row: K8sResource, fallback: string) =>
      row.namespace || (fallback === ALL_NAMESPACES ? '' : fallback),
    [],
  )

  const openLogs = useCallback(
    (row: K8sResource) => {
      if (!context) return
      stickRef.current = true
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
        ended: false,
      })
      setCopied(false)
    },
    [context, namespace, rowNamespace],
  )

  // ---- follow mode: a live `kubectl logs -f` drained by a poll ----
  //
  // The recursive `setTimeout` (not `setInterval`) is what keeps the order straight:
  // a slow `poll_k8s_logs` cannot overlap the next one and append chunks out of turn.
  const appendLogs = useCallback((text: string) => {
    setLogs((prev) =>
      prev ? { ...prev, text: trimToChars(prev.text + text), loading: false } : prev,
    )
  }, [])

  const stopLogStream = useCallback(async () => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current)
      pollTimerRef.current = null
    }
    const sid = streamIdRef.current
    streamIdRef.current = null
    if (sid) {
      await stopK8sLogsStream(sid).catch(() => {
        /* already gone */
      })
    }
  }, [])

  const startLogStream = useCallback(
    async (scope: {
      context: string
      namespace: string
      pod: string
      container: string
      tail: number
    }) => {
      await stopLogStream()
      try {
        const sid = await k8sLogsStreamStart(
          hostRef.current,
          scope.context,
          scope.namespace,
          scope.pod,
          scope.container || null,
          scope.tail,
        )
        streamIdRef.current = sid
        const tick = async () => {
          // The stream was closed or replaced while this tick was queued.
          if (streamIdRef.current !== sid) return
          try {
            const poll = await pollK8sLogs(sid)
            if (streamIdRef.current !== sid) return
            if (poll.chunks.length > 0) appendLogs(poll.chunks.join(''))
            else setLogs((prev) => (prev ? { ...prev, loading: false } : prev))
            if (poll.ended) {
              streamIdRef.current = null
              setLogs((prev) => (prev ? { ...prev, ended: true, loading: false } : prev))
              // The buffer is drained; releasing it keeps the registry from holding
              // a dead stream until the viewer happens to close.
              await stopK8sLogsStream(sid).catch(() => {})
              return
            }
          } catch {
            // A failed poll is not worth losing the follow for; the next tick retries.
          }
          if (streamIdRef.current === sid) {
            pollTimerRef.current = setTimeout(tick, 500)
          }
        }
        pollTimerRef.current = setTimeout(tick, 500)
      } catch (e) {
        setLogs((prev) => (prev ? { ...prev, error: String(e), loading: false } : prev))
      }
    },
    [appendLogs, stopLogStream],
  )

  // One string names everything the viewer can be asked about, so switching pod,
  // container, tail length or follow mode restarts the read from a clean buffer.
  const logScope = logs
    ? `${logs.context}|${logs.namespace}|${logs.row.name}|${logs.container}|${logs.tail}|${logs.follow}`
    : ''
  useEffect(() => {
    const current = logsRef.current
    if (!current) return
    setLogs((prev) => (prev ? { ...prev, text: '', error: '', ended: false, loading: true } : prev))
    if (current.follow) {
      void startLogStream({
        context: current.context,
        namespace: current.namespace,
        pod: current.row.name,
        container: current.container,
        tail: current.tail,
      })
    } else {
      k8sPodLogs(
        hostRef.current,
        current.context,
        current.namespace,
        current.row.name,
        current.container || null,
        current.tail,
      )
        .then((text) =>
          setLogs((prev) => (prev ? { ...prev, text, loading: false, error: '' } : prev)),
        )
        .catch((e) =>
          setLogs((prev) => (prev ? { ...prev, error: String(e), loading: false } : prev)),
        )
    }
    return () => {
      void stopLogStream()
    }
    // `logScope` is the whole input; the callbacks read it through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logScope])

  // Keep the newest lines in view, but only while the user has not scrolled back to
  // read something — a viewer that yanks you forward is a viewer you turn off.
  useEffect(() => {
    if (!logRef.current || !stickRef.current) return
    logRef.current.scrollTop = logRef.current.scrollHeight
  }, [logs?.text])

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
      setForwardSave(true)
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
      if (forwardSave) {
        // Saved after the forward actually started: a rule that cannot work is
        // clutter, and the start is where the port conflict would have shown up.
        const rule: K8sForwardRule = {
          id: crypto.randomUUID(),
          hostKind: hostRef.current.kind,
          connectionId: hostRef.current.kind === 'ssh' ? (connectionId ?? null) : null,
          connectionName: hostRef.current.kind === 'ssh' ? (connectionName ?? null) : null,
          context: forwardDialog.context || null,
          namespace: forwardDialog.namespace,
          target: forwardDialog.target,
          localPort: local,
          remotePort: remote,
          allInterfaces: forwardLan,
        }
        try {
          setRules(await k8sSaveForwardRule(rule))
        } catch (e) {
          // The forward is up; only the remembering failed.
          setError(String(e))
        }
      }
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
  }, [
    forwardDialog,
    forwardLocal,
    forwardRemote,
    forwardLan,
    forwardSave,
    connectionId,
    connectionName,
    refreshForwards,
    t,
  ])

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

  useEffect(() => {
    k8sListForwardRules()
      .then(setRules)
      .catch(() => setRules([]))
  }, [])

  // What identifies a forward across the running list and the saved rules. The port
  // number rather than `listenAddr`, so a rule saved with 0.0.0.0 still matches.
  const forwardKey = (o: {
    namespace: string
    target: string
    localPort: number
    remotePort: string
  }) => `${o.namespace}|${o.target}|${o.localPort}|${o.remotePort}`

  const startForwardRule = useCallback(
    async (rule: K8sForwardRule) => {
      const host = resolveRuleHost?.(rule)
      if (!host) {
        setNotice(
          t('k8sForwardNeedsSession', { name: rule.connectionName ?? rule.connectionId ?? '' }),
        )
        return
      }
      try {
        await k8sPortForwardStart(
          host,
          rule.context ?? null,
          rule.namespace,
          rule.target,
          rule.localPort,
          rule.remotePort,
          rule.allInterfaces,
        )
        setNotice(t('k8sForwardStarted', { addr: `:${rule.localPort}`, target: rule.target }))
        await refreshForwards()
      } catch (e) {
        setError(String(e))
      }
    },
    [refreshForwards, resolveRuleHost, t],
  )

  const removeForwardRule = useCallback(async (id: string) => {
    try {
      setRules(await k8sDeleteForwardRule(id))
    } catch (e) {
      setError(String(e))
    }
  }, [])

  const q = filter.toLowerCase()
  const visible = resources.filter(
    (r) =>
      !q ||
      r.name.toLowerCase().includes(q) ||
      r.detail.toLowerCase().includes(q) ||
      r.status.toLowerCase().includes(q),
  )
  // The same filter box narrows the release list, by chart and status as well as name.
  const visibleReleases = releases.filter(
    (r) =>
      !q ||
      r.name.toLowerCase().includes(q) ||
      r.chart.toLowerCase().includes(q) ||
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
          {context
            ? `${mode === 'helm' ? visibleReleases.length : visible.length} · ${context}`
            : mode === 'helm'
              ? visibleReleases.length
              : visible.length}
        </span>
        {mode === 'helm' ? (
          <button
            type="button"
            className="icon-btn"
            title={t('k8sHelmInstall')}
            aria-label={t('k8sHelmInstall')}
            onClick={() => {
              setInstallError('')
              setInstallOpen(true)
            }}
            disabled={!scopeReady || !helmInfo?.installed}
          >
            <Icon name="plus" size={13} />
          </button>
        ) : (
          <button
            type="button"
            className="icon-btn"
            title={t('k8sApply')}
            aria-label={t('k8sApply')}
            onClick={() => {
              setApplyError('')
              setApplyOpen(true)
            }}
            disabled={!scopeReady}
          >
            <Icon name="edit" size={13} />
          </button>
        )}
        <button
          type="button"
          className="icon-btn"
          title={t('refresh')}
          aria-label={t('refresh')}
          onClick={() => setLocalRefresh((k) => k + 1)}
          disabled={loading || helmLoading}
        >
          <Icon name="refresh" size={13} />
        </button>
      </div>

      {/* Two lists, one scope: the context and namespace pickers below apply to
          whichever of these is showing. */}
      <div className="k8s-modes" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'resources'}
          className={`k8s-mode${mode === 'resources' ? ' active' : ''}`}
          onClick={() => onScopeChange({ mode: 'resources' })}
        >
          {t('k8sModeResources')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'helm'}
          className={`k8s-mode${mode === 'helm' ? ' active' : ''}`}
          onClick={() => onScopeChange({ mode: 'helm' })}
        >
          {t('k8sModeHelm')}
        </button>
      </div>

      <div className="k8s-filters">
        <label className="k8s-field k8s-field-wide">
          <span>{t('k8sContext')}</span>
          <select
            className="k8s-select"
            value={contextReady ? context : ''}
            onChange={(e) => onScopeChange({ context: e.target.value, namespace: '' })}
            disabled={contextsHost !== hostKey || contexts.length === 0}
            aria-label={t('k8sContext')}
          >
            {!contextReady && <option value="">—</option>}
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
            value={scopeReady ? namespace : ''}
            onChange={(e) => onScopeChange({ namespace: e.target.value })}
            disabled={!namespaceListReady}
            aria-label={t('k8sNamespace')}
          >
            {!scopeReady && <option value="">—</option>}
            <option value={ALL_NAMESPACES}>{t('k8sAllNamespaces')}</option>
            {namespaces.map((n) => (
              <option key={n.name} value={n.name}>
                {n.name}
              </option>
            ))}
          </select>
        </label>
        {mode === 'resources' && (
          <label className="k8s-field">
            <span>{t('k8sResourceKind')}</span>
            <select
              className="k8s-select"
              value={kind}
              onChange={(e) => onScopeChange({ kind: e.target.value })}
              aria-label={t('k8sResourceKind')}
            >
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(KIND_LABEL[k])}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {notice && <div className="k8s-notice">{notice}</div>}

      <div className="k8s-list">
        {mode === 'resources' && (
          <>
            {error && <div className="file-error">{error}</div>}
            {loading && <div className="file-empty">{t('loading')}</div>}
            {!loading && !error && contexts.length === 0 && (
              <div className="file-empty">{t('k8sNoContexts')}</div>
            )}
            {!loading && !error && scopeReady && visible.length === 0 && (
              <div className="file-empty">{t('k8sNoResources', { kind: t(KIND_LABEL[kind]) })}</div>
            )}
          </>
        )}
        {mode === 'helm' && (
          <>
            {!scopeReady && error && <div className="file-error">{error}</div>}
            {helmError && <div className="file-error">{helmError}</div>}
            {((!scopeReady && loading) || helmLoading) && (
              <div className="file-empty">{t('loading')}</div>
            )}
            {!loading && !error && contexts.length === 0 && (
              <div className="file-empty">{t('k8sNoContexts')}</div>
            )}
            {helmInfo && !helmInfo.installed && (
              <div className="file-empty" title={helmInfo.message || undefined}>
                {t('k8sNoHelm')}
              </div>
            )}
            {!helmLoading &&
              scopeReady &&
              helmInfo?.installed &&
              !helmError &&
              visibleReleases.length === 0 && (
                <div className="file-empty">{t('k8sNoReleases')}</div>
              )}
          </>
        )}
        {mode === 'resources' &&
          visible.map((r) => (
            <div
              key={`${r.namespace}/${r.name}`}
              className={`k8s-item${r.kind === 'pods' && activePod === r.name ? ' active' : ''}`}
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
        {mode === 'helm' &&
          visibleReleases.map((r) => (
            <div
              key={`${r.namespace}/${r.name}`}
              className="k8s-item"
              onClick={() => void showValues(r)}
              onContextMenu={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setHelmMenu({ x: e.clientX, y: e.clientY, rel: r })
                setMenuStyle({ left: e.clientX, top: e.clientY })
              }}
              title={`${r.name}\n${r.namespace}\n${r.status} · ${t('k8sHelmRevision')} ${r.revision}\n${r.chart}${
                r.updated ? `\n${r.updated}` : ''
              }\n\n${t('k8sHelmValuesHint')}`}
            >
              <span className="k8s-icon">
                <Icon name="package" size={14} />
              </span>
              <div className="k8s-info">
                <div className="k8s-name">
                  {r.name}
                  {r.namespace && namespace === ALL_NAMESPACES && (
                    <span className="k8s-ns">{r.namespace}</span>
                  )}
                </div>
                <div className="k8s-detail">
                  {r.chart}
                  {r.appVersion ? ` · ${r.appVersion}` : ''}
                </div>
              </div>
              <div className="k8s-chips">
                <span className={`k8s-chip ${statusTone(r.status)}`}>{r.status}</span>
                <span className="k8s-chip muted">r{r.revision}</span>
              </div>
            </div>
          ))}
      </div>

      {/* Port forwards outlive this panel (and the resource list it was started from),
          so they get their own strip: address → target, with the row that stopped on
          its own kept until dismissed. Saved rules with no live forward sit under the
          running ones, ready to start again. */}
      {(() => {
        const running = new Set(forwards.map((f) => forwardKey(f)))
        const idle = rules.filter((r) => !running.has(forwardKey(r)))
        if (forwards.length === 0 && idle.length === 0) return null
        return (
          <div className="k8s-forwards">
            <div className="k8s-forwards-head">
              <span>{t('k8sForwards')}</span>
              <span className="cnt">{forwards.length + idle.length}</span>
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
            {idle.map((r) => {
              const canStart = resolveRuleHost ? resolveRuleHost(r) != null : true
              const hint = t('k8sForwardNeedsSession', {
                name: r.connectionName ?? r.connectionId ?? '',
              })
              return (
                <div key={r.id} className="k8s-forward saved" title={canStart ? r.target : hint}>
                  <span className="k8s-dot idle" />
                  <span className="k8s-forward-addr">
                    {r.allInterfaces ? '0.0.0.0' : '127.0.0.1'}:{r.localPort}
                  </span>
                  <span className="k8s-forward-arrow">→</span>
                  <span className="k8s-forward-target">
                    {r.target}:{r.remotePort}
                  </span>
                  <button
                    type="button"
                    className="icon-btn"
                    title={canStart ? t('k8sForwardStartNow') : hint}
                    aria-label={t('k8sForwardStartNow')}
                    disabled={!canStart}
                    onClick={() => void startForwardRule(r)}
                  >
                    <Icon name="play" size={12} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    title={t('k8sForwardRemoveRule')}
                    aria-label={t('k8sForwardRemoveRule')}
                    onClick={() => void removeForwardRule(r.id)}
                  >
                    <Icon name="trash" size={12} />
                  </button>
                </div>
              )
            })}
          </div>
        )
      })()}

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
              {onBrowsePod && (
                <div
                  className="context-menu-item"
                  onClick={() => {
                    onBrowsePod({
                      context: context || null,
                      namespace: rowNamespace(menu.row, namespace),
                      pod: menu.row.name,
                      container: menu.row.containers[0] ?? null,
                    })
                    setMenu(null)
                  }}
                >
                  <Icon name="folderOpen" size={14} />
                  {t('k8sBrowseFiles')}
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

      {/* Helm releases: values and history are reads, uninstall is not. */}
      {helmMenu && (
        <div
          ref={menuRef}
          className="context-menu"
          style={{ left: menuStyle.left, top: menuStyle.top }}
          onClick={(e) => e.stopPropagation()}
        >
          <div
            className="context-menu-item"
            onClick={() => {
              void showValues(helmMenu.rel)
              setHelmMenu(null)
            }}
          >
            <Icon name="file" size={14} />
            {t('k8sHelmValues')}
          </div>
          <div
            className="context-menu-item"
            onClick={() => {
              void showHistory(helmMenu.rel)
              setHelmMenu(null)
            }}
          >
            <Icon name="history" size={14} />
            {t('k8sHelmHistory')}
          </div>
          <div
            className="context-menu-item ctx-danger"
            onClick={() => {
              setConfirmUninstall(helmMenu.rel)
              setHelmMenu(null)
            }}
          >
            <Icon name="trash" size={14} />
            {t('k8sHelmUninstall')}
          </div>
        </div>
      )}

      {/* Logs */}
      {logs && (
        <DraggableModal className="k8s-modal" onClose={() => setLogs(null)}>
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
          <pre
            className="k8s-log-output"
            ref={logRef}
            onScroll={(e) => {
              const el = e.currentTarget
              stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
            }}
          >
            {logs.loading && !logs.text ? t('loading') : logs.text || t('k8sNoLogs')}
          </pre>
          {logs.ended && <div className="k8s-note">{t('k8sStreamEnded')}</div>}
        </DraggableModal>
      )}

      {/* YAML */}
      {yaml && (
        <DraggableModal className="k8s-modal" onClose={() => setYaml(null)}>
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
        </DraggableModal>
      )}

      {/* Apply */}
      {applyOpen && (
        <DraggableModal className="k8s-modal" onClose={() => setApplyOpen(false)}>
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
        </DraggableModal>
      )}

      {/* Scale */}
      {scaleTarget && (
        <DraggableModal onClose={() => setScaleTarget(null)}>
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
        </DraggableModal>
      )}

      {forwardDialog && (
        <DraggableModal onClose={() => setForwardDialog(null)}>
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
            <label className="k8s-inline k8s-check">
              <input
                type="checkbox"
                checked={forwardSave}
                onChange={(e) => setForwardSave(e.target.checked)}
              />
              <span>{t('k8sForwardSaveRule')}</span>
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
        </DraggableModal>
      )}

      {/* Helm values — the same read-only pre the pod YAML uses. */}
      {helmText && (
        <DraggableModal className="k8s-modal" onClose={() => setHelmText(null)}>
          <div className="modal-header">
            <h3>{helmText.title}</h3>
            <span className="k8s-modal-close" onClick={() => setHelmText(null)}>
              <Icon name="x" size={14} />
            </span>
          </div>
          {helmText.error && <div className="modal-error">{helmText.error}</div>}
          <pre className="k8s-yaml">
            {helmText.loading && !helmText.text ? t('loading') : helmText.text}
          </pre>
        </DraggableModal>
      )}

      {/* Revision history, with a rollback per row. */}
      {history && (
        <DraggableModal className="k8s-modal" onClose={() => setHistory(null)}>
          <div className="modal-header">
            <h3>{t('k8sHelmHistoryTitle', { name: history.release })}</h3>
            <span className="k8s-modal-close" onClick={() => setHistory(null)}>
              <Icon name="x" size={14} />
            </span>
          </div>
          {history.error && <div className="modal-error">{history.error}</div>}
          <div className="k8s-history">
            {history.loading && <div className="file-empty">{t('loading')}</div>}
            {!history.loading && history.rows.length === 0 && (
              <div className="file-empty">{t('k8sHelmNoHistory')}</div>
            )}
            {history.rows
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
                    disabled={rev.status === 'deployed'}
                    title={rev.updated}
                    onClick={() => {
                      const rel = releases.find((r) => r.name === history.release)
                      if (rel) void doRollback(rel, rev.revision)
                    }}
                  >
                    {t('k8sHelmRollback')}
                  </button>
                </div>
              ))}
          </div>
        </DraggableModal>
      )}

      {/* Install / upgrade: `helm upgrade --install`, so one dialog covers both. */}
      {installOpen && (
        <DraggableModal className="k8s-modal" onClose={() => setInstallOpen(false)}>
          <div className="modal-header">
            <h3>{t('k8sHelmInstallTitle')}</h3>
            <span className="k8s-modal-close" onClick={() => setInstallOpen(false)}>
              <Icon name="x" size={14} />
            </span>
          </div>
          <div className="modal-body">
            <div className="k8s-forward-fields">
              <label className="k8s-field">
                <span>{t('k8sHelmRelease')}</span>
                <input
                  className="k8s-input"
                  value={installRelease}
                  onChange={(e) => setInstallRelease(e.target.value)}
                  placeholder="web"
                  autoFocus
                />
              </label>
              <label className="k8s-field">
                <span>{t('k8sHelmVersion')}</span>
                <input
                  className="k8s-input"
                  value={installVersion}
                  onChange={(e) => setInstallVersion(e.target.value)}
                  placeholder="1.2.3"
                />
              </label>
            </div>
            <label className="k8s-field">
              <span>{t('k8sHelmChart')}</span>
              <input
                className="k8s-input"
                value={installChart}
                onChange={(e) => setInstallChart(e.target.value)}
                placeholder="bitnami/nginx or oci://host/charts/web"
              />
            </label>
            <label className="k8s-field">
              <span>{t('k8sHelmValuesFile')}</span>
              <textarea
                className="k8s-apply-input"
                value={installValues}
                onChange={(e) => setInstallValues(e.target.value)}
                placeholder={'replicas: 2\nimage:\n  tag: "1.2.3"'}
                spellCheck={false}
              />
            </label>
            <label className="k8s-inline k8s-check">
              <input
                type="checkbox"
                checked={installWait}
                onChange={(e) => setInstallWait(e.target.checked)}
              />
              <span>{t('k8sHelmWait')}</span>
            </label>
            <label className="k8s-inline k8s-check">
              <input
                type="checkbox"
                checked={installCreateNs}
                onChange={(e) => setInstallCreateNs(e.target.checked)}
              />
              <span>{t('k8sHelmCreateNamespace')}</span>
            </label>
            <div className="k8s-note">
              {t('k8sHelmInstallScope', {
                namespace: namespace === ALL_NAMESPACES ? t('k8sAllNamespaces') : namespace,
              })}
            </div>
            {installError && <div className="modal-error">{installError}</div>}
          </div>
          <div className="modal-footer">
            <button className="btn-cancel" onClick={() => setInstallOpen(false)}>
              {t('cancel')}
            </button>
            <button className="btn-primary" onClick={() => void doInstall()} disabled={installBusy}>
              {t('k8sHelmInstall')}
            </button>
          </div>
        </DraggableModal>
      )}

      {confirmUninstall && (
        <ConfirmDialog
          danger
          draggable
          title={t('k8sHelmUninstallTitle')}
          message={t('k8sHelmUninstallConfirm', {
            name: confirmUninstall.name,
            namespace: confirmUninstall.namespace,
          })}
          confirmLabel={t('k8sHelmUninstall')}
          cancelLabel={t('cancel')}
          onConfirm={() => void doUninstall()}
          onCancel={() => setConfirmUninstall(null)}
        />
      )}

      {confirmDelete && (
        <ConfirmDialog
          danger
          draggable
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

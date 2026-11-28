import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
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
  K8sTabRef,
  K8sHelmRef,
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
  k8sRestartWorkload,
  k8sStartWorkload,
  k8sStopWorkload,
  k8sStopPortForward,
  k8sSaveForwardRule,
  pollK8sLogs,
  stopK8sLogsStream,
} from '../commands'
import { namespaceColorIndex, namespaceColorMap } from '../lib/k8sNamespaceColor'
import { Icon } from './Icon'
import { ConfirmDialog } from './ConfirmDialog'
import { DraggableModal } from './DraggableModal'
import { LogViewer, type LogSource } from './LogViewer'
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

/** The "all namespaces" pseudo-selection. Shared with App's default scope. */
export const ALL_NAMESPACES = '*'

/**
 * Whether the scope pickers are folded under the summary bar. A display-only
 * preference, so it lives in localStorage beside the theme/highlight keys rather
 * than in the workspace layout — and it is app-wide, not per host: a folded
 * picker is a habit, not a property of the cluster.
 */
const SCOPE_OPEN_KEY = 'wrolp-k8s-scope-open'

function readScopeOpenPref(): boolean | null {
  try {
    const raw = localStorage.getItem(SCOPE_OPEN_KEY)
    return raw === null ? null : raw === '1'
  } catch {
    return null
  }
}

function writeScopeOpenPref(open: boolean): void {
  try {
    localStorage.setItem(SCOPE_OPEN_KEY, open ? '1' : '0')
  } catch {
    // Storage unavailable — the panel still folds for this mount.
  }
}

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
 * kubectl's phases and helm's release statuses (`deployed`, `pending-upgrade`, …).
 * Shared with the Helm history tab, which draws the same chips. */
export function statusTone(status: string): 'ok' | 'warn' | 'bad' {
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

/** Sort weight for the status chip row — problems first, so the chips a user is
 * most likely to toggle sit at the front of the wrap. Mirrors `statusTone`. */
function statusRank(status: string): number {
  const tone = statusTone(status)
  return tone === 'bad' ? 0 : tone === 'warn' ? 1 : tone === 'ok' ? 2 : 3
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
  /** Opens the pod's log view as a tab. Falls back to the in-panel dialog when absent. */
  onOpenLogs?: (target: K8sTabRef) => void
  /** Opens the resource's YAML as a tab. Falls back to the in-panel dialog when absent. */
  onOpenYaml?: (target: K8sTabRef) => void
  /** Opens a release's values as a tab. Falls back to the in-panel dialog when absent. */
  onOpenHelmValues?: (target: K8sHelmRef) => void
  /** Opens a release's revision history as a tab. Falls back to the in-panel dialog. */
  onOpenHelmHistory?: (target: K8sHelmRef) => void
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
  onOpenLogs,
  onOpenYaml,
  onOpenHelmValues,
  onOpenHelmHistory,
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
  // Status words toggled off in the chip filter. Empty = every status is shown.
  // Local to this mount: a host switch remounts the panel (keyed by host), and a
  // kind switch resets it below, so a choice can never outlive the list it came from.
  const [hiddenStatuses, setHiddenStatuses] = useState<Set<string>>(new Set())

  // The three scope pickers are a setting, not a read-out. Folded, the summary bar
  // keeps the same information on one 24px line and the list gets the ~105px back.
  // Expanded until the user folds it once: the first look at a panel has to show
  // what there is to choose before it can hide it.
  const [scopeOpen, setScopeOpen] = useState(() => readScopeOpenPref() ?? true)

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
  // Restart / stop ask first; starting a stopped object is safe and runs directly.
  const [lifecycleConfirm, setLifecycleConfirm] = useState<{
    row: K8sResource
    context: string
    action: 'restart' | 'stop'
  } | null>(null)

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
          onScopeChangeRef.current({ context: chosen.name, namespace: ALL_NAMESPACES })
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

  // Explicit context changes reset to All namespaces; unchanged restored contexts keep it.
  useEffect(() => {
    setNamespacesScope(null)
    setNamespaces([])
    setResources([])
    setReleases([])
    setHelmLoading(false)
    if (!contextReady) return
    let cancelled = false
    setLoading(true)
    setError('')
    k8sListNamespaces(hostRef.current, context)
      .then((list) => {
        if (cancelled || scopeRef.current.context !== context) return
        const saved = scopeRef.current.namespace
        // Keep a valid saved choice (including All namespaces); a stale one falls
        // back to All namespaces rather than guessing a namespace from the
        // kubeconfig — the user asked to see the whole cluster by default. An
        // empty list is a failed validation, not a default: leave the saved
        // choice untouched so it can be restored once the host answers again.
        const preferred =
          saved === ALL_NAMESPACES || list.some((n) => n.name === saved)
            ? saved
            : list.length > 0
              ? ALL_NAMESPACES
              : null
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

  // A kind or host change presents a different set of status words; clear the
  // exclusion set so the new list starts fully visible. (A host change also
  // remounts the panel, but the kind change within one host does not.)
  useEffect(() => {
    setHiddenStatuses(new Set())
  }, [kind, hostKey])

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
      if (onOpenHelmValues) {
        onOpenHelmValues({ context, namespace: rel.namespace, release: rel.name })
        return
      }
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
    [context, t, onOpenHelmValues],
  )

  const showHistory = useCallback(
    async (rel: HelmRelease) => {
      if (onOpenHelmHistory) {
        onOpenHelmHistory({ context, namespace: rel.namespace, release: rel.name })
        return
      }
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
    [context, onOpenHelmHistory],
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
      const ns = rowNamespace(row, namespace)
      if (onOpenLogs) {
        // A tab keeps the rail usable while the stream runs. The dialog below is
        // only the fallback for a panel mounted without an App host.
        onOpenLogs({
          context,
          namespace: ns,
          kind: row.kind,
          name: row.name,
          container: row.containers[0] ?? null,
          containers: row.containers,
        })
        return
      }
      setLogs({ row, context, namespace: ns, container: row.containers[0] ?? '' })
    },
    [context, namespace, rowNamespace, onOpenLogs],
  )

  // Transport for the shared log viewer: one-shot tail, live `kubectl logs -f`
  // stream, and its poll/stop. The callbacks read the host through the ref (it
  // follows the focused terminal); the memo is keyed on the opened scope.
  const logsSource = useMemo<LogSource | null>(() => {
    if (!logs) return null
    const { context: ctx, namespace: ns, row, container } = logs
    return {
      fetchTail: (tail) => k8sPodLogs(hostRef.current, ctx, ns, row.name, container || null, tail),
      startStream: (tail) =>
        k8sLogsStreamStart(hostRef.current, ctx, ns, row.name, container || null, tail),
      pollStream: async (streamId) => {
        const poll = await pollK8sLogs(streamId)
        return { chunks: poll.chunks, ended: poll.ended }
      },
      stopStream: (streamId) => stopK8sLogsStream(streamId),
    }
  }, [logs])

  const openYaml = useCallback(
    (row: K8sResource) => {
      if (!context) return
      const ns = rowNamespace(row, namespace)
      if (onOpenYaml) {
        onOpenYaml({ context, namespace: ns, kind: row.kind, name: row.name })
        return
      }
      setYaml({ row, context, namespace: ns, text: '', error: '', loading: true })
      k8sResourceYaml(hostRef.current, context, ns, row.kind, row.name)
        .then((text) => setYaml((prev) => (prev ? { ...prev, text, loading: false } : prev)))
        .catch((e) =>
          setYaml((prev) => (prev ? { ...prev, error: String(e), loading: false } : prev)),
        )
    },
    [context, namespace, rowNamespace, onOpenYaml],
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

  /** Restart / stop / start one workload (or suspend/resume a cron job). */
  const runLifecycle = useCallback(
    async (row: K8sResource, ctx: string, action: 'restart' | 'stop' | 'start') => {
      const ns = rowNamespace(row, namespace)
      try {
        if (action === 'restart') {
          await k8sRestartWorkload(hostRef.current, ctx, ns, row.kind, row.name)
        } else if (action === 'stop') {
          await k8sStopWorkload(hostRef.current, ctx, ns, row.kind, row.name)
        } else {
          await k8sStartWorkload(hostRef.current, ctx, ns, row.kind, row.name)
        }
        setLocalRefresh((k) => k + 1)
        setNotice(
          t(
            action === 'restart'
              ? 'k8sRestartDone'
              : action === 'stop'
                ? 'k8sStopDone'
                : 'k8sStartDone',
            { kind: row.kind, name: row.name },
          ),
        )
      } catch (e) {
        setError(t('k8sLifecycleFailed', { kind: row.kind, name: row.name, err: String(e) }))
      }
    },
    [namespace, rowNamespace, t],
  )

  const doLifecycle = useCallback(() => {
    if (!lifecycleConfirm) return
    const { row, context: ctx, action } = lifecycleConfirm
    setLifecycleConfirm(null)
    void runLifecycle(row, ctx, action)
  }, [lifecycleConfirm, runLifecycle])

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

  // Distinct status words in the current list, problems first. Resources only —
  // the chip row is not rendered in helm mode.
  const statusOptions = useMemo(() => {
    const seen = new Set<string>()
    for (const r of resources) {
      if (r.status) seen.add(r.status)
    }
    return [...seen].sort((a, b) => statusRank(a) - statusRank(b) || a.localeCompare(b))
  }, [resources])

  const toggleStatus = useCallback((status: string) => {
    setHiddenStatuses((prev) => {
      const next = new Set(prev)
      if (next.has(status)) next.delete(status)
      else next.add(status)
      return next
    })
  }, [])

  const toggleScope = useCallback(() => {
    setScopeOpen((prev) => {
      const next = !prev
      writeScopeOpenPref(next)
      return next
    })
  }, [])

  const q = filter.toLowerCase()
  // Status chips exclude whole statuses; the text filter then narrows what's left.
  // Both apply to the resource list only; helm keeps its text-only filter.
  const visible = resources.filter((r) => {
    if (hiddenStatuses.has(r.status)) return false
    if (!q) return true
    return (
      r.name.toLowerCase().includes(q) ||
      r.detail.toLowerCase().includes(q) ||
      (r.node ?? '').toLowerCase().includes(q) ||
      r.status.toLowerCase().includes(q)
    )
  })
  // The same filter box narrows the release list, by chart and status as well as name.
  const visibleReleases = releases.filter(
    (r) =>
      !q ||
      r.name.toLowerCase().includes(q) ||
      r.chart.toLowerCase().includes(q) ||
      r.status.toLowerCase().includes(q),
  )
  // One palette assignment for everything on screen: two rows from different
  // namespaces must never share a colour, so the hash is de-duplicated against
  // the namespaces this list actually shows.
  const nsColors = namespaceColorMap([
    ...visible.map((r) => r.namespace),
    ...visibleReleases.map((r) => r.namespace),
  ])
  const colorClassFor = (ns: string) =>
    `k8s-ns-color-${nsColors.get(ns) ?? namespaceColorIndex(ns)}`

  const menuRow = menu?.row
  const canScale =
    menuRow != null && (menuRow.kind === 'deployments' || menuRow.kind === 'statefulsets')
  // Restart rolls the controller's pods; stop/start scale a workload to zero and
  // back, or suspend/resume a cron job.
  const canRestart =
    menuRow != null &&
    (menuRow.kind === 'deployments' ||
      menuRow.kind === 'statefulsets' ||
      menuRow.kind === 'daemonsets')
  const canToggleRun =
    menuRow != null &&
    (menuRow.kind === 'deployments' ||
      menuRow.kind === 'statefulsets' ||
      menuRow.kind === 'cronjobs')
  const isStopped =
    menuRow != null && (menuRow.status === 'Stopped' || menuRow.status === 'Suspended')
  // `kubectl port-forward` only speaks to workload-ish targets; the map is the list.
  const canForward = menuRow != null && FORWARD_PREFIX[menuRow.kind] != null

  return (
    <div className={`k8s-panel${scopeOpen ? ' scope-open' : ''}`}>
      <div className="panel-head sec k8s-head">
        <span className="panel-title">{t('railK8s')}</span>
        {/* Two lists, one scope: the context and namespace pickers below apply to
            whichever of these is showing. The switch lives in the head rather than
            on a row of its own — 29px is a row of resources in a 264px rail. */}
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

      {/* The chosen scope, always on one line. The three pickers below are a
          setting, not a read-out, and folding them away hands their ~105px back to
          the list. The bar is the whole disclosure - one target, one chevron. */}
      <button
        type="button"
        className="k8s-scope-bar"
        aria-expanded={scopeOpen}
        title={t(scopeOpen ? 'k8sScopeCollapse' : 'k8sScopeExpand')}
        onClick={toggleScope}
      >
        <span className="k8s-scope-ctx">{context || '—'}</span>
        <span className="k8s-scope-sep">›</span>
        <span className="k8s-scope-ns">
          {namespace === ALL_NAMESPACES ? t('k8sAllNamespaces') : namespace || '—'}
        </span>
        <span className="k8s-scope-sep">›</span>
        <span className="k8s-scope-kind">
          {mode === 'helm' ? t('k8sModeHelm') : t(KIND_LABEL[kind])}
        </span>
        <Icon name="chevronDown" size={12} className="k8s-scope-chev" />
      </button>

      {scopeOpen && (
        <div className="k8s-filters">
          <label className="k8s-field k8s-field-wide">
            <span>{t('k8sContext')}</span>
            <select
              className="k8s-select"
              value={contextReady ? context : ''}
              onChange={(e) =>
                onScopeChange({ context: e.target.value, namespace: ALL_NAMESPACES })
              }
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
      )}

      {mode === 'resources' && statusOptions.length > 0 && (
        <div className="k8s-status-bar">
          <span className="k8s-status-label">{t('k8sStatus')}</span>
          <div className="k8s-status-chips">
            {statusOptions.map((s) => {
              const hidden = hiddenStatuses.has(s)
              return (
                <button
                  key={s}
                  type="button"
                  className={`k8s-status-chip ${statusTone(s)}${hidden ? ' off' : ''}`}
                  aria-pressed={!hidden}
                  title={
                    hidden ? t('k8sStatusShow', { status: s }) : t('k8sStatusHide', { status: s })
                  }
                  onClick={() => toggleStatus(s)}
                >
                  {s}
                </button>
              )
            })}
          </div>
        </div>
      )}

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
              <div className="file-empty">
                {resources.length > 0
                  ? t('k8sNoMatches')
                  : t('k8sNoResources', { kind: t(KIND_LABEL[kind]) })}
              </div>
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
              }${r.node ? `\n${r.node}` : ''}`}
            >
              <span className="k8s-icon">
                <Icon name="boxes" size={14} />
              </span>
              <div className="k8s-info">
                <div className="k8s-name">
                  {r.name}
                  {r.namespace && namespace === ALL_NAMESPACES && (
                    <span className={`k8s-ns ${colorClassFor(r.namespace)}`}>{r.namespace}</span>
                  )}
                </div>
                <div className="k8s-detail">{r.detail}</div>
                {r.node && <div className="k8s-node">{r.node}</div>}
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
                    <span className={`k8s-ns ${colorClassFor(r.namespace)}`}>{r.namespace}</span>
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
          {canRestart && (
            <div
              className="context-menu-item"
              onClick={() => {
                setLifecycleConfirm({ row: menu.row, context, action: 'restart' })
                setMenu(null)
              }}
            >
              <Icon name="refresh" size={14} />
              {t('k8sRestart')}
            </div>
          )}
          {canToggleRun && !isStopped && (
            <div
              className="context-menu-item"
              onClick={() => {
                setLifecycleConfirm({ row: menu.row, context, action: 'stop' })
                setMenu(null)
              }}
            >
              <Icon name="stop" size={14} />
              {t('k8sStop')}
            </div>
          )}
          {canToggleRun && isStopped && (
            <div
              className="context-menu-item"
              onClick={() => {
                void runLifecycle(menu.row, context, 'start')
                setMenu(null)
              }}
            >
              <Icon name="play" size={14} />
              {t('k8sStart')}
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
            {logs.row.containers.length > 1 && (
              <label className="k8s-inline k8s-log-container">
                <span>{t('k8sContainer')}</span>
                <select
                  className="k8s-select"
                  value={logs.container}
                  onChange={(e) =>
                    setLogs((prev) => (prev ? { ...prev, container: e.target.value } : prev))
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
            <span className="modal-close" onClick={() => setLogs(null)}>
              <Icon name="x" size={14} />
            </span>
          </div>
          {logsSource && (
            <LogViewer
              // A different pod/container is a different stream: remount so the
              // viewer starts with a clean buffer and fresh follow/toggles.
              key={`${logs.context}|${logs.namespace}|${logs.row.name}|${logs.container}`}
              source={logsSource}
              initialTail={500}
              endedLabel={t('k8sStreamEnded')}
              className="k8s-modal-log"
            />
          )}
        </DraggableModal>
      )}

      {/* YAML */}
      {yaml && (
        <DraggableModal className="k8s-modal" onClose={() => setYaml(null)}>
          <div className="modal-header">
            <h3>{t('k8sYamlTitle', { name: yaml.row.name })}</h3>
            <span className="modal-close" onClick={() => setYaml(null)}>
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
            <span className="modal-close" onClick={() => setApplyOpen(false)}>
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
            <span className="modal-close" onClick={() => setHelmText(null)}>
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
            <span className="modal-close" onClick={() => setHistory(null)}>
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
            <span className="modal-close" onClick={() => setInstallOpen(false)}>
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

      {lifecycleConfirm && (
        <ConfirmDialog
          danger={lifecycleConfirm.action === 'stop'}
          draggable
          title={t(lifecycleConfirm.action === 'restart' ? 'k8sRestart' : 'k8sStop')}
          message={t(
            lifecycleConfirm.action === 'restart' ? 'k8sRestartConfirm' : 'k8sStopConfirm',
            { kind: lifecycleConfirm.row.kind, name: lifecycleConfirm.row.name },
          )}
          confirmLabel={t(lifecycleConfirm.action === 'restart' ? 'k8sRestart' : 'k8sStop')}
          cancelLabel={t('cancel')}
          onConfirm={doLifecycle}
          onCancel={() => setLifecycleConfirm(null)}
        />
      )}
    </div>
  )
}

export default K8sPanel

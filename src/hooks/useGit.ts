import { listen } from '@tauri-apps/api/event'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  gitAbort,
  gitBranchCreate,
  gitBranchDelete,
  gitBranchSwitch,
  gitBranches,
  gitCancel,
  gitClone,
  gitCommit,
  gitConflicts,
  gitDiscard,
  gitFetch,
  gitInit,
  gitLocalIgnore,
  gitLog,
  gitProbe,
  gitPull,
  gitPush,
  gitRemoteAdd,
  gitRemoteRemove,
  gitRemotes,
  gitRepoInfo,
  gitResolve,
  gitScanRepos,
  gitStashEntry,
  gitStashList,
  gitStashPush,
  gitStage,
  gitStatus,
  gitUnstage,
} from '../commands'
import { applySettingChanges, readSetting } from '../lib/appSettings'
import { gitHostKey, rememberGitRepo } from '../lib/gitHost'
import type {
  GitBranch,
  GitCommit,
  GitCommitResult,
  GitConflicts,
  GitHostRef,
  GitNetworkResult,
  GitProbe,
  GitProgressEvent,
  GitRemote,
  GitRepoInfo,
  GitStash,
  GitStatus,
} from '../types'

/** Page sizes the history picker offers; the backend clamps at 1000. */
export const HISTORY_PAGE_SIZES = [100, 200, 500, 1000] as const
export type HistoryPageSize = (typeof HISTORY_PAGE_SIZES)[number]
const DEFAULT_HISTORY_PAGE: HistoryPageSize = 100
const HISTORY_PAGE_KEY = 'wrolp.git.historyPage'
/** "Load all" already loops, so each request asks for the backend's maximum. */
const HISTORY_LOAD_ALL_PAGE = 1000

function readHistoryPageSize(): HistoryPageSize {
  try {
    const n = Number(localStorage.getItem(HISTORY_PAGE_KEY))
    if ((HISTORY_PAGE_SIZES as readonly number[]).includes(n)) return n as HistoryPageSize
  } catch {
    // Unavailable storage falls through to the default.
  }
  return DEFAULT_HISTORY_PAGE
}

export type GitNetworkKind = 'fetch' | 'pull' | 'push' | 'clone'

/** The user-configured local executable, or `null` when auto-detection is on. */
function readLocalBin(): string | null {
  const value = readSetting('git.localBin')?.value
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/**
 * One Git mode's data and actions. Repository discovery, status refresh and
 * every write live here; the panel only renders and calls back, so a host or
 * root change resets cleanly instead of leaving stale rows behind.
 *
 * `suggestedPath` is the focused terminal's cwd: it is tried once per value and
 * a non-repository is *not* an error (the user may simply be in a parent folder).
 */
export function useGit(host: GitHostRef, suggestedPath: string | null) {
  const hostKey = gitHostKey(host)
  const [probe, setProbe] = useState<GitProbe | null>(null)
  const [probing, setProbing] = useState(false)
  /** Configured local `git` executable; changing it re-runs the probe. */
  const [localBin, setLocalBin] = useState<string | null>(readLocalBin)
  const [repo, setRepo] = useState<GitRepoInfo | null>(null)
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [branches, setBranches] = useState<GitBranch[]>([])
  const [remotes, setRemotes] = useState<GitRemote[]>([])
  const [conflicts, setConflicts] = useState<GitConflicts | null>(null)
  const [stashes, setStashes] = useState<GitStash[]>([])
  const [commits, setCommits] = useState<GitCommit[]>([])
  const [hasMoreLog, setHasMoreLog] = useState(false)
  const [historyPageSize, setHistoryPageSizeState] = useState<HistoryPageSize>(readHistoryPageSize)
  /** Which history expansion is running, if any (both buttons disable). */
  const [historyAction, setHistoryAction] = useState<'more' | 'all' | 'page' | null>(null)
  const [loading, setLoading] = useState(false)
  /** Repository discovery failures (not a repo, bare, no path). */
  const [error, setError] = useState<string | null>(null)
  /** Results of the last folder scan, or `null` when none has run. */
  const [scanResults, setScanResults] = useState<string[] | null>(null)
  const [scanning, setScanning] = useState(false)
  /** The last write / network failure, shown as a dismissible banner. */
  const [actionError, setActionError] = useState<string | null>(null)
  const [lastCommit, setLastCommit] = useState<GitCommitResult | null>(null)
  const [networkKind, setNetworkKind] = useState<GitNetworkKind | null>(null)
  const [progress, setProgress] = useState<GitProgressEvent | null>(null)
  const [networkResult, setNetworkResult] = useState<GitNetworkResult | null>(null)

  const opRef = useRef<string | null>(null)
  const autoTriedRef = useRef<string | null>(null)
  const probeSeqRef = useRef(0)
  /** Cancels an in-flight load-more/load-all once the log is reloaded or reset. */
  const historySeqRef = useRef(0)

  // Host changes wipe every host-specific row before the new probe lands.
  useEffect(() => {
    historySeqRef.current++
    setProbe(null)
    setRepo(null)
    setStatus(null)
    setBranches([])
    setRemotes([])
    setConflicts(null)
    setStashes([])
    setCommits([])
    setHasMoreLog(false)
    setHistoryAction(null)
    setLoading(false)
    setError(null)
    setActionError(null)
    setScanResults(null)
    setLastCommit(null)
    setNetworkResult(null)
    setProgress(null)
    setNetworkKind(null)
    opRef.current = null
    autoTriedRef.current = null
  }, [hostKey])

  const reprobe = useCallback(async () => {
    const seq = ++probeSeqRef.current
    setProbing(true)
    try {
      const p = await gitProbe(host, localBin)
      if (seq === probeSeqRef.current) setProbe(p)
    } catch (e: unknown) {
      if (seq === probeSeqRef.current) {
        setProbe({
          installed: false,
          version: null,
          bin: null,
          message: String(e),
        })
      }
    } finally {
      if (seq === probeSeqRef.current) setProbing(false)
    }
  }, [host, localBin])

  useEffect(() => {
    void reprobe()
  }, [reprobe])

  /** Persist the local executable path; the probe effect re-runs on the change. */
  const configureLocalBin = useCallback((bin: string) => {
    const value = bin.trim()
    try {
      applySettingChanges({ 'git.localBin': value }, 'user')
    } catch (e: unknown) {
      setActionError(String(e))
      return false
    }
    setLocalBin(value || null)
    return true
  }, [])

  // Progress events are broadcast for every operation; only the one this hook
  // started is kept, so a late event from a previous op cannot paint.
  useEffect(() => {
    let unlisten: (() => void) | undefined
    let cancelled = false
    void listen<GitProgressEvent>('git-progress', (event) => {
      if (event.payload.opId !== opRef.current) return
      setProgress(event.payload)
    }).then((fn) => {
      if (cancelled) fn()
      else unlisten = fn
    })
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])

  const loadAll = useCallback(
    async (root: string) => {
      const seq = ++historySeqRef.current
      setHistoryAction(null)
      setLoading(true)
      try {
        const [st, br, rm, lg, cf, sts] = await Promise.all([
          gitStatus(host, root),
          gitBranches(host, root),
          gitRemotes(host, root),
          gitLog(host, root, historyPageSize, 0),
          gitConflicts(host, root),
          gitStashList(host, root),
        ])
        if (historySeqRef.current !== seq) return
        setStatus(st)
        setBranches(br)
        setRemotes(rm)
        setCommits(lg.commits)
        setHasMoreLog(lg.hasMore)
        setConflicts(cf)
        setStashes(sts)
      } catch (e: unknown) {
        if (historySeqRef.current === seq) setActionError(String(e))
      } finally {
        if (historySeqRef.current === seq) setLoading(false)
      }
    },
    [host, historyPageSize],
  )

  /** Open a folder as a repository. `quiet` is used by the auto-try from the cwd. */
  const open = useCallback(
    async (path: string, quiet = false) => {
      const trimmed = path.trim()
      if (!trimmed) return
      setLoading(true)
      setError(null)
      if (!quiet) {
        setActionError(null)
        setLastCommit(null)
      }
      try {
        const info = await gitRepoInfo(host, trimmed)
        setRepo(info)
        rememberGitRepo(hostKey, info.root)
        if (info.bare) {
          setStatus(null)
          setBranches([])
          setRemotes([])
          setConflicts(null)
          setStashes([])
          setCommits([])
          setHasMoreLog(false)
        } else {
          await loadAll(info.root)
        }
      } catch (e: unknown) {
        setRepo(null)
        setStatus(null)
        // An auto-try from a terminal cwd must stay silent: "not a repo" is the
        // normal case when the user is in a parent folder.
        setError(quiet ? null : String(e))
      } finally {
        setLoading(false)
      }
    },
    [host, hostKey, loadAll],
  )

  /** Bounded folder scan; a hit is opened by the panel, not here. */
  const scan = useCallback(
    async (path: string, depth = 2) => {
      const trimmed = path.trim()
      if (!trimmed || scanning) return false
      setScanning(true)
      setScanResults(null)
      setActionError(null)
      try {
        setScanResults(await gitScanRepos(host, trimmed, depth))
        return true
      } catch (e: unknown) {
        setActionError(String(e))
        return false
      } finally {
        setScanning(false)
      }
    },
    [host, scanning],
  )

  const clearScan = useCallback(() => setScanResults(null), [])

  /**
   * Go back to the picker. The recent list is what makes another repository
   * reachable without an app restart; every host-scoped row is dropped so a
   * stale status cannot be rendered against the next repository.
   */
  const closeRepo = useCallback(() => {
    historySeqRef.current++
    setHistoryAction(null)
    setLoading(false)
    setRepo(null)
    setStatus(null)
    setBranches([])
    setRemotes([])
    setConflicts(null)
    setStashes([])
    setCommits([])
    setHasMoreLog(false)
    setError(null)
    setActionError(null)
    setLastCommit(null)
    setNetworkResult(null)
    setScanResults(null)
  }, [])

  const init = useCallback(
    async (path: string) => {
      const trimmed = path.trim()
      if (!trimmed) return
      setLoading(true)
      setError(null)
      setActionError(null)
      try {
        const info = await gitInit(host, trimmed)
        setRepo(info)
        rememberGitRepo(hostKey, info.root)
        await loadAll(info.root)
      } catch (e: unknown) {
        setError(String(e))
      } finally {
        setLoading(false)
      }
    },
    [host, hostKey, loadAll],
  )

  // Auto-open the focused terminal's cwd exactly once per value.
  useEffect(() => {
    if (!probe?.installed || repo || probing) return
    const path = suggestedPath?.trim()
    if (!path) return
    if (autoTriedRef.current === path) return
    autoTriedRef.current = path
    void open(path, true)
  }, [open, probe, probing, repo, suggestedPath])

  const refresh = useCallback(async () => {
    if (!repo || repo.bare) return
    await loadAll(repo.root)
  }, [loadAll, repo])

  const runStatusAction = useCallback(
    async (action: (root: string) => Promise<GitStatus>) => {
      if (!repo || repo.bare) return false
      setActionError(null)
      try {
        setStatus(await action(repo.root))
        return true
      } catch (e: unknown) {
        setActionError(String(e))
        return false
      }
    },
    [repo],
  )

  const stage = useCallback(
    (paths: string[]) => runStatusAction((root) => gitStage(host, root, paths)),
    [host, runStatusAction],
  )

  const unstage = useCallback(
    (paths: string[]) => runStatusAction((root) => gitUnstage(host, root, paths)),
    [host, runStatusAction],
  )

  const discard = useCallback(
    (paths: string[]) => runStatusAction((root) => gitDiscard(host, root, paths)),
    [host, runStatusAction],
  )

  /** Local ignore: the paths leave Untracked without touching `.gitignore`. */
  const ignoreLocally = useCallback(
    async (paths: string[]) => {
      if (!repo || repo.bare || paths.length === 0) return false
      setActionError(null)
      try {
        await gitLocalIgnore(host, repo.root, paths)
        await refresh()
        return true
      } catch (e: unknown) {
        setActionError(String(e))
        return false
      }
    },
    [host, refresh, repo],
  )

  const commit = useCallback(
    async (message: string, amend: boolean) => {
      if (!repo || repo.bare) return false
      setActionError(null)
      setLastCommit(null)
      try {
        const result = await gitCommit(host, repo.root, message, amend)
        setLastCommit(result)
        await loadAll(repo.root)
        return true
      } catch (e: unknown) {
        setActionError(String(e))
        return false
      }
    },
    [host, loadAll, repo],
  )

  const createBranch = useCallback(
    async (name: string, startPoint: string | null, checkout: boolean) => {
      if (!repo || repo.bare) return false
      setActionError(null)
      try {
        setStatus(await gitBranchCreate(host, repo.root, name, startPoint, checkout))
        await refresh()
        return true
      } catch (e: unknown) {
        setActionError(String(e))
        return false
      }
    },
    [host, refresh, repo],
  )

  /** Switching to a remote branch creates a local tracking branch first. */
  const switchBranch = useCallback(
    async (branch: GitBranch) => {
      if (!repo || repo.bare) return false
      setActionError(null)
      try {
        if (branch.remote) {
          const localName = branch.name.split('/').slice(1).join('/')
          setStatus(await gitBranchCreate(host, repo.root, localName, branch.name, true))
        } else {
          setStatus(await gitBranchSwitch(host, repo.root, branch.name))
        }
        await refresh()
        return true
      } catch (e: unknown) {
        setActionError(String(e))
        return false
      }
    },
    [host, refresh, repo],
  )

  const deleteBranch = useCallback(
    async (name: string, force: boolean) => {
      if (!repo || repo.bare) return false
      setActionError(null)
      try {
        setBranches(await gitBranchDelete(host, repo.root, name, force))
        await refresh()
        return true
      } catch (e: unknown) {
        setActionError(String(e))
        return false
      }
    },
    [host, refresh, repo],
  )

  const abortOperation = useCallback(
    async (operation: 'merge' | 'rebase' | 'cherry-pick' | 'revert') => {
      const ok = await runStatusAction((root) => gitAbort(host, root, operation))
      if (ok) await refresh()
      return ok
    },
    [host, refresh, runStatusAction],
  )

  const resolveConflict = useCallback(
    (path: string, resolution: 'ours' | 'theirs' | 'resolved') =>
      runStatusAction((root) => gitResolve(host, root, path, resolution)),
    [host, runStatusAction],
  )

  const addRemote = useCallback(
    async (name: string, url: string) => {
      if (!repo || repo.bare) return false
      setActionError(null)
      try {
        setRemotes(await gitRemoteAdd(host, repo.root, name, url))
        return true
      } catch (e: unknown) {
        setActionError(String(e))
        return false
      }
    },
    [host, repo],
  )

  const removeRemote = useCallback(
    async (name: string) => {
      if (!repo || repo.bare) return false
      setActionError(null)
      try {
        setRemotes(await gitRemoteRemove(host, repo.root, name))
        return true
      } catch (e: unknown) {
        setActionError(String(e))
        return false
      }
    },
    [host, repo],
  )

  /** `git stash push`: the working tree empties, so status is refreshed too. */
  const pushStash = useCallback(
    async (message: string | null, includeUntracked: boolean) => {
      if (!repo || repo.bare) return false
      setActionError(null)
      try {
        setStashes(await gitStashPush(host, repo.root, message, includeUntracked))
        await refresh()
        return true
      } catch (e: unknown) {
        setActionError(String(e))
        return false
      }
    },
    [host, refresh, repo],
  )

  /** `pop` / `apply` change the worktree; `drop` does not. Refresh either way. */
  const stashAction = useCallback(
    async (index: number, action: 'pop' | 'apply' | 'drop') => {
      if (!repo || repo.bare) return false
      setActionError(null)
      try {
        setStashes(await gitStashEntry(host, repo.root, index, action))
        if (action !== 'drop') await refresh()
        return true
      } catch (e: unknown) {
        setActionError(String(e))
        return false
      }
    },
    [host, refresh, repo],
  )

  /**
   * Clone into `dest`, sharing the network progress UI, then open the result.
   * Runs outside any repository root.
   */
  const clone = useCallback(
    async (url: string, dest: string) => {
      if (!url.trim() || !dest.trim() || networkKind) return false
      const opId = `git-clone-${Date.now()}`
      opRef.current = opId
      setNetworkKind('clone')
      setNetworkResult(null)
      setActionError(null)
      setProgress({ opId, phase: 'remote', received: 0, total: 0, percent: null, text: '' })
      try {
        const info = await gitClone(host, url.trim(), dest.trim(), opId)
        setRepo(info)
        rememberGitRepo(hostKey, info.root)
        await loadAll(info.root)
        return true
      } catch (e: unknown) {
        setActionError(String(e))
        return false
      } finally {
        opRef.current = null
        setNetworkKind(null)
        setProgress(null)
      }
    },
    [host, hostKey, loadAll, networkKind],
  )

  /** Persist the page size and reload the log at the new size from the top. */
  const setHistoryPageSize = useCallback(
    (size: number) => {
      const next = (HISTORY_PAGE_SIZES as readonly number[]).includes(size)
        ? (size as HistoryPageSize)
        : DEFAULT_HISTORY_PAGE
      if (next === historyPageSize) return
      try {
        localStorage.setItem(HISTORY_PAGE_KEY, String(next))
      } catch {
        // Preference only; the in-memory value still applies.
      }
      setHistoryPageSizeState(next)
      if (!repo || repo.bare) return
      const seq = ++historySeqRef.current
      setHistoryAction('page')
      setLoading(true)
      setActionError(null)
      gitLog(host, repo.root, next, 0)
        .then((page) => {
          if (historySeqRef.current !== seq) return
          setCommits(page.commits)
          setHasMoreLog(page.hasMore)
        })
        .catch((e: unknown) => {
          if (historySeqRef.current === seq) setActionError(String(e))
        })
        .finally(() => {
          if (historySeqRef.current !== seq) return
          setHistoryAction(null)
          setLoading(false)
        })
    },
    [historyPageSize, host, repo],
  )

  const loadMoreLog = useCallback(async () => {
    if (!repo || repo.bare || historyAction || loading) return
    const seq = ++historySeqRef.current
    setHistoryAction('more')
    setActionError(null)
    try {
      const page = await gitLog(host, repo.root, historyPageSize, commits.length)
      if (historySeqRef.current !== seq) return
      setCommits((prev) => [...prev, ...page.commits])
      setHasMoreLog(page.hasMore)
    } catch (e: unknown) {
      if (historySeqRef.current === seq) setActionError(String(e))
    } finally {
      if (historySeqRef.current === seq) setHistoryAction(null)
    }
  }, [commits.length, historyAction, historyPageSize, host, repo])

  /**
   * Append every remaining page. Requests are sequential (so a slow host cannot
   * reorder pages) and always use the backend maximum; rows appear as they land.
   */
  const loadAllLog = useCallback(async () => {
    if (!repo || repo.bare || historyAction || loading) return
    const seq = ++historySeqRef.current
    setHistoryAction('all')
    setActionError(null)
    let skip = commits.length
    try {
      for (;;) {
        const page = await gitLog(host, repo.root, HISTORY_LOAD_ALL_PAGE, skip)
        if (historySeqRef.current !== seq) return
        if (page.commits.length === 0) {
          setHasMoreLog(false)
          return
        }
        skip += page.commits.length
        setCommits((prev) => [...prev, ...page.commits])
        setHasMoreLog(page.hasMore)
        if (!page.hasMore) return
      }
    } catch (e: unknown) {
      if (historySeqRef.current === seq) setActionError(String(e))
    } finally {
      if (historySeqRef.current === seq) setHistoryAction(null)
    }
  }, [commits.length, historyAction, host, repo])

  /**
   * The remote a network verb talks to: the one the branch tracks (`origin` for
   * `origin/main`), falling back to the first configured remote. Picking
   * `remotes[0]` alone is wrong as soon as a repository has an `upstream`
   * remote next to `origin`.
   */
  const defaultRemote = useMemo(() => {
    const tracked = status?.upstream?.split('/')[0]
    if (tracked && remotes.some((r) => r.name === tracked)) return tracked
    return remotes[0]?.name ?? null
  }, [remotes, status?.upstream])

  /** `force` only matters for push and always means `--force-with-lease`. */
  const runNetwork = useCallback(
    async (kind: GitNetworkKind, force = false) => {
      if (!repo || repo.bare || networkKind) return
      const opId = `git-${kind}-${Date.now()}`
      opRef.current = opId
      setNetworkKind(kind)
      setNetworkResult(null)
      setActionError(null)
      setProgress({
        opId,
        phase: 'remote',
        received: 0,
        total: 0,
        percent: null,
        text: '',
      })
      const remote = defaultRemote
      const branch = status?.branch ?? null
      try {
        const result =
          kind === 'fetch'
            ? await gitFetch(host, repo.root, remote, opId)
            : kind === 'pull'
              ? await gitPull(host, repo.root, remote, branch, opId)
              : await gitPush(host, repo.root, remote, branch, force, opId)
        setNetworkResult(result)
        await loadAll(repo.root)
      } catch (e: unknown) {
        setActionError(String(e))
      } finally {
        opRef.current = null
        setNetworkKind(null)
        setProgress(null)
      }
    },
    [defaultRemote, host, loadAll, networkKind, repo, status?.branch],
  )

  const cancelNetwork = useCallback(async () => {
    const opId = opRef.current
    if (!opId) return
    try {
      await gitCancel(opId)
    } catch {
      // Cancelling a finished op is a no-op backend-side; nothing to surface.
    }
  }, [])

  const dismissActionError = useCallback(() => setActionError(null), [])

  return {
    hostKey,
    probe,
    probing,
    reprobe,
    localBin,
    configureLocalBin,
    repo,
    root: repo?.root ?? null,
    status,
    branches,
    remotes,
    conflicts,
    stashes,
    defaultRemote,
    commits,
    hasMoreLog,
    historyPageSize,
    setHistoryPageSize,
    historyAction,
    loading,
    error,
    actionError,
    scanResults,
    scanning,
    scan,
    clearScan,
    closeRepo,
    lastCommit,
    networkKind,
    progress,
    networkResult,
    open,
    init,
    refresh,
    stage,
    unstage,
    discard,
    ignoreLocally,
    commit,
    createBranch,
    switchBranch,
    deleteBranch,
    abortOperation,
    resolveConflict,
    addRemote,
    removeRemote,
    pushStash,
    stashAction,
    clone,
    loadMoreLog,
    loadAllLog,
    runNetwork,
    cancelNetwork,
    dismissActionError,
  }
}

export type UseGit = ReturnType<typeof useGit>

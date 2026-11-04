import { listen } from '@tauri-apps/api/event'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  gitAbort,
  gitBranchCreate,
  gitBranchDelete,
  gitBranchSwitch,
  gitBranches,
  gitCancel,
  gitCommit,
  gitDiscard,
  gitFetch,
  gitInit,
  gitLog,
  gitProbe,
  gitPull,
  gitPush,
  gitRemotes,
  gitRepoInfo,
  gitStage,
  gitStatus,
  gitUnstage,
} from '../commands'
import { gitHostKey, rememberGitRepo } from '../lib/gitHost'
import type {
  GitBranch,
  GitCommit,
  GitCommitResult,
  GitHostRef,
  GitNetworkResult,
  GitProbe,
  GitProgressEvent,
  GitRemote,
  GitRepoInfo,
  GitStatus,
} from '../types'

const HISTORY_PAGE = 20

export type GitNetworkKind = 'fetch' | 'pull' | 'push'

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
  const [repo, setRepo] = useState<GitRepoInfo | null>(null)
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [branches, setBranches] = useState<GitBranch[]>([])
  const [remotes, setRemotes] = useState<GitRemote[]>([])
  const [commits, setCommits] = useState<GitCommit[]>([])
  const [hasMoreLog, setHasMoreLog] = useState(false)
  const [loading, setLoading] = useState(false)
  /** Repository discovery failures (not a repo, bare, no path). */
  const [error, setError] = useState<string | null>(null)
  /** The last write / network failure, shown as a dismissible banner. */
  const [actionError, setActionError] = useState<string | null>(null)
  const [lastCommit, setLastCommit] = useState<GitCommitResult | null>(null)
  const [networkKind, setNetworkKind] = useState<GitNetworkKind | null>(null)
  const [progress, setProgress] = useState<GitProgressEvent | null>(null)
  const [networkResult, setNetworkResult] = useState<GitNetworkResult | null>(null)

  const opRef = useRef<string | null>(null)
  const autoTriedRef = useRef<string | null>(null)
  const probeSeqRef = useRef(0)

  // Host changes wipe every host-specific row before the new probe lands.
  useEffect(() => {
    setProbe(null)
    setRepo(null)
    setStatus(null)
    setBranches([])
    setRemotes([])
    setCommits([])
    setHasMoreLog(false)
    setError(null)
    setActionError(null)
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
      const p = await gitProbe(host)
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
  }, [host])

  useEffect(() => {
    void reprobe()
  }, [reprobe])

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
      setLoading(true)
      try {
        const [st, br, rm, lg] = await Promise.all([
          gitStatus(host, root),
          gitBranches(host, root),
          gitRemotes(host, root),
          gitLog(host, root, HISTORY_PAGE, 0),
        ])
        setStatus(st)
        setBranches(br)
        setRemotes(rm)
        setCommits(lg.commits)
        setHasMoreLog(lg.hasMore)
      } catch (e: unknown) {
        setActionError(String(e))
      } finally {
        setLoading(false)
      }
    },
    [host],
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
      return await runStatusAction((root) => gitAbort(host, root, operation))
    },
    [host, runStatusAction],
  )

  const loadMoreLog = useCallback(async () => {
    if (!repo || repo.bare) return
    try {
      const page = await gitLog(host, repo.root, HISTORY_PAGE, commits.length)
      setCommits((prev) => [...prev, ...page.commits])
      setHasMoreLog(page.hasMore)
    } catch (e: unknown) {
      setActionError(String(e))
    }
  }, [commits.length, host, repo])

  const runNetwork = useCallback(
    async (kind: GitNetworkKind) => {
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
      const remote = remotes[0]?.name ?? null
      const branch = status?.branch ?? null
      try {
        const result =
          kind === 'fetch'
            ? await gitFetch(host, repo.root, remote, opId)
            : kind === 'pull'
              ? await gitPull(host, repo.root, remote, branch, opId)
              : await gitPush(host, repo.root, remote, branch, opId)
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
    [host, loadAll, networkKind, remotes, repo, status],
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

  const defaultRemote = useMemo(() => remotes[0]?.name ?? null, [remotes])

  return {
    hostKey,
    probe,
    probing,
    reprobe,
    repo,
    root: repo?.root ?? null,
    status,
    branches,
    remotes,
    defaultRemote,
    commits,
    hasMoreLog,
    loading,
    error,
    actionError,
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
    commit,
    createBranch,
    switchBranch,
    deleteBranch,
    abortOperation,
    loadMoreLog,
    runNetwork,
    cancelNetwork,
    dismissActionError,
  }
}

export type UseGit = ReturnType<typeof useGit>

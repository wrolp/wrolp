import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useI18n } from '../i18n'
import type { TranslationKey } from '../i18n/en'
import { useGit } from '../hooks/useGit'
import { gitCommitFiles } from '../commands'
import {
  forgetGitRepo,
  gitErrorDetail,
  gitErrorStage,
  gitHostKey,
  loadRecentGitRepos,
} from '../lib/gitHost'
import { groupGitStatus, gitEntryKey, gitEntryLetter } from '../lib/gitStatus'
import { computeLanes, graphLaneCount } from '../lib/gitGraph'
import type { GitCommitFile, GitHostRef, GitStatusEntry } from '../types'
import { ConfirmDialog } from './ConfirmDialog'
import { GitBlameView } from './GitBlameView'
import { GitDiffView } from './GitDiffView'
import { Icon } from './Icon'

interface GitPanelProps {
  host: GitHostRef
  /** The focused terminal's cwd, tried once as the repository root. */
  suggestedPath: string | null
}

/** Backend stages the panel has a sentence for; anything else keeps its text. */
const ERROR_KEYS: Record<string, TranslationKey> = {
  git_not_repo: 'gitErrNotRepo',
  git_no_folder: 'gitErrNoFolder',
  git_index_locked: 'gitErrIndexLocked',
  git_not_fast_forward: 'gitErrNotFastForward',
  git_auth_required: 'gitErrAuthRequired',
  git_no_identity: 'gitErrNoIdentity',
  git_no_remote: 'gitErrNoRemote',
  git_no_git: 'gitErrNoGit',
  git_busy: 'gitErrBusy',
  git_timeout: 'gitErrTimeout',
  git_cancelled: 'gitErrCancelled',
}

type DiffScope = 'unstaged' | 'staged' | 'commit'

interface DiffTarget {
  path: string | null
  scope: DiffScope
  oid?: string | null
  title: string
}

function describeGitError(
  message: string,
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
): string {
  const stage = gitErrorStage(message)
  const key = ERROR_KEYS[stage]
  const head = t(key ?? 'gitErrGeneric')
  const detail = gitErrorDetail(message)
  return detail && detail !== head ? `${head} — ${detail}` : head
}

function formatWhen(ts: number): string {
  if (!ts) return ''
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'short' }).format(new Date(ts * 1000))
  } catch {
    return new Date(ts * 1000).toLocaleDateString()
  }
}

function uniquePaths(entries: GitStatusEntry[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of entries) {
    if (seen.has(entry.path)) continue
    seen.add(entry.path)
    out.push(entry.path)
  }
  return out
}

/**
 * The Git mode: one repository at a time, chosen automatically from the focused
 * terminal's cwd or by hand. Everything here is `git` CLI on the host — the panel
 * never reimplements Git; it just gives the common operations a button.
 */
export function GitPanel({ host, suggestedPath }: GitPanelProps) {
  const { t } = useI18n()
  const git = useGit(host, suggestedPath)
  const [pathInput, setPathInput] = useState(suggestedPath ?? '')
  const [recent, setRecent] = useState(() => loadRecentGitRepos(gitHostKey(host)))
  const [branchesOpen, setBranchesOpen] = useState(false)
  const [newBranch, setNewBranch] = useState('')
  const [remoteName, setRemoteName] = useState('')
  const [remoteUrl, setRemoteUrl] = useState('')
  const [message, setMessage] = useState('')
  const [amend, setAmend] = useState(false)
  const [stashUntracked, setStashUntracked] = useState(false)
  const [diffTarget, setDiffTarget] = useState<DiffTarget | null>(null)
  const [discardPaths, setDiscardPaths] = useState<string[] | null>(null)
  /** Local git executable, editable from the "git not installed" state (D5). */
  const [binInput, setBinInput] = useState(() => git.localBin ?? '')
  const [blamePath, setBlamePath] = useState<string | null>(null)
  const [forcePushOpen, setForcePushOpen] = useState(false)
  const [cloneOpen, setCloneOpen] = useState(false)
  const [cloneUrl, setCloneUrl] = useState('')
  const [cloneDest, setCloneDest] = useState('')

  const groups = useMemo(() => groupGitStatus(git.status), [git.status])
  const stagedPaths = uniquePaths(groups.staged)
  const laneRows = useMemo(
    () => computeLanes(git.commits.map((c) => ({ oid: c.oid, parents: c.parents }))),
    [git.commits],
  )
  const laneCount = useMemo(() => graphLaneCount(laneRows), [laneRows])

  /** The commit whose file list is expanded, and the files once loaded. */
  const [expandedOid, setExpandedOid] = useState<string | null>(null)
  const [commitFiles, setCommitFiles] = useState<GitCommitFile[] | null>(null)
  const [historyError, setHistoryError] = useState<string | null>(null)

  const toggleCommitFiles = (oid: string) => {
    if (expandedOid === oid) {
      setExpandedOid(null)
      setCommitFiles(null)
      return
    }
    setExpandedOid(oid)
    setCommitFiles(null)
    setHistoryError(null)
    if (!git.root) return
    void gitCommitFiles(host, git.root, oid)
      .then(setCommitFiles)
      .catch((e: unknown) => setHistoryError(String(e)))
  }

  // Suggested cwd changes (the user clicked another terminal) only pre-fill the
  // field; the hook decides whether to try it once.
  useEffect(() => {
    if (suggestedPath) setPathInput(suggestedPath)
  }, [suggestedPath])

  useEffect(() => {
    setBranchesOpen(false)
    setNewBranch('')
    setRemoteName('')
    setRemoteUrl('')
    setMessage('')
    setAmend(false)
    setStashUntracked(false)
    setBlamePath(null)
    setForcePushOpen(false)
    setDiffTarget(null)
    setDiscardPaths(null)
    setExpandedOid(null)
    setCommitFiles(null)
    setHistoryError(null)
    setPathInput(suggestedPath ?? '')
    setRecent(loadRecentGitRepos(gitHostKey(host)))
  }, [host, suggestedPath])

  // The hook remembers repositories on open; re-read so the list matches.
  useEffect(() => {
    setRecent(loadRecentGitRepos(git.hostKey))
  }, [git.hostKey, git.root])

  const busy = git.loading || git.networkKind != null
  const committed = git.lastCommit
  const inProgress = git.conflicts?.inProgress ?? null
  const dirty = groups.staged.length + groups.changes.length + groups.untracked.length > 0

  const openPath = (path: string) => {
    void git.open(path)
  }

  const renderRow = (entry: GitStatusEntry, section: string, staged: boolean) => {
    const letter = gitEntryLetter(entry, staged)
    return (
      <div
        className={`git-row git-arrow-${letter.toLowerCase()}`}
        key={gitEntryKey(entry, section)}
      >
        <button
          type="button"
          className="git-row-main"
          title={entry.path}
          disabled={entry.kind === 'untracked' || entry.kind === 'ignored'}
          onClick={() =>
            setDiffTarget({
              path: entry.path,
              scope: staged ? 'staged' : 'unstaged',
              title: `${entry.path} · ${staged ? t('gitDiffStaged') : t('gitDiffUnstaged')}`,
            })
          }
        >
          <span className="git-letter">{letter}</span>
          <span className="git-path">{entry.path}</span>
          {entry.origPath && <span className="git-orig-path">{entry.origPath}</span>}
        </button>
        <div className="git-row-actions">
          {entry.conflicted ? (
            <>
              <button
                type="button"
                className="git-mini-btn"
                title={t('gitResolveOurs')}
                onClick={() => void git.resolveConflict(entry.path, 'ours')}
              >
                {t('gitOursShort')}
              </button>
              <button
                type="button"
                className="git-mini-btn"
                title={t('gitResolveTheirs')}
                onClick={() => void git.resolveConflict(entry.path, 'theirs')}
              >
                {t('gitTheirsShort')}
              </button>
              <button
                type="button"
                className="git-mini-btn"
                title={t('gitMarkResolved')}
                onClick={() => void git.resolveConflict(entry.path, 'resolved')}
              >
                ✓
              </button>
            </>
          ) : (
            entry.kind !== 'ignored' && (
              <button
                type="button"
                className="git-mini-btn"
                title={staged ? t('gitUnstage') : t('gitStage')}
                onClick={() => void (staged ? git.unstage([entry.path]) : git.stage([entry.path]))}
              >
                {staged ? '−' : '+'}
              </button>
            )
          )}
          {entry.kind !== 'ignored' && entry.kind !== 'untracked' && (
            <button
              type="button"
              className="git-mini-btn"
              title={t('gitBlameOpen')}
              onClick={() => setBlamePath(entry.path)}
            >
              B
            </button>
          )}
          {entry.kind !== 'ignored' && !entry.conflicted && (
            <button
              type="button"
              className="git-mini-btn danger"
              title={t('gitDiscard')}
              onClick={() => setDiscardPaths([entry.path])}
            >
              <Icon name="trash" size={11} />
            </button>
          )}
        </div>
      </div>
    )
  }

  const section = (
    title: string,
    entries: GitStatusEntry[],
    staged: boolean,
    actions?: ReactNode,
  ) =>
    entries.length > 0 && (
      <section className="git-section">
        <div className="git-section-head">
          <span>
            {title} <span className="git-count">{entries.length}</span>
          </span>
          {actions && <div className="git-section-actions">{actions}</div>}
        </div>
        {entries.map((e) => renderRow(e, title, staged))}
      </section>
    )

  if (git.probing) {
    return (
      <div className="git-panel">
        <div className="git-empty">{t('gitProbeChecking')}</div>
      </div>
    )
  }

  if (git.probe && !git.probe.installed) {
    return (
      <div className="git-panel">
        <div className="git-empty">
          <Icon name="gitBranch" size={26} />
          <div className="git-empty-title">{t('gitProbeMissingTitle')}</div>
          {git.probe.message && <div className="git-empty-detail">{git.probe.message}</div>}
          {/* The executable path only applies to this machine; a remote host
              resolves `git` from its own login shell. */}
          {host.kind === 'local' && (
            <>
              <form
                className="git-path-row"
                onSubmit={(e) => {
                  e.preventDefault()
                  git.configureLocalBin(binInput)
                }}
              >
                <input
                  type="text"
                  value={binInput}
                  placeholder={t('gitBinPlaceholder')}
                  onChange={(e) => setBinInput(e.target.value)}
                />
                <button type="submit" className="btn-primary" disabled={git.probing}>
                  {t('gitBinSave')}
                </button>
              </form>
              {git.localBin && (
                <button
                  type="button"
                  className="git-link-btn"
                  onClick={() => {
                    setBinInput('')
                    git.configureLocalBin('')
                  }}
                >
                  {t('gitBinReset')}
                </button>
              )}
            </>
          )}
          <button type="button" className="git-link-btn" onClick={() => void git.reprobe()}>
            {t('gitProbeMissingRetry')}
          </button>
        </div>
      </div>
    )
  }

  if (!git.repo) {
    return (
      <div className="git-panel">
        <div className="git-empty">
          <Icon name="gitBranch" size={26} />
          <div className="git-empty-title">{t('gitNoRepo')}</div>
          <form
            className="git-path-row"
            onSubmit={(e) => {
              e.preventDefault()
              openPath(pathInput)
            }}
          >
            <input
              type="text"
              value={pathInput}
              placeholder={t('gitPathPlaceholder')}
              onChange={(e) => setPathInput(e.target.value)}
            />
            <button type="submit" className="btn-primary" disabled={busy || !pathInput.trim()}>
              {t('gitOpenRepo')}
            </button>
          </form>
          <button
            type="button"
            className="git-link-btn"
            disabled={busy || !pathInput.trim()}
            onClick={() => void git.init(pathInput)}
          >
            {t('gitInitRepo')}
          </button>
          {cloneOpen ? (
            <form
              className="git-clone-row"
              onSubmit={(e) => {
                e.preventDefault()
                void git.clone(cloneUrl, cloneDest).then((ok) => {
                  if (ok) setCloneOpen(false)
                })
              }}
            >
              <input
                type="text"
                value={cloneUrl}
                placeholder={t('gitCloneUrlPlaceholder')}
                onChange={(e) => setCloneUrl(e.target.value)}
              />
              <input
                type="text"
                value={cloneDest}
                placeholder={t('gitCloneDestPlaceholder')}
                onChange={(e) => setCloneDest(e.target.value)}
              />
              <button
                type="submit"
                className="btn-primary"
                disabled={busy || !cloneUrl.trim() || !cloneDest.trim()}
              >
                {t('gitClone')}
              </button>
            </form>
          ) : (
            <button
              type="button"
              className="git-link-btn"
              disabled={busy}
              onClick={() => {
                setCloneDest(pathInput.trim())
                setCloneOpen(true)
              }}
            >
              {t('gitCloneOpen')}
            </button>
          )}
          {git.error && <div className="git-error">{describeGitError(git.error, t)}</div>}
          {recent.length > 0 && (
            <div className="git-recent">
              <div className="git-recent-head">{t('gitRecentRepos')}</div>
              {recent.map((r) => (
                <div className="git-recent-row" key={r.root}>
                  <button
                    type="button"
                    className="git-row-main"
                    title={r.root}
                    onClick={() => openPath(r.root)}
                  >
                    <Icon name="gitBranch" size={11} />
                    <span className="git-path">{r.root}</span>
                  </button>
                  <button
                    type="button"
                    className="git-mini-btn"
                    title={t('gitRemoveRecent')}
                    onClick={() => setRecent(forgetGitRepo(git.hostKey, r.root))}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="git-panel">
      <div className="git-repo-bar">
        <div className="git-repo-root" title={git.root ?? undefined}>
          <Icon name="gitBranch" size={12} />
          <span>{git.root?.split(/[\\/]/).filter(Boolean).pop() ?? git.root}</span>
        </div>
        <button
          type="button"
          className="git-icon-btn"
          title={t('gitRefresh')}
          disabled={busy}
          onClick={() => void git.refresh()}
        >
          <Icon name="refresh" size={13} />
        </button>
      </div>

      {git.repo.bare ? (
        <div className="git-empty">
          <div className="git-empty-title">{t('gitBareRepo')}</div>
        </div>
      ) : (
        <>
          <div className="git-branch-bar">
            <button
              type="button"
              className={`git-branch-chip${branchesOpen ? ' open' : ''}`}
              onClick={() => setBranchesOpen((v) => !v)}
              title={t('gitBranchTooltip')}
            >
              <Icon name="gitBranch" size={12} />
              <span>
                {git.status?.detached
                  ? t('gitDetached')
                  : git.status?.unborn
                    ? t('gitUnborn')
                    : (git.status?.branch ?? '')}
              </span>
              {(git.status?.ahead ?? 0) > 0 && (
                <span className="git-ahead">↑{git.status?.ahead}</span>
              )}
              {(git.status?.behind ?? 0) > 0 && (
                <span className="git-behind">↓{git.status?.behind}</span>
              )}
            </button>
            <div className="git-network-actions">
              <button
                type="button"
                className="git-icon-btn"
                title={t('gitFetch')}
                disabled={busy}
                onClick={() => void git.runNetwork('fetch')}
              >
                {t('gitFetch')}
              </button>
              <button
                type="button"
                className="git-icon-btn"
                title={t('gitPullFfHint')}
                disabled={busy}
                onClick={() => void git.runNetwork('pull')}
              >
                {t('gitPull')}
              </button>
              <button
                type="button"
                className="git-icon-btn"
                title={t('gitPush')}
                disabled={busy}
                onClick={() => void git.runNetwork('push')}
              >
                {t('gitPush')}
              </button>
              <button
                type="button"
                className="git-icon-btn danger"
                title={t('gitPushForceHint')}
                disabled={busy}
                onClick={() => setForcePushOpen(true)}
              >
                ⇑
              </button>
            </div>
          </div>

          {inProgress && (
            <div className="git-conflict-banner">
              <span>{t('gitInProgress', { op: inProgress })}</span>
              <button
                type="button"
                className="git-link-btn danger"
                onClick={() => void git.abortOperation(inProgress)}
              >
                {t('gitAbortOp')}
              </button>
            </div>
          )}

          {branchesOpen && (
            <div className="git-branch-list">
              {git.branches
                .filter((b) => !b.remote)
                .map((b) => (
                  <div className={`git-branch-row${b.current ? ' current' : ''}`} key={b.fullName}>
                    <button
                      type="button"
                      className="git-row-main"
                      disabled={b.current}
                      onClick={() => {
                        setBranchesOpen(false)
                        void git.switchBranch(b)
                      }}
                    >
                      <span className="git-branch-name">{b.name}</span>
                      {b.upstream && <span className="git-branch-upstream">{b.upstream}</span>}
                    </button>
                    {!b.current && (
                      <button
                        type="button"
                        className="git-mini-btn danger"
                        title={t('gitDeleteBranch')}
                        onClick={() => void git.deleteBranch(b.name, false)}
                      >
                        <Icon name="trash" size={11} />
                      </button>
                    )}
                  </div>
                ))}
              {git.branches.some((b) => b.remote) && (
                <>
                  <div className="git-branch-group">{t('gitRemoteBranches')}</div>
                  {git.branches
                    .filter((b) => b.remote)
                    .map((b) => (
                      <div className="git-branch-row" key={b.fullName}>
                        <button
                          type="button"
                          className="git-row-main"
                          onClick={() => {
                            setBranchesOpen(false)
                            void git.switchBranch(b)
                          }}
                        >
                          <span className="git-branch-name">{b.name}</span>
                        </button>
                      </div>
                    ))}
                </>
              )}
              <form
                className="git-path-row"
                onSubmit={(e) => {
                  e.preventDefault()
                  const name = newBranch.trim()
                  if (!name) return
                  setBranchesOpen(false)
                  void git.createBranch(name, null, true)
                  setNewBranch('')
                }}
              >
                <input
                  type="text"
                  value={newBranch}
                  placeholder={t('gitNewBranchPlaceholder')}
                  onChange={(e) => setNewBranch(e.target.value)}
                />
                <button type="submit" className="git-link-btn" disabled={!newBranch.trim()}>
                  {t('gitCreateAndCheckout')}
                </button>
              </form>
              <div className="git-branch-group">{t('gitRemotesSection')}</div>
              {git.remotes.map((r) => (
                <div className="git-branch-row" key={r.name}>
                  <div className="git-row-main" title={`${r.name} · ${r.fetchUrl}`}>
                    <span className="git-branch-name">{r.name}</span>
                    <span className="git-branch-upstream">{r.fetchUrl}</span>
                  </div>
                  <button
                    type="button"
                    className="git-mini-btn danger"
                    title={t('gitRemoteRemove')}
                    onClick={() => void git.removeRemote(r.name)}
                  >
                    <Icon name="trash" size={11} />
                  </button>
                </div>
              ))}
              {git.remotes.length === 0 && <div className="git-note">{t('gitNoRemotes')}</div>}
              <form
                className="git-path-row"
                onSubmit={(e) => {
                  e.preventDefault()
                  const name = remoteName.trim()
                  const url = remoteUrl.trim()
                  if (!name || !url) return
                  void git.addRemote(name, url)
                  setRemoteName('')
                  setRemoteUrl('')
                }}
              >
                <input
                  type="text"
                  value={remoteName}
                  placeholder={t('gitRemoteNamePlaceholder')}
                  onChange={(e) => setRemoteName(e.target.value)}
                />
                <input
                  type="text"
                  value={remoteUrl}
                  placeholder={t('gitRemoteUrlPlaceholder')}
                  onChange={(e) => setRemoteUrl(e.target.value)}
                />
                <button
                  type="submit"
                  className="git-link-btn"
                  disabled={!remoteName.trim() || !remoteUrl.trim()}
                >
                  {t('gitRemoteAdd')}
                </button>
              </form>
            </div>
          )}

          {git.networkKind && (
            <div className="git-progress">
              <span className="git-progress-text">
                {git.progress?.percent != null
                  ? `${git.networkKind} ${git.progress.percent}%`
                  : git.progress?.text || git.networkKind}
              </span>
              <button
                type="button"
                className="git-link-btn"
                onClick={() => void git.cancelNetwork()}
              >
                {t('gitCancelOp')}
              </button>
            </div>
          )}

          {git.actionError && (
            <div className="git-error">
              <span>{describeGitError(git.actionError, t)}</span>
              <button type="button" className="git-error-close" onClick={git.dismissActionError}>
                ×
              </button>
            </div>
          )}
          {committed && (
            <div className="git-ok">
              {t('gitCommitSuccess', {
                oid: committed.oid.slice(0, 7),
                summary: committed.summary,
              })}
            </div>
          )}
          {git.status?.truncated && <div className="git-note">{t('gitTruncated')}</div>}

          {section(
            t('gitStaged'),
            groups.staged,
            true,
            <button
              type="button"
              className="git-link-btn"
              disabled={stagedPaths.length === 0}
              onClick={() => void git.unstage(stagedPaths)}
            >
              {t('gitUnstageAll')}
            </button>,
          )}
          {section(t('gitConflicted'), groups.conflicted, false)}
          {section(
            t('gitChanges'),
            groups.changes,
            false,
            <>
              <button
                type="button"
                className="git-link-btn"
                disabled={groups.changes.length === 0}
                onClick={() => void git.stage(uniquePaths(groups.changes))}
              >
                {t('gitStageAll')}
              </button>
              <button
                type="button"
                className="git-link-btn danger"
                disabled={groups.changes.length === 0}
                onClick={() => setDiscardPaths(uniquePaths(groups.changes))}
              >
                {t('gitDiscardAll')}
              </button>
            </>,
          )}
          {section(
            t('gitUntracked'),
            groups.untracked,
            false,
            <>
              <button
                type="button"
                className="git-link-btn"
                disabled={groups.untracked.length === 0}
                onClick={() => void git.stage(uniquePaths(groups.untracked))}
              >
                {t('gitStageAll')}
              </button>
              <button
                type="button"
                className="git-link-btn danger"
                disabled={groups.untracked.length === 0}
                onClick={() => setDiscardPaths(uniquePaths(groups.untracked))}
              >
                {t('gitDiscardAll')}
              </button>
            </>,
          )}
          {groups.staged.length === 0 &&
            groups.changes.length === 0 &&
            groups.untracked.length === 0 &&
            groups.conflicted.length === 0 && (
              <div className="git-clean">
                <Icon name="check" size={13} />
                {t('gitEmptyChanges')}
              </div>
            )}

          <section className="git-commit-box">
            <textarea
              value={message}
              rows={3}
              placeholder={t('gitCommitMessage')}
              onChange={(e) => setMessage(e.target.value)}
            />
            <div className="git-commit-actions">
              <label className="git-amend">
                <input
                  type="checkbox"
                  checked={amend}
                  onChange={(e) => setAmend(e.target.checked)}
                />
                {t('gitAmend')}
              </label>
              <button
                type="button"
                className="btn-primary"
                disabled={busy || groups.staged.length === 0 || !message.trim()}
                onClick={() => {
                  void git.commit(message, amend).then((ok) => {
                    if (ok) {
                      setMessage('')
                      setAmend(false)
                    }
                  })
                }}
              >
                {t('gitCommit')}
              </button>
            </div>
            <div className="git-stash-row">
              <label className="git-amend">
                <input
                  type="checkbox"
                  checked={stashUntracked}
                  onChange={(e) => setStashUntracked(e.target.checked)}
                />
                {t('gitStashUntracked')}
              </label>
              <button
                type="button"
                className="git-link-btn"
                title={t('gitStashHint')}
                disabled={busy || !dirty}
                onClick={() => {
                  void git.pushStash(message.trim() || null, stashUntracked).then((ok) => {
                    if (ok) {
                      setMessage('')
                      setAmend(false)
                    }
                  })
                }}
              >
                {t('gitStashChanges')}
              </button>
            </div>
          </section>

          {git.stashes.length > 0 && (
            <section className="git-section">
              <div className="git-section-head">
                <span>
                  {t('gitStashes')} <span className="git-count">{git.stashes.length}</span>
                </span>
              </div>
              {git.stashes.map((s) => (
                <div className="git-row" key={`${s.index}-${s.oid}`}>
                  <div className="git-row-main git-stash-main" title={s.message}>
                    <span className="git-stash-index">{`stash@{${s.index}}`}</span>
                    <span className="git-path">{s.message}</span>
                  </div>
                  <div className="git-row-actions">
                    <button
                      type="button"
                      className="git-mini-btn"
                      title={t('gitStashPopHint')}
                      onClick={() => void git.stashAction(s.index, 'pop')}
                    >
                      {t('gitStashPop')}
                    </button>
                    <button
                      type="button"
                      className="git-mini-btn"
                      title={t('gitStashApplyHint')}
                      onClick={() => void git.stashAction(s.index, 'apply')}
                    >
                      {t('gitStashApply')}
                    </button>
                    <button
                      type="button"
                      className="git-mini-btn danger"
                      title={t('gitStashDropHint')}
                      onClick={() => void git.stashAction(s.index, 'drop')}
                    >
                      <Icon name="trash" size={11} />
                    </button>
                  </div>
                </div>
              ))}
            </section>
          )}

          <section className="git-section">
            <div className="git-section-head">
              <span>{t('gitHistory')}</span>
            </div>
            {git.commits.map((c, i) => {
              const row = laneRows[i]
              const expanded = expandedOid === c.oid
              return (
                <div className="git-history-item" key={c.oid}>
                  <button
                    type="button"
                    className={`git-commit-row${expanded ? ' expanded' : ''}`}
                    onClick={() => toggleCommitFiles(c.oid)}
                  >
                    <span
                      className="git-lane"
                      style={{
                        width: laneCount * 12,
                        ['--lane' as string]: row ? row.lane : 0,
                      }}
                    >
                      {row &&
                        Array.from({ length: row.laneCount }, (_, l) => (
                          <span
                            className={`git-lane-line${l === row.lane ? ' own' : ''}`}
                            key={l}
                            style={{ ['--li' as string]: l }}
                          />
                        ))}
                      <span className="git-lane-dot" />
                    </span>
                    <div className="git-commit-main">
                      <div className="git-commit-top">
                        <span className="git-commit-oid">{c.shortOid}</span>
                        <span className="git-commit-subject">{c.subject}</span>
                      </div>
                      <div className="git-commit-meta">
                        <span>{c.authorName}</span>
                        <span>{formatWhen(c.timestamp)}</span>
                        {c.refs.map((ref) => (
                          <span className="git-ref-chip" key={ref}>
                            {ref}
                          </span>
                        ))}
                      </div>
                    </div>
                  </button>
                  {expanded && (
                    <div className="git-commit-files">
                      {commitFiles === null && (
                        <div className="git-note">{t('gitLoadingFiles')}</div>
                      )}
                      {commitFiles !== null && commitFiles.length === 0 && (
                        <div className="git-note">{t('gitNoFiles')}</div>
                      )}
                      {commitFiles?.map((f) => (
                        <button
                          type="button"
                          className="git-commit-file"
                          key={`${f.status}:${f.path}`}
                          title={f.path}
                          onClick={() =>
                            setDiffTarget({
                              path: f.path,
                              scope: 'commit',
                              oid: c.oid,
                              title: `${f.status} ${f.path} · ${c.shortOid}`,
                            })
                          }
                        >
                          <span className={`git-file-status st-${f.status[0].toLowerCase()}`}>
                            {f.status}
                          </span>
                          <span className="git-path">{f.path}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
            {historyError && <div className="git-error">{describeGitError(historyError, t)}</div>}
            {git.hasMoreLog && (
              <button type="button" className="git-link-btn" onClick={() => void git.loadMoreLog()}>
                {t('gitLoadMore')}
              </button>
            )}
          </section>
        </>
      )}

      {diffTarget && git.root && (
        <GitDiffView
          host={host}
          root={git.root}
          path={diffTarget.path}
          scope={diffTarget.scope}
          oid={diffTarget.oid ?? null}
          title={diffTarget.title}
          onClose={() => setDiffTarget(null)}
        />
      )}

      {blamePath && git.root && (
        <GitBlameView
          host={host}
          root={git.root}
          path={blamePath}
          onClose={() => setBlamePath(null)}
        />
      )}

      {forcePushOpen && (
        <ConfirmDialog
          title={t('gitPushForce')}
          message={t('gitPushForceConfirm')}
          confirmLabel={t('gitPushForce')}
          cancelLabel={t('gitCancel')}
          danger
          onConfirm={() => {
            setForcePushOpen(false)
            void git.runNetwork('push', true)
          }}
          onCancel={() => setForcePushOpen(false)}
        />
      )}

      {discardPaths && (
        <ConfirmDialog
          title={t('gitDiscard')}
          message={t('gitDiscardConfirm', { count: discardPaths.length })}
          confirmLabel={t('gitDiscard')}
          cancelLabel={t('gitCancel')}
          danger
          onConfirm={() => {
            const paths = discardPaths
            setDiscardPaths(null)
            void git.discard(paths)
          }}
          onCancel={() => setDiscardPaths(null)}
        />
      )}
    </div>
  )
}

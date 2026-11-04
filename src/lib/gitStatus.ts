import type { GitStatus, GitStatusEntry } from '../types'

/** The four sections the panel paints, in rail order. */
export interface GitStatusGroups {
  staged: GitStatusEntry[]
  changes: GitStatusEntry[]
  untracked: GitStatusEntry[]
  conflicted: GitStatusEntry[]
}

/**
 * Split porcelain v2 rows into the sections the panel shows.
 *
 * A row can appear twice on purpose: `MM` is staged *and* has further worktree
 * edits, and both sides need their own action (unstage vs discard).
 */
export function groupGitStatus(status: GitStatus | null): GitStatusGroups {
  const groups: GitStatusGroups = {
    staged: [],
    changes: [],
    untracked: [],
    conflicted: [],
  }
  for (const entry of status?.entries ?? []) {
    if (entry.conflicted) {
      groups.conflicted.push(entry)
      continue
    }
    if (entry.kind === 'untracked') {
      groups.untracked.push(entry)
      continue
    }
    if (entry.kind === 'ignored') continue
    if (entry.staged) groups.staged.push(entry)
    if (entry.unstaged) groups.changes.push(entry)
  }
  return groups
}

/** A stable React key: porcelain rows are unique per path within a section. */
export function gitEntryKey(entry: GitStatusEntry, section: string): string {
  return `${section}:${entry.path}:${entry.x}${entry.y}`
}

/** Short human label for the porcelain letters (`M`, `A`, `D`, `R`…). */
export function gitEntryLetter(entry: GitStatusEntry, staged: boolean): string {
  const letter = staged ? entry.x : entry.y
  if (entry.kind === 'untracked') return 'U'
  if (entry.conflicted) return '!'
  return letter === '.' ? '•' : letter
}

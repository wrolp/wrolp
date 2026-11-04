import type { GitHostRef } from '../types'

/** Stable persistence key: `ssh:<tabId>` or `local`, mirroring the backend. */
export function gitHostKey(host: GitHostRef): string {
  return host.kind === 'ssh' ? `ssh:${host.jumpTabId}` : 'local'
}

/** AST-safe split of a backend `git_<stage>:<message>` error. */
export function gitErrorStage(message: string): string {
  const i = message.indexOf(':')
  return i > 0 ? message.slice(0, i) : message
}

export function gitErrorDetail(message: string): string {
  const i = message.indexOf(':')
  return i >= 0 ? message.slice(i + 1).trim() : ''
}

export interface GitRecentRepo {
  root: string
  host: string
  usedAt: number
}

const STORAGE_KEY = 'wrolp.git.recentRepos'
const MAX_RECENT = 8

/** Recent repository paths, scoped per host so a jump host never suggests a
 *  local Windows path (and vice versa). */
export function loadRecentGitRepos(hostKey: string): GitRecentRepo[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return (parsed as GitRecentRepo[])
      .filter((r) => r && typeof r.root === 'string' && r.host === hostKey)
      .sort((a, b) => b.usedAt - a.usedAt)
      .slice(0, MAX_RECENT)
  } catch {
    return []
  }
}

/** Remember a repository after it opened successfully; returns the updated list. */
export function rememberGitRepo(hostKey: string, root: string): GitRecentRepo[] {
  let all: GitRecentRepo[] = []
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    if (Array.isArray(parsed)) all = parsed as GitRecentRepo[]
  } catch {
    all = []
  }
  const others = all.filter((r) => r && r.host !== hostKey)
  const mine = all.filter((r) => r && r.host === hostKey && r.root !== root)
  const next = [...mine, { root, host: hostKey, usedAt: Date.now() }, ...others]
    .filter((r) => r && typeof r.root === 'string' && typeof r.host === 'string')
    .sort((a, b) => b.usedAt - a.usedAt)
    .slice(0, MAX_RECENT * 2)
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Storage can be unavailable (private mode); the in-memory list still works.
  }
  return loadRecentGitRepos(hostKey)
}

/** Forget a repository the user removed from the recent list. */
export function forgetGitRepo(hostKey: string, root: string): GitRecentRepo[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    if (Array.isArray(parsed)) {
      const kept = (parsed as GitRecentRepo[]).filter(
        (r) => r && !(r.host === hostKey && r.root === root),
      )
      localStorage.setItem(STORAGE_KEY, JSON.stringify(kept))
    }
  } catch {
    // Ignored for the same reason as the write above.
  }
  return loadRecentGitRepos(hostKey)
}

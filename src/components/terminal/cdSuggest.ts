// Pure logic for the Warp-style `cd` directory dropdown
// (plan: task/plans/cd-directory-dropdown-plan.md).
//
// Nothing in here touches xterm, React or IPC: every export is a pure function
// over strings and arrays, so `scripts/check-cd-suggest.mjs` can exercise all
// its branches directly (Node >= 23 strips TS types natively).
//
// NOTE: the `../../lib/lsParse.ts` import carries an explicit extension on
// purpose — Node's type-stripping resolver cannot follow extensionless TS
// specifiers, while Vite and `tsc` (`allowImportingTsExtensions`) both accept
// it. Keeping this module importable is what buys us a real unit test in a repo
// that has no test runner.

import { resolveCdTarget } from '../../lib/lsParse.ts'

/** How a shell's own line editor is driven — decides quoting and "clear line". */
export type CdShellKind = 'posix' | 'windows'

/** One directory offered by the dropdown. */
export interface CdCandidate {
  /** Display name (`..` for the synthetic parent entry). */
  name: string
  /** Absolute path this candidate resolves to. */
  fullPath: string
  /** Bytes to type when the zero-deletion path applies, else `null` (rewrite). */
  append: string | null
}

/** Where a partially typed `cd` argument should be listed from. */
export interface CdArgSplit {
  /** Directory to list; `null` means "do not open the dropdown". */
  base: string | null
  /** The filter prefix — never contains a separator. */
  prefix: string
  /** `cd C:` on a local Windows shell ⇒ offer the drive list instead. */
  drives: boolean
}

export interface CdCandidateList {
  items: CdCandidate[]
  /** How many further matches were dropped by the 200-item cap. */
  omitted: number
}

/** The highest number of candidates rendered at once (see plan §2). */
export const CD_MAX_CANDIDATES = 200

/**
 * Typing must not fire a listing per keystroke — an SFTP list opens a NEW SSH
 * connection, so filtering through a cached directory is free but the request
 * itself is debounced by this much (plan §5).
 */
export const CD_DEBOUNCE_MS = 120

const CD_COMMANDS = new Set(['cd', 'chdir', 'set-location', 'sl'])
const SEP = /[\\/]/

/**
 * The single argument of an in-progress `cd`, or `null` when the line is not a
 * `cd` yet (wrong command, no space yet, several arguments, flags).
 *
 * `cd ` (trailing space, empty argument) IS a match: that is the moment the
 * dropdown must open with every child of the current directory.
 */
export function parseCdInput(command: string): string | null {
  const m = /^\s*(\S+)\s+(\S*)$/.exec(command)
  if (!m) return null
  if (!CD_COMMANDS.has(m[1].toLowerCase())) return null
  const arg = m[2]
  // Flags (`cd --`, `cd -`, `cd -L x`) are not paths — leave them to the shell.
  if (arg.startsWith('-')) return null
  return arg
}

/** Show the dropdown for this argument at all? Keeps v1's scope explicit. */
export function isCdSupported(arg: string): boolean {
  if (!arg) return true
  // `~` would need the REMOTE `$HOME`; the backend's `expand_tilde` expands the
  // LOCAL one, so guessing here would list the wrong directory (plan §5).
  if (arg.startsWith('~')) return false
  // Quoting is not modelled yet: `cd "Prog…` would resolve against a base that
  // does not exist once the quotes are stripped.
  if (/["'`]/.test(arg)) return false
  if (arg.includes('$')) return false
  return true
}

/**
 * Split a partially typed `cd` argument into the directory to list and the
 * filter prefix (the last path segment being typed).
 */
export function splitCdArg(arg: string, cwd: string | null): CdArgSplit {
  if (!arg) return { base: cwd, prefix: '', drives: false }
  if (!isCdSupported(arg)) return { base: null, prefix: '', drives: false }
  // A bare Windows drive (`cd C:`) switches drives — there is no directory to
  // list, the candidates are the drives themselves.
  if (/^[A-Za-z]:$/.test(arg)) return { base: null, prefix: '', drives: true }
  const cut = Math.max(arg.lastIndexOf('/'), arg.lastIndexOf('\\'))
  if (cut < 0) return { base: cwd, prefix: arg, drives: false }
  const head = arg.slice(0, cut + 1)
  // `resolveCdTarget` already handles `.`/`..`, Windows drives and git-bash
  // `/c/…`, and returns null when a relative head has no known cwd to anchor to.
  return { base: resolveCdTarget(head, cwd), prefix: arg.slice(cut + 1), drives: false }
}

function isWindowsPath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.includes('\\')
}

/** Append one segment to a directory path, preserving the Windows separator. */
export function joinCdPath(base: string, name: string): string {
  const trimmed = SEP.test(base[base.length - 1] ?? '') ? base.slice(0, -1) : base
  if (!trimmed) return `/${name}`
  return `${trimmed}${isWindowsPath(base) ? '\\' : '/'}${name}`
}

/** The parent directory of `base`, or `null` at a filesystem root. */
export function parentDirOf(base: string): string | null {
  if (/^[A-Za-z]:[\\/]?$/.test(base)) return null // `C:\` has no parent entry
  let trimmed = base
  while (trimmed.length > 1 && SEP.test(trimmed[trimmed.length - 1])) {
    trimmed = trimmed.slice(0, -1)
  }
  if (trimmed === '/') return null // the root has no parent to offer
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (cut < 0) return null
  const parent = trimmed.slice(0, cut)
  return parent === '' ? '/' : parent
}

/**
 * Turn a directory listing into dropdown rows: directories only, `..` first,
 * exact-prefix matches before case-insensitive ones, capped at 200.
 *
 * Hidden (`dot`-prefixed) directories are listed only once the user has typed a
 * leading dot, so a plain `cd ` is not swamped by `.git`, `.cache`, …
 */
export function buildCdCandidates(
  base: string,
  entries: readonly { name: string; isDir: boolean }[],
  prefix: string,
): CdCandidateList {
  const lower = prefix.toLowerCase()
  const hidden = prefix.startsWith('.')
  const rows: { name: string; exact: boolean }[] = []
  const parent = parentDirOf(base)
  if (parent && '..'.startsWith(prefix)) rows.push({ name: '..', exact: true })
  const dirs = entries.filter((e) => e.isDir && (hidden || !e.name.startsWith('.')))
  const exact: string[] = []
  const loose: string[] = []
  for (const e of dirs) {
    if (e.name.startsWith(prefix)) exact.push(e.name)
    else if (prefix && e.name.toLowerCase().startsWith(lower)) loose.push(e.name)
  }
  exact.sort((a, b) => a.localeCompare(b))
  loose.sort((a, b) => a.localeCompare(b))
  for (const name of [...exact, ...loose]) {
    rows.push({ name, exact: name.startsWith(prefix) })
  }
  const items = rows.slice(0, CD_MAX_CANDIDATES).map(({ name, exact }) => ({
    name,
    fullPath: name === '..' ? (parentDirOf(base) ?? base) : joinCdPath(base, name),
    append: exact ? name.slice(prefix.length) : null,
  }))
  return { items, omitted: Math.max(0, rows.length - items.length) }
}

/**
 * The bytes that accept the highlighted candidate.
 *
 * `append` (zero deletions) is always preferred: it only types the missing tail,
 * so the shell's own line editor keeps every byte it has already echoed. When
 * the candidate does not literally start with what the user typed (a different
 * case: `cd doc` → `Documents`), there is no tail to append and the whole line
 * is rewritten with `cd -- '…'` instead.
 */
export function planCdAccept(candidate: CdCandidate, shell: CdShellKind): string {
  if (candidate.append !== null) return candidate.append
  return `${clearLineBytes(shell)}${cdCommandFor(shell, candidate.fullPath)}`
}

/** Bytes that wipe the current input line without submitting it. */
export function clearLineBytes(shell: CdShellKind): string {
  // Ctrl-A Ctrl-K for readline (home, then kill-to-EOL); Esc clears cmd's
  // line buffer. A bare Esc would be a readline META prefix, so it must stay
  // confined to non-POSIX shells.
  return shell === 'posix' ? '\x01\x0b' : '\x1b'
}

/**
 * A complete, quoted `cd` command for `abs` — the single home for the quoting
 * rules, shared by the `ls` directory click and the dropdown's rewrite path.
 * `~` must stay unquoted so the shell expands it.
 */
export function cdCommandFor(shell: CdShellKind, abs: string): string {
  if (shell === 'windows') return `cd "${abs}"`
  if (abs.startsWith('~')) return `cd -- ${abs}`
  return `cd -- '${abs.replace(/'/g, "'\\''")}'`
}

// ---- Projected input line ---------------------------------------------------
//
// A keystroke reaches `onData` BEFORE the shell's echo has been written into the
// xterm buffer, so reading the line back there lags by one key. To react to the
// space that turns `cd` into `cd ` immediately, we keep the not-yet-echoed tail
// (`lag`) and project the keystroke onto it.

export interface CdProjection {
  /** The input line as it will read once this keystroke has echoed. */
  line: string | null
  /** The not-yet-echoed tail to carry into the next keystroke. */
  lag: string
}

/**
 * Apply one keystroke to a line. Returns `null` when the result cannot be known
 * (cursor moves, escape sequences, anything else that edits in place): the
 * caller then simply stops guessing until the buffer catches up.
 */
export function applyKeystroke(line: string, data: string): string | null {
  if (!data) return line
  if (data.length === 1) {
    const code = data.charCodeAt(0)
    if (data === '\x7f' || data === '\x08') return line.slice(0, -1) // backspace
    if (code === 0x15 || code === 0x03 || code === 0x0b) return '' // ctrl-u/c/k
    if (code === 0x0d || code === 0x0a) return '' // submitted ⇒ line is gone
    if (code < 0x20 || code === 0x7f) return null // cursor moves, ^A, ^E, …
    return line + data
  }
  // A multi-byte chunk: only an all-printable block (IME text, a short paste) can
  // be appended verbatim; anything with a control byte makes the result unknown.
  if (/[\x00-\x1f\x7f]/.test(data)) return null
  return line + data
}

/**
 * The part of `lag` the buffer has NOT caught up with yet — the tail of what was
 * typed and sent but still has no echo on screen. Callers that need the line "as
 * the user typed it" (the command history, for one) append this to `live`.
 */
export function unechoedTail(live: string | null, lag: string): string {
  if (!lag || live === null) return ''
  return live.endsWith(lag) ? '' : lag
}

/**
 * Project one keystroke onto the possibly-stale line read from the terminal.
 *
 * `live` is what the buffer currently shows and `lag` is what this component has
 * already sent without seeing it echoed yet. Whenever the buffer has caught up
 * (`live` already ends with `lag`) the lag is dropped, so a fast local echo and
 * a slow remote one converge on the same line without any bookkeeping.
 */
export function projectInputLine(live: string | null, lag: string, data: string): CdProjection {
  if (live === null) return { line: null, lag: '' }
  const pending = unechoedTail(live, lag)
  const line = applyKeystroke(live + pending, data)
  const next = line === null ? '' : (applyKeystroke(pending, data) ?? '')
  return { line, lag: next }
}

// ---- Listing cache ----------------------------------------------------------
//
// An SFTP listing is expensive (each call opens a NEW SSH connection), so keying
// the directory at display speed is not an option: results are cached for 15s
// and evicted least-recently-used.

export class CdListCache<T> {
  private readonly map = new Map<string, { value: T; at: number }>()
  private readonly ttlMs: number
  private readonly max: number

  // NOTE: no parameter properties — Node's type-stripping loader (which is how
  // `scripts/check-cd-suggest.mjs` imports this module) rejects them.
  constructor(ttlMs = 15_000, max = 64) {
    this.ttlMs = ttlMs
    this.max = max
  }

  get(key: string, now = Date.now()): T | null {
    const hit = this.map.get(key)
    if (!hit) return null
    if (now - hit.at > this.ttlMs) {
      this.map.delete(key)
      return null
    }
    // Map preserves insertion order ⇒ re-insert to mark it most-recently used.
    this.map.delete(key)
    this.map.set(key, hit)
    return hit.value
  }

  set(key: string, value: T, now = Date.now()): void {
    if (this.map.has(key)) this.map.delete(key)
    this.map.set(key, { value, at: now })
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next()
      if (oldest.done) break
      this.map.delete(oldest.value)
    }
  }

  clear(): void {
    this.map.clear()
  }
}

/** Cache key for one (session target, directory) pair. */
export function cdCacheKey(targetKey: string, dir: string): string {
  return `${targetKey}|${dir}`
}

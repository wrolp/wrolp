import type { LsEntry } from '../../lib/lsParse'

// ---- clickable `ls` output (ls/ll/dir) ----
//
// When the user runs `ls -l`/`ll`/`la`/`dir`, output is written to the
// terminal unchanged (passthrough) while being buffered for parsing. Once the
// next prompt (or a silence timeout) ends the block, each entry's name becomes
// a clickable xterm link (via registerLinkProvider): directories send
// `cd <name>`, files open in the editor. The row for each entry is derived
// from the buffer row captured when the command was submitted.

export const LS_CAPTURE_TIMEOUT_MS = 2000
export const LS_MAX_BYTES = 128 * 1024

export interface LsCaptureState {
  format: 'long' | 'dir' | 'multi' | 'multiF'
  prompt: string
  /** Absolute buffer row of the echoed command line (captured at submit). */
  startRow: number
  buf: string
  bytes: number
  timeout: ReturnType<typeof setTimeout> | null
  /** Raw bytes of an incomplete trailing line (held back until its newline arrives). */
  pending: string
  /**
   * True until the first group of text has been painted. Only that one begins
   * with the echoed command line, whose column positions must not be read as
   * entries (see `parseLsBlock`'s `skipFirstLine`).
   */
  firstGroup: boolean
  /**
   * True once a chunk of this listing carried the shell's own colour SGR. From
   * then on every chunk is passed through untouched: `ls --color` knows things
   * about those names we can't see (a `.gz` is red, a door is magenta), and
   * layering our hues on top would fight them.
   */
  colored: boolean
  /**
   * The listed directory's name → is-directory map, or null while the fetch is
   * still in flight. A bare `ls` prints nothing but names, so this is the only
   * way to know which of them are directories.
   */
  dirFlags: Map<string, boolean> | null
}

/**
 * A parsed `ls` entry bound to the absolute base directory of *its own*
 * listing (captured at submit time). Carrying the baseDir per entry — rather
 * than reading a single global "latest listing" ref — is what lets multiple
 * listings coexist on screen: each click resolves against the directory of
 * the listing it came from, even after a newer `ls` has run elsewhere.
 */
export interface LsClickableEntry extends LsEntry {
  baseDirPromise: Promise<string | null>
}

/**
 * One candidate for a link the provider is about to build: an entry that
 * matched the hovered line at the same place as at least one other entry.
 */
export interface LsLinkCandidate<T> {
  entry: T
  /** Absolute buffer row the entry is stored under — a row of ITS OWN listing. */
  row: number
  /** Insertion order: higher means captured later (a newer listing). */
  order: number
}

/**
 * Pick which entry a link is built from when several listings put the same name
 * at the same spot on the hovered line.
 *
 * The provider matches entries against the *text* of the hovered row (so a link
 * survives scrolling and row drift), which means two listings of two different
 * directories both match when they contain a file of the same name. xterm takes
 * the FIRST link whose range covers the cursor (`Linkifier`: `links.find(…)`), so
 * emitting one link per entry handed the click to the listing that happened to
 * be stored first — the older one — and opened the OTHER directory's file.
 *
 * The rule: the entry whose own row is nearest the row the name is rendered on
 * is the listing actually under the cursor; a tie goes to the newer listing,
 * because `resolveLsRow` can park a fresh entry on a row an older listing
 * already owns, and what the user sees there is the newer listing.
 */
export function pickLsLinkEntry<T>(
  cands: readonly LsLinkCandidate<T>[],
  linkTopRow: number,
): LsLinkCandidate<T> | null {
  let best: LsLinkCandidate<T> | null = null
  let bestDist = Infinity
  for (const c of cands) {
    const dist = Math.abs(c.row - linkTopRow)
    if (best === null || dist < bestDist || (dist === bestDist && c.order > best.order)) {
      best = c
      bestDist = dist
    }
  }
  return best
}

export function joinPath(base: string, name: string): string {
  if (!base) return name
  // Use the host's native separator so Windows local paths stay `C:\a\b`
  // (cmd/PowerShell/backend PathBuf all accept it) and Unix paths stay `/a/b`.
  const sep = /^[A-Za-z]:[\\/]/.test(base) ? '\\' : '/'
  return `${base.replace(/[\\/]+$/, '')}${sep}${name}`
}

/**
 * Resolve the absolute path an `ls` entry click should open (B22).
 *
 * By default the path is built from the listing's *captured* base directory
 * (`joinPath(capturedBase, name)`), so a click lands in the directory the
 * listing was produced from even after the user has `cd`'d away. But if the
 * file is no longer at that base — e.g. it was `mv`'d out of the listing's
 * directory — we fall back to the current cwd so a moved file still opens.
 *
 * We only switch bases when the captured path is confirmed *gone* AND the cwd
 * path *exists*, so the "click lands in the listing's dir" behavior is
 * preserved for every other case (notably: `cd` away while the file is still
 * in its original place). `exists` is injected so the logic is testable
 * without a live filesystem/backend; in the app it's `fsFileExists(lsFsTarget(),
 * p)`. `nested` skips the fallback (a docker exec / nested shell's host-tracked
 * cwd can't describe container-side paths).
 */
export interface LsEntryResolveCtx {
  capturedBase: string | null
  name: string
  cwd: string | null
  nested: boolean
  exists: (abs: string) => Promise<boolean>
  /** Recent `mv` destinations, newest last. Consulted only after the captured
   *  path is confirmed gone, so a moved file still opens at its new home. */
  moves?: readonly MvMove[]
}

export interface LsEntryResolveResult {
  abs: string
  base: string | null
}

export async function resolveLsEntryPath(ctx: LsEntryResolveCtx): Promise<LsEntryResolveResult> {
  const { capturedBase, name, cwd, nested, exists, moves } = ctx
  const capturedAbs = capturedBase ? joinPath(capturedBase, name) : name
  if (!nested && capturedBase) {
    let capturedExists = false
    try {
      capturedExists = await exists(capturedAbs)
    } catch {
      capturedExists = true // on error, trust the captured path
    }
    if (!capturedExists) {
      if (cwd) {
        const cwdAbs = joinPath(cwd, name)
        try {
          if (await exists(cwdAbs)) return { abs: cwdAbs, base: cwd }
        } catch {
          /* keep looking */
        }
      }
      if (moves) {
        for (let i = moves.length - 1; i >= 0; i--) {
          const move = moves[i]
          try {
            const atDest = joinPath(move.destDir, name)
            if (await exists(atDest)) return { abs: atDest, base: move.destDir }
            if (move.renamedFrom === name && move.renamedTo && (await exists(move.renamedTo))) {
              return { abs: move.renamedTo, base: parentDir(move.renamedTo) }
            }
          } catch {
            /* try the next move */
          }
        }
      }
    }
  }
  return { abs: capturedAbs, base: capturedBase }
}

/** One `mv` observed in this session, enough to follow a moved listing entry. */
export interface MvMove {
  /** The move's destination path (a directory, or the new file name). */
  destDir: string
  /** Old basename when a single file was renamed into `renamedTo`. */
  renamedFrom: string | null
  renamedTo: string | null
}

function normalizePath(p: string): string {
  const windows = /^[A-Za-z]:[\\/]/.test(p)
  const sep = windows ? '\\' : '/'
  const rest = windows ? p.slice(2) : p
  const parts: string[] = []
  for (const part of rest.split(/[\\/]/)) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop()
      else if (!windows && !p.startsWith('/')) parts.push('..')
      continue
    }
    parts.push(part)
  }
  const root = windows ? `${p.slice(0, 2)}${sep}` : p.startsWith('/') ? '/' : ''
  return root + parts.join(sep) || root || '.'
}

function parentDir(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '')
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (idx < 0) return ''
  if (idx === 0) return trimmed.slice(0, 1)
  if (/^[A-Za-z]:$/.test(trimmed.slice(0, idx))) return trimmed.slice(0, idx + 1)
  return trimmed.slice(0, idx)
}

function basename(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] ?? ''
}

/** Split a simple shell command into words, honouring quotes and backslashes.
 *  Returns null for compound lines (`|`, `;`, `&&`, redirections), where a
 *  destination cannot be attributed to one `mv`. */
function splitWords(command: string): string[] | null {
  const words: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let hasToken = false
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      hasToken = true
      continue
    }
    if (ch === '\\') {
      i += 1
      if (i < command.length) current += command[i]
      hasToken = true
      continue
    }
    if (ch === ' ' || ch === '\t') {
      if (hasToken) words.push(current)
      current = ''
      hasToken = false
      continue
    }
    if ('|;&<>`'.includes(ch)) return null
    current += ch
    hasToken = true
  }
  if (quote) return null
  if (hasToken) words.push(current)
  return words
}

/**
 * Parse the destination of an `mv` so `ls` links against a listing made before
 * the move can follow the file (B22). Returns null for anything we cannot
 * attribute confidently: compound commands, `~` destinations (no home here),
 * a relative destination without a known cwd, or too few operands.
 */
export function parseMvMove(command: string, cwd: string | null): MvMove | null {
  const words = splitWords(command.trim())
  if (!words) return null
  let i = 0
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++
  if (words[i] === 'sudo') i++
  if (words[i] !== 'mv') return null
  i++

  let target: string | null = null
  const sources: string[] = []
  for (let j = i; j < words.length; j++) {
    const word = words[j]
    if (word === '--') {
      sources.push(...words.slice(j + 1))
      break
    }
    if (word === '-t' || word === '--target-directory') {
      target = words[++j] ?? null
      continue
    }
    if (word.startsWith('--target-directory=')) {
      target = word.slice('--target-directory='.length)
      continue
    }
    if (word.startsWith('-') && word !== '-') continue
    sources.push(word)
  }
  if (!target) {
    if (sources.length < 2) return null
    target = sources.pop() ?? null
  }
  if (!target || sources.length === 0) return null

  const absolute = target.startsWith('/') || /^[A-Za-z]:[\\/]/.test(target)
  if (target.startsWith('~')) return null
  const dest = (absolute ? target : cwd ? joinPath(cwd, target) : null)?.replace(/[\\/]+$/, '')
  if (!dest) return null
  const normalized = normalizePath(dest)

  const renamedFrom =
    sources.length === 1 && !/[*?[\]{}]/.test(sources[0]) ? basename(sources[0]) : null
  // A trailing separator always means a directory; without one, the same path
  // may also be the new file name, which the resolver tries second.
  const renamedTo = renamedFrom && !/[\\/]$/.test(target) ? normalized : null
  return { destDir: normalized, renamedFrom, renamedTo }
}

/** Extract a single non-flag path argument from an `ls`-style command, if any. */
export function extractLsTargetArg(cmd: string): string | null {
  const tokens = cmd.trim().split(/\s+/).filter(Boolean)
  const nonFlag = tokens.slice(1).filter((a) => !a.startsWith('-'))
  return nonFlag.length === 1 ? nonFlag[0] : null
}

/**
 * Resolve the directory a listing's entries live in: the command's target path
 * argument when present (absolute `/…` / `X:\…` / `~…` used as-is, relative
 * joined to the cwd captured at submit time), otherwise the cwd itself. Returns
 * null only when neither the target nor the cwd is known.
 */
export function resolveLsBaseDir(cwd: string | null, targetArg: string | null): string | null {
  if (!targetArg) return cwd
  if (targetArg.startsWith('~') || targetArg.startsWith('/') || /^[A-Za-z]:[\\/]/.test(targetArg)) {
    return targetArg.replace(/[\\/]+$/, '')
  }
  if (!cwd) return null
  return joinPath(cwd, targetArg)
}

/**
 * Expand a leading `~/…` (or bare `~`) to `home`; leave other paths untouched.
 * SFTP doesn't expand `~` itself, and the backend's `expand_tilde` resolves the
 * *local* machine's home — so remote editor-open paths must be absolutized here.
 */
export function expandTilde(cwd: string | null, home: string | null): string | null {
  if (!cwd) return null
  if (cwd === '~') return home ?? cwd
  if (cwd.startsWith('~/') && home) return `${home}${cwd.slice(1)}` // cwd.slice(1) → '/…'
  return cwd
}

/**
 * True when a submitted command enters an interactive nested session whose cwd
 * lives in another context: a docker exec shell (`docker exec -it <ct> bash`)
 * or an interactive nested ssh (`ssh host`, no remote command). Inside such a
 * session the tracked cwd and any hidden `pwd` query describe the OUTER shell,
 * not what's on screen — the cwd tracking must be invalidated and `ls` link
 * bases taken from the prompt alone.
 */
export function isNestedSessionEntry(command: string): boolean {
  const c = command.trim()
  if (!c) return false
  const tokens = c.split(/\s+/).filter(Boolean)
  const prog = tokens[0] === 'sudo' ? tokens[1] : tokens[0]
  if (prog === 'docker') {
    const m = /docker\s+exec\b/.exec(c)
    if (!m) return false
    const afterExec = c.slice(m.index + m[0].length)
    // Interactive (`-it`/`-i`) shell entry only; one-shot remote commands
    // (`docker exec <ct> ls /tmp`) return immediately and don't nest.
    const interactive = /(?:^|\s)-[a-zA-Z]*i[a-zA-Z]*(?:\s|$)/.test(afterExec)
    const shell = /(?:^|\s)(?:\/bin\/)?(?:bash|sh|zsh|ash|fish|ksh)(?:\s|$)/.test(afterExec)
    return interactive && shell
  }
  if (prog === 'ssh') {
    // Remote commands / pipes / redirections / quoting mean a one-shot
    // non-interactive run (`ssh host 'ls'`, `ssh host | cat`).
    if (/[|;"'<>]|&&|\|\|/.test(c)) return false
    // Interactive login: `ssh [-flags value…] host` — exactly one trailing
    // non-flag token (the host), nothing after it.
    return /^(?:[^\s-]+\s+)?ssh\s+(?:-[a-zA-Z]+\s+\S+\s+)*\S+$/.test(c)
  }
  return false
}

/**
 * Extracts the container name/ID from a `docker exec` command line, e.g.
 * `docker exec -it lac-nacos /bin/bash` → "lac-nacos". Handles combined flags
 * (`-it`), `--flag=value`, and flags that take a separate value (`-u root`,
 * `-w /app`). Returns null when no container argument follows.
 */
export function parseDockerExecContainer(command: string): string | null {
  const c = command.trim()
  const m = /docker\s+exec\b/.exec(c)
  if (!m) return null
  const rest = c.slice(m.index + m[0].length).trim()
  if (!rest) return null
  // Flags of `docker exec` that consume the next token as their value.
  const takesValue = /^-(?:u|w|e|l|m|c|d|i|env|workdir|user|label|env-file|cpu-shares|memory)$/
  const tokens = rest.split(/\s+/)
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]
    if (tok.startsWith('-')) {
      const eq = tok.indexOf('=')
      const flag = eq === -1 ? tok : tok.slice(0, eq)
      if (
        eq === -1 &&
        takesValue.test(flag) &&
        i + 1 < tokens.length &&
        !tokens[i + 1].startsWith('-')
      ) {
        i += 1
      }
      continue
    }
    return tok.replace(/^["']+|["']+$/g, '')
  }
  return null
}

/** True for `exit`/`logout` — leaves a nested session (or the shell itself). */
export function isNestedSessionExit(command: string): boolean {
  return /^(?:exit|logout)\b/.test(command.trim())
}

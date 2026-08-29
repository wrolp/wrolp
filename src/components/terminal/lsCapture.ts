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
  /** Raw bytes of an incomplete trailing line (plain `ls`/`dir` coloring only). */
  pending: string
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

export function joinPath(base: string, name: string): string {
  if (!base) return name
  // Use the host's native separator so Windows local paths stay `C:\a\b`
  // (cmd/PowerShell/backend PathBuf all accept it) and Unix paths stay `/a/b`.
  const sep = /^[A-Za-z]:[\\/]/.test(base) ? '\\' : '/'
  return `${base.replace(/[\\/]+$/, '')}${sep}${name}`
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

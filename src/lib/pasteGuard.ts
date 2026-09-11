// Multi-line paste guard: config store + pure decision/sanitising helpers.
//
// Precedent: `wrolp-terminal-highlight` / `wrolp-maxScrollback` also live in
// localStorage — no Rust/window.json involvement for display-only preferences.
//
// See B20 in `task/BUGS.md` and `task/finished/terminal-multiline-paste-plan.md`.

const STORAGE_KEY = 'wrolp-paste-guard'

/** How a guarded multi-line paste is handled when the remote application has
 *  NOT enabled bracketed paste (so xterm cannot make the paste safe by itself). */
export type PasteMode = 'ask' | 'insert' | 'execute'

export interface PasteGuardConfig {
  /** Master switch. When false, pasting keeps the legacy raw behaviour. */
  enabled: boolean
  /** Only guard when the paste has MORE lines than this (1 = any multi-line). */
  threshold: number
  /** Only consulted when the remote did not enable bracketed paste. */
  mode: PasteMode
  /** `insert` only: append a `\` line continuation to non-final lines so the
   *  block is submitted as ONE command when the user finally presses Enter
   *  (without it, bash splits the buffered newlines into separate commands). */
  appendContinuation: boolean
}

export const PASTE_GUARD_DEFAULTS: PasteGuardConfig = {
  enabled: true,
  threshold: 1,
  mode: 'ask',
  appendContinuation: true,
}

/** The four kinds of session a terminal component can be attached to. */
export type SessionKind = 'ssh' | 'local' | 'serial' | 'telnet'

/** What `pasteIntoTerminal` should do with the (already sanitised) text. */
export type PasteAction = 'passthrough' | 'drop-serial' | 'insert' | 'execute' | 'ask'

export const PASTE_PREVIEW_LINES = 5

type Listener = (cfg: PasteGuardConfig) => void
const listeners = new Set<Listener>()

function emit(cfg: PasteGuardConfig): void {
  for (const l of [...listeners]) l(cfg)
}

function clampThreshold(n: number): number {
  if (!Number.isFinite(n)) return PASTE_GUARD_DEFAULTS.threshold
  return Math.min(50, Math.max(1, Math.round(n)))
}

/** Coerce an arbitrary stored value into a valid config (never throws). */
export function sanitizePasteGuard(raw: unknown): PasteGuardConfig {
  if (!raw || typeof raw !== 'object') return { ...PASTE_GUARD_DEFAULTS }
  const rec = raw as Record<string, unknown>
  const mode: PasteMode =
    rec.mode === 'ask' || rec.mode === 'insert' || rec.mode === 'execute'
      ? rec.mode
      : PASTE_GUARD_DEFAULTS.mode
  return {
    enabled: typeof rec.enabled === 'boolean' ? rec.enabled : PASTE_GUARD_DEFAULTS.enabled,
    threshold:
      typeof rec.threshold === 'number'
        ? clampThreshold(rec.threshold)
        : PASTE_GUARD_DEFAULTS.threshold,
    mode,
    appendContinuation:
      typeof rec.appendContinuation === 'boolean'
        ? rec.appendContinuation
        : PASTE_GUARD_DEFAULTS.appendContinuation,
  }
}

export function loadPasteGuard(): PasteGuardConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? sanitizePasteGuard(JSON.parse(raw)) : { ...PASTE_GUARD_DEFAULTS }
  } catch {
    return { ...PASTE_GUARD_DEFAULTS }
  }
}

export function savePasteGuard(cfg: PasteGuardConfig): PasteGuardConfig {
  const next = sanitizePasteGuard(cfg)
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Storage full/unavailable — keep running with in-memory settings only.
  }
  emit(next)
  return next
}

export function subscribePasteGuard(fn: Listener): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

// ---- pure helpers (unit-testable, no DOM access) ----

const BRACKETED_MARKER_RE = /\u001b\[20[01]~/g
// C0 control characters, keeping TAB (09), LF (0A) and CR (0D); plus DEL (7F).
// Pasted control characters would hand control of the session to whoever
// produced the clipboard content (Ctrl-C/Ctrl-D/Ctrl-Z/…), so they are dropped.
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g

export interface SanitizedPaste {
  text: string
  /** Number of `\x1b[200~` / `\x1b[201~` markers removed. */
  removedSequences: number
  /** Number of C0 control characters removed (TAB/LF/CR are kept). */
  removedControls: number
}

/** Strip bracketed-paste markers and unsafe control characters from text that
 *  is about to be written to a PTY. A pasted `\x1b[200~` would otherwise close
 *  the bracket early and let the rest of the paste escape as raw commands. */
export function sanitizePasteText(input: string): SanitizedPaste {
  let removedSequences = 0
  const withoutMarkers = input.replace(BRACKETED_MARKER_RE, () => {
    removedSequences += 1
    return ''
  })
  let removedControls = 0
  const text = withoutMarkers.replace(CONTROL_RE, () => {
    removedControls += 1
    return ''
  })
  return { text, removedSequences, removedControls }
}

/** Number of lines in the paste, ignoring a single trailing newline (a
 *  clipboard entry such as `ls\n` is still "one line" for guarding purposes). */
export function pasteLineCount(text: string): number {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const trimmed = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized
  if (!trimmed) return 0
  return trimmed.split('\n').length
}

export function isMultilinePaste(text: string): boolean {
  return pasteLineCount(text) > 1
}

/** Convert newlines into readline's quoted-insert form: `\x16` (Ctrl-V) makes
 *  readline insert the NEXT byte literally, so `\x16\n` puts a real newline in
 *  the edit buffer instead of submitting the line. Only meaningful when the
 *  remote actually runs a readline-based shell (see `canQuotedInsert`). */
export function toQuotedInsert(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  return normalized.replace(/\n/g, '\u0016\n')
}

// ---- POSIX shell detection ----
//
// `\` is only a valid line continuation for POSIX shells. cmd.exe uses `^` and
// PowerShell uses a backtick, so pasting a `\`-joined block into those would
// type garbage — they must be excluded from both the continuation and the
// quoted-insert action.

/** Local-shell presets that run a POSIX shell with a readline line editor. */
const POSIX_LOCAL_SHELLS = new Set([
  'bash',
  'wsl',
  'gitbash',
  'git-bash',
  'sh',
  'zsh',
  'dash',
  'ash',
  'ksh',
  'fish',
])

/** `wsl.exe` / PowerShell only exist on Windows (the app's primary target). */
const IS_WINDOWS = typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent)

/** True when a local terminal runs a POSIX shell. `spec` is the stored
 *  `localShellType` (a preset like `wsl`, or a user-typed executable path). An
 *  empty value means the platform default: cmd.exe on Windows, `$SHELL`
 *  elsewhere. */
export function isPosixLocalShell(spec?: string | null): boolean {
  const s = (spec ?? '').trim().toLowerCase()
  if (!s) return !IS_WINDOWS
  if (POSIX_LOCAL_SHELLS.has(s)) return true
  if (
    s.includes('powershell') ||
    s.includes('pwsh') ||
    s.includes('cmd.exe') ||
    /(^|[\\/])cmd$/.test(s)
  ) {
    return false
  }
  return (
    s.includes('bash') ||
    s.includes('zsh') ||
    s.includes('wsl') ||
    s.includes('git-bash') ||
    s.includes('git\\bin\\bash') ||
    s.includes('git/usr/bin/bash') ||
    s.endsWith('sh.exe') ||
    /(^|[\\/])(sh|zsh|dash|ash|ksh|fish)$/.test(s)
  )
}

/** True when the session's shell is POSIX-ish, i.e. `\` continues the line.
 *  SSH targets are assumed POSIX (a Windows box reached over SSH does not run
 *  a readline shell anyway); serial/Telnet never are. */
export function isPosixSession(sessionKind: SessionKind, localShellType?: string | null): boolean {
  if (sessionKind === 'ssh') return true
  if (sessionKind === 'local') return isPosixLocalShell(localShellType)
  return false
}

/** `insert without executing` needs a line editor that honours quoted-insert,
 *  and only while the app has NOT enabled bracketed paste (otherwise xterm
 *  makes the paste safe by itself). WSL / Git Bash are local POSIX shells with
 *  the very same readline, so they qualify exactly like an SSH shell does. */
export function canQuotedInsert(
  sessionKind: SessionKind,
  bracketedPasteMode: boolean,
  localShellType?: string | null,
): boolean {
  if (bracketedPasteMode) return false
  if (sessionKind === 'ssh') return true
  return sessionKind === 'local' && isPosixLocalShell(localShellType)
}

// ---- line continuation for the `insert` action ----
//
// A buffered newline is still a command separator: once the user finally
// presses Enter, `echo one` + newline + `echo two` runs BOTH commands. To make
// the reviewed block submit as a single command, every non-final line needs a
// trailing `\` (line continuation), which is what a human would type.

/** Lines that already continue by themselves: an explicit backslash, a shell
 *  operator that keeps the command open, or a block keyword (`for …; do`,
 *  `if …; then`, `… else`, `case … in`). Adding a `\` to those would join the
 *  following line into the construct and break it. */
/** Open operator / grouping: the command already continues by itself. */
const CONTINUES_OPERATOR_RE = /[|&(,{\[]$/
/** Block keyword at EOL (`for …; do`, `if …; then`, `… else`, `case … in`). */
const CONTINUES_KEYWORD_RE = /\b(?:do|then|else|elif|in)$/
/** Trailing run of backslashes (an ODD run continues the line; an even run is
 *  an escaped literal backslash). */
const TRAILING_BACKSLASHES_RE = /(\\+)$/
const COMMENT_LINE_RE = /^\s*#/
/** Presence of one of these means the paste is a shell script / compound
 *  command (`for … do … done`, `if … then … fi`, `while … do`, `{ … }`), whose
 *  newlines are syntactically significant and which the shell already buffers
 *  as ONE command. Such a paste is never modified. */
const COMPOUND_MARKER_RE = /^(?:fi|done|esac|\}|\{)$|\b(?:do|then|else)\s*$/

/** Quote state carried across lines (`null` = not inside a string). */
type QuoteState = '"' | "'" | null

/** Scan one line: return the quote state at its end and the heredoc delimiter
 *  it opens (`<<EOF`, `<<-'EOF'`, …). A deliberately small scanner — it only
 *  needs to know whether the line leaves a construct open. */
function scanOpenState(
  line: string,
  quote: QuoteState,
): { quote: QuoteState; heredoc: string | null } {
  let heredoc: string | null = null
  if (!quote) {
    const m = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line)
    if (m) heredoc = m[2]
  }
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quote) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === '\\') {
      i += 1 // escaped character — never a delimiter
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
  }
  return { quote, heredoc }
}

export interface ContinuationResult {
  text: string
  /** Lines that were given a trailing `\` or had one moved back to the EOL. */
  added: number
}

/** Append a `\` line continuation to every non-final line, so that pressing
 *  Enter submits the whole block as ONE command instead of running each line.
 *
 *  Left alone on purpose:
 *  - empty lines and comments (continuing a comment would swallow the next line);
 *  - lines that already end with `\` or an open operator / block keyword;
 *  - lines inside an open string or heredoc (their content must stay verbatim —
 *    the construct already continues by itself);
 *  - lines followed by an empty line (that blank line ends the command anyway).
 *
 *  A space is inserted before the backslash when the line does not end with
 *  whitespace, otherwise the join would glue tokens together (`echo one` →
 *  `echo one \`, never `echo one\`).
 *
 *  A backslash only continues the line when it is the LAST character, so text
 *  copied out of docs/PDFs as `cd \ ` (backslash + stray space) is repaired by
 *  moving the whitespace off the end — otherwise the shell reads `\ ` as an
 *  escaped space, treats the line as complete and runs it before the next one.
 */
export function withLineContinuation(text: string): ContinuationResult {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const endsWithNewline = normalized.endsWith('\n')
  const body = endsWithNewline ? normalized.slice(0, -1) : normalized
  if (!body) return { text: normalized, added: 0 }

  const lines = body.split('\n')
  // A compound command/script is one command already (the shell keeps the
  // secondary prompt open until the construct is closed) — leave it verbatim,
  // otherwise a `\` would glue the following line INTO the construct.
  if (lines.some((l) => COMPOUND_MARKER_RE.test(l.trim()))) {
    return { text: normalized, added: 0 }
  }
  let added = 0
  let quote: QuoteState = null
  let heredoc: string | null = null

  // The last line is never touched (it is what the user submits as the tail).
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i]
    if (heredoc) {
      // Heredoc body: verbatim. Its terminator line closes the construct and
      // needs no continuation either.
      if (line.trim() === heredoc) heredoc = null
      continue
    }
    if (quote) {
      quote = scanOpenState(line, quote).quote
      continue
    }
    const trimmed = line.trimEnd()
    if (!trimmed || COMMENT_LINE_RE.test(line)) continue
    // An empty (or whitespace-only) next line terminates the command anyway,
    // so a backslash there would be pointless noise.
    if (!lines[i + 1]?.trim()) continue
    const scan = scanOpenState(trimmed, null)
    quote = scan.quote
    heredoc = scan.heredoc
    if (quote || heredoc) continue
    const backslashes = TRAILING_BACKSLASHES_RE.exec(trimmed)?.[1].length ?? 0
    const continuesItself =
      backslashes % 2 === 1 ||
      CONTINUES_OPERATOR_RE.test(trimmed) ||
      CONTINUES_KEYWORD_RE.test(trimmed)
    if (continuesItself) {
      // Already continued — except when the backslash is followed by
      // whitespace (`cd \ `), which is NOT a continuation for the shell: the
      // `\` escapes the space instead and the line runs on its own. Move the
      // backslash back to the end so the pasted block actually continues.
      if (backslashes % 2 === 1 && line !== trimmed) {
        lines[i] = trimmed
        added += 1
      }
      continue
    }
    lines[i] = /\s$/.test(line) ? `${line}\\` : `${trimmed} \\`
    added += 1
  }

  return { text: lines.join('\n') + (endsWithNewline ? '\n' : ''), added }
}

/** First `max` lines of the paste, for the confirmation preview. */
export function pastePreview(text: string, max: number = PASTE_PREVIEW_LINES): string[] {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const trimmed = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized
  const lines = trimmed ? trimmed.split('\n') : []
  if (lines.length <= max) return lines
  return [...lines.slice(0, max), `… (+${lines.length - max})`]
}

export interface PastePlanInput {
  /** Already sanitised text. */
  text: string
  /** `term.modes.bracketedPasteMode` — true when the shell enabled `CSI ? 2004 h`. */
  bracketedPasteMode: boolean
  sessionKind: SessionKind
  /** `localShellType` — decides whether a local session is POSIX. */
  localShellType?: string | null
  config: PasteGuardConfig
}

/** What to do with the paste, plus the exact text each action types. */
export interface PastePlan {
  action: PasteAction
  /** Sanitised text, unchanged — used by `execute` and by the dialog preview. */
  text: string
  /** Text as the INSERTING actions type it (line continuation applied). */
  insertText: string
  /** Lines that received a trailing `\`. */
  continuationAdded: number
  /** Whether `insert without executing` is possible for this session. */
  canInsert: boolean
}

function pickAction(input: PastePlanInput): PasteAction {
  const { text, bracketedPasteMode, sessionKind, localShellType, config } = input
  if (!text) return 'passthrough'
  // Single-line (or below the user's threshold) pastes stay completely
  // untouched — no dialog, exactly the previous behaviour.
  if (pasteLineCount(text) <= config.threshold) return 'passthrough'
  // Master switch off → legacy behaviour (sends raw, shell executes per line).
  if (!config.enabled) return 'passthrough'
  // Serial consoles have no line editor and no concept of "commands": a
  // multi-line paste is almost always a mis-paste into a device console, so it
  // is dropped outright instead of being turned into a dangerous dialog.
  if (sessionKind === 'serial') return 'drop-serial'
  // A shell that enabled bracketed paste treats the paste as literal input:
  // xterm wraps it for us and nothing executes until the user presses Enter.
  if (bracketedPasteMode) return 'passthrough'
  switch (config.mode) {
    case 'execute':
      return 'execute'
    case 'insert':
      // Inserting is impossible without a readline-based shell — fall back to
      // asking rather than silently executing.
      return canQuotedInsert(sessionKind, bracketedPasteMode, localShellType) ? 'insert' : 'ask'
    case 'ask':
    default:
      return 'ask'
  }
}

/** Decide everything about a paste in one pure step (unit-testable, see
 *  `scripts/check-paste-guard.mjs`): the action, whether the safer choices are
 *  available, and the text each action will type.
 *
 *  The line continuation is applied to every path that INSERTS the text
 *  without executing it — the explicit `insert` action AND the automatic
 *  bracketed-paste path — because both leave the block sitting in the edit
 *  buffer, where the shell would still split it at each newline once the user
 *  presses Enter. `execute` (line-by-line) and the legacy passthrough must
 *  stay byte-for-byte identical. */
export function planPaste(input: PastePlanInput): PastePlan {
  const { text, bracketedPasteMode, sessionKind, localShellType, config } = input
  const action = pickAction(input)
  const canInsert = canQuotedInsert(sessionKind, bracketedPasteMode, localShellType)
  const guarded =
    !!text && config.enabled && pasteLineCount(text) > config.threshold && sessionKind !== 'serial'
  const insertionPath =
    action === 'insert' ||
    (action === 'ask' && canInsert) ||
    (action === 'passthrough' && bracketedPasteMode)
  const continuation =
    config.appendContinuation &&
    guarded &&
    insertionPath &&
    isPosixSession(sessionKind, localShellType)
      ? // `execute` / `drop-serial` never carry a modified payload.
        withLineContinuation(text)
      : { text, added: 0 }
  return {
    action,
    text,
    insertText: continuation.text,
    continuationAdded: continuation.added,
    canInsert,
  }
}

/** Action-only convenience wrapper around [`planPaste`]. */
export function decidePasteAction(input: PastePlanInput): PasteAction {
  return planPaste(input).action
}

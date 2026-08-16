import React, { useEffect, useRef, useCallback, useState, useLayoutEffect } from 'react'
import { Terminal } from '@xterm/xterm'
import type { ILink } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SerializeAddon } from '@xterm/addon-serialize'
import { listen } from '@tauri-apps/api/event'
import '@xterm/xterm/css/xterm.css'
import {
  connect,
  sendInput,
  commitCommand,
  pollOutput,
  resizeTerminal,
  openLocalShell,
  localSendInput,
  localResize,
  pollWorkingDir,
  fsListFiles,
} from '../commands'
import { Icon } from './Icon'
import { useI18n } from '../i18n'
import {
  parsePrintCommand,
  highlightLines,
  stripAnsi,
  preloadHighlightLanguages,
} from '../lib/termHighlight'
import { detectLsCommand, parseLsBlock, extractCwdFromPrompt } from '../lib/lsParse'
import type { LsEntry } from '../lib/lsParse'
import type { AiTermMark, TargetRef } from '../types'

// Tracks the single "active" terminal instance per session tabId. During a
// transient double-mount (React mounts the new terminal before unmounting the
// old one — e.g. on split/close/reconcile), two instances for the same tabId
// briefly coexist. Only the instance registered here may send input, so the
// stale duplicate can never echo the same keystroke twice into the SSH session
// (which produced bugs like typing "ls" reaching the shell as "lss").
const activeTerminalByTab = new Map<number, Terminal>()

// Tracks the most recently mounted terminal instance for each session tabId,
// regardless of focus. Used by `focusTerminal` so callers outside this file
// (reconnect button, "send to terminal") can move keyboard focus into the
// right xterm instance — even when that terminal is not the currently focused
// pane (e.g. a disconnected tab about to be reconnected).
const latestTerminalByTab = new Map<number, Terminal>()

/** Move keyboard focus into the terminal owned by `tabId` (no-op if none). */
export const focusTerminal = (tabId: number): void => {
  const term = latestTerminalByTab.get(tabId)
  if (term) term.focus()
}

/** Text the user has already typed on the current input line (prompt
 *  stripped), for the terminal owned by `tabId`. Empty if none / unknown. */
export const getTerminalInputText = (tabId: number): string => {
  const term = latestTerminalByTab.get(tabId)
  if (!term) return ''
  return stripPrompt(getCurrentCommandLine(term))
}

// Preserves terminal scrollback across transient re-mounts (float pop-out / dock
// back). React tears down the xterm instance when its portal container changes,
// so we serialize the full buffer (ANSI colors included, via @xterm/addon-serialize)
// here and replay it on the next mount.
const scrollbackCache = new Map<number, string>()

const replayScrollback = (term: Terminal, tabId: number): void => {
  const cached = scrollbackCache.get(tabId)
  if (!cached) return
  scrollbackCache.delete(tabId)
  term.write(cached)
  term.scrollToBottom()
}

// ---- terminal output syntax highlight state machine (cat/head/tail) ----
//
// When the user runs `cat file.py`, we enter "capture" mode: output chunks are
// buffered (ANSI-stripped), complete lines are re-tokenized with Monaco and
// written with ANSI colors as they stream in, and the next shell prompt (or a
// silence timeout) ends the capture. Large outputs fall back to raw passthrough.

interface CaptureState {
  lang: string
  /** Plain-text shell prompt captured from the submitted command line. */
  prompt: string
  /** ANSI-stripped output accumulated since capture started. */
  buf: string
  /** Number of `buf` lines already written to the terminal (line 0 = echo). */
  writtenLines: number
  bytes: number
  timeout: ReturnType<typeof setTimeout> | null
  flushTimer: ReturnType<typeof setTimeout> | null
}

const MAX_HIGHLIGHT_BYTES = 512 * 1024
const CAPTURE_TIMEOUT_MS = 800
const FLUSH_DEBOUNCE_MS = 40

let highlightLanguagesPreloaded = false

function clearCaptureTimers(c: CaptureState): void {
  if (c.timeout) {
    clearTimeout(c.timeout)
    c.timeout = null
  }
  if (c.flushTimer) {
    clearTimeout(c.flushTimer)
    c.flushTimer = null
  }
}

/**
 * Write `buf` lines in the inclusive range `[from, to)`. Line 0 is the shell's
 * echo of the command and is written plainly; the rest are colorized. When
 * `trailingNewline` is true every written line is newline-terminated (used for
 * flushing complete lines only); otherwise only interior lines get the newline.
 */
function writeRange(
  term: Terminal,
  c: CaptureState,
  content: string,
  from: number,
  to: number,
  trailingNewline: boolean,
): void {
  if (to <= from) return
  const lines = content.split('\n')
  const colored = highlightLines(content, c.lang)
  for (let i = from; i < to; i++) {
    term.write(i === 0 ? lines[0] : colored[i])
    if (trailingNewline || i < to - 1) term.write('\r\n')
  }
  c.writtenLines = to
}

/** Flush any new *complete* lines (buffered so far) as colored output. */
function flushCapturedLines(term: Terminal, c: CaptureState): void {
  const completeCount = c.buf.split('\n').length - 1
  writeRange(term, c, c.buf, c.writtenLines, completeCount, true)
}

/** Colorize everything remaining and stop capturing; optionally append the prompt. */
function finalizeCapture(term: Terminal, c: CaptureState, promptEnd: string | null): void {
  clearCaptureTimers(c)
  const content = promptEnd ? c.buf.slice(0, c.buf.length - promptEnd.length) : c.buf
  writeRange(term, c, content, c.writtenLines, content.split('\n').length, false)
  if (promptEnd) term.write(promptEnd)
}

/** Abort capture (over the size threshold): dump the unwritten tail raw. */
function giveUpCapture(term: Terminal, c: CaptureState): void {
  clearCaptureTimers(c)
  const rest = c.buf.split('\n').slice(c.writtenLines).join('\r\n')
  if (rest.length > 0) term.write(rest)
}

/**
 * Feed one output chunk while capturing. `onEnd` is invoked (synchronously for
 * prompt/size endings, or later from the silence timeout) once capture has
 * ended, so the caller can drop the capture state and resume passthrough.
 */
function feedCapture(term: Terminal, c: CaptureState, chunk: string, onEnd: () => void): void {
  c.buf += stripAnsi(chunk)
  c.bytes += chunk.length

  if (c.bytes > MAX_HIGHLIGHT_BYTES) {
    giveUpCapture(term, c)
    onEnd()
    return
  }

  if (c.prompt && c.buf.endsWith(c.prompt)) {
    finalizeCapture(term, c, c.prompt)
    onEnd()
    return
  }

  if (c.flushTimer) clearTimeout(c.flushTimer)
  c.flushTimer = setTimeout(() => {
    c.flushTimer = null
    flushCapturedLines(term, c)
  }, FLUSH_DEBOUNCE_MS)

  if (c.timeout) clearTimeout(c.timeout)
  c.timeout = setTimeout(() => {
    c.timeout = null
    finalizeCapture(term, c, null)
    onEnd()
  }, CAPTURE_TIMEOUT_MS)
}

// ---- AI-issued command/output highlight (ai-term-mark) ----
//
// `run_command_on_terminal` types AI commands into the live shell and emits
// `ai-term-mark` begin/end events. xterm's `onData` never fires for backend
// writes, so the command line can't be detected via keystrokes — instead the
// frontend colorizes the output stream itself: bright cyan + bold for the
// echoed command line (up to its first newline), dim cyan for the command's
// output, restoring the default color on `end`. This is a pure output-stream
// rewrite, so it works identically for SSH and ConPTY local shells.

const AI_CMD_FG = '\x1b[96m\x1b[1m' // bright cyan + bold
const AI_OUTPUT_FG = '\x1b[2m\x1b[36m' // dim cyan
const ANSI_RESET = '\x1b[0m'
const AI_MARK_TIMEOUT_MS = 90_000

/** Truncate a command to a displayable length for the status badge. */
function truncateCmd(cmd: string, max = 40): string {
  if (cmd.length <= max) return cmd
  return cmd.slice(0, max) + '…'
}

interface AiMarkState {
  mode: 'cmd' | 'output' | 'done'
  seq: number
  /** The shell prompt captured at `begin` (plain text, as read from the
   *  terminal buffer). Used to detect when the shell redraws it after the
   *  command finishes — at that point we stop tinting so the prompt keeps its
   *  original color instead of inheriting the AI output tint. */
  prompt: string
}

/** Rewrite a chunk's foreground color, dropping any pre-existing SGR color. */
function colorizeChunk(chunk: string, fg: string): string {
  if (!chunk.includes('\x1b[')) return fg + chunk + ANSI_RESET
  return fg + chunk.replace(/(\x1b\[[0-9;]*m)/g, ANSI_RESET + fg) + ANSI_RESET
}

/** Dim a plain output chunk; pass colored chunks (grep/git) through untouched. */
function colorizeOutputChunk(chunk: string): string {
  if (chunk.includes('\x1b[')) return chunk
  return AI_OUTPUT_FG + chunk + ANSI_RESET
}

// ---- clickable `ls` output (ls/ll/dir) ----
//
// When the user runs `ls -l`/`ll`/`la`/`dir`, output is written to the
// terminal unchanged (passthrough) while being buffered for parsing. Once the
// next prompt (or a silence timeout) ends the block, each entry's name becomes
// a clickable xterm link (via registerLinkProvider): directories send
// `cd <name>`, files open in the editor. The row for each entry is derived
// from the buffer row captured when the command was submitted.

const LS_CAPTURE_TIMEOUT_MS = 2000
const LS_MAX_BYTES = 128 * 1024

interface LsCaptureState {
  format: 'long' | 'dir' | 'multi' | 'multiF'
  prompt: string
  /** Absolute buffer row of the echoed command line (captured at submit). */
  startRow: number
  buf: string
  bytes: number
  timeout: ReturnType<typeof setTimeout> | null
}

/**
 * A parsed `ls` entry bound to the absolute base directory of *its own*
 * listing (captured at submit time). Carrying the baseDir per entry — rather
 * than reading a single global "latest listing" ref — is what lets multiple
 * listings coexist on screen: each click resolves against the directory of
 * the listing it came from, even after a newer `ls` has run elsewhere.
 */
interface LsClickableEntry extends LsEntry {
  baseDirPromise: Promise<string | null>
}

function joinPath(base: string, name: string): string {
  if (!base) return name
  // Use the host's native separator so Windows local paths stay `C:\a\b`
  // (cmd/PowerShell/backend PathBuf all accept it) and Unix paths stay `/a/b`.
  const sep = /^[A-Za-z]:[\\/]/.test(base) ? '\\' : '/'
  return `${base.replace(/[\\/]+$/, '')}${sep}${name}`
}

/** Extract a single non-flag path argument from an `ls`-style command, if any. */
function extractLsTargetArg(cmd: string): string | null {
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
function resolveLsBaseDir(cwd: string | null, targetArg: string | null): string | null {
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
function expandTilde(cwd: string | null, home: string | null): string | null {
  if (!cwd) return null
  if (cwd === '~') return home ?? cwd
  if (cwd.startsWith('~/') && home) return `${home}${cwd.slice(1)}` // cwd.slice(1) → '/…'
  return cwd
}

interface TerminalComponentProps {
  tabId: number
  isActive: boolean
  isFocused?: boolean
  /** Current shell view for this tab's pane ("terminal", editor key, docker
   *  log key). When transitioning back to "terminal" (e.g. from file editor),
   *  the terminal is automatically focused. */
  shellView?: string
  reconnectTrigger?: number
  connectConfig?: {
    id: string
    name?: string
    host: string
    port: number
    username: string
    password?: string
    keyPath?: string
  }
  /** When true, run a local PTY-backed shell instead of an SSH connection. */
  isLocal?: boolean
  /** Working directory to start the local shell in (local mode only). */
  localCwd?: string
  /** Shell command to use for the local shell (local mode only). */
  localShellType?: string
  autoConnect: boolean
  /** Maximum scrollback lines to retain (default 5000). */
  maxScrollback?: number
  onStatusChange: (
    status: 'connecting' | 'connected' | 'error' | 'disconnected',
    errorMessage?: string,
  ) => void
  onSizeChange?: (cols: number, rows: number) => void
  onAskAi?: (selectedText: string) => void
  /** Save the selected text as a command snippet (floating command list). */
  onAddCommandSnippet?: (text: string) => void
  /** Open a file (clicked in `ls` output) in the remote/local editor. */
  onOpenFile?: (target: TargetRef, path: string) => void
}

export const TerminalComponent: React.FC<TerminalComponentProps> = ({
  tabId,
  isActive,
  isFocused,
  shellView,
  reconnectTrigger,
  connectConfig,
  autoConnect,
  maxScrollback,
  onStatusChange,
  onSizeChange,
  onAskAi,
  onAddCommandSnippet,
  onOpenFile,
  isLocal,
  localCwd,
  localShellType,
}) => {
  const { t } = useI18n()
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const isActiveRef = useRef(isActive)
  const tabIdRef = useRef(tabId)
  const connectConfigRef = useRef(connectConfig)
  const onStatusChangeRef = useRef(onStatusChange)
  const onSizeChangeRef = useRef(onSizeChange)
  const onOpenFileRef = useRef(onOpenFile)
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const hasRun = useRef(false)
  const reconnectTriggerRef = useRef(reconnectTrigger ?? 0)
  const localShellTypeRef = useRef(localShellType)
  const resizeObserverRef = useRef<ResizeObserver | null>(null)
  // B16: last successfully-sent geometry, used to skip redundant resize sends.
  const lastColsRef = useRef(0)
  const lastRowsRef = useRef(0)
  // Guards sendResize until the backend shell is registered (otherwise ResizeObserver
  // fires before openLocalShell resolves, producing "local_resize: Local shell not found").
  const connectedRef = useRef(false)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null)
  const ctxMenuRef = useRef<HTMLDivElement | null>(null)
  // Clickable hover card shown over a clickable `ls`/`dir` entry, like VSCode's
  // terminal link tooltip ("Enter folder" / "Open file" + modifier hint). The
  // card itself is clickable and triggers the same action as the link. It is
  // anchored to the top-left of the entry name (not the mouse) and appears
  // after a short delay.
  const [linkTooltip, setLinkTooltip] = useState<{
    x: number
    y: number
    below?: boolean
    entry: LsClickableEntry
  } | null>(null)
  // Delay hiding the card after leaving the link, so the mouse can reach the
  // card and click it (the card floats above the link).
  const linkTooltipHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Delay showing the card until the mouse has hovered the link for 500ms.
  const linkTooltipShowTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // The entry whose card is currently displayed (prevents re-arming the 500ms
  // delay on repeat hover callbacks for the same link).
  const linkTooltipEntryRef = useRef<LsClickableEntry | null>(null)

  // Compute the screen position of a link's top-left corner. `bufferRow` is the
  // 0-based buffer row and `col` the 0-based column where the link text starts.
  const computeLinkAnchor = (
    term: Terminal,
    bufferRow: number,
    col: number,
  ): { x: number; y: number; cellH: number } | null => {
    const rect = term.element?.getBoundingClientRect()
    if (!rect) return null
    const core = (term as unknown as {
      _core?: { _renderService?: { dimensions?: { css?: { cell?: { width: number; height: number } } } } }
    })._core
    let cellW = core?._renderService?.dimensions?.css?.cell?.width
    let cellH = core?._renderService?.dimensions?.css?.cell?.height
    if (!cellW || !cellH) {
      cellW = rect.width / Math.max(1, term.cols)
      cellH = rect.height / Math.max(1, term.rows)
    }
    const baseY = term.buffer.active.baseY
    const rowInViewport = bufferRow - baseY
    return {
      x: rect.left + col * cellW,
      y: rect.top + rowInViewport * cellH,
      cellH,
    }
  }

  // ---- custom overlay scrollbar (B13: terminal needs a visible scrollbar) ----
  const [scrollThumb, setScrollThumb] = useState({ h: 0, t: 0, show: false })
  const scrollThumbDragging = useRef(false)
  const scrollThumbDragY = useRef(0)
  const scrollThumbDragStart = useRef(0)
  const viewportRef = useRef<HTMLElement | null>(null)
  const scrollHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scheduleScrollHide = useRef<() => void>(() => {})

  // ---- terminal output syntax highlighting (cat/head/tail) ----
  const captureRef = useRef<CaptureState | null>(null)

  const resetCapture = () => {
    const c = captureRef.current
    if (c) clearCaptureTimers(c)
    captureRef.current = null
  }

  // ---- clickable `ls` output (ls/ll/dir) ----
  const lsCaptureRef = useRef<LsCaptureState | null>(null)
  // Parsed ls entries keyed by absolute buffer row (0-based), consumed by the
  // link provider that is registered once per terminal. Multiple listings
  // accumulate here (a new `ls` does NOT clear the old ones) — entries from
  // older listings stay clickable as long as their rows remain in the buffer,
  // each carrying its own baseDir so a click resolves against the right dir.
  const lsEntriesRef = useRef<Map<number, LsClickableEntry[]>>(new Map())
  // Cache of `ls -F`/plain-`ls` dir-vs-file lookups, keyed by the listing's
  // base dir → (name → isDir). Plain `ls` entries are tagged `unknown` (the
  // output carries no type info), so on click we list the base dir once and
  // memoize the result to avoid re-listing on every click of the same listing.
  const lsDirCacheRef = useRef<Map<string, Map<string, boolean>>>(new Map())
  // Base directory of the listing currently being captured (set by
  // startLsCaptureIfMatch, consumed by finalizeLsCapture → setLsEntries to bind
  // onto each entry). Not read at click time — clicks use entry.baseDirPromise.
  const lsBaseDirPromiseRef = useRef<Promise<string | null> | null>(null)

  const clearLsLinks = () => {
    lsEntriesRef.current.clear()
    lsDirCacheRef.current.clear()
  }

  const resetLsCapture = () => {
    const c = lsCaptureRef.current
    if (c && c.timeout) clearTimeout(c.timeout)
    lsCaptureRef.current = null
    lsBaseDirPromiseRef.current = null
    // NOTE: do NOT clearLsLinks() here. A new `ls`/`ll`/`dir` must NOT wipe the
    // previous listing's clickable entries — they stay clickable while their
    // rows are still in the buffer (the link provider matches live line text,
    // so scrolled-off entries can't produce phantom links). Only the true
    // resets (clear / disconnect / reconnect / AI command / unmount) call
    // clearLsLinks().
  }

  // Resolve whether a plain-`ls` (`unknown`-kind) entry is a directory, by
  // listing its base dir (cached per base dir). Returns null when the lookup
  // can't be performed (no base dir, or the listing failed) — callers fall
  // back to a best-effort default.
  const lookupIsDir = async (
    baseDirPromise: Promise<string | null>,
    name: string,
  ): Promise<boolean | null> => {
    const base = await baseDirPromise
    if (!base) return null
    const cache = lsDirCacheRef.current
    let dirMap = cache.get(base)
    if (dirMap?.has(name)) return dirMap.get(name) ?? null
    try {
      const target: TargetRef = isLocal
        ? { kind: 'local', tabId: tabIdRef.current }
        : { kind: 'session', tabId: tabIdRef.current }
      const entries = await fsListFiles(target, base)
      dirMap = new Map(entries.map((e) => [e.name, e.isDir]))
      cache.set(base, dirMap)
      return dirMap.get(name) ?? null
    } catch {
      return null
    }
  }

  const onLsEntryClick = async (entry: LsClickableEntry) => {
    // Resolve the entry's absolute path from *this listing's* base directory
    // (captured at submit time and bound to the entry), so the click lands in
    // the right place even after the user has `cd`'d away — and even if a newer
    // `ls` has since run in a different directory.
    const base = (await entry.baseDirPromise) ?? null
    const abs = base ? joinPath(base, entry.name) : entry.name
    // Plain `ls` (multi format) carries no type info — resolve dir-vs-file at
    // click time. On lookup failure, default to treating it as a directory: a
    // `cd` into a file fails gently in the shell, whereas opening a directory
    // in the editor pops an error dialog.
    let isDir = entry.kind === 'dir'
    if (entry.kind === 'unknown') {
      const resolved = await lookupIsDir(entry.baseDirPromise, entry.name)
      isDir = resolved === null ? true : resolved
    }
    if (isDir) {
      if (isLocal) {
        // cmd/PowerShell: double-quote to tolerate spaces; both accept it.
        localSendInput(tabIdRef.current, `cd "${abs}"\r`).catch((e) =>
          console.error('local_send_input error:', e),
        )
      } else {
        // `~` must stay unquoted so the shell expands it; absolute/relative
        // paths are single-quoted to tolerate spaces and special chars.
        const cmd = abs.startsWith('~')
          ? `cd -- ${abs}\r`
          : `cd -- '${abs.replace(/'/g, "'\\''")}'\r`
        sendInput(tabIdRef.current, cmd)
      }
      return
    }
    void openLsFile(abs)
  }

  const openLsFile = async (absPath: string) => {
    const cb = onOpenFileRef.current
    if (!cb) return
    const target: TargetRef = isLocal
      ? { kind: 'local', tabId: tabIdRef.current }
      : { kind: 'session', tabId: tabIdRef.current }
    cb(target, absPath)
  }

  // The parsed `entry.line` is a logical-line index into the (ANSI-stripped)
  // captured buffer, which only equals the rendered absolute row when there is a
  // perfect 1:1 mapping between logical lines and terminal rows. That assumption
  // breaks when the terminal wraps a long line (a long prompt + command, or a
  // long entry line) or inserts an extra blank/redraw line between the echoed
  // command and the listing — every following entry then lands one or more rows
  // away from `startRow + entry.line`, so a click would `cd` into the directory
  // rendered *above* the one that was clicked. Resolve the real absolute buffer
  // row by matching the entry name against the live terminal near the expected
  // row (searching outward in both directions).
  const resolveLsRow = (term: Terminal, expectedRow: number, entry: LsEntry): number => {
    const buf = term.buffer.active
    // Column-anchored + name-boundary match. The name must sit exactly at
    // [col, col+len) on the candidate row, AND the character immediately after
    // it must be a boundary (EOL / whitespace / start of a ` -> ` symlink
    // arrow). Otherwise a shorter name like `password-platform` wrongly passes
    // when evaluated against a row that actually contains the longer name
    // `password-platform-dev` at the same column (the first 17 chars match,
    // but `-dev` follows so it's a different entry).
    const nameAt = (y: number): boolean => {
      const line = buf.getLine(y)
      if (!line) return false
      const text = line.translateToString(true)
      const len = entry.name.length
      // Mirror the link provider: the name begins on its "home" visual row at
      // `entry.col % cols` (the raw column for an unwrapped line). Accept either
      // the full name or, when the wrap splits it, just the visible leading
      // chunk.
      const cols = term.cols
      const homeCol = cols > 0 ? entry.col % cols : entry.col
      const visOnHome = cols > 0 ? Math.min(len, cols - homeCol) : len
      const wrapped = cols > 0 && entry.col >= cols
      if (visOnHome === len) {
        if (text.slice(homeCol, homeCol + len) !== entry.name) return false
      } else if (visOnHome > 0) {
        if (text.slice(homeCol, homeCol + visOnHome) !== entry.name.slice(0, visOnHome)) return false
      } else {
        return false
      }
      // Before-boundary: skip for wrapped entries (the char before is wrapped
      // remainder text); for non-wrapped entries require whitespace/row-start so
      // a shorter name doesn't match inside a longer neighbor.
      if (!wrapped) {
        const before = homeCol > 0 ? text[homeCol - 1] : undefined
        if (before !== undefined && !/\s/.test(before)) return false
      }
      if (visOnHome === len) {
        const end = homeCol + len
        const after = text[end]
        // Boundary: EOL / whitespace / symlink arrow / an `ls -F` type indicator
        // (`/ @ * = |`) — the indicator trails the name on screen but isn't part
        // of entry.name (parseMultiLine strips it), so it must count as a valid
        // boundary or `dir/` won't match the `dir` entry.
        if (
          !(
            after === undefined ||
            /\s/.test(after) ||
            text.slice(end, end + 4) === ' -> ' ||
            /[@*=|/]/.test(after)
          )
        )
          return false
      }
      return true
    }
    if (nameAt(expectedRow)) return expectedRow
    // The expected row can drift when the buffer scrolled between submit and
    // finalize (full scrollback) or an extra blank/redraw line was emitted —
    // search outward for the real row.
    for (let d = 1; d <= 12; d++) {
      if (nameAt(expectedRow - d)) return expectedRow - d
      if (nameAt(expectedRow + d)) return expectedRow + d
    }
    return expectedRow
  }

  // Append a freshly parsed ls block's entries to the link table. Rows are
  // resolved against the live terminal buffer (not just `startRow + entry.line`)
  // so the link provider matches the lines xterm actually renders. Each entry is
  // bound to its listing's `baseDirPromise` so a click resolves against the
  // right directory even when several listings coexist on screen. Also paints a
  // subtle background highlight on each entry name. Does NOT clear previous
  // listings — those stay clickable while their rows remain in the buffer.
  const setLsEntries = (
    startRow: number,
    entries: LsEntry[],
    baseDirPromise: Promise<string | null>,
  ) => {
    const term = termRef.current
    const map = lsEntriesRef.current
    // GC: drop entries whose row has scrolled out of the buffer. Keeps the map
    // bounded across many ls invocations without affecting visible listings
    // (the link provider reads live line text anyway, so a stale row can never
    // match once it's gone from the buffer).
    if (term) {
      const bufLen = term.buffer.active.length
      if (bufLen > 0) {
        for (const row of map.keys()) {
          if (row >= bufLen) map.delete(row)
        }
      }
    }
    for (const entry of entries) {
      const row = term ? resolveLsRow(term, startRow + entry.line, entry) : startRow + entry.line
      const clickable: LsClickableEntry = { ...entry, baseDirPromise }
      const arr = map.get(row)
      if (arr) arr.push(clickable)
      else map.set(row, [clickable])
      // No background-color decoration: the link provider (hover underline +
      // pointer cursor) is the sole visual affordance that the name is
      // clickable. xterm decorations only support backgroundColor/foregroundColor
      // (no underline), and a persistent background was deemed too noisy.
    }
  }

  const finalizeLsCapture = (term: Terminal, ls: LsCaptureState, promptEnd: string | null) => {
    if (ls.timeout) {
      clearTimeout(ls.timeout)
      ls.timeout = null
    }
    lsCaptureRef.current = null
    let text = ls.buf
    if (promptEnd) text = text.slice(0, text.length - promptEnd.length)
    const entries = parseLsBlock(text, ls.format)
    const baseDirPromise = lsBaseDirPromiseRef.current
    if (entries.length > 0 && baseDirPromise) {
      setLsEntries(ls.startRow, entries, baseDirPromise)
    }
  }

  const writeLsChunk = (term: Terminal, ls: LsCaptureState, chunk: string) => {
    term.write(chunk)
    ls.buf += stripAnsi(chunk)
    ls.bytes += chunk.length
    if (ls.bytes > LS_MAX_BYTES) {
      resetLsCapture()
      return
    }
    if (ls.prompt && ls.buf.endsWith(ls.prompt)) {
      finalizeLsCapture(term, ls, ls.prompt)
      return
    }
    if (ls.timeout) clearTimeout(ls.timeout)
    ls.timeout = setTimeout(() => {
      ls.timeout = null
      finalizeLsCapture(term, ls, null)
    }, LS_CAPTURE_TIMEOUT_MS)
  }

  const startLsCaptureIfMatch = (cmd: string, prompt: string) => {
    const format = detectLsCommand(cmd)
    if (!format) return
    resetCapture()
    resetLsCapture()
    const term = termRef.current
    if (!term) return
    // Capture the listing's base directory now (at submit time) so later clicks
    // resolve the correct absolute path regardless of the current cwd.
    //
    // SSH: the interactive shell's cwd is parsed from the *prompt* — the prompt
    // reflects the real session cwd. A fresh `poll_working_dir` connection runs
    // `pwd` in the user's $HOME, NOT the shell's current dir, so it can't be
    // trusted for the cwd; it's fired only to fetch $HOME so a leading `~` (from
    // the prompt or from `ls -l ~/docs`) can be expanded to an absolute path
    // (SFTP doesn't expand `~`, and the backend `expand_tilde` uses the *local*
    // machine's home, not the remote one).
    // Local: cwd from the prompt, falling back to the shell's start dir.
    const targetArg = extractLsTargetArg(cmd)
    const promptCwd = extractCwdFromPrompt(prompt || '')
    const homePromise: Promise<string | null> = isLocal
      ? Promise.resolve(null)
      : pollWorkingDir(tabIdRef.current).catch(() => null)
    lsBaseDirPromiseRef.current = homePromise.then((home) => {
      const cwd = isLocal ? (promptCwd ?? localCwd ?? null) : (promptCwd ?? home)
      const base = resolveLsBaseDir(cwd, targetArg)
      return isLocal ? base : expandTilde(base, home)
    })
    const buf = term.buffer.active
    lsCaptureRef.current = {
      format,
      prompt: prompt || '',
      startRow: buf.baseY + buf.cursorY,
      buf: '',
      bytes: 0,
      timeout: null,
    }
  }

  // ---- AI-issued command/output highlight (ai-term-mark) ----
  const aiMarkRef = useRef<AiMarkState | null>(null)
  const aiMarkTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Execution-status badge ("AI running → done/error") driven by the same
  // ai-term-mark events, rendered as a DOM overlay on top of the terminal.
  interface AiBadgeState {
    state: 'running' | 'done' | 'error'
    seq: number
    command: string
    elapsedMs?: number
    timedOut?: boolean
    truncated?: boolean
    error?: string | null
  }
  const [aiBadge, setAiBadge] = useState<AiBadgeState | null>(null)
  const aiBadgeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearAiBadgeTimeout = () => {
    if (aiBadgeTimeoutRef.current) {
      clearTimeout(aiBadgeTimeoutRef.current)
      aiBadgeTimeoutRef.current = null
    }
  }

  const clearAiMarkTimeout = () => {
    if (aiMarkTimeoutRef.current) {
      clearTimeout(aiMarkTimeoutRef.current)
      aiMarkTimeoutRef.current = null
    }
  }

  // Restore default color on `end`. (No timed-out/truncated status text is
  // written here: appending anything after the shell prompt would desync the
  // cursor the same way injecting extra rows does for ConPTY/readline repaints.
  // Those hints already surface in the AI chat panel's result note.)
  const endAiMark = (mark: AiTermMark) => {
    const st = aiMarkRef.current
    if (!st || mark.seq !== st.seq) return // stale end — ignore
    clearAiMarkTimeout()
    aiMarkRef.current = null
    termRef.current?.write(ANSI_RESET)
  }

  // Read the shell's current prompt (last non-empty viewport line) at `begin`
  // time, before the AI command is typed. Used by the output colorizer to stop
  // tinting when the shell redraws this prompt after the command finishes.
  const readPromptFromTerm = (term: Terminal): string => {
    const buf = term.buffer.active
    const cursorRow = buf.baseY + buf.cursorY
    for (let y = cursorRow; y >= 0; y--) {
      const line = buf.getLine(y)
      if (!line) continue
      const text = line.translateToString(true).trim()
      if (text) return text
    }
    return ''
  }

  const beginAiMark = (mark: AiTermMark) => {
    // An AI command supersedes any in-flight cat/head/tail capture and any
    // stale clickable `ls` overlays.
    resetCapture()
    resetLsCapture()
    clearLsLinks()
    const term = termRef.current
    aiMarkRef.current = {
      mode: 'cmd',
      seq: mark.seq,
      prompt: term ? readPromptFromTerm(term) : '',
    }
    clearAiMarkTimeout()
    // Safety net: if the backend dies before emitting `end`, stop coloring.
    aiMarkTimeoutRef.current = setTimeout(() => {
      aiMarkTimeoutRef.current = null
      aiMarkRef.current = null
      termRef.current?.write(ANSI_RESET)
    }, AI_MARK_TIMEOUT_MS)
  }

  const writeAiChunk = (st: AiMarkState, chunk: string) => {
    const term = termRef.current
    if (!term) return
    // After the trailing prompt has been seen, pass everything through untouched
    // (the `end` event hasn't arrived yet, but coloring is done).
    if (st.mode === 'done') {
      term.write(chunk)
      return
    }
    if (st.mode === 'output') {
      // The shell redraws its prompt after the command finishes, and that prompt
      // arrives as part of the output stream *before* the `end` event. Tinting
      // it leaves the prompt stuck in the AI output color. Detect the prompt
      // (captured at `begin`) and stop coloring at it. Only checked for plain
      // chunks: a chunk carrying ANSI (colored PS1, or grep/git output) is
      // already passed through untouched by colorizeOutputChunk, so its prompt
      // keeps its color already.
      if (st.prompt && st.prompt.length >= 3 && !chunk.includes('\x1b[')) {
        const idx = chunk.indexOf(st.prompt)
        if (idx !== -1) {
          const before = chunk.slice(0, idx)
          term.write(AI_OUTPUT_FG + before + ANSI_RESET + chunk.slice(idx))
          st.mode = 'done'
          return
        }
      }
      term.write(colorizeOutputChunk(chunk))
      return
    }
    // cmd mode: the echoed command line is everything up to its first newline;
    // what follows is output.
    const idx = chunk.indexOf('\n')
    if (idx === -1) {
      term.write(colorizeChunk(chunk, AI_CMD_FG))
    } else {
      term.write(colorizeChunk(chunk.slice(0, idx + 1), AI_CMD_FG))
      st.mode = 'output'
      const rest = chunk.slice(idx + 1)
      if (rest.length > 0) writeAiChunk(st, rest)
    }
  }

  // Single funnel for all output chunks: AI-command coloring first, then the
  // ls clickable capture, then the cat/head/tail capture machine, otherwise
  // passthrough.
  const writeOutput = (chunk: string) => {
    const term = termRef.current
    if (!term) return
    const ai = aiMarkRef.current
    if (ai) {
      writeAiChunk(ai, chunk)
      return
    }
    const ls = lsCaptureRef.current
    if (ls) {
      writeLsChunk(term, ls, chunk)
      return
    }
    const c = captureRef.current
    if (!c) {
      term.write(chunk)
      return
    }
    feedCapture(term, c, chunk, () => {
      captureRef.current = null
    })
  }

  const startCaptureIfPrint = (cmd: string, prompt: string) => {
    resetCapture()
    const match = parsePrintCommand(cmd)
    if (!match) return
    // NOTE: do NOT clearLsLinks() here. A previous `ls` listing may still be
    // visible on screen and should stay clickable. The link provider matches
    // live line text (column-anchored + name-boundary), so `cat`/`head`/`tail`
    // output can only produce a link where it genuinely matches an entry name
    // at the right column — which is benign (the user sees the name and can
    // click it). Listings are cleared only on clear/disconnect/reconnect/AI
    // command/unmount.
    captureRef.current = {
      lang: match.lang,
      prompt: prompt || '',
      buf: '',
      writtenLines: 0,
      bytes: 0,
      timeout: null,
      flushTimer: null,
    }
  }

  // Keep the right-click menu fully on-screen (e.g. when triggered near the
  // bottom edge of the shell pane it would otherwise be clipped).
  useLayoutEffect(() => {
    if (!ctxMenu) return
    const el = ctxMenuRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const vh = window.innerHeight
    const vw = window.innerWidth
    let top = ctxMenu.y
    if (top + rect.height > vh - 8) {
      top = Math.max(8, vh - rect.height - 8)
    }
    let left = ctxMenu.x
    if (left + rect.width > vw - 8) {
      left = Math.max(8, vw - rect.width - 8)
    }
    el.style.top = `${top}px`
    el.style.left = `${left}px`
  }, [ctxMenu])

  useEffect(() => {
    isActiveRef.current = isActive
  }, [isActive])
  useEffect(() => {
    tabIdRef.current = tabId
  }, [tabId])
  useEffect(() => {
    connectConfigRef.current = connectConfig
  })
  useEffect(() => {
    localShellTypeRef.current = localShellType
  })
  useEffect(() => {
    onStatusChangeRef.current = onStatusChange
  })
  useEffect(() => {
    onSizeChangeRef.current = onSizeChange
  })
  useEffect(() => {
    onOpenFileRef.current = onOpenFile
  })

  // Calculate terminal cols/rows and send resize command
  const sendResize = useCallback(
    (term: Terminal) => {
      const cols = term.cols
      const rows = term.rows
      console.log(`[Terminal] resizing to ${cols}x${rows}`)
      onSizeChangeRef.current?.(cols, rows)
      if (isLocal) {
        if (connectedRef.current) {
          localResize(tabIdRef.current, cols, rows).catch((err) =>
            console.error('local_resize error:', err),
          )
        }
      } else {
        if (connectedRef.current) {
          resizeTerminal(tabIdRef.current, cols, rows).catch((err) =>
            console.error('resize_terminal error:', err),
          )
        }
      }
    },
    [isLocal],
  )

  // Create terminal + start connection + poll output
  useEffect(() => {
    console.log(
      '[Terminal] effect running, containerRef=',
      !!containerRef.current,
      'autoConnect=',
      autoConnect,
      'hasRun=',
      hasRun.current,
    )
    if (!containerRef.current || !autoConnect || hasRun.current) {
      console.log('[Terminal] effect early return')
      return
    }
    hasRun.current = true

    if (!highlightLanguagesPreloaded) {
      highlightLanguagesPreloaded = true
      preloadHighlightLanguages()
    }

    const cfg = connectConfigRef.current
    console.log('[Terminal] connectConfig=', cfg)
    // Local shells have no SSH connectConfig — only SSH sessions need it. Without
    // this guard, opening a local terminal would bail here and never start.
    if (!cfg && !isLocal) {
      console.log('[Terminal] no cfg, return')
      return
    }

    const currentTabId = tabIdRef.current

    // Colorize AI-issued command lines and their output on this terminal (see
    // the ai-term-mark state machine above). Filtered to this tab; the backend
    // emits begin/end around every run_command_on_terminal.
    let unlistenAiMark: (() => void) | null = null
    listen<AiTermMark>('ai-term-mark', (event) => {
      const m = event.payload
      if (m.tabId !== currentTabId) return
      if (m.mark === 'begin') {
        beginAiMark(m)
        clearAiBadgeTimeout()
        setAiBadge({ state: 'running', seq: m.seq, command: m.command })
      } else if (m.mark === 'end') {
        endAiMark(m)
        // Only the badge for the currently running command gets updated; a
        // stale end (different seq) is ignored.
        setAiBadge((prev) => {
          if (prev && prev.seq !== m.seq) return prev
          return {
            state: 'done',
            seq: m.seq,
            command: m.command,
            elapsedMs: m.elapsedMs ?? 0,
            timedOut: m.timedOut,
            truncated: m.truncated,
          }
        })
        clearAiBadgeTimeout()
        aiBadgeTimeoutRef.current = setTimeout(() => setAiBadge(null), 3000)
      } else if (m.mark === 'error') {
        // Error marks reset the coloring state machine too (a begin may or may
        // not have fired before the rejection).
        endAiMark(m)
        setAiBadge({
          state: 'error',
          seq: m.seq,
          command: m.command,
          error: m.error ?? t('aiTermError'),
        })
        clearAiBadgeTimeout()
        aiBadgeTimeoutRef.current = setTimeout(() => setAiBadge(null), 5000)
      }
    }).then((un) => {
      unlistenAiMark = un
    })

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: '"Fira Code", "Cascadia Code", Consolas, "Courier New", monospace',
      scrollback: maxScrollback ?? 5000,
      // NOTE: do NOT enable `windowsMode`. It is the legacy winpty / pre-1903
      // ConPTY workaround (forces a line feed at the right edge and disables
      // reflow) and actively misaligns rows against a modern ConPTY, which
      // already emits proper VT sequences.
      theme: {
        background: '#00000000',
        foreground: '#d4d4d4',
        cursor: '#aeafad',
        selectionBackground: '#264f78',
        black: '#1e1e1e',
        red: '#f44747',
        green: '#3a8558',
        yellow: '#dcdcaa',
        blue: '#b8e0ff',
        magenta: '#c586c0',
        cyan: '#4dc9b0',
        white: '#d4d4d4',
        brightBlack: '#808080',
        brightRed: '#f44747',
        brightGreen: '#4daa6a',
        brightYellow: '#dcdcaa',
        brightBlue: '#d4ecff',
        brightMagenta: '#d4a0d4',
        brightCyan: '#6ae6cc',
        brightWhite: '#ffffff',
      },
      allowProposedApi: true,
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    // Serialize addon snapshots the full screen (colors + cursor) so a re-mounted
    // instance (float pop-out / dock-back) can replay it exactly.
    const serializeAddon = new SerializeAddon()
    term.loadAddon(serializeAddon)
    term.open(containerRef.current)

    // Replay any scrollback cached from a previous mount (float pop-out / dock-back)
    // before fitting/connecting, so the user's prior output is restored. Done here
    // (not in the fit step) so every re-mounted instance restores content rather than
    // a transient instance overwriting the cache with empty output.
    replayScrollback(term, currentTabId)

    termRef.current = term
    fitRef.current = fitAddon
    // Register this instance so external callers (reconnect, "send to terminal")
    // can focus it. Overwrites any stale instance for the same tabId.
    latestTerminalByTab.set(currentTabId, term)

    // Clickable `ls` output: a single link provider makes directory/file names
    // from any parsed `ls` block hoverable (underline + pointer) and clickable.
    // Multiple listings accumulate (a new `ls` doesn't clear the old ones); the
    // provider matches against the live hovered line, so only entries whose
    // names are actually visible at the cursor produce links. xterm's linkifier
    // handles the mouse events natively — far more reliable than decoration
    // overlays for receiving clicks.
    const lsLinkProviderDisposable = term.registerLinkProvider({
      provideLinks: (bufferLineNumber, callback) => {
        const term = termRef.current
        const entries = lsEntriesRef.current
        if (!term || entries.size === 0) {
          callback([])
          return
        }
        const buf = term.buffer.active
        // Match entries against the *live* hovered line, not cached row keys.
        // xterm's `bufferLineNumber` is 1-based and `getLine` is 0-based, so the
        // hovered row is `bufferLineNumber - 1`. Reading the line text and
        // requiring the entry's name to sit exactly at its recorded column (plus
        // a name boundary) makes the click land on whatever is visibly under the
        // cursor — immune to scroll, to substring names (`dir` won't match a row
        // showing `dir1`), and to multiple listings sharing the buffer.
        const line = buf.getLine(bufferLineNumber - 1)
        if (!line) {
          callback([])
          return
        }
        const allEntries: LsClickableEntry[] = []
        for (const arr of entries.values()) allEntries.push(...arr)
        const links: ILink[] = []
        const seen = new Set<LsClickableEntry>()
        const cols = term.cols
        if (cols <= 0) {
          callback([])
          return
        }
        // A long `ls -l` line is wrapped by xterm across several visual rows of
        // width `cols`. The name may therefore be split across rows (e.g.
        // `longfile…` at the end of one row, `…name` at the start of the next),
        // and CJK / wide characters make a naive character-count mapping
        // between `entry.col` and xterm columns incorrect. We rebuild the full
        // logical line directly from the buffer, then map the name occurrence
        // back to the hovered visual row using each character's real xterm cell
        // column.
        // Walk up while the line at `firstRow` itself is marked `isWrapped`
        // (`isWrapped` means "this line is a continuation of the line above").
        let firstRow = bufferLineNumber - 1
        while (firstRow > 0) {
          const cur = buf.getLine(firstRow)
          if (cur && cur.isWrapped) firstRow--
          else break
        }
        const hoveredRowIdx = bufferLineNumber - 1 - firstRow

        // Reconstruct the logical line and a map from each logical character to
        // its global (0-based) xterm column. Reading cells directly handles
        // wide characters exactly as xterm renders them.
        //
        // NOTE on `isWrapped` semantics: a row with `isWrapped === true` is a
        // *continuation* of the row above, so the logical line's FIRST row
        // always has `isWrapped === false`. To walk down through the rest of
        // the logical line we must therefore check the NEXT row's `isWrapped`
        // (it continues the current row), never the current row's — checking
        // the current row breaks immediately after the first row, leaving the
        // wrapped remainder of the name out of `logicalText` and breaking
        // every wrapped `ls` link.
        type LogicalChar = { ch: string; globalCol: number }
        const logicalChars: LogicalChar[] = []
        let scanRow = firstRow
        while (true) {
          const l = buf.getLine(scanRow)
          if (!l) break
          const rowBase = (scanRow - firstRow) * cols
          for (let x = 0; x < l.length; x++) {
            const cell = l.getCell(x)
            if (!cell) continue
            const w = cell.getWidth()
            if (w === 0) continue // wide-char padding cell
            const ch = cell.getChars()
            if (ch === '') continue
            logicalChars.push({ ch, globalCol: rowBase + x })
          }
          const next = buf.getLine(scanRow + 1)
          if (!next || !next.isWrapped) break
          scanRow++
        }
        if (logicalChars.length === 0) {
          callback([])
          return
        }
        const logicalText = logicalChars.map((c) => c.ch).join('')
        const endOfLineGlobalCol = (scanRow - firstRow + 1) * cols

        for (const entry of allEntries) {
          if (entry.name.length === 0 || seen.has(entry)) continue

          // Find the occurrence of the name nearest to the parsed column.
          // `entry.col` is a character offset in the (unwrapped) source text,
          // which matches `logicalText` because both are derived from the same
          // terminal output. Multiple matches are disambiguated by proximity.
          let bestIdx = -1
          let bestDist = Infinity
          let searchPos = 0
          while (true) {
            const idx = logicalText.indexOf(entry.name, searchPos)
            if (idx === -1) break
            const dist = Math.abs(idx - entry.col)
            if (dist < bestDist) {
              bestDist = dist
              bestIdx = idx
            }
            searchPos = idx + 1
          }
          if (bestIdx === -1) continue
          const idx = bestIdx
          const len = entry.name.length

          // Boundary check so `bar` doesn't match inside `foobar`.
          const before = idx > 0 ? logicalChars[idx - 1].ch : undefined
          if (before !== undefined && !/\s/.test(before)) continue
          const afterChar = idx + len < logicalChars.length ? logicalChars[idx + len].ch : undefined
          const afterSlice = logicalChars
            .slice(idx + len, idx + len + 4)
            .map((c) => c.ch)
            .join('')
          const boundaryOk =
            afterChar === undefined ||
            /\s/.test(afterChar) ||
            afterSlice === ' -> ' ||
            /[@*=|/]/.test(afterChar)
          if (!boundaryOk) continue

          // Global column range of this occurrence (end is exclusive).
          const startGlobalCol = logicalChars[idx].globalCol
          const endGlobalCol =
            idx + len < logicalChars.length ? logicalChars[idx + len].globalCol : endOfLineGlobalCol

          // Which visual rows does the occurrence span?
          const occStartRow = Math.floor(startGlobalCol / cols)
          const occEndRow = Math.floor((endGlobalCol - 1) / cols)
          if (hoveredRowIdx < occStartRow || hoveredRowIdx > occEndRow) continue

          // Clip to the hovered row.
          const rowStartGlobalCol = hoveredRowIdx * cols
          const rowEndGlobalCol = (hoveredRowIdx + 1) * cols
          const linkStartGlobalCol = Math.max(startGlobalCol, rowStartGlobalCol)
          const linkEndGlobalCol = Math.min(endGlobalCol, rowEndGlobalCol)
          const localStart = linkStartGlobalCol - rowStartGlobalCol
          const localEnd = linkEndGlobalCol - rowStartGlobalCol
          if (localStart < 0 || localEnd <= localStart || localStart >= cols) continue

          seen.add(entry)
          // Top-left of the link text in buffer coordinates (for anchoring the
          // hover card above the entry name, independent of the mouse).
          const linkTopBufferRow = firstRow + occStartRow
          const linkLeftCol = startGlobalCol % cols
          links.push({
            range: {
              start: { x: localStart + 1, y: bufferLineNumber },
              end: { x: localEnd + 1, y: bufferLineNumber },
            },
            text: entry.name,
            decorations: { pointerCursor: true, underline: true },
            hover: () => {
              // Card appears after a 500ms delay, anchored to the top-left of
              // the entry name (like VSCode) instead of following the mouse.
              if (linkTooltipEntryRef.current === entry) return
              if (linkTooltipShowTimer.current) clearTimeout(linkTooltipShowTimer.current)
              linkTooltipShowTimer.current = setTimeout(() => {
                linkTooltipShowTimer.current = null
                const pos = computeLinkAnchor(term, linkTopBufferRow, linkLeftCol)
                if (!pos) return
                linkTooltipEntryRef.current = entry
                if (pos.y < 70) {
                  // Too close to the top edge — show below the name instead.
                  setLinkTooltip({ x: pos.x, y: pos.y + pos.cellH, below: true, entry })
                } else {
                  // Overlap the top of the entry name by 2px.
                  setLinkTooltip({ x: pos.x, y: pos.y - 2, entry })
                }
              }, 800)
            },
            leave: () => {
              if (linkTooltipShowTimer.current) {
                clearTimeout(linkTooltipShowTimer.current)
                linkTooltipShowTimer.current = null
              }
              linkTooltipEntryRef.current = null
              // Delay hiding so the mouse can move up onto the card and click it.
              if (linkTooltipHideTimer.current) clearTimeout(linkTooltipHideTimer.current)
              linkTooltipHideTimer.current = setTimeout(() => setLinkTooltip(null), 300)
            },
            activate: (event) => {
              // Follow the link only when Ctrl (Linux/Windows) or Cmd (macOS) is
              // held, matching VSCode's terminal link behavior.
              if (event.ctrlKey || event.metaKey) {
                onLsEntryClick(entry)
              }
            },
          })
        }
        callback(links)
      },
    })

    // ---- custom overlay scrollbar: track xterm's internal viewport ----
    scheduleScrollHide.current = () => {
      if (scrollHideTimer.current) clearTimeout(scrollHideTimer.current)
      scrollHideTimer.current = setTimeout(() => {
        setScrollThumb((p) => ({ ...p, show: false }))
      }, 1000)
    }
    const updateThumb = () => {
      const vp = viewportRef.current
      if (!vp) return
      const { scrollTop, scrollHeight, clientHeight } = vp
      const pct = scrollHeight > 0 ? clientHeight / scrollHeight : 0
      const h = Math.max(20, Math.round(clientHeight * pct))
      const maxT = clientHeight - h
      const maxS = scrollHeight - clientHeight
      const t = maxS > 0 ? Math.round((scrollTop / maxS) * maxT) : 0
      setScrollThumb((prev) => {
        if (prev.h === h && prev.t === t && prev.show) return prev
        return { h, t, show: true }
      })
      scheduleScrollHide.current()
    }

    const viewport = term.element?.querySelector('.xterm-viewport') as HTMLElement | null
    if (viewport) {
      viewportRef.current = viewport
      viewport.addEventListener('scroll', updateThumb, { passive: true })
      updateThumb()
    }

    const onViewportMouseEnter = () => {
      if (scrollHideTimer.current) clearTimeout(scrollHideTimer.current)
      setScrollThumb((p) => ({ ...p, show: true }))
    }
    const onViewportMouseLeave = (e: MouseEvent) => {
      const rel = e.relatedTarget as HTMLElement | null
      if (rel?.closest('.term-scrollbar')) return
      scheduleScrollHide.current()
    }
    const vpEl = viewport as HTMLElement | undefined
    if (vpEl) {
      vpEl.addEventListener('mouseenter', onViewportMouseEnter)
      vpEl.addEventListener('mouseleave', onViewportMouseLeave)
    }

    // ResizeObserver on the viewport so the thumb updates when xterm re-flows.
    let viewportRO: ResizeObserver | null = null
    if (viewport) {
      viewportRO = new ResizeObserver(() => updateThumb())
      viewportRO.observe(viewport)
    }

    // User input → SSH. During a transient double-mount (React mounts the new
    // terminal before unmounting the old one — e.g. on split/close/reconcile),
    // both instances for the same session can briefly be alive. The guard below
    // (activeTerminalByTab) ensures ONLY the registered, focused instance sends,
    // so a single keystroke is delivered exactly once — no dropped characters
    // (janky/laggy echo or input) and no duplicated characters (e.g. "ls"
    // reaching the shell as "lss").
    term.onData((data) => {
      // Only the registered active instance for this tabId may send. Stale
      // duplicate instances (transient double-mounts) are blocked here, so a
      // single keystroke is sent exactly once.
      if (activeTerminalByTab.get(currentTabId) !== term) return
      // Capture the full command line (with tab-completed text) when the user
      // submits it, before the remote echo changes the buffer row.
      if (data.includes('\r') || data.includes('\n')) {
        commitSubmittedCommands(term, data, currentTabId)
        // A lone Enter submits a single command: detect print-style commands
        // (`cat`/`head`/`tail`) and `ls`-style listings for their respective
        // capture machines. The prompt is captured from the same buffer line so
        // capture can end precisely when the next prompt arrives.
        if (/^[\r\n]+$/.test(data)) {
          const { prompt, command } = splitPromptCommand(getCurrentCommandLine(term))
          // NOTE: do NOT clearLsLinks() on Enter. A previous `ls` listing stays
          // visible on screen across ordinary commands (Enter, `cd`, `cat`, a
          // new `ls`…) and should remain clickable throughout. The link provider
          // matches the *live* hovered line (column-anchored + name-boundary),
          // so entries can't produce phantom links once their rows scroll off —
          // they simply stop matching. Each entry carries its own baseDir, so a
          // click always resolves against the listing it came from, even after
          // a newer `ls` elsewhere. Links are cleared only on:
          //   `clear` / disconnect / reconnect / AI command / unmount.
          startCaptureIfPrint(command, prompt)
          startLsCaptureIfMatch(command, prompt)
        }
      }
      if (isLocal) {
        localSendInput(currentTabId, data).catch((err) =>
          console.error('local_send_input error:', err),
        )
      } else {
        sendInput(currentTabId, data)
          .then(() => {
            // Flush the output buffer right away so the remote echo of the
            // keystroke we just sent shows up immediately instead of waiting for
            // the next 100ms poll — otherwise fast typing looks like the echo
            // "doesn't keep up" (echo lagging behind). pollOutput drains the
            // buffer, so
            // this never doubles what the interval poll will later write.
            return pollOutput(currentTabId)
          })
          .then((chunks) => {
            for (const chunk of chunks) writeOutput(chunk)
          })
          .catch((err) => console.error('send_input error:', err))
      }
    })

    // Focus on click
    const handleClick = () => {
      term.focus()
    }
    containerRef.current.addEventListener('click', handleClick)

    // Right-click context menu for copy/paste/select-all
    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setCtxMenu({ x: e.clientX, y: e.clientY })
    }
    containerRef.current.addEventListener('contextmenu', handleContextMenu)

    // Fit + optionally propagate the new size to the shell. When the container
    // is hidden (display:none — e.g. a file editor overlay covers this pane),
    // `fit()` resolves to 0 columns/rows; sending that to ConPTY poisons the
    // local shell's width (SIGWINCH to 0 cols) and the prompt repaints
    // truncated/misaligned after switching back. So only propagate real sizes.
    const maybeFitAndResize = () => {
      if (!isActiveRef.current || !fitRef.current) return
      const container = containerRef.current
      if (!container || container.clientWidth === 0 || container.clientHeight === 0) return
      fitRef.current.fit()
      term.refresh(0, term.rows - 1)
      // B16: only send a resize when the geometry actually changed. Sending the
      // same cols/rows repeatedly makes the remote shell repaint its prompt for
      // nothing, and — worse — re-triggers xterm's scrollback reflow, which can
      // race the shell's own SIGWINCH repaint and corrupt rows (the truncated /
      // duplicated prompt artifacts). A changed-size check collapses these.
      if (
        term.cols > 0 &&
        term.rows > 0 &&
        (term.cols !== lastColsRef.current || term.rows !== lastRowsRef.current)
      ) {
        lastColsRef.current = term.cols
        lastRowsRef.current = term.rows
        sendResize(term)
      }
    }

    // B16: coalesce bursts of resize events (window drag fires ResizeObserver +
    // window.resize many times per frame) into a single fit/sendResize per
    // animation frame. This avoids a pile-up of reflow-vs-SIGWINCH races that
    // leave the terminal misaligned with duplicated/truncated prompt lines.
    let resizeFrameId: number | null = null
    const scheduleFitAndResize = () => {
      if (resizeFrameId != null) return
      resizeFrameId = requestAnimationFrame(() => {
        resizeFrameId = null
        maybeFitAndResize()
      })
    }

    // Window resize
    const handleResize = () => {
      scheduleFitAndResize()
    }
    window.addEventListener('resize', handleResize)

    // Use ResizeObserver to monitor container size changes (more accurate than window resize)
    if (containerRef.current) {
      resizeObserverRef.current = new ResizeObserver(() => {
        scheduleFitAndResize()
      })
      resizeObserverRef.current.observe(containerRef.current)
    }

    // Poll SSH output (every 100ms), completely bypassing Tauri event system
    const startPolling = () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current)
      // Do one immediate poll so slow first-output doesn't wait for the first
      // 100 ms interval tick.
      const doPoll = async () => {
        try {
          const chunks = await pollOutput(currentTabId)
          if (chunks.length > 0) {
            for (const chunk of chunks) writeOutput(chunk)
          }
        } catch {
          // Silently ignore polling failures to avoid spam
        }
      }
      doPoll()
      pollTimerRef.current = setInterval(doPoll, 100)
    }

    // Wait for container to get actual layout dimensions, fit to get real cols/rows, then connect SSH with those dimensions
    const doConnect = () => {
      const cols = term.cols
      const rows = term.rows
      console.log(`[Terminal] initial fit done: ${cols}x${rows}, starting connect`)
      onSizeChangeRef.current?.(cols, rows)
      // Seed the last-sent geometry so the first ResizeObserver tick after
      // connect doesn't re-send an identical size (which would trigger a
      // spurious SIGWINCH repaint and risk misalignment).
      lastColsRef.current = cols
      lastRowsRef.current = rows
      onStatusChangeRef.current('connecting')
      if (isLocal) {
        openLocalShell(currentTabId, localShellTypeRef.current, localCwd, true, cols, rows)
          .then(() => {
            connectedRef.current = true
            onStatusChangeRef.current('connected')
            startPolling()
          })
          .catch((err) => {
            const errMsg = typeof err === 'string' ? err : (err as any)?.message || String(err)
            // Show the error inside the terminal instead of hiding the pane,
            // so the user can see *why* the local shell failed to start.
            term.write(`\x1b[31m[local shell] failed to start: ${errMsg}\x1b[0m\r\n`)
            onStatusChangeRef.current('error', errMsg)
            console.error('open_local_shell error:', err)
          })
      } else {
        const sshCfg = cfg!
        connect(
          {
            id: sshCfg.id,
            name: sshCfg.name || `${sshCfg.username}@${sshCfg.host}`,
            host: sshCfg.host,
            port: sshCfg.port,
            username: sshCfg.username,
            password: sshCfg.password,
            keyPath: sshCfg.keyPath,
          },
          currentTabId,
          cols,
          rows,
          true,
        )
          .then(() => {
            connectedRef.current = true
            onStatusChangeRef.current('connected')
            startPolling()
          })
          .catch((err) => {
            const errMsg = typeof err === 'string' ? err : (err as any)?.message || String(err)
            onStatusChangeRef.current('error', errMsg)
            console.error('connect error:', err)
          })
      }
    }

    const waitForLayoutAndFit = () => {
      const container = containerRef.current
      if (!container) return
      const w = container.clientWidth
      const h = container.clientHeight
      if (w > 0 && h > 0) {
        fitAddon.fit()
        // B3 fix: repaint after fit so a stale trailing row / blinking cursor
        // pinned to the bottom edge is cleared.
        term.refresh(0, term.rows - 1)
        doConnect()
      } else {
        // Container still has zero dimensions, keep waiting
        requestAnimationFrame(waitForLayoutAndFit)
      }
    }
    // Use double rAF to ensure flex layout is complete, then enter polling wait for actual dimensions
    requestAnimationFrame(() => {
      requestAnimationFrame(waitForLayoutAndFit)
    })

    return () => {
      console.log('[Terminal] cleanup, resetting hasRun')
      hasRun.current = false
      connectedRef.current = false
      resetCapture()
      clearAiMarkTimeout()
      aiMarkRef.current = null
      clearAiBadgeTimeout()
      resetLsCapture()
      clearLsLinks()
      lsLinkProviderDisposable.dispose()
      if (linkTooltipShowTimer.current) clearTimeout(linkTooltipShowTimer.current)
      if (linkTooltipHideTimer.current) clearTimeout(linkTooltipHideTimer.current)
      linkTooltipEntryRef.current = null
      setLinkTooltip(null)
      unlistenAiMark?.()
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current)
        pollTimerRef.current = null
      }
      containerRef.current?.removeEventListener('click', handleClick)
      containerRef.current?.removeEventListener('contextmenu', handleContextMenu)
      window.removeEventListener('resize', handleResize)
      resizeObserverRef.current?.disconnect()
      resizeObserverRef.current = null
      // Scrollbar teardown
      const vp = viewportRef.current
      if (vp) {
        vp.removeEventListener('scroll', updateThumb)
        vp.removeEventListener('mouseenter', onViewportMouseEnter)
        vp.removeEventListener('mouseleave', onViewportMouseLeave)
        viewportRef.current = null
      }
      if (viewportRO) viewportRO.disconnect()
      scrollThumbDragging.current = false
      if (scrollHideTimer.current) clearTimeout(scrollHideTimer.current)
      // Drop this instance from the active registry if it was the registered
      // one (so a superseding instance isn't blocked by a disposed entry).
      if (activeTerminalByTab.get(currentTabId) === term) {
        activeTerminalByTab.delete(currentTabId)
      }
      if (latestTerminalByTab.get(currentTabId) === term) {
        latestTerminalByTab.delete(currentTabId)
      }
      // Snapshot the full screen (colors + cursor) before tearing down the xterm
      // instance, so the next mount (e.g. float pop-out / dock-back) can replay it
      // and the user keeps their prior output instead of a blank screen.
      try {
        scrollbackCache.set(currentTabId, serializeAddon.serialize())
      } catch {
        // failing to cache must never break teardown
      }
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoConnect])

  // Reconnect when trigger changes (keep xterm instance alive, preserve history)
  useEffect(() => {
    const trigger = reconnectTrigger ?? 0
    if (trigger === 0 || trigger === reconnectTriggerRef.current) return
    reconnectTriggerRef.current = trigger

    // Stop existing poll timer
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current)
      pollTimerRef.current = null
    }

    // A reconnect starts a fresh session — abandon any in-flight highlight capture.
    resetCapture()
    clearAiMarkTimeout()
    aiMarkRef.current = null
    resetLsCapture()
    clearLsLinks()

    const term = termRef.current
    if (!term) return

    const cfg = connectConfigRef.current
    const currentTabId = tabIdRef.current
    // Local shells have no SSH connectConfig; only SSH sessions need it.
    if (!cfg && !isLocal) return

    if (isLocal) {
      // A local shell is driven by ConPTY, which repaints the screen with
      // *absolute* cursor positioning relative to its own buffer origin. Any
      // pre-existing content (old session output, a separator line, ...) shifts
      // xterm's rows out of sync and typed input lands above the prompt. Reset
      // to a clean screen so ConPTY's origin matches row 0.
      term.reset()
    } else {
      // Write separator to terminal to mark new session
      term.write('\r\n\x1b[33m══════ Reconnecting ══════\x1b[0m\r\n')
    }

    const doConnect = () => {
      const cols = term.cols
      const rows = term.rows
      console.log(`[Terminal] reconnect: ${cols}x${rows}`)
      onSizeChangeRef.current?.(cols, rows)
      onStatusChangeRef.current('connecting')

      if (isLocal) {
        openLocalShell(
          currentTabId,
          localShellTypeRef.current,
          localCwd,
          false,
          term.cols,
          term.rows,
        )
          .then(() => {
            onStatusChangeRef.current('connected')
            if (pollTimerRef.current) clearInterval(pollTimerRef.current)
            pollTimerRef.current = setInterval(async () => {
              try {
                const chunks = await pollOutput(currentTabId)
                if (chunks.length > 0) {
                  for (const chunk of chunks) writeOutput(chunk)
                }
              } catch {}
            }, 100)
          })
          .catch((err) => {
            const errMsg = typeof err === 'string' ? err : (err as any)?.message || String(err)
            onStatusChangeRef.current('error', errMsg)
            console.error('local reconnect error:', err)
          })
        return
      }

      const sshCfg = cfg!
      connect(
        {
          id: sshCfg.id,
          name: sshCfg.name || `${sshCfg.username}@${sshCfg.host}`,
          host: sshCfg.host,
          port: sshCfg.port,
          username: sshCfg.username,
          password: sshCfg.password,
          keyPath: sshCfg.keyPath,
        },
        currentTabId,
        cols,
        rows,
        false,
      )
        .then(() => {
          onStatusChangeRef.current('connected')
          // Start polling again
          if (pollTimerRef.current) clearInterval(pollTimerRef.current)
          pollTimerRef.current = setInterval(async () => {
            try {
              const chunks = await pollOutput(currentTabId)
              if (chunks.length > 0) {
                for (const chunk of chunks) {
                  writeOutput(chunk)
                }
              }
            } catch {}
          }, 100)
        })
        .catch((err) => {
          const errMsg = typeof err === 'string' ? err : (err as any)?.message || String(err)
          onStatusChangeRef.current('error', errMsg)
          console.error('reconnect error:', err)
        })
    }

    // Ensure terminal has dimensions before connecting
    if (term.cols > 0 && term.rows > 0) {
      doConnect()
    } else {
      const waitForLayout = () => {
        if (term.cols > 0 && term.rows > 0) {
          fitRef.current?.fit()
          doConnect()
        } else {
          requestAnimationFrame(waitForLayout)
        }
      }
      requestAnimationFrame(waitForLayout)
    }
  }, [reconnectTrigger])

  // Focus when this pane becomes the focused one; explicitly blur when it
  // loses focus. On focus we also register this instance as the active one for
  // its tabId in `activeTerminalByTab`, so input is only ever sent from the
  // live, focused terminal — blocking any stale duplicate (transient
  // double-mount) from re-sending the same keystroke (e.g. "ls" reaching the
  // shell as "lss").
  useEffect(() => {
    const term = termRef.current
    if (isFocused && term) {
      activeTerminalByTab.set(tabIdRef.current, term)
      term.focus()
    } else if (!isFocused && term && document.activeElement === term.textarea) {
      term.blur()
    }
  }, [isFocused])

  // When the shell-view switches back to "terminal" (e.g. user clicks the
  // terminal tab after editing a file), the terminal is already mounted and
  // focused in the pane's sense — isFocused doesn't change.  This effect
  // detects the view change and re-focuses the xterm textarea so the cursor
  // lands in the shell prompt.
  useEffect(() => {
    if (shellView === 'terminal' && connectedRef.current) {
      const term = termRef.current
      if (term) {
        activeTerminalByTab.set(tabIdRef.current, term)
        term.focus()
        // B14: switching back from the file editor can leave the xterm
        // viewport scrolled up (pane re-show resets the scroll position),
        // while the cursor lands at the top and newer output stays out of
        // sight below. Bring the viewport back to the bottom so the prompt /
        // latest output is visible.
        term.scrollToBottom()
      }
      // B14 follow-up: while the editor overlay was shown the terminal column
      // was display:none, and depending on timing the local shell's ConPTY may
      // have received a 0-sized resize (or none at all) — so its width no
      // longer matches xterm and the prompt can repaint truncated. Wait one
      // frame for the layout to settle, then re-align geometry and force a
      // repaint.
      //
      // NOTE: do NOT call t.reset() here. Unlike reconnect, the PTY process is
      // still alive and ConPTY's own buffer still holds all history. reset()
      // only wipes the xterm-side buffer, so after switching back the screen
      // appears cleared (cursor at top-left) and, once the shell repaints at
      // its absolute cursor row, the rows above stay blank. Keeping xterm's
      // buffer intact + refitting + sendResize lets the shell repaint the
      // prompt in place and preserves the scrollback.
      const frame = requestAnimationFrame(() => {
        const t = termRef.current
        if (!t) return
        const container = containerRef.current
        // Still hidden / zero-size: nothing to align yet; ResizeObserver will
        // fire again once the container gets real dimensions.
        if (!container || container.clientWidth === 0 || container.clientHeight === 0) return
        try {
          if (fitRef.current) fitRef.current.fit()
        } catch {
          /* container may be temporarily 0-sized mid-layout */
        }
        if (t.cols > 0 && t.rows > 0) sendResize(t)
        // Force xterm to re-render every visible row from its buffer, repairing
        // any rows that were drawn against stale geometry.
        t.refresh(0, t.rows - 1)
        t.focus()
        t.scrollToBottom()
      })
      return () => cancelAnimationFrame(frame)
    }
  }, [shellView])

  // Close context menu on click anywhere
  useEffect(() => {
    if (!ctxMenu) return
    const close = () => setCtxMenu(null)
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [ctxMenu])

  // Clipboard actions
  const handleCopy = useCallback(async () => {
    setCtxMenu(null)
    termRef.current?.focus()
    const term = termRef.current
    if (!term) return
    const sel = term.getSelection()
    if (sel) {
      try {
        await navigator.clipboard.writeText(sel)
      } catch {
        // Fallback: execCommand (some WebView2 contexts)
        const ta = document.createElement('textarea')
        ta.value = sel
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
      }
    }
  }, [])

  const handlePaste = useCallback(async () => {
    setCtxMenu(null)
    termRef.current?.focus()
    const term = termRef.current
    if (!term) return
    try {
      const text = await navigator.clipboard.readText()
      if (text) {
        if (isLocal) {
          await localSendInput(tabIdRef.current, text)
        } else {
          await sendInput(tabIdRef.current, text)
        }
      }
    } catch {
      // Clipboard read may be blocked; silently ignore
    }
  }, [])

  const handleSelectAll = useCallback(() => {
    setCtxMenu(null)
    termRef.current?.focus()
    termRef.current?.selectAll()
  }, [])

  const handleClear = useCallback(() => {
    setCtxMenu(null)
    termRef.current?.focus()
    termRef.current?.clear()
    clearLsLinks()
    resetLsCapture()
  }, [])

  const handleAskAi = useCallback(() => {
    setCtxMenu(null)
    const term = termRef.current
    if (!term) return
    const sel = term.getSelection()
    if (sel && onAskAi) {
      onAskAi(sel)
    }
  }, [onAskAi])

  const handleAddSnippet = useCallback(() => {
    setCtxMenu(null)
    const term = termRef.current
    if (!term) return
    const sel = term.getSelection()
    if (sel && onAddCommandSnippet) {
      onAddCommandSnippet(sel)
    }
  }, [onAddCommandSnippet])

  // ---- overlay scrollbar thumb drag ----
  const handleThumbMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    scrollThumbDragging.current = true
    scrollThumbDragY.current = e.clientY
    const vp = viewportRef.current
    if (vp) scrollThumbDragStart.current = vp.scrollTop
    const thumbH = (e.target as HTMLElement).offsetHeight
    const onMove = (ev: MouseEvent) => {
      if (!scrollThumbDragging.current) return
      const vp2 = viewportRef.current
      if (!vp2) return
      const dY = ev.clientY - scrollThumbDragY.current
      const maxS = vp2.scrollHeight - vp2.clientHeight
      const maxT = vp2.clientHeight - thumbH
      const ratio = maxS / Math.max(1, maxT)
      vp2.scrollTop = Math.max(0, Math.min(maxS, scrollThumbDragStart.current + dY * ratio))
      setScrollThumb((p) => ({ ...p, show: true }))
    }
    const onUp = () => {
      scrollThumbDragging.current = false
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [])

  return (
    <div className="term-scrollbar-wrapper">
      <div
        ref={containerRef}
        style={{ height: '100%', width: '100%', minHeight: 0, overflow: 'hidden' }}
      />
      {/* Overlay custom scrollbar (B13) */}
      {scrollThumb.show && scrollThumb.h > 0 && (
        <div className="term-scrollbar" data-term-scrollbar={tabId}>
          <div
            className="term-scrollbar-thumb"
            style={{ top: `${scrollThumb.t}px`, height: `${scrollThumb.h}px` }}
            onMouseDown={handleThumbMouseDown}
          />
        </div>
      )}
      {aiBadge && (
        <div className={`term-ai-status term-ai-status-${aiBadge.state}`} title={aiBadge.command}>
          {aiBadge.state === 'running' && (
            <>
              <span className="term-ai-status-spinner" aria-hidden />
              {t('aiTermRunning')} · {truncateCmd(aiBadge.command)}
            </>
          )}
          {aiBadge.state === 'done' && (
            <>
              ✓ {t('aiTermDone')}
              {aiBadge.elapsedMs !== undefined && (
                <span className="term-ai-status-meta">
                  · {(aiBadge.elapsedMs / 1000).toFixed(1)}
                  {t('aiTermSec')}
                </span>
              )}
              {aiBadge.truncated && (
                <span className="term-ai-status-meta">· {t('aiTermTruncated')}</span>
              )}
              {aiBadge.timedOut && (
                <span className="term-ai-status-meta">· {t('aiTermMayStillRun')}</span>
              )}
            </>
          )}
          {aiBadge.state === 'error' && <>✗ {aiBadge.error || t('aiTermError')}</>}
        </div>
      )}
      {linkTooltip && (
        <div
          className={`term-link-tooltip${linkTooltip.below ? ' below' : ''}`}
          style={{ left: linkTooltip.x, top: linkTooltip.y }}
          onMouseEnter={() => {
            // Mouse is on the card — cancel the delayed hide.
            if (linkTooltipHideTimer.current) {
              clearTimeout(linkTooltipHideTimer.current)
              linkTooltipHideTimer.current = null
            }
          }}
          onMouseLeave={() => {
            if (linkTooltipHideTimer.current) {
              clearTimeout(linkTooltipHideTimer.current)
              linkTooltipHideTimer.current = null
            }
            setLinkTooltip(null)
          }}
          onClick={(e) => {
            e.stopPropagation()
            setLinkTooltip(null)
            onLsEntryClick(linkTooltip.entry)
          }}
        >
          <span className="term-link-tooltip-label">
            {linkTooltip.entry.kind === 'dir' ? 'Enter folder' : 'Open file'}
          </span>
          <span className="term-link-tooltip-hint">
            ({/mac|iphone|ipad/i.test(navigator.userAgent) ? 'cmd' : 'ctrl'} + click)
          </span>
        </div>
      )}
      {ctxMenu && (
        <div
          ref={ctxMenuRef}
          className="context-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="context-menu-item" onClick={handleCopy}>
            <Icon name="copy" /> {t('copy')}
          </div>
          <div className="context-menu-item" onClick={handlePaste}>
            <Icon name="paste" /> {t('paste')}
          </div>
          <div className="context-menu-divider" />
          <div className="context-menu-item" onClick={handleSelectAll}>
            🔤 {t('selectAll')}
          </div>
          <div className="context-menu-divider" />
          <div className="context-menu-item" onClick={handleClear}>
            🧹 {t('clear')}
          </div>
          <div className="context-menu-divider" />
          <div className="context-menu-item" onClick={handleAskAi}>
            🤖 {t('aiChatAskAi')}
          </div>
          <div className="context-menu-item" onClick={handleAddSnippet}>
            <Icon name="plus" size={12} /> {t('addToCommandList')}
          </div>
        </div>
      )}
    </div>
  )
}

// Read the full logical line under the cursor, reassembling wrapped
// continuation lines so long tab-completed commands are not truncated.
function getCurrentCommandLine(term: Terminal): string {
  const buffer = term.buffer.active
  // `cursorY` is relative to `baseY` (0..rows-1) but `getLine` expects an
  // absolute buffer index — offset by `baseY` so this reads the actual cursor
  // row rather than a stale scrollback line.
  let y = buffer.baseY + buffer.cursorY
  const line = buffer.getLine(y)
  if (!line) return ''
  let text = line.translateToString(true)
  while (y > 0) {
    const prev = buffer.getLine(y - 1)
    if (prev && prev.isWrapped) {
      text = prev.translateToString(true) + text
      y -= 1
    } else {
      break
    }
  }
  return text
}

// Remove ANSI escape sequences and split a submitted buffer line into its
// leading shell prompt (plain text) and the command that follows.
function splitPromptCommand(line: string): { prompt: string; command: string } {
  const noAnsi = line.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
  // Markers in both "with trailing space" and bare forms: PowerShell / cmd
  // prompts end in `>` (often WITHOUT a trailing space — `PS C:\path>`),
  // bash/zsh use `$ ` / `# ` / `% ` / `❯ ` (usually WITH a space). Taking the
  // rightmost match keeps user-typed `>`/`$` inside an actual command intact
  // enough for the "is there already input?" check: a bare prompt yields an
  // empty command, a prompt + typed text yields the text.
  const markers = ['$ ', '# ', '% ', '> ', '❯ ', '$', '#', '%', '>', '❯']
  let idx = -1
  let matched = ''
  for (const m of markers) {
    const pos = noAnsi.lastIndexOf(m)
    if (pos > idx) {
      idx = pos
      matched = m
    }
  }
  if (idx >= 0) {
    return {
      prompt: noAnsi.slice(0, idx + matched.length),
      command: noAnsi.slice(idx + matched.length).trimEnd(),
    }
  }
  return { prompt: '', command: noAnsi.trim() }
}

// Remove ANSI escape sequences and strip a leading shell prompt so only the
// command itself remains.
function stripPrompt(line: string): string {
  return splitPromptCommand(line).command
}

// Capture commands submitted by the user. A single Enter commits the current
// terminal-buffer line (which holds tab-completed text); a multi-line paste
// commits each pasted line directly.
function commitSubmittedCommands(term: Terminal, data: string, tabId: number) {
  if (/^[\r\n]+$/.test(data)) {
    const cmd = stripPrompt(getCurrentCommandLine(term))
    if (cmd.trim().length > 0) {
      commitCommand(tabId, cmd).catch((e) => console.error('commit_command error:', e))
    }
    return
  }
  for (const raw of data.split(/[\r\n]+/)) {
    const cmd = raw.replace(/[\x00-\x1f]/g, '').trim()
    if (cmd.length > 0) {
      commitCommand(tabId, cmd).catch((e) => console.error('commit_command error:', e))
    }
  }
}

import React, { useEffect, useRef, useCallback, useState, useLayoutEffect } from 'react'
import { Terminal } from '@xterm/xterm'
import type { IDecoration, ILink } from '@xterm/xterm'
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

interface AiMarkState {
  mode: 'cmd' | 'output'
  seq: number
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

// Persistent highlight colors so clickable `ls` entries are visibly distinct
// from ordinary output (dirs / files / symlinks). Decorations are purely
// visual; the link provider (below) still owns click handling.
const LS_DIR_BG = '#1e4620'
const LS_FILE_BG = '#1a3650'
const LS_LINK_BG = '#3d1e50'

interface LsCaptureState {
  format: 'long' | 'dir'
  prompt: string
  /** Absolute buffer row of the echoed command line (captured at submit). */
  startRow: number
  buf: string
  bytes: number
  timeout: ReturnType<typeof setTimeout> | null
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
  // link provider that is registered once per terminal.
  const lsEntriesRef = useRef<Map<number, LsEntry[]>>(new Map())
  // Persistent clickable-entry decorations (one per entry name), disposed on
  // clear/new command/clear-screen/disconnect/AI command.
  const lsDecorationsRef = useRef<IDecoration[]>([])
  // Absolute directory the current listing lives in, captured at submit time
  // (one-shot `pwd` for SSH, prompt parse for local) and resolved with the
  // command's target arg. Clicks read this so they resolve the right path even
  // after the user has `cd`'d away from the listing's directory.
  const lsBaseDirPromiseRef = useRef<Promise<string | null> | null>(null)

  const clearLsLinks = () => {
    lsEntriesRef.current.clear()
    for (const d of lsDecorationsRef.current) {
      try {
        d.dispose()
      } catch {
        // disposal must never throw
      }
    }
    lsDecorationsRef.current = []
  }

  const resetLsCapture = () => {
    const c = lsCaptureRef.current
    if (c && c.timeout) clearTimeout(c.timeout)
    lsCaptureRef.current = null
    lsBaseDirPromiseRef.current = null
    // Any lingering clickable overlay belongs to a previous listing — drop it.
    clearLsLinks()
  }

  const onLsEntryClick = async (entry: LsEntry) => {
    // Resolve the entry's absolute path from the listing's base directory
    // (captured at submit time), so the click lands in the right place even
    // after the user has `cd`'d away from where `ls` was run.
    const base = (await lsBaseDirPromiseRef.current) ?? null
    const abs = base ? joinPath(base, entry.name) : entry.name
    if (entry.kind === 'dir') {
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
      const end = entry.col + entry.name.length
      if (text.slice(entry.col, end) !== entry.name) return false
      const after = text[end]
      return after === undefined || /\s/.test(after) || text.slice(end, end + 4) === ' -> '
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

  // Populate the link table for a freshly parsed ls block. Rows are resolved
  // against the live terminal buffer (not just `startRow + entry.line`) so the
  // link provider matches the lines xterm actually renders. Also paints a subtle
  // background highlight on each entry name so the user can see at a glance that
  // the listing is clickable, without clobbering the existing ANSI colors
  // emitted by `ls --color`.
  const setLsEntries = (startRow: number, entries: LsEntry[]) => {
    clearLsLinks()
    const map = new Map<number, LsEntry[]>()
    const term = termRef.current
    for (const entry of entries) {
      const row = term ? resolveLsRow(term, startRow + entry.line, entry) : startRow + entry.line
      const arr = map.get(row)
      if (arr) arr.push(entry)
      else map.set(row, [entry])
      if (term && entry.name.length > 0) {
        try {
          // `registerMarker` pins to a line relative to the *current cursor*;
          // convert the absolute entry row into that offset so the decoration
          // tracks the correct line as the buffer scrolls.
          const buf = term.buffer.active
          const cursorRow = buf.baseY + buf.cursorY
          const marker = term.registerMarker(row - cursorRow)
          // xterm decoration `x` is a 0-based offset from the anchor (unlike
          // the link provider's 1-based buffer positions), so use entry.col
          // directly so the highlight exactly covers the name cells.
          const dec = term.registerDecoration({
            marker,
            layer: 'top',
            x: entry.col,
            width: entry.name.length,
            backgroundColor:
              entry.kind === 'dir' ? LS_DIR_BG : entry.kind === 'link' ? LS_LINK_BG : LS_FILE_BG,
          })
          if (dec) lsDecorationsRef.current.push(dec)
        } catch {
          // decoration creation must never break link setup
        }
      }
    }
    lsEntriesRef.current = map
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
    if (entries.length > 0) setLsEntries(ls.startRow, entries)
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
      const cwd = isLocal ? promptCwd ?? localCwd ?? null : promptCwd ?? home
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

  const beginAiMark = (mark: AiTermMark) => {
    // An AI command supersedes any in-flight cat/head/tail capture and any
    // stale clickable `ls` overlays.
    resetCapture()
    resetLsCapture()
    clearLsLinks()
    aiMarkRef.current = { mode: 'cmd', seq: mark.seq }
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
    if (st.mode === 'output') {
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
      if (rest.length > 0) term.write(colorizeOutputChunk(rest))
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
      if (m.mark === 'begin') beginAiMark(m)
      else endAiMark(m)
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
    // from the last parsed `ls` block hoverable (underline + pointer) and
    // clickable. xterm's linkifier handles the mouse events natively — far more
    // reliable than decoration overlays for receiving clicks.
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
        // hovered row is `bufferLineNumber - 1`. Cached absolute-row keys go stale
        // once the buffer scrolls (and an earlier off-by-one read the wrong row
        // entirely), which made a click activate a different entry than the one
        // under the cursor. Reading the line text and requiring the entry's name
        // to sit exactly at its recorded column makes the click land on whatever
        // is visibly under the cursor — immune to scroll and to substring names
        // (`dir` no longer matches a row showing `dir1`).
        const line = buf.getLine(bufferLineNumber - 1)
        if (!line) {
          callback([])
          return
        }
        const text = line.translateToString(true)
        const allEntries: LsEntry[] = []
        for (const arr of entries.values()) allEntries.push(...arr)
        const links: ILink[] = []
        const seen = new Set<LsEntry>()
        for (const entry of allEntries) {
          if (entry.name.length === 0 || seen.has(entry)) continue
          const end = entry.col + entry.name.length
          if (text.slice(entry.col, end) !== entry.name) continue
          // Name boundary: the next char must be EOL / whitespace / the start of
          // a ` -> ` symlink arrow. Without this, a shorter entry like
          // `password-platform` (17 chars) wrongly matches on the row of its
          // longer neighbor `password-platform-dev` — the slice matches the
          // first 17 chars even though the real token on that row is 22 chars.
          const after = text[end]
          const boundaryOk =
            after === undefined || /\s/.test(after) || text.slice(end, end + 4) === ' -> '
          if (!boundaryOk) continue
          seen.add(entry)
          links.push({
            range: {
              start: { x: entry.col + 1, y: bufferLineNumber },
              end: { x: entry.col + entry.name.length + 1, y: bufferLineNumber },
            },
            text: entry.name,
            decorations: { pointerCursor: true, underline: true },
            activate: () => {
              // Keep links clickable after a click — a click is not a "new
              // command" from the buffer's perspective (cd is sent straight
              // via sendInput, not through onData). Links are cleared at the
              // right moments: next Enter-submitted command, clear, disconnect,
              // reconnect, AI command, and unmount.
              onLsEntryClick(entry)
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
          clearLsLinks()
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
      resetLsCapture()
      clearLsLinks()
      lsLinkProviderDisposable.dispose()
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
  const markers = ['$ ', '# ', '% ', '> ', '❯ ']
  let idx = -1
  for (const m of markers) {
    const pos = noAnsi.lastIndexOf(m)
    if (pos > idx) idx = pos
  }
  if (idx >= 0) {
    return { prompt: noAnsi.slice(0, idx + 2), command: noAnsi.slice(idx + 2).trimEnd() }
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

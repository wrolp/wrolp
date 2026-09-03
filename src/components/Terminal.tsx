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
  pollOutput,
  resizeTerminal,
  openLocalShell,
  localSendInput,
  localResize,
  pollWorkingDir,
  fsListFiles,
  fsFileExists,
  connectSerial,
  serialSendInput,
  connectTelnet,
  telnetSendInput,
} from '../commands'
import { Icon } from './Icon'
import { useI18n } from '../i18n'
import { stripAnsi, highlightTableText } from '../lib/termHighlight'
import {
  detectLsCommand,
  parseLsBlock,
  extractCwdFromPrompt,
  resolveCdTarget,
} from '../lib/lsParse'
import type { LsEntry } from '../lib/lsParse'
import { detectTableCommand } from '../lib/tableOutput'
import type { AiTermMark, TargetRef } from '../types'
import {
  activeTerminalByTab,
  latestTerminalByTab,
  scrollbackCache,
  replayScrollback,
} from './terminal/registry'
import type { CaptureState } from './terminal/capture'
import { clearCaptureTimers, feedCapture, ensureHighlightLanguagesPreloaded } from './terminal/capture'
import {
  AI_CMD_FG,
  AI_OUTPUT_FG,
  ANSI_RESET,
  AI_MARK_TIMEOUT_MS,
  truncateCmd,
} from './terminal/aiMark'
import type { AiMarkState } from './terminal/aiMark'
import { colorizeChunk, colorizeOutputChunk } from './terminal/aiMark'
import {
  LS_CAPTURE_TIMEOUT_MS,
  LS_MAX_BYTES,
  joinPath,
  extractLsTargetArg,
  resolveLsBaseDir,
  expandTilde,
  isNestedSessionEntry,
  parseDockerExecContainer,
  isNestedSessionExit,
} from './terminal/lsCapture'
import type { LsCaptureState, LsClickableEntry } from './terminal/lsCapture'
import {
  getCurrentCommandLine,
  splitPromptCommand,
  highlightCurrentCommandLine,
  getInputLineAtCursorEnd,
  commitSubmittedCommands,
  isPagerPrompt,
} from './terminal/promptLine'
import { commandHighlighter } from './terminal/langHighlight'
import type { TableCaptureState } from './terminal/tableCapture'
import { feedTable } from './terminal/tableCapture'
import type { TerminalComponentProps } from './terminal/types'

export { focusTerminal, getTerminalInputText } from './terminal/registry'




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
  onCwdChange,
  isLocal,
  isSerial,
  isTelnet,
  dockerContainer,
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
  // rAF retry counter for the initial fit-wait loop (capped to avoid a 60 fps
  // spin when a pane stays 0-sized, e.g. hidden behind a file editor overlay).
  const layoutWaitFrames = useRef(0)
  const hasRun = useRef(false)
  const reconnectTriggerRef = useRef(reconnectTrigger ?? 0)
  const localShellTypeRef = useRef(localShellType)
  // Tracks the CURRENT working directory for `ls` link resolution. For local
  // shells the backend's `LocalShell.cwd` is only the startup dir (never updated
  // on `cd`); for SSH the prompt only shows a *relative* basename (e.g. "lac724"
  // for `[root@host lac724]#`). We keep the real (absolute) cwd by querying the
  // shell's actual directory (see fetchRemoteCwd) and by following `cd` commands.
  const cwdRef = useRef<string | null>(localCwd ?? null)
  // Depth of nested interactive sessions (docker exec shell / nested interactive
  // ssh). Inside one, the tracked cwd and any hidden `pwd` query describe the
  // OUTER shell, not the session shown on screen — so `ls` link bases must come
  // from the prompt alone (see startLsCaptureIfMatch).
  const nestedDepthRef = useRef(0)
  // Non-null when this session was opened as a `docker exec` shell from the
  // Docker sidebar (the docker exec itself is sent programmatically, so the
  // Enter-handler nested tracking never fires — see prop docs).
  const dockerContainerRef = useRef<string | null>(dockerContainer)
  dockerContainerRef.current = dockerContainer
  // Wrapper that keeps cwdRef in sync AND notifies the parent (so the FilePanel
  // shell-sync follows the real directory instead of $HOME from poll_working_dir).
  const onCwdChangeRef = useRef(onCwdChange)
  onCwdChangeRef.current = onCwdChange
  const setCwd = useCallback((path: string | null) => {
    cwdRef.current = path
    onCwdChangeRef.current?.(path)
  }, [])
  // Cache of the SSH session's $HOME, fetched from poll_working_dir so a leading
  // `~` (from the prompt or `ls -l ~/docs`) can be expanded to an absolute path
  // (SFTP doesn't expand `~`, and the backend `expand_tilde` uses the *local*
  // machine's home, not the remote one).
  const homeRef = useRef<string | null>(null)
  // Most recent prompt-derived cwd (a bare basename on default shells, e.g.
  // "lac724" for `[root@host lac724]#`). Fallback only when we have no better cwd.
  const promptCwdRef = useRef<string | null>(null)
  // --- Hidden shell `pwd` query (SSH) ---------------------------------------
  // The prompt only shows a relative basename and `poll_working_dir` runs `pwd`
  // in a *fresh* exec channel (which starts in $HOME, NOT the shell's cwd), so
  // neither can tell us the real directory. The only reliable source is the
  // interactive shell itself. We send a marker-wrapped `pwd`, capture the result
  // from the output stream, and strip the echo+result from the terminal so the
  // user never sees it.
  // Begin/end markers for the hidden `pwd` query. They are fixed per terminal
  // instance so any stale/cancelled query output is always stripped from the
  // screen. The regex distinguishes the *result* line (`BEG<path>END`) from the
  // *echoed command* line by requiring the captured text to start with a real
  // path prefix (`/`, `~`, or a Windows drive).
  const cwdQueryBegRef = useRef<string>(`__WROLP_CWD_BEG_${Math.random().toString(36).slice(2, 10)}__`)
  const cwdQueryEndRef = useRef<string>(`__WROLP_CWD_END_${Math.random().toString(36).slice(2, 10)}__`)
  // Single in-flight cwd query. Only the latest query is ever honored — starting
  // a new one cancels the previous (stale) one so a late `pwd` result can never
  // clobber a newer, correctly-tracked working directory (e.g. the connect-time
  // seed resolving after the user has already `cd`'d somewhere else).
  const cwdQueryPendingRef = useRef<{
    resolve: (v: string | null) => void
    timer: ReturnType<typeof setTimeout> | null
  } | null>(null)
  const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // A real cwd starts with `/`, `~`, or a Windows drive. The echoed command's
  // `$(pwd)` text does NOT, so anchoring the capture on this prefix is what
  // stops us from matching the echoed command line and harvesting `$(pwd)`.
  const CWD_PATH_PREFIX = '(?:\\/|~|(?:[A-Za-z]:[\\\\/]))'
  // Strip our hidden `pwd` query from a chunk, resolving the pending cwd promise
  // with the captured path. Returns the cleaned chunk (may be empty).
  const stripCwdQuery = (chunk: string): string => {
    const beg = cwdQueryBegRef.current
    const end = cwdQueryEndRef.current
    if (!beg || !end || !chunk.includes(beg) || !chunk.includes(end)) return chunk
    const escB = escapeRegex(beg)
    const escE = escapeRegex(end)
    const m = chunk.match(new RegExp(escB + '(' + CWD_PATH_PREFIX + '[^\n]*?)' + escE))
    if (m && cwdQueryPendingRef.current) {
      const pending = cwdQueryPendingRef.current
      cwdQueryPendingRef.current = null
      if (pending.timer) clearTimeout(pending.timer)
      pending.resolve(m[1])
    }
    // Remove every line that contains a marker (the echoed command + the result).
    return chunk.replace(new RegExp('[^\n]*(?:' + escB + '|' + escE + ')[^\n]*\n?', 'g'), '')
  }
  // Ask the interactive shell for its real absolute cwd. Resolves with the path
  // (or null on timeout/error). The query output is stripped by stripCwdQuery.
  const fetchRemoteCwd = (): Promise<string | null> => {
    // Telnet has no SFTP channel, so there is nothing to query — skip it
    // instead of firing an SSH-only request that is guaranteed to fail.
    if (isLocal || isTelnet) return Promise.resolve(null)
    // Cancel any in-flight query so a stale result can't clobber a newer cwd.
    if (cwdQueryPendingRef.current) {
      const old = cwdQueryPendingRef.current
      cwdQueryPendingRef.current = null
      if (old.timer) clearTimeout(old.timer)
      old.resolve(null)
    }
    return new Promise((resolve) => {
      const beg = cwdQueryBegRef.current
      const end = cwdQueryEndRef.current
      const timer = setTimeout(() => {
        if (cwdQueryPendingRef.current && cwdQueryPendingRef.current.resolve === resolve) {
          cwdQueryPendingRef.current = null
        }
        resolve(null)
      }, 4000)
      cwdQueryPendingRef.current = { resolve, timer }
      sendInput(tabIdRef.current, `echo "${beg}$(pwd)${end}"\r`)
    })
  }
  // Seed the best-known remote cwd right after connecting: a configured startup
  // directory is authoritative (the backend `cd`s into it before handing over
  // the interactive shell). Otherwise use `poll_working_dir`, which opens a fresh
  // exec channel — at connect time that channel starts in the user's $HOME, the
  // same place the interactive shell starts, so it gives a reliable initial cwd
  // without injecting anything into the terminal stream and racing user input.
  const seedInitialRemoteCwd = () => {
    if (isLocal) return
    const sd = connectConfigRef.current?.startupDir
    if (sd) {
      setCwd(sd)
      return
    }
    pollWorkingDir(tabIdRef.current)
      .then((real) => {
        if (real && cwdRef.current == null) setCwd(real)
      })
      .catch(() => {})
  }
  // Best-known remote cwd when no `cd`-tracked absolute path exists yet. A
  // configured startup directory is authoritative (the shell `cd`s into it on
  // connect). Otherwise fall back to the (relative) prompt name — never guess
  // by prepending $HOME, since the dir need not live under $HOME.
  const seedRemoteCwd = (prompt: string | null): string | null => {
    const sd = connectConfigRef.current?.startupDir
    if (sd) return sd
    return prompt ?? null
  }
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
  // Keep the overlay scrollbar widened for the whole drag: the pointer routinely
  // strays outside the grab zone mid-drag, where CSS :hover alone would drop it.
  const [thumbDragging, setThumbDragging] = useState(false)
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

  const tableCaptureRef = useRef<TableCaptureState | null>(null)
  // True from the moment we send a keystroke until its echo has been recolored.
  // Gates the writeOutput recolor so we only recolor *typed* lines and never
  // unrelated program output that merely ends in a prompt-like token (e.g.
  // `echo "price is $10"`).
  const expectingEchoRef = useRef(false)
  // Telnet/Serial sessions start at a login prompt, and local shells may run
  // interactive programs (ssh host-key confirmation, sudo, password prompts...).
  // Live input coloring relies on shell-prompt heuristics that misidentify those
  // lines and corrupt the echoed first character. Stay disabled (Telnet/Serial
  // start disabled; local starts enabled) until a real shell prompt appears, or
  // while an interactive prompt is on screen.
  const shellReadyRef = useRef(!isTelnet && !isSerial)

  const resetTableCapture = () => {
    const c = tableCaptureRef.current
    if (c) {
      if (c.timeout) clearTimeout(c.timeout)
    }
    tableCaptureRef.current = null
  }

  // Recolor the line the user is currently typing, AFTER the shell has echoed the
  // keystroke into the buffer (so the newest character is colored too). Only runs
  // while we are awaiting an echo for a keystroke we just sent (expectingEchoRef),
  // so program output is never recolored as if it were a typed command.
  const recolorLiveLine = () => {
    const term = termRef.current
    if (!term) return
    if (!expectingEchoRef.current) return
    if (
      tableCaptureRef.current ||
      captureRef.current ||
      lsCaptureRef.current ||
      aiMarkRef.current
    )
      return
    const at = getInputLineAtCursorEnd(term)
    if (!at) {
      // Cursor isn't at the end of a line — not the live input line. Stop waiting
      // for an echo (it went somewhere else, e.g. a continuation prompt).
      expectingEchoRef.current = false
      return
    }
    if (!at.command) {
      // Only a bare prompt is currently on screen (the echoed keystroke hasn't
      // arrived yet). Don't recolor yet and, crucially, DON'T reset expectingEcho:
      // the 100ms interval poll can fire before the echo and would otherwise
      // flip the flag, leaving the typed character uncolored when its echo lands.
      return
    }
    highlightCurrentCommandLine(term)
    expectingEchoRef.current = false
  }

  // Heuristics for Telnet/Serial login detection. We disable live input coloring
  // while the remote is showing login/password prompts, then enable it once a
  // real shell prompt appears. SSH/local sessions bypass this (shellReadyRef is
  // initialized to true).
  function looksLikeLoginPrompt(line: string): boolean {
    return /\b(?:login|user(?:name| name|-name)?|password|passwort|passcode|pin|passwd)\s*[:：]\s*$/i.test(line)
  }
  function looksLikeShellPrompt(line: string): boolean {
    return /[$#%>❯]\s*$/.test(line.trimEnd())
  }
  // An interactive program (ssh host-key confirmation, yes/no questions, password
  // prompts, ...) is not a shell command line, so recoloring it corrupts the
  // echoed first character. Treat such lines as prompts and suspend live coloring
  // until a real shell prompt returns.
  function looksLikeInteractivePrompt(line: string): boolean {
    const plain = line.trimEnd()
    if (!plain) return false
    if (/are you sure you want to continue connecting/i.test(plain)) return true
    if (/\(yes\/no(?:\/[^)]+)?\)\s*\?*\s*$/i.test(plain)) return true
    if (/\[\s*y\s*\/\s*n\s*\]\s*\?*\s*$/i.test(plain)) return true
    if (/\b(password|passphrase|passcode|pin)\b.*:\s*$/i.test(plain)) return true
    if (/\?\s*$/.test(plain)) return true
    return false
  }

  // Start a table capture for known table commands (df/ps/free/ss/...). Only
  // one command runs at a time, so clears the print/ls captures first to avoid
  // double capture. (docker ps/images are excluded — handled by the multiline
  // block tokenizer instead.)
  const startTableCaptureIfMatch = (cmd: string, prompt: string) => {
    const spec = detectTableCommand(cmd)
    if (!spec) return
    resetTableCapture()
    resetCapture()
    resetLsCapture()
    lsDirCacheRef.current.clear()
    tableCaptureRef.current = {
      spec,
      prompt: prompt || '',
      partial: '',
      lineCount: 0,
      bytes: 0,
      done: false,
      timeout: null,
    }
  }

  // Resolve whether a plain-`ls` (`unknown`-kind) entry is a directory, by
  // listing its base dir (cached per base dir). Returns null when the lookup
  // can't be performed (no base dir, or the listing failed) — callers fall
  // back to a best-effort default.
  // Target used to query the filesystem for `ls` click type resolution / file
  // opening. A docker exec shell (dockerContainerRef set) queries the
  // CONTAINER's filesystem, listed through the host session's docker CLI — the
  // host session's SFTP would resolve container paths against the host and
  // fail. Everything else uses the session's SFTP, or the local FS.
  const lsFsTarget = (): TargetRef => {
    const container = dockerContainerRef.current
    return isLocal
      ? { kind: 'local', tabId: tabIdRef.current }
      : container
        ? { kind: 'docker', jumpTabId: tabIdRef.current, container }
        : { kind: 'session', tabId: tabIdRef.current }
  }

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
      const entries = await fsListFiles(lsFsTarget(), base)
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
      // Track the new directory so the FilePanel shell-sync can follow it.
      // This programmatic `sendInput` bypasses term.onData, so the Enter-handler
      // cd tracking never sees it — resolve the target here instead. Unresolvable
      // targets (`~`-relative, bare names without a base) keep the old value.
      // In a docker exec shell the path is container-side (base came from the
      // container's prompt or is a bare relative name) — the host-tracked cwd
      // can't describe it, so skip the host-side tracking there.
      if (dockerContainerRef.current == null) {
        const next = resolveCdTarget(abs, cwdRef.current)
        if (next) setCwd(next)
      }
      // The click was on the floating tooltip card (or a ctrl+click on the link),
      // both of which can steal keyboard focus from xterm — give it back so the
      // user can keep typing immediately after `cd`. Opening a *file* keeps the
      // focus in the editor, so only the directory branch restores it.
      termRef.current?.focus()
      return
    }
    void openLsFile(abs)
  }

  const openLsFile = async (absPath: string) => {
    const cb = onOpenFileRef.current
    if (!cb) return
    cb(lsFsTarget(), absPath)
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

  // Resolve the dir/file type for plain-`ls` entries (kind === 'unknown', which
  // carry no type info) by listing the base directory once. Reuses lsDirCacheRef
  // so repeated listings of the same dir are cheap. Entries whose name isn't
  // found in the listing are left as 'unknown' (callers fall back gracefully).
  const resolveLsKinds = async (
    entries: LsEntry[],
    baseDirPromise: Promise<string | null> | null,
  ): Promise<LsEntry[]> => {
    if (!baseDirPromise) return entries
    if (!entries.some((e) => e.kind === 'unknown')) return entries
    let base: string | null = null
    try {
      base = await baseDirPromise
    } catch {
      return entries
    }
    if (!base) return entries
    const cache = lsDirCacheRef.current
    let dirMap = cache.get(base)
    if (!dirMap) {
      try {
        const got = await fsListFiles(lsFsTarget(), base)
        dirMap = new Map(got.map((e) => [e.name, e.isDir]))
        cache.set(base, dirMap)
      } catch {
        return entries
      }
    }
    return entries.map((e) => {
      if (e.kind !== 'unknown') return e
      const isDir = dirMap!.get(e.name)
      if (isDir === undefined) return e
      return { ...e, kind: isDir ? 'dir' : 'file' }
    })
  }

  const finalizeLsCapture = async (
    term: Terminal,
    ls: LsCaptureState,
    promptEnd: string | null,
  ) => {
    if (ls.timeout) {
      clearTimeout(ls.timeout)
      ls.timeout = null
    }
    lsCaptureRef.current = null
    let text = ls.buf
    if (promptEnd) text = text.slice(0, text.length - promptEnd.length)
    // Flush any leftover trailing partial line (plain ls/dir coloring): it never
    // got a newline, so colorize it now before the capture is torn down.
    if (ls.pending && ls.format !== 'long') {
      term.write(highlightTableText(ls.pending, ls.format).join('\n'))
      ls.pending = ''
    }
    const rawEntries = parseLsBlock(text, ls.format)
    const baseDirPromise = lsBaseDirPromiseRef.current
    const entries =
      rawEntries.length > 0 && baseDirPromise
        ? await resolveLsKinds(rawEntries, baseDirPromise)
        : rawEntries
    if (entries.length > 0 && baseDirPromise) {
      setLsEntries(ls.startRow, entries, baseDirPromise)
    }
  }

  const writeLsChunk = (term: Terminal, ls: LsCaptureState, chunk: string) => {
    ls.buf += stripAnsi(chunk)
    ls.bytes += chunk.length
    if (ls.bytes > LS_MAX_BYTES) {
      resetLsCapture()
      return
    }
    // Long format: passthrough (only clickable links are added on finalize).
    // Plain `ls`/`dir` (multi/dir): colorize complete lines as they arrive, like
    // the old `startCaptureIfLsPlain` path did — but keep the buffer so rows still
    // become clickable. The trailing partial line waits for the next chunk.
    if (ls.format === 'long') {
      term.write(chunk)
    } else {
      ls.pending += chunk
      const nl = ls.pending.lastIndexOf('\n')
      if (nl >= 0) {
        const complete = ls.pending.slice(0, nl + 1)
        ls.pending = ls.pending.slice(nl + 1)
        term.write(highlightTableText(complete, ls.format).join('\n'))
      }
    }
    if (ls.prompt && ls.buf.endsWith(ls.prompt)) {
      void finalizeLsCapture(term, ls, ls.prompt)
      return
    }
    if (ls.timeout) clearTimeout(ls.timeout)
    ls.timeout = setTimeout(() => {
      ls.timeout = null
      void finalizeLsCapture(term, ls, null)
    }, LS_CAPTURE_TIMEOUT_MS)
  }

  const startLsCaptureIfMatch = (cmd: string, prompt: string) => {
    const format = detectLsCommand(cmd)
    if (!format) return
    // All ls/dir forms are clickable here. Plain multi-column listings (`ls` /
    // `ls -F` / `dir`) are colorized inline by writeLsChunk (via highlightTableText)
    // while buffering, so they keep their original color AND gain clickable links.
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
    // Local: track the cwd via `cd` commands (the backend's LocalShell.cwd is
    // only the *startup* dir and is never updated on `cd`), so links resolve
    // against the real current directory. The prompt is a fallback only.
    const targetArg = extractLsTargetArg(cmd)
    const promptCwd = extractCwdFromPrompt(prompt || '')
    promptCwdRef.current = promptCwd
    // $HOME (via poll_working_dir) is only used to expand a leading `~`. The real
    // cwd comes from the shell itself: `cwdRef` (seeded at connect / on every
    // `cd`), or a hidden `pwd` query when we have nothing tracked yet. Inside a
    // nested session (docker exec / nested ssh) both the tracked cwd and the
    // `pwd` query describe the OUTER shell — and the prompt is not a reliable
    // source either: bare prompts like `bash-5.0#` carry no path at all (the
    // version token would be misread as a cwd), and bracketed ones show the
    // OUTER cwd. So no base is captured; links resolve relative and the nested
    // shell resolves them against its own working directory. The outer $HOME
    // must not be used to expand `~` either.
    const nested = nestedDepthRef.current > 0 || dockerContainerRef.current != null
    const homePromise: Promise<string | null> = isLocal || nested
      ? Promise.resolve(null)
      : pollWorkingDir(tabIdRef.current).catch(() => null)
    const cwdPromise: Promise<string | null> = isLocal
      ? Promise.resolve(cwdRef.current ?? promptCwd ?? localCwd ?? null)
      : (async () => {
          // Docker exec / nested ssh sessions: never take the cwd from the
          // prompt — it either carries no path (bare `bash-5.0#`) or encodes the
          // OUTER context. Query the interactive shell itself instead (it IS the
          // container/remote shell) with the hidden marker-wrapped `pwd`, so ls
          // links resolve to the real container-side absolute path and clicking
          // a directory keeps working after the shell has `cd`'d elsewhere. On
          // failure this resolves null and links fall back to relative paths
          // (`cd -- 'x'`) resolved by the nested shell.
          if (nested) {
            // The query is injected into the interactive shell via sendInput —
            // but this handler runs synchronously BEFORE the user's own `\r` is
            // dispatched (sendInput(data) at the end of onData), so sending now
            // would splice the query into the user's input line (`ls` + `echo …`
            // → `lsecho …`). Defer one macrotask so the newline goes out first
            // and the query lands as its own line at the next prompt.
            return new Promise<string | null>((resolve) => {
              setTimeout(() => resolve(fetchRemoteCwd()), 0)
            })
          }
          if (cwdRef.current) return cwdRef.current
          const real = await fetchRemoteCwd()
          if (real) {
            // Don't clobber a cwd set (by a `cd` handler) while we were awaiting.
            if (cwdRef.current == null) setCwd(real)
            return cwdRef.current ?? real
          }
          return seedRemoteCwd(promptCwd)
        })()
    lsBaseDirPromiseRef.current = Promise.all([homePromise, cwdPromise]).then(([home, cwd]) => {
      if (!isLocal) homeRef.current = home ?? null
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
      pending: '',
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
    resetTableCapture()
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
  // ls clickable capture, then the cat/head/tail capture machine, then the
  // generic-table capture machine, otherwise passthrough.
  const writeOutput = (chunk: string) => {
    const term = termRef.current
    if (!term) return
    // Strip our hidden `pwd` query (the echoed command + its result) so the
    // terminal never shows it; the resolved cwd is captured separately.
    chunk = stripCwdQuery(chunk)
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
    if (c) {
      feedCapture(term, c, chunk, () => {
        captureRef.current = null
      })
      return
    }
    const t = tableCaptureRef.current
    if (t) {
      feedTable(term, t, chunk, () => {
        tableCaptureRef.current = null
      })
      return
    }
    term.write(chunk)
    // A newline means a command started producing output — we're no longer
    // awaiting a typed-line echo, so drop the gate to avoid recoloring output.
    if (chunk.includes('\n') || chunk.includes('\r')) expectingEchoRef.current = false
    // Telnet/Serial: detect login vs shell-prompt state from the latest output.
    // Login/password prompts disable live coloring so the echoed first character
    // isn't duplicated; a real shell prompt re-enables it. This also handles sudo
    // password prompts, nested session logins, and interactive prompts inside a
    // local shell (e.g. `ssh` host-key confirmation) inside an already-colored
    // session.
    if (isTelnet || isSerial || isLocal) {
      const lines = stripAnsi(chunk).split(/[\r\n]+/)
      const last = lines[lines.length - 1] || ''
      if (looksLikeLoginPrompt(last) || looksLikeInteractivePrompt(last)) {
        shellReadyRef.current = false
      } else if (looksLikeShellPrompt(last)) {
        shellReadyRef.current = true
      }
    }
    // Recolor the live input line after the echo is written: this colors the
    // newest keystroke (which arrives a frame after the per-keystroke highlight
    // in onData). recolorLiveLine is gated by expectingEchoRef, so
    // it only fires while we're awaiting a keystroke echo — program output is
    // never recolored, which keeps input working.
    // For Telnet/Serial this is also gated by shellReadyRef so login/password
    // prompts are not corrupted by the prompt-recognition heuristics.
    if (shellReadyRef.current) recolorLiveLine()
  }

  const startPrintCapture = (lang: string, highlighter: (t: string) => string[], prompt: string) => {
    resetCapture()
    // NOTE: do NOT clearLsLinks() here. A previous `ls` listing may still be
    // visible on screen and should stay clickable. The link provider matches
    // live line text (column-anchored + name-boundary), so `cat`/`head`/`tail`
    // output can only produce a link where it genuinely matches an entry name
    // at the right column — which is benign (the user sees the name and can
    // click it). Listings are cleared only on clear/disconnect/reconnect/AI
    // command/unmount.
    captureRef.current = {
      lang,
      highlighter,
      prompt: prompt || '',
      buf: '',
      writtenLines: 0,
      bytes: 0,
      timeout: null,
      flushTimer: null,
    }
  }

  const startCaptureIfPrint = (cmd: string, prompt: string) => {
    const h = commandHighlighter(cmd)
    if (!h) return
    startPrintCapture(h.lang, h.highlighter, prompt)
  }

  // Plain multi-column `ls` / `dir` (no `-l`): colorize the listing in place.
  // The `ls -l`/`ll`/`dir` long form is handled separately by the clickable
  // listing linkifier, so we only intercept the plain form here.
  const startCaptureIfLsPlain = (cmd: string, prompt: string) => {
    const fmt = detectLsCommand(cmd)
    if (!fmt || fmt === 'long') return
    resetCapture()
    captureRef.current = {
      lang: 'ls',
      highlighter: (t) => highlightTableText(t, fmt),
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
  // On reconnect the shell restarts in its start dir, so drop the tracked cwd
  // (it would otherwise stay stale at the pre-reconnect directory).
  useEffect(() => {
    setCwd(localCwd ?? null)
    homeRef.current = null
  }, [reconnectTrigger])
  useEffect(() => {
    connectConfigRef.current = connectConfig
    localShellTypeRef.current = localShellType
    onStatusChangeRef.current = onStatusChange
    onSizeChangeRef.current = onSizeChange
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

    ensureHighlightLanguagesPreloaded()

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
      fontFamily:
        '"WrolpNerdFont", "FiraCode Nerd Font", "Fira Code Nerd Font", "CaskaydiaCove Nerd Font", "CaskaydiaCove NF", "JetBrainsMono Nerd Font", "MesloLGS NF", "Symbols Nerd Font", "Fira Code", "Cascadia Code", Consolas, "Courier New", "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", monospace',
      scrollback: maxScrollback ?? 5000,
      // NOTE: do NOT enable `windowsMode`. It is the legacy winpty / pre-1903
      // ConPTY workaround (forces a line feed at the right edge and disables
      // reflow) and actively misaligns rows against a modern ConPTY, which
      // already emits proper VT sequences.
      theme: {
        // Opaque terminal background. Do NOT use transparency here: xterm.js
        // will alpha-blend shell-rendered cell backgrounds (e.g. powerlevel10k
        // prompt blocks) against the theme background and the colors look wrong.
        background: '#1e1e1e',
        foreground: '#ffffff',
        cursor: '#aeafad',
        selectionBackground: '#264f78',
        black: '#a0a0a0',
        red: '#f44747',
        green: '#3a8558',
        yellow: '#dcdcaa',
        blue: '#5b7fb5',
        magenta: '#c586c0',
        cyan: '#4dc9b0',
        white: '#ffffff',
        brightBlack: '#808080',
        brightRed: '#f44747',
        brightGreen: '#4daa6a',
        brightYellow: '#dcdcaa',
        brightBlue: '#5b7fb5',
        brightMagenta: '#d4a0d4',
        brightCyan: '#6ae6cc',
        brightWhite: '#ffffff',
      },
      minimumContrastRatio: 1,
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
                // Render the card below the entry when it's near the top of the
                // viewport, so it isn't clipped/overlapped at the top-left corner.
                // A small downward nudge keeps it clearly under the name.
                let below = pos.y < 90
                // Above the name: nudge down 2px; below the name: nudge up 2px.
                let top = below ? pos.y + pos.cellH - 2 : pos.y + 2
                // Safety: even in the above case, never let the card climb above
                // the viewport — flip it below if it would.
                if (!below && top < 8) {
                  below = true
                  top = pos.y + pos.cellH - 2
                }
                setLinkTooltip({ x: pos.x, y: top, below, entry })
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
        // A command is being submitted — any pending echo recolor is for the line
        // we just highlighted above; stop awaiting it so stray output isn't
        // mistaken for a typed line.
        expectingEchoRef.current = false
        if (shellReadyRef.current) {
          commitSubmittedCommands(term, data, currentTabId)
        }
        // A lone Enter submits a single command: detect print-style commands
        // (`cat`/`head`/`tail`) and `ls`-style listings for their respective
        // capture machines. The prompt is captured from the same buffer line so
        // capture can end precisely when the next prompt arrives.
        if (/^[\r\n]+$/.test(data)) {
          const { prompt, command } = splitPromptCommand(getCurrentCommandLine(term))
          // A pager prompt (`---- More ----`, `--More--`, `-- MORE --`, `---(more)---`)
          // is device OUTPUT awaiting a keypress, not a submitted command. Skip the
          // command-processing block (cwd tracking / capture machines / echo recolor) so
          // paging through long output isn't mistaken for a command input. This mirrors
          // the guard in `commitSubmittedCommands`; without it a fast Enter on a pager
          // prompt still got classified as a command. The keystroke itself is still
          // forwarded to the device below — only the bookkeeping is skipped.
          if (!isPagerPrompt(command)) {
          // Track directory changes (local AND ssh) by following cd/Set-Location.
          // The backend never updates LocalShell.cwd on `cd`, and SSH prompts only
          // show a *relative* cwd, so we keep the real (absolute) cwd here for `ls`
          // link resolution. SSH is seeded from $HOME on the first `cd`.
          if (command) {
            // Session-boundary commands switch the shell context: entering a
            // nested session (docker exec shell / interactive ssh) or leaving
            // one (exit/logout) makes the tracked cwd stale — it describes the
            // OUTER shell, not what's on screen. Drop it so `ls` link bases
            // fall back to the prompt-derived cwd (see startLsCaptureIfMatch).
            if (isNestedSessionEntry(command)) {
              nestedDepthRef.current += 1
              // A manually typed `docker exec` shell — remember the container so
              // `ls` click type resolution queries the CONTAINER filesystem (not
              // the host SFTP) and cwd tracking stays container-relative.
              dockerContainerRef.current = parseDockerExecContainer(command) ?? dockerContainerRef.current
              cwdRef.current = null
            } else if (isNestedSessionExit(command)) {
              // Leaving a nested session, or exiting a sidebar-opened docker exec
              // shell back to the host — drop the nested state so `ls` link
              // bases fall back to the host cwd again.
              if (nestedDepthRef.current > 0) nestedDepthRef.current -= 1
              dockerContainerRef.current = null
              cwdRef.current = null
            }
            const t0 = command.trim().split(/\s+/)[0]?.toLowerCase()
            if (t0 === 'cd' || t0 === 'chdir' || t0 === 'set-location' || t0 === 'sl') {
              // Strip the `--` end-of-options marker and common flags (e.g.
              // `cd -- /path`, `cd -L /path`) so the real target is parsed.
              let cdRaw = command.trim().slice(t0.length).trim()
              cdRaw = cdRaw.replace(/^--\s+/, '').replace(/^-[LP]\s+/, '')
              const arg = cdRaw.split(/\s+/)[0] ?? ''
              void (async () => {
                // Docker exec shells: `cd` runs inside the container — the
                // host-tracked cwd can't describe container paths, so skip both
                // the `pwd` seed and the cwd tracking (ls links resolve from the
                // container's prompt instead).
                if (dockerContainerRef.current != null) return
                // SSH: seed the cwd from the shell's real directory (a hidden
                // `pwd` query) when we don't yet track an absolute cwd. We never
                // guess from $HOME, since the dir need not live under it. Inside
                // a nested session the query would hit the OUTER shell, so skip
                // it — absolute `cd` targets still resolve, relative ones fall
                // back to the prompt on the next `ls`.
                if (!isLocal && cwdRef.current == null && nestedDepthRef.current === 0) {
                  try {
                    const real = await fetchRemoteCwd()
                    if (real && cwdRef.current == null) setCwd(real)
                  } catch {
                    /* keep null; will fall back to the prompt */
                  }
                }
                const next = resolveCdTarget(arg, cwdRef.current)
                if (!next) return
                // Don't trust the computed path — verify the directory actually exists
                // before updating the tracked cwd. A failed `cd` leaves the shell in
                // its current directory, so using the bogus target would make all
                // subsequent `ls` links point to a non-existent base.
                try {
                  const exists = await fsFileExists(lsFsTarget(), next)
                  if (exists) setCwd(next)
                } catch {
                  /* fall through: keep old cwd; ls links will use prompt as fallback */
                }
              })()
            }
          }
          // F1: recolor the typed command (and, if the PS1 is uncolored, its
          // trailing symbol) right before the shell processes the Enter. The line
          // is already on screen uncolored; we rewrite it in place.
          // Skip for Telnet/Serial until the shell prompt is detected.
          if (shellReadyRef.current) {
            highlightCurrentCommandLine(term)
          }
          // NOTE: do NOT clearLsLinks() on Enter. A previous `ls` listing stays
          // visible on screen across ordinary commands (Enter, `cd`, `cat`, a
          // new `ls`…) and should remain clickable throughout. The link provider
          // matches the *live* hovered line (column-anchored + name-boundary),
          // so entries can't produce phantom links once their rows scroll off —
          // they simply stop matching. Each entry carries its own baseDir, so a
          // click always resolves against the listing it came from, even after
          // a newer `ls` elsewhere. Links are cleared only on:
          //   `clear` / disconnect / reconnect / AI command / unmount.
          // Clear any stale table capture first so a non-table command (e.g.
          // `echo hi` right after `df`) can't be wrongly colored as a table.
          resetTableCapture()
          // TODO(临时): 暂注释命令输出相关高亮（表格/print），保留输入高亮与 ls/dir。
          // startCaptureIfPrint(command, prompt)          // 命令输出高亮：cat/head/tail
          // startCaptureIfLsPlain 已由 startLsCaptureIfMatch 兼管（plain ls/dir 在
          // writeLsChunk 里完成着色+可点击，避免两个 capture 同时占用输出）。
          // Telnet has no SFTP channel, so `ls` entries can't be resolved or
          // opened — skip the clickable-link capture entirely for it.
          if (!isTelnet) startLsCaptureIfMatch(command, prompt) // 保留：原 ls/dir 着色+可点击
          // startTableCaptureIfMatch(command, prompt)     // 命令输出高亮：df/ps/free/netstat/...
          }
        }
      }
      // Mark that we are awaiting this keystroke's echo so the post-echo recolor
      // in writeOutput knows the line is a typed command (not program output).
      // Coloring is done ONLY once the echo is written back (race-free with the
      // async SSH echo — no rAF rewrite that could erase in-flight characters).
      // For Telnet/Serial only start expecting echoes after a real shell prompt
      // has been detected, so login/password prompts are not corrupted.
      if (shellReadyRef.current && !/^[\r\n]+$/.test(data)) {
        expectingEchoRef.current = true
      }
      if (isLocal) {
        localSendInput(currentTabId, data).catch((err) =>
          console.error('local_send_input error:', err),
        )
      } else if (isSerial) {
        serialSendInput(currentTabId, data).catch((err) =>
          console.error('serial_send_input error:', err),
        )
      } else if (isTelnet) {
        telnetSendInput(currentTabId, data).catch((err) =>
          console.error('telnet_send_input error:', err),
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

    // Re-fit once web fonts (Nerd Fonts etc.) finish loading. xterm measures cell
    // metrics at fit() time, so a fit that ran before the font arrived computes
    // wrong cols/rows and the prompt renders truncated until a manual resize.
    if (typeof document !== 'undefined' && document.fonts?.ready) {
      document.fonts.ready
        .then(() => maybeFitAndResize())
        .catch(() => {})
    }

    // Poll SSH output (every 100ms), completely bypassing Tauri event system.
    // The poll is skipped while the window is hidden (minimized / occluded) or
    // the session is no longer connected — backend buffers the output, and the
    // next visible/connected tick drains it. This keeps the IPC loop (10 Hz ×
    // every tab) from burning CPU while the user isn't looking at the window.
    const startPolling = () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current)
      // Do one immediate poll so slow first-output doesn't wait for the first
      // 100 ms interval tick.
      const doPoll = async () => {
        if (document.hidden || !connectedRef.current) return
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

    // Stop polling (and mark disconnected) when the backend reports the SSH
    // connection closed, instead of keeping the 10 Hz IPC loop running forever.
    let unlistenClosed: (() => void) | null = null
    listen<{ tabId: number }>('connection-closed', (event) => {
      if (event.payload.tabId !== currentTabId) return
      connectedRef.current = false
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current)
        pollTimerRef.current = null
      }
    }).then((un) => {
      unlistenClosed = un
    })

    // When the window becomes visible again, drain any output that accumulated
    // while it was hidden in one immediate poll (next interval tick is up to
    // 100 ms away — this makes it feel instant).
    const handleVisibility = () => {
      if (!document.hidden && connectedRef.current && pollTimerRef.current) {
        const currentTab = tabIdRef.current
        pollOutput(currentTab)
          .then((chunks) => {
            for (const chunk of chunks) writeOutput(chunk)
          })
          .catch(() => {})
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)

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
            // Defer startPolling until after a confirmed-good fit+resize.
            // If we start polling now, the shell may emit its prompt at the
            // initial (possibly undersized) cols/rows, and even a later SIGWINCH
            // cannot fully fix already-rendered content. Waiting for the container
            // to reach its final geometry ensures the first frame of output is
            // rendered at the correct width — matching what the user sees after a
            // manual window resize.
            setTimeout(() => {
              if (fitRef.current && term.cols > 0 && term.rows > 0) {
                const prevCols = term.cols
                const prevRows = term.rows
                fitRef.current.fit()
                term.refresh(0, term.rows - 1)
                // Only propagate if geometry actually changed (avoids spurious
                // SIGWINCH when the initial fit was already correct).
                if (
                  term.cols !== prevCols ||
                  term.rows !== prevRows
                ) {
                  lastColsRef.current = term.cols
                  lastRowsRef.current = term.rows
                  sendResize(term)
                }
              }
              startPolling()
            }, 400)
          })
          .catch((err) => {
            const errMsg = typeof err === 'string' ? err : (err as any)?.message || String(err)
            // Show the error inside the terminal instead of hiding the pane,
            // so the user can see *why* the local shell failed to start.
            term.write(`\x1b[31m[local shell] failed to start: ${errMsg}\x1b[0m\r\n`)
            onStatusChangeRef.current('error', errMsg)
            console.error('open_local_shell error:', err)
          })
      } else if (isSerial) {
        const sCfg = cfg!
        connectSerial(
          {
            id: sCfg.id,
            name: sCfg.name || sCfg.portName || 'Serial',
            portName: sCfg.portName || '',
            baudRate: sCfg.baudRate ?? 9600,
            dataBits: sCfg.dataBits ?? 8,
            stopBits: sCfg.stopBits ?? 1,
            parity: sCfg.parity || 'none',
            flowControl: sCfg.flowControl || 'none',
            group: sCfg.group,
            workspaceId: sCfg.workspaceId,
          },
          currentTabId,
          cols,
          rows,
        )
          .then(() => {
            connectedRef.current = true
            onStatusChangeRef.current('connected')
            startPolling()
          })
          .catch((err) => {
            const errMsg = typeof err === 'string' ? err : (err as any)?.message || String(err)
            term.write(`\x1b[31m[serial] connect failed: ${errMsg}\x1b[0m\r\n`)
            onStatusChangeRef.current('error', errMsg)
            console.error('connect_serial error:', err)
          })
      } else if (isTelnet) {
        const tCfg = cfg!
        connectTelnet(
          {
            id: tCfg.id,
            name: tCfg.name || `${tCfg.username || ''}@${tCfg.host}`.replace(/^@/, ''),
            host: tCfg.host,
            port: tCfg.port || 23,
            username: tCfg.username || '',
            password: tCfg.password,
            autoLogin: tCfg.autoLogin ?? false,
            group: tCfg.group,
            workspaceId: tCfg.workspaceId,
          },
          currentTabId,
          cols,
          rows,
        )
          .then(() => {
            connectedRef.current = true
            onStatusChangeRef.current('connected')
            startPolling()
          })
          .catch((err) => {
            const errMsg = typeof err === 'string' ? err : (err as any)?.message || String(err)
            term.write(`\x1b[31m[telnet] connect failed: ${errMsg}\x1b[0m\r\n`)
            onStatusChangeRef.current('error', errMsg)
            console.error('connect_telnet error:', err)
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
            nestedDepthRef.current = 0 // fresh shell: no nested session carry-over
            seedInitialRemoteCwd()
            // Same deferred-fit-then-poll rationale as the local shell path:
            // ensure correct geometry before any output is rendered.
            setTimeout(() => {
              if (fitRef.current && term.cols > 0 && term.rows > 0) {
                const prevCols = term.cols
                const prevRows = term.rows
                fitRef.current.fit()
                term.refresh(0, term.rows - 1)
                if (
                  term.cols !== prevCols ||
                  term.rows !== prevRows
                ) {
                  lastColsRef.current = term.cols
                  lastRowsRef.current = term.rows
                  sendResize(term)
                }
              }
              startPolling()
            }, 400)
          })
          .catch((err) => {
            const errMsg = typeof err === 'string' ? err : (err as any)?.message || String(err)
            onStatusChangeRef.current('error', errMsg)
            console.error('connect error:', err)
          })
      }
    }

    const waitForLayoutAndFit = async () => {
      // Wait for the bundled Nerd Font before measuring cells. If fit() runs
      // with a fallback font, the column width is wrong and the shell prompt is
      // misaligned until the window is manually resized.
      await document.fonts.load('14px "WrolpNerdFont"').catch(() => {
        /* fall back to the current font if the bundled font fails to load */
      })
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
      } else if (layoutWaitFrames.current < 300) {
        // Container still has zero dimensions, keep waiting (capped so a
        // permanently hidden pane can't spin a 60 fps rAF loop forever).
        layoutWaitFrames.current++
        requestAnimationFrame(waitForLayoutAndFit)
      }
    }
    layoutWaitFrames.current = 0
    // Use double rAF to ensure flex layout is complete, then enter polling wait for actual dimensions
    requestAnimationFrame(() => {
      requestAnimationFrame(waitForLayoutAndFit)
    })

    return () => {
      console.log('[Terminal] cleanup, resetting hasRun')
      hasRun.current = false
      connectedRef.current = false
      resetCapture()
      resetTableCapture()
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
      unlistenClosed?.()
      document.removeEventListener('visibilitychange', handleVisibility)
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

  // Load the bundled Nerd Font. If xterm opened with a fallback font, the
  // texture atlas and cell metrics need to be reset once the real font is
  // ready, otherwise icon glyphs render with stale metrics and leave ghosts.
  useEffect(() => {
    document.fonts.load('14px "WrolpNerdFont"').then(
      () => {
        const fit = fitRef.current
        const term = termRef.current
        if (fit && term && term.cols > 0 && term.rows > 0) {
          try {
            // Reset the renderer so the font texture atlas is rebuilt with the
            // newly loaded Nerd Font metrics, then refresh every visible row.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ;(term as any)._core?._renderService?.clear()
            fit.fit()
            term.refresh(0, term.rows - 1)
            // Propagate the corrected geometry to the shell too (SIGWINCH),
            // otherwise the shell keeps the pre-font-load size and the prompt
            // stays truncated until a manual resize.
            if (
              term.cols !== lastColsRef.current ||
              term.rows !== lastRowsRef.current
            ) {
              lastColsRef.current = term.cols
              lastRowsRef.current = term.rows
              sendResize(term)
            }
          } catch {
            /* container may be momentarily 0-sized */
          }
        }
      },
      () => {
        /* font failed to load; terminal stays on fallback, input still works */
      },
    )
  }, [])

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
    resetTableCapture()
    clearAiMarkTimeout()
    aiMarkRef.current = null
    resetLsCapture()
    clearLsLinks()
    // Reset login-state detection so Telnet/Serial re-enter the login prompt
    // without live coloring until the shell prompt reappears.
    shellReadyRef.current = !isTelnet && !isSerial

    const term = termRef.current
    if (!term) return

    const cfg = connectConfigRef.current
    const currentTabId = tabIdRef.current
    // Local shells and serials: serials still have a connectConfig, but guard anyway.
    if (!cfg && !isLocal && !isSerial) return

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
            connectedRef.current = true
            onStatusChangeRef.current('connected')
            // Defer polling + post-connect fit so geometry is correct before
            // any output is rendered.
            setTimeout(() => {
              const fit = fitRef.current
              if (fit && term.cols > 0 && term.rows > 0) {
                const prevCols = term.cols
                const prevRows = term.rows
                fit.fit()
                term.refresh(0, term.rows - 1)
                if (
                  term.cols !== prevCols ||
                  term.rows !== prevRows
                ) {
                  lastColsRef.current = term.cols
                  lastRowsRef.current = term.rows
                  sendResize(term)
                }
              }
              if (pollTimerRef.current) clearInterval(pollTimerRef.current)
              pollTimerRef.current = setInterval(async () => {
                if (document.hidden || !connectedRef.current) return
                try {
                  const chunks = await pollOutput(currentTabId)
                  if (chunks.length > 0) {
                    for (const chunk of chunks) writeOutput(chunk)
                  }
                } catch {}
              }, 100)
            }, 300)
          })
          .catch((err) => {
            const errMsg = typeof err === 'string' ? err : (err as any)?.message || String(err)
            onStatusChangeRef.current('error', errMsg)
            console.error('local reconnect error:', err)
          })
        return
      }

      if (isSerial) {
        const sCfg = cfg!
        connectSerial(
          {
            id: sCfg.id,
            name: sCfg.name || sCfg.portName || 'Serial',
            portName: sCfg.portName || '',
            baudRate: sCfg.baudRate ?? 9600,
            dataBits: sCfg.dataBits ?? 8,
            stopBits: sCfg.stopBits ?? 1,
            parity: sCfg.parity || 'none',
            flowControl: sCfg.flowControl || 'none',
            group: sCfg.group,
            workspaceId: sCfg.workspaceId,
          },
          currentTabId,
          cols,
          rows,
        )
          .then(() => {
            connectedRef.current = true
            onStatusChangeRef.current('connected')
            setTimeout(() => {
              if (pollTimerRef.current) clearInterval(pollTimerRef.current)
              pollTimerRef.current = setInterval(async () => {
                if (document.hidden || !connectedRef.current) return
                try {
                  const chunks = await pollOutput(currentTabId)
                  if (chunks.length > 0) {
                    for (const chunk of chunks) writeOutput(chunk)
                  }
                } catch {}
              }, 100)
            }, 300)
          })
          .catch((err) => {
            const errMsg = typeof err === 'string' ? err : (err as any)?.message || String(err)
            term.write(`\x1b[31m[serial] reconnect failed: ${errMsg}\x1b[0m\r\n`)
            onStatusChangeRef.current('error', errMsg)
            console.error('connect_serial error:', err)
          })
        return
      }

      if (isTelnet) {
        const tCfg = cfg!
        connectTelnet(
          {
            id: tCfg.id,
            name: tCfg.name || `${tCfg.username || ''}@${tCfg.host}`.replace(/^@/, ''),
            host: tCfg.host,
            port: tCfg.port || 23,
            username: tCfg.username || '',
            password: tCfg.password,
            autoLogin: tCfg.autoLogin ?? false,
            group: tCfg.group,
            workspaceId: tCfg.workspaceId,
          },
          currentTabId,
          cols,
          rows,
        )
          .then(() => {
            connectedRef.current = true
            onStatusChangeRef.current('connected')
            setTimeout(() => {
              if (pollTimerRef.current) clearInterval(pollTimerRef.current)
              pollTimerRef.current = setInterval(async () => {
                if (document.hidden || !connectedRef.current) return
                try {
                  const chunks = await pollOutput(currentTabId)
                  if (chunks.length > 0) {
                    for (const chunk of chunks) writeOutput(chunk)
                  }
                } catch {}
              }, 100)
            }, 300)
          })
          .catch((err) => {
            const errMsg = typeof err === 'string' ? err : (err as any)?.message || String(err)
            term.write(`\x1b[31m[telnet] reconnect failed: ${errMsg}\x1b[0m\r\n`)
            onStatusChangeRef.current('error', errMsg)
            console.error('connect_telnet error:', err)
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
          connectedRef.current = true
          onStatusChangeRef.current('connected')
          nestedDepthRef.current = 0 // fresh shell: no nested session carry-over
          seedInitialRemoteCwd()
          // Defer polling + post-connect fit so geometry is correct before any
          // output is rendered.
          setTimeout(() => {
            const fit = fitRef.current
            if (fit && term.cols > 0 && term.rows > 0) {
              const prevCols = term.cols
              const prevRows = term.rows
              fit.fit()
              term.refresh(0, term.rows - 1)
              if (
                term.cols !== prevCols ||
                term.rows !== prevRows
              ) {
                lastColsRef.current = term.cols
                lastRowsRef.current = term.rows
                sendResize(term)
              }
            }
            if (pollTimerRef.current) clearInterval(pollTimerRef.current)
            pollTimerRef.current = setInterval(async () => {
              if (document.hidden || !connectedRef.current) return
              try {
                const chunks = await pollOutput(currentTabId)
                if (chunks.length > 0) {
                  for (const chunk of chunks) writeOutput(chunk)
                }
              } catch {}
            }, 100)
          }, 300)
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
        } else if (layoutWaitFrames.current < 300) {
          layoutWaitFrames.current++
          requestAnimationFrame(waitForLayout)
        }
      }
      layoutWaitFrames.current = 0
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
    resetTableCapture()
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
    // Keep the bar wide for the whole gesture even if the pointer strays out of
    // the grab zone — CSS :hover alone would collapse it mid-drag.
    setThumbDragging(true)
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
      setThumbDragging(false)
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
        <div
          className={'term-scrollbar' + (thumbDragging ? ' is-dragging' : '')}
          data-term-scrollbar={tabId}
        >
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



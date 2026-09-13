import { Terminal } from '@xterm/xterm'
import { getCurrentCommandLine, stripPrompt } from './promptLine'

// Tracks the single "active" terminal instance per session tabId. During a
// transient double-mount (React mounts the new terminal before unmounting the
// old one — e.g. on split/close/reconcile), two instances for the same tabId
// briefly coexist. Only the instance registered here may send input, so the
// stale duplicate can never echo the same keystroke twice into the SSH session
// (which produced bugs like typing "ls" reaching the shell as "lss").
export const activeTerminalByTab = new Map<number, Terminal>()

// Tracks the most recently mounted terminal instance for each session tabId,
// regardless of focus. Used by `focusTerminal` so callers outside this file
// (reconnect button, "send to terminal") can move keyboard focus into the
// right xterm instance — even when that terminal is not the currently focused
// pane (e.g. a disconnected tab about to be reconnected).
export const latestTerminalByTab = new Map<number, Terminal>()

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

// Registered per terminal tab so external callers (command-list snippets) can
// drive the SAME paste pipeline as a real Ctrl+V — multi-line text then gets the
// guard / bracketed-paste / quoted-insert treatment instead of being written raw
// via `sendInput` (which would execute each line immediately). The registered
// fn is the terminal's own `pasteIntoTerminal` callback, so it already knows the
// session kind, bracketed-paste mode and the correct send path.
export const pasteFnByTab = new Map<number, (text: string) => void>()

export const registerPaste = (tabId: number, fn: (text: string) => void): void => {
  pasteFnByTab.set(tabId, fn)
}

// Only clear our entry when it still belongs to this instance — during a
// transient double-mount the superseding instance overwrites the map entry, so
// the stale instance's cleanup must NOT delete the live one.
export const unregisterPaste = (tabId: number, fn: (text: string) => void): void => {
  if (pasteFnByTab.get(tabId) === fn) pasteFnByTab.delete(tabId)
}

/** Paste `text` into the terminal owned by `tabId` through that tab's paste
 *  pipeline. No-op if the terminal is not mounted / not registered. */
export const pasteToTerminal = (tabId: number, text: string): void => {
  const fn = pasteFnByTab.get(tabId)
  if (fn) fn(text)
}

// Terminal instances raise a per-tab "awaiting input echo" gate while the shell
// is expected to echo a line that was just sent. Typing raises it automatically
// (it lives in the terminal's own onData handler), but a PROGRAMMATIC send that
// bypasses onData must raise it too — e.g. a snippet appended to a non-empty
// input line (`sendInput(' && <cmd>')`, no trailing newline). That echo is an
// INPUT line owned by the command-line colorizer, and the stream highlighter
// would otherwise hold its trailing token back (a number such as `50` stayed
// invisible until the next output arrived — issue #26). Mirrors `registerPaste`.
export const expectEchoFnByTab = new Map<number, () => void>()

export const registerExpectEcho = (tabId: number, fn: () => void): void => {
  expectEchoFnByTab.set(tabId, fn)
}

// Only clear our entry when it still belongs to this instance (same guard as
// `unregisterPaste`: a transient double-mount must not delete the live entry).
export const unregisterExpectEcho = (tabId: number, fn: () => void): void => {
  if (expectEchoFnByTab.get(tabId) === fn) expectEchoFnByTab.delete(tabId)
}

/** Mark `tabId` as about to receive the echo of a sent input line. No-op if the
 *  terminal is not mounted / not registered. */
export const markInputEcho = (tabId: number): void => {
  const fn = expectEchoFnByTab.get(tabId)
  if (fn) fn()
}

// Preserves terminal scrollback across transient re-mounts (float pop-out / dock
// back). React tears down the xterm instance when its portal container changes,
// so we serialize the full buffer (ANSI colors included, via @xterm/addon-serialize)
// here and replay it on the next mount.
export const scrollbackCache = new Map<number, string>()

export const replayScrollback = (term: Terminal, tabId: number): void => {
  const cached = scrollbackCache.get(tabId)
  if (!cached) return
  scrollbackCache.delete(tabId)
  term.write(cached)
  term.scrollToBottom()
}

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

import { Terminal } from '@xterm/xterm'
import { stripAnsi } from '../../lib/termHighlight'
import { colorizeCommand } from '../../lib/cmdEcho'
import { commitCommand } from '../../commands'
import { canRecolorInPlace, isWrappedContinuation, logicalTopRow } from './wrapDetect'

// Read the full logical line under the cursor, reassembling wrapped
// continuation lines so long tab-completed commands are not truncated.
export function getCurrentCommandLine(term: Terminal): string {
  const buffer = term.buffer.active
  const cols = term.cols
  // `cursorY` is relative to `baseY` (0..rows-1) but `getLine` expects an
  // absolute buffer index — offset by `baseY` so this reads the actual cursor
  // row rather than a stale scrollback line.
  const cursorRow = buffer.baseY + buffer.cursorY
  let y = cursorRow
  const line = buffer.getLine(y)
  if (!line) return ''
  let text = line.translateToString(true)
  // Walk back while the previous row is a wrapped continuation. `isWrapped` is
  // authoritative; the full-row length fallback only stands in for the tick
  // where the caret has just spilled onto a fresh row (see `wrapDetect`). Using
  // it unconditionally merged a full-width OUTPUT row into the input line,
  // which then made the recolor erase that row (task/BUGS.md B25).
  while (y > 0) {
    const prev = buffer.getLine(y - 1)
    if (!prev) break
    const { prompt } = splitPromptCommand(stripAnsi(text))
    if (prompt.length > 0) break
    const prevText = prev.translateToString(true)
    const merge = isWrappedContinuation({
      cursorX: buffer.cursorX,
      isFirstStep: y === cursorRow,
      prevIsWrapped: prev.isWrapped,
      prevVisibleLength: stripAnsi(prevText).length,
      cols,
    })
    if (merge) {
      text = prevText + text
      y -= 1
      continue
    }
    break
  }
  return text
}

// Upper bound on a plausible prompt length. A marker found beyond this point is
// far more likely to be command syntax (a redirect, a `$VAR`, a glob) than the
// terminator of a shell prompt.
const MAX_PROMPT_LEN = 96

// Leftmost occurrence of any marker, searched only within the first `maxPos`
// characters. Returns the match position and the matched marker's length.
const findLeftmostMarker = (
  text: string,
  markers: string[],
  maxPos: number,
): { pos: number; len: number } | null => {
  let best = -1
  let bestLen = 0
  for (const m of markers) {
    const pos = text.indexOf(m)
    if (pos >= 0 && pos < maxPos && (best < 0 || pos < best)) {
      best = pos
      bestLen = m.length
    }
  }
  return best >= 0 ? { pos: best, len: bestLen } : null
}

// Prompts terminated by a closing bracket instead of a classic symbol, e.g.
// `[root@host:~] ` or `(venv) `. The head up to (and including) the bracket must
// be space-free and start with the matching opener, which rules out ordinary
// command text such as `echo [a-z] file`.
const findBracketPrompt = (text: string): { pos: number; len: number } | null => {
  const pairs: Array<[string, string]> = [
    ['[', ']'],
    ['(', ')'],
    ['{', '}'],
  ]
  for (const [open, close] of pairs) {
    const pos = text.indexOf(close + ' ')
    if (pos <= 0 || pos >= MAX_PROMPT_LEN) continue
    const head = text.slice(0, pos + 1)
    if (!head.startsWith(open) || /\s/.test(head)) continue
    return { pos, len: 2 }
  }
  return null
}

// Remove ANSI escape sequences and split a submitted buffer line into its
// leading shell prompt (plain text) and the command that follows.
export function splitPromptCommand(line: string): { prompt: string; command: string } {
  const noAnsi = line.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
  // The prompt always PRECEDES the command, so scan left-to-right and keep the
  // FIRST plausible terminator. (The previous rightmost-match rule swallowed the
  // head of the command: in `[root@host:~]# ls > out.txt` the `> ` redirect sits
  // further right than the real `# `, so `ls > ` was classed as prompt and never
  // recolored.)
  //
  // Pass 1 — "marker + space" (`$ `, `# `, `% `, `> `, `❯ `): how virtually every
  //   shell terminates its prompt. Most reliable, so it wins outright. Covers
  //   PowerShell / cmd prompts that DO end in `> `.
  // Pass 2 — bare marker (`PS C:\path>` often carries no trailing space), trusted
  //   only within MAX_PROMPT_LEN.
  // Pass 3 — bracket-terminated prompts (`[root@host:~] `), which carry no
  //   classic symbol at all. Without this the whole prompt is recolored as if it
  //   were command text.
  const spaced = findLeftmostMarker(noAnsi, ['$ ', '# ', '% ', '> ', '❯ '], MAX_PROMPT_LEN)
  const bare = spaced ? null : findLeftmostMarker(noAnsi, ['$', '#', '%', '>', '❯'], MAX_PROMPT_LEN)
  const hit = spaced ?? bare ?? findBracketPrompt(noAnsi)
  if (hit) {
    const end = hit.pos + hit.len
    return { prompt: noAnsi.slice(0, end), command: noAnsi.slice(end).trimEnd() }
  }
  return { prompt: '', command: noAnsi.trim() }
}

// Pager prompts that network CLIs print at the bottom of a full screen: Cisco
// `--More--`, Huawei/H3C `---- More ----`, HP `-- MORE --`, and the bracketed
// `---(more)---` variant. These are command OUTPUT waiting for a keypress, NOT a
// command line — they carry no prompt marker, so `splitPromptCommand` returns them
// whole as `command`, and tokenizing them paints the dashes as green options and
// wipes the device's own rendering with the trailing `\x1b[K`.
const PAGER_PROMPT_RE = /-{2,}\s*\(?\s*more\s*\)?\s*-{2,}/i

export const isPagerPrompt = (line: string): boolean => PAGER_PROMPT_RE.test(line)

// Remove ANSI escape sequences and strip a leading shell prompt so only the
// command itself remains.
export function stripPrompt(line: string): string {
  return splitPromptCommand(line).command
}

// Recolor the currently-displayed input line (prompt + typed command) in place.
// The remote shell has already echoed the uncolored line onto the screen; we
// tokenize the command and rewrite just that line with SGR colors.
//
// - If the user's PS1 is uncolored (no ANSI in the raw line), we also color the
//   trailing prompt symbol (root `#` red, else green) and rewrite the whole line.
// - If the PS1 is already colored, we leave the prompt untouched and only recolor
//   the command portion (split the raw line exactly at the prompt boundary so the
//   user's ANSI PS1 is preserved byte-for-byte).
//
// Wrapped (multi-row) commands are NOT recolored: repainting one requires moving
// the cursor up and clearing rows, which repeatedly corrupted the screen (see
// `canRecolorInPlace`). The shell's own echo is left exactly as-is — the only
// cost is that a wrapped command keeps the prompt's SGR instead of being
// syntax-colored.
export function highlightCurrentCommandLine(term: Terminal) {
  const rawLine = getCurrentCommandLine(term)
  if (!rawLine) return
  const plain = stripAnsi(rawLine)
  const { prompt, command } = splitPromptCommand(plain)
  if (!command && !prompt) return
  // No prompt marker was found — this is program output, not a shell command line.
  // Recoloring it would strip indentation and color unrelated text (e.g. network
  // device help listings like "  install     Perform ...").
  if (!prompt) return
  // Never recolor full-screen TUI screens (vi/nano/less/tmux/etc.). Those use the
  // alternate buffer and manage their own styling; rewriting a line here strips
  // their colors and corrupts indentation.
  if (term.buffer.active.type === 'alternate') return
  // A pager prompt (`---- More ----`) is device output, not a typed command.
  if (isPagerPrompt(plain)) return
  const buffer = term.buffer.active
  const cols = term.cols
  const lastRow = buffer.baseY + buffer.cursorY
  // Top physical row of this (possibly wrapped) logical line. Prefer the
  // explicit `isWrapped` chain, but fall back to the logical length: right at
  // the wrap boundary xterm may not have set `isWrapped` yet, so a line whose
  // cursor has just spilled onto the next row would otherwise look unwrapped.
  let chainTopRow = lastRow
  while (chainTopRow > 0 && buffer.getLine(chainTopRow - 1)?.isWrapped) {
    chainTopRow -= 1
  }
  const logicalLen = prompt.length + command.length
  const firstRow = logicalTopRow({
    lastRow,
    chainTopRow,
    logicalLen,
    cols,
    cursorX: buffer.cursorX,
  })
  const rowOffset = lastRow - firstRow
  // Only a single-row input line is recolored. Repainting a wrapped line means
  // moving the cursor up and clearing rows, which repeatedly corrupted the
  // screen (erased the previous output row, left residue after backspace, and
  // dropped the echoed tail) — the shell's line editor already redraws wrapped
  // lines correctly on its own, so we leave them exactly as echoed. The only
  // loss is the syntax coloring of a wrapped command.
  if (!canRecolorInPlace({ rowOffset, logicalLen, cols, cursorX: buffer.cursorX })) return

  const coloredCmd = colorizeCommand(command)
  // Selection can stick to buffer coordinates and repaint newly typed text with
  // the selection background — drop it before rewriting.
  term.clearSelection()

  // In-place recolor: move to just past the prompt, reset SGR so the prompt's
  // style doesn't leak, and rewrite the colored command. Clear the tail in case
  // the command just shrank (backspace).
  term.write(`\r\x1b[${prompt.length}C\x1b[0m` + coloredCmd)
  term.write(`\x1b[0m\x1b[K`)
}

// Return the current input line only when the cursor sits at its END (so a
// full-line recolor leaves the caret exactly where the user is typing). Returns
// null when: the caret is mid-command (e.g. after an arrow key), or the caret is
// in program output. A wrapped (multi-row) command whose caret is on its LAST
// physical row IS recognized, so the continuation rows get recolored too. An empty
// command (a bare prompt) is allowed — it is used to color just the prompt symbol.
export function getInputLineAtCursorEnd(
  term: Terminal,
): { prompt: string; command: string } | null {
  const rawLine = getCurrentCommandLine(term)
  if (!rawLine) return null
  const plain = stripAnsi(rawLine)
  const { prompt, command } = splitPromptCommand(plain)
  // No prompt marker — not a live shell command line.
  if (!prompt) return null
  const buffer = term.buffer.active
  // Full-screen programs (vi/nano/less/tmux/etc.) use the alternate buffer. Every
  // line there is program output, not a shell command line, so never recolor it.
  if (buffer.type === 'alternate') return null
  // A pager prompt (`---- More ----`) sits on an output line, not an input one.
  if (isPagerPrompt(plain)) return null
  const cols = term.cols
  const logicalLen = prompt.length + command.length
  const row = buffer.baseY + buffer.cursorY
  const nextRow = row + 1 <= buffer.baseY + term.rows - 1 ? buffer.getLine(row + 1) : null
  const nextWrapped = !!(nextRow && nextRow.isWrapped)
  // The caret is at the end of the command when it sits on the LAST physical row of
  // the (possibly wrapped) logical line, at the column where the command's tail ends.
  // For a wrapped line the tail column is logicalLen % cols; an exact multiple of cols
  // leaves the caret at column 0 of the following (non-wrapped) row.
  const tailCol = logicalLen % cols
  const atEndCol = buffer.cursorX === tailCol || (tailCol === 0 && buffer.cursorX === 0)
  if (!atEndCol) return null
  // If the next row is a wrapped continuation, the caret is mid-wrap, not at the end.
  if (nextWrapped) return null
  return { prompt, command }
}

// Capture commands submitted by the user. A single Enter commits the current
// terminal-buffer line (which holds tab-completed text); a multi-line paste
// commits each pasted line directly.
export function commitSubmittedCommands(term: Terminal, data: string, tabId: number) {
  if (/^[\r\n]+$/.test(data)) {
    const rawLine = getCurrentCommandLine(term)
    if (!rawLine) return
    const { prompt, command } = splitPromptCommand(rawLine)
    // No prompt marker — not a submitted command (e.g. pager output / help text).
    if (!prompt) return
    const cmd = command.trim()
    // Never record a pager prompt (`---- More ----`) as a submitted command —
    // paging through long device output would otherwise flood the command history.
    if (cmd.length > 0 && !isPagerPrompt(cmd)) {
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

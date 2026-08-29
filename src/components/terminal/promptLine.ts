import { Terminal } from '@xterm/xterm'
import { stripAnsi } from '../../lib/termHighlight'
import { colorizeCommand } from '../../lib/cmdEcho'
import { commitCommand } from '../../commands'

// Read the full logical line under the cursor, reassembling wrapped
// continuation lines so long tab-completed commands are not truncated.
export function getCurrentCommandLine(term: Terminal): string {
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
export function splitPromptCommand(line: string): { prompt: string; command: string } {
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
// Wrapped (multi-row) lines are skipped — repositioning would corrupt the
// continuation rows, and an uncolored long line is harmless.
export function highlightCurrentCommandLine(term: Terminal) {
  const rawLine = getCurrentCommandLine(term)
  if (!rawLine) return
  const plain = stripAnsi(rawLine)
  const { prompt, command } = splitPromptCommand(plain)
  if (!command && !prompt) return
  // Never recolor full-screen TUI screens (vi/nano/less/tmux/etc.). Those use the
  // alternate buffer and manage their own styling; rewriting a line here strips
  // their colors and corrupts indentation.
  if (term.buffer.active.type === 'alternate') return
  const buffer = term.buffer.active
  let y = buffer.baseY + buffer.cursorY
  let wrapped = false
  while (y > 0) {
    const prev = buffer.getLine(y - 1)
    if (prev && prev.isWrapped) {
      wrapped = true
      y -= 1
    } else break
  }
  if (wrapped) return
  const coloredCmd = colorizeCommand(command)
  // Rewrite ONLY the command portion, leaving the prompt exactly as the shell
  // drew it (including any user-colored PS1). xterm's line buffer does not expose
  // the prompt's original ANSI codes (translateToString yields plain text), so
  // redrawing the whole line would strip a custom-colored PS1's leading color.
  // Instead we move the cursor to the end of the prompt and clear just from there
  // to the line end, so the prompt keeps its appearance no matter how it's styled.
  term.write(`\r\x1b[${prompt.length}C\x1b[K` + coloredCmd)
}

// Return the current input line only when the cursor sits at its END (so a
// full-line recolor leaves the caret exactly where the user is typing). Returns
// null when: the line is wrapped across rows, the caret is mid-command (e.g.
// after an arrow key), or the caret is in program output. An empty command
// (a bare prompt) is allowed — it is used to color just the prompt symbol.
export function getInputLineAtCursorEnd(term: Terminal): { prompt: string; command: string } | null {
  const rawLine = getCurrentCommandLine(term)
  if (!rawLine) return null
  const plain = stripAnsi(rawLine)
  const { prompt, command } = splitPromptCommand(plain)
  const buffer = term.buffer.active
  // Full-screen programs (vi/nano/less/tmux/etc.) use the alternate buffer. Every
  // line there is program output, not a shell command line, so never recolor it.
  if (buffer.type === 'alternate') return null
  // Reject wrapped (multi-row) commands: repositioning would corrupt rows.
  let y = buffer.baseY + buffer.cursorY
  while (y > 0) {
    const prev = buffer.getLine(y - 1)
    if (prev && prev.isWrapped) return null
    else break
  }
  // Cursor must be on the last row at column = promptLen + commandLen.
  if (buffer.cursorX !== prompt.length + command.length) return null
  return { prompt, command }
}

// Capture commands submitted by the user. A single Enter commits the current
// terminal-buffer line (which holds tab-completed text); a multi-line paste
// commits each pasted line directly.
export function commitSubmittedCommands(term: Terminal, data: string, tabId: number) {
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

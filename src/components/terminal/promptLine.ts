import { Terminal } from '@xterm/xterm'
import type { IBufferLine } from '@xterm/xterm'
import { stripAnsi } from '../../lib/termHighlight'
import { colorizeCommand } from '../../lib/cmdEcho'
import { commitCommand } from '../../commands'
import {
  canRecolorInPlace,
  columnsOfText,
  isWrappedContinuation,
  logicalTopRow,
} from './wrapDetect'

/**
 * Characters between two COLUMNS of a buffer row.
 *
 * `translateToString()` + `slice()` is indexed by characters, while a caret
 * position is a column: on a row holding a Chinese prompt the two differ by one
 * index per wide character, so slicing by the column reads the wrong text. A wide
 * character contributes its text once, at its leading cell (its trailing cell is
 * an empty width-0 cell), which is exactly what "the text up to column N" means.
 */
function rowCells(line: IBufferLine, from: number, to: number): string {
  let out = ''
  for (let x = Math.max(0, from); x < to; x++) out += line.getCell(x)?.getChars() ?? ''
  return out
}

// What marks a screen as application-owned (an inline TUI that opens neither the
// alternate buffer nor mouse tracking, so `isApplicationScreen` cannot see it):
// its output moves the cursor, where a shell's linear output only ever advances it
// with printable text + CR/LF. Match a complete CSI whose final byte is a cursor
// move (`A`B`C`D`E`F`G`H`, `f`, `d`); params are digits/`;`, so SGR (`…m`), erase
// (`…K`/`…J`), mode sets (`ESC[?1000h`) and save/restore (`s`/`u`) never match.
// Ink TUIs repaint by moving up (`ESC[<n>A`) and rewriting, not only by absolute
// `H`, so the relative moves are essential — matching just `H`/`f` let Qoder CLI's
// command list slip through (BUGS.md B46 ④).
export const CURSOR_REPOSITION = /\x1b\[[0-9;]*[ABCDEFGHdf]/
// The subset that changes the ROW: up/down, next/prev line, set-row. A LOCAL
// shell's ConPTY re-serializes the console *screen*, so it repaints the input line
// with absolute moves — once per keystroke (`ESC[1;20Hnetstat -ano ESC[1;32H`) and
// a lone `ESC[8;20H` after every prompt. Those are not frames, so for local shells
// only a row change counts: comparing a move's target against `cursorY` cannot
// work, because writes parse asynchronously and every chunk of one poll batch
// reads the same pre-batch row.
export const VERTICAL_MOVE = /\x1b\[[0-9;]*[ABEFd]/

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
      // Columns: a full CJK row holds `cols` cells but fewer characters, and the
      // fallback is "is the row above as wide as the terminal?".
      prevVisibleLength: columnsOfText(
        stripAnsi(prevText),
        (col) => prev.getCell(col)?.getWidth() ?? 1,
      ),
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
//
// An answer-choice group is NOT a prompt: `[y/n] ` / `(yes/no) ` sit at the end of
// a program's own question, and reading them as the prompt turned the typed answer
// into a submitted command (`[y/n] y` → command `y`).
const OPTION_LIST_HEAD = /^[([{]\s*(?:y|yes|n|no)(?:\s*[/|]\s*(?:y|yes|n|no))+\s*[)\]}]$/i

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
    if (OPTION_LIST_HEAD.test(head)) continue
    return { pos, len: 2 }
  }
  return null
}

// Glyphs a RENDERED prompt draws on the same row as the command: Nerd Font /
// Powerline private-use icons (powerlevel10k segments and separators), box
// drawing (p10k's multi-line connectors) and the decorative arrows/checks the
// themes use. ASCII and CJK are deliberately absent — those start real command
// text, not an ornament.
const PROMPT_ORNAMENT =
  /[\ue000-\uf8ff\u2500-\u259f\u276f\u276e\u279c\u2794\u21a9\u2713\u2714\u2717\u2718\u25b6\u25c0]/
const PROMPT_ORNAMENT_RUN = new RegExp(`^\\s*(?:${PROMPT_ORNAMENT.source}\\s*){1,3}`, 'u')

/**
 * Is the text right of the caret a RIGHT prompt rather than typed input?
 *
 * Normally anything non-blank there means the caret is mid-line, and a suggestion
 * hanging off it would paint over what the user typed. A RENDERED prompt breaks
 * that assumption: powerlevel10k paints its status/clock segments as a right
 * prompt on the SAME row, at a fixed column right of the input (the live `❯`
 * prompt char only appears after Enter). Such a tail opens — after the blanks
 * that separate it from the input — with an ornament glyph (a powerline
 * separator, an icon), while text typed after the caret starts with the
 * character just typed. A plain-text right prompt (`[12:00]`) is not recognised
 * and keeps answering "mid-line", exactly as before.
 */
function isRightPromptTail(right: string): boolean {
  const head = right.replace(/^\s+/, '')
  return head.length > 0 && PROMPT_ORNAMENT.test(head[0])
}

/**
 * The invariant opening of a rendered prompt: the ornament glyphs (and blanks) it
 * starts with. A powerlevel10k prompt can never be matched whole — its clock
 * changes on every draw — but the icons it opens with are the same each time,
 * which is what lets an `ls` capture notice the next prompt. Answers `''` for a
 * plain prompt, where there is nothing to anchor on.
 */
export function renderedPromptHead(prompt: string): string {
  return PROMPT_ORNAMENT_RUN.exec(prompt)?.[0] ?? ''
}

/**
 * Split an input row whose prompt is *rendered* rather than marked.
 *
 * powerlevel10k (and spaceship/oh-my-posh in the same style) paints its segments
 * — OS icon, directory, git status, time — on the SAME buffer row as the typed
 * command, and prints the `❯` prompt char only in the transient prompt that
 * replaces the line after Enter. The live row therefore carries no `$ `/`❯ `
 * marker at all, so `splitPromptCommand` finds nothing and every feature keyed on
 * it (live recolor, `ls` capture, history, `cd` tracking) silently does nothing.
 *
 * The command starts right after the LAST ornament glyph of the line and the
 * blanks following it; everything before that is the prompt. `text` must be the
 * row cut at the caret, because the right prompt (the clock in the screenshot's
 * bottom row) sits past it and would otherwise be read as command text.
 *
 * Answers `null` for a row without a single ornament: a plain row cannot be
 * identified as a prompt, and guessing there is what B46 was about.
 */
export function splitRenderedPrompt(text: string): { prompt: string; command: string } | null {
  let last = -1
  for (let i = 0; i < text.length; i++) {
    if (PROMPT_ORNAMENT.test(text[i])) last = i
  }
  if (last < 0) return null
  let end = last + 1
  while (end < text.length && (text[end] === ' ' || text[end] === '\t')) end++
  // An ornament at the end of the row (nothing typed yet) is still a prompt: the
  // command comes back empty, which is how a bare prompt gets its symbol coloured.
  return { prompt: text.slice(0, end), command: text.slice(end).trimEnd() }
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
  // Pass 4 — a prompt ornament no fixed marker list can cover: oh-my-zsh's
  // robbyrussell `➜`, the Nerd Font chevron (U+F054 …) themes substitute for
  // `❯`, spaceship's failure `❮`. The ornament has to be the line's whole head,
  // followed by whitespace. ASCII and CJK are excluded because they start real
  // commands, not ornaments.
  //
  // A command starting with a path is deliberately NOT split: `➜  /opt ls` is
  // robbyrussell's cwd followed by a command, and treating `/opt` as command
  // text would recolor (and record as a command) the prompt's own path. The
  // trade-off is that an actual path command typed after a glyph-only prompt
  // stays unparsed — the previous behaviour for every one of these prompts.
  const glyph = /^([^\s\x00-\x7f\p{Script=Han}]{1,4}\s+)(?![~/.])(\S.*)$/u.exec(noAnsi) ?? null
  if (glyph) {
    return { prompt: glyph[1], command: glyph[2].trimEnd() }
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

/**
 * True when the line ENDS with a program's own question rather than a shell
 * prompt — and with the answer already typed after it (`[y/n] y`, `(yes/no)? n`),
 * because the echo of the answer lands on the same row as the question. This is
 * what the submit path reads back, so without it an answer is recorded as a
 * command.
 *
 * Narrower than `looksLikeInteractivePrompt` on purpose: a trailing `?` alone is
 * not enough to call something a question, since `ls file?` is a real command.
 */
export function isInteractiveQuestion(line: string): boolean {
  const plain = line.trim()
  if (!plain) return false
  if (/are you sure you want to continue connecting/i.test(plain)) return true
  if (/[([{]\s*(?:y|yes|n|no)(?:\s*[/|]\s*(?:y|yes|n|no))+\s*[)\]}]\s*[?:]?\s*\S*$/i.test(plain))
    return true
  // A password answer must never reach the history. `--password=x` is not matched:
  // the rule needs a colon after the word, which only the prompt itself carries.
  return /\b(?:password|passphrase|passcode|pin)\b[^:]*:\s*\S*$/i.test(plain)
}

/**
 * Heuristic that suspends live input-line coloring while a program is asking
 * something (login/password prompts, yes/no questions, ssh's host-key
 * confirmation): recoloring such a line corrupts the character the user just
 * echoed. Moved here from `Terminal.tsx` so the command-history writers can veto
 * the same lines instead of only suspending coloring.
 */
export function looksLikeInteractivePrompt(line: string): boolean {
  const plain = line.trimEnd()
  if (!plain) return false
  if (isInteractiveQuestion(plain)) return true
  // Shapes that only matter for coloring: any `(yes/no/…)` choice group, any
  // password-ish prefix, and any line that simply ends in `?`.
  if (/\(yes\/no(?:\/[^)]+)?\)\s*\?*\s*$/i.test(plain)) return true
  if (/\b(password|passphrase|passcode|pin)\b.*:\s*$/i.test(plain)) return true
  return /\?\s*$/.test(plain)
}

/**
 * True when the screen is owned by an interactive application (a TUI) rather than
 * a shell reading a command line. Every shell-oriented screen heuristic must bail
 * out here: the caret sits on the app's own input line, and rewriting that line —
 * or worse, starting an output capture on it — corrupts the app's frame
 * (residual/stale rows, misaligned box borders; BUGS.md B46).
 *
 * Only signals a SHELL never produces are used:
 *   1. the alternate buffer (vi / nano / less / tmux, and any TUI that switches);
 *   2. mouse tracking enabled — no shell turns this on, while agent TUIs
 *      (CodeBuddy CLI, Claude Code, …) do, so it also catches the ones that render
 *      *inline* without an alternate buffer.
 *
 * Deliberately NOT used: "the caret is not on the bottom-most content row". A
 * Windows local shell (ConPTY) repaints its prompt with `ESC [ H` + `ESC [ 2 K`
 * on nearly every keystroke, which leaves the caret at the TOP with the whole
 * screen of content below it — indistinguishable from a TUI by that test, and it
 * made real shells stop recording their commands (see `terminal-tail-room.spec`).
 */
export function isApplicationScreen(term: Terminal): boolean {
  if (term.buffer.active.type === 'alternate') return true
  return term.modes.mouseTrackingMode !== 'none'
}

// Remove ANSI escape sequences and strip a leading shell prompt so only the
// command itself remains.
export function stripPrompt(line: string): string {
  return splitPromptCommand(line).command
}

/**
 * The caret's row cut at the caret, split as a RENDERED prompt (see
 * `splitRenderedPrompt`). Answers `null` when the row is plain or is a wrapped
 * continuation — cutting a wrapped line at the caret would hand back its last
 * visual row instead of the command.
 */
function renderedInputRow(
  term: Terminal,
): { text: string; parsed: { prompt: string; command: string } } | null {
  const buffer = term.buffer.active
  const line = buffer.getLine(buffer.baseY + buffer.cursorY)
  if (!line || line.isWrapped) return null
  const text = stripAnsi(rowCells(line, 0, buffer.cursorX))
  const parsed = splitRenderedPrompt(text)
  return parsed ? { text, parsed } : null
}

/**
 * The submitted input line, parsed. A rendered prompt (powerlevel10k) draws its
 * right prompt past the caret, so a whole-row read ends in the clock/branch
 * segment and `splitPromptCommand` sees trailing text it cannot classify — the
 * command then never matches `ls`/`cd` and history records garbage. Read the row
 * cut at the caret in that case.
 */
export function readSubmittedLine(
  term: Terminal,
): { prompt: string; command: string; rendered: boolean } | null {
  const rawLine = getCurrentCommandLine(term)
  if (!rawLine) return null
  const split = splitPromptCommand(stripAnsi(rawLine))
  if (split.prompt) return { ...split, rendered: false }
  const rendered = renderedInputRow(term)
  return rendered ? { ...rendered.parsed, rendered: true } : null
}

/**
 * Repaint the row ABOVE the caret after the shell has redrawn a submitted line.
 *
 * powerlevel10k replaces the submitted line with its *transient* prompt — `❯ cmd`
 * with no SGR at all — as the first thing it writes after Enter, so the colours
 * painted before sending the command are gone the moment the user hits Enter.
 * Once the shell has moved off that row (caret exactly one below) and left it
 * blank past the command, rewrite it from the saved cursor position so the live
 * caret is untouched.
 *
 * Answers `false` when there is nothing safe to repaint yet: the row still carries
 * a live prompt (its RIGHT prompt would be erased), or the shell has scrolled on.
 */
export function repaintSubmittedRow(term: Terminal, submitRow: number, command: string): boolean {
  const buffer = term.buffer.active
  const cols = term.cols
  const delta = buffer.baseY + buffer.cursorY - submitRow
  // The shell leaves the line for the input row below, which on a rendered prompt
  // is a couple of rows down (its status line sits in between).
  if (delta < 1 || delta > 5) return false
  const line = buffer.getLine(submitRow)
  if (!line) return false
  const text = stripAnsi(rowCells(line, 0, cols))
  // Only the line we submitted: the shell may have scrolled it away or rewritten
  // the row with output by now.
  if (!text.trimEnd().endsWith(command)) return false
  const { prompt } = splitPromptCommand(text.trimEnd())
  if (!prompt) return false
  const widthAt = (col: number) => line.getCell(col)?.getWidth() ?? 1
  const promptWidth = columnsOfText(prompt, widthAt)
  const typed = text.slice(prompt.length)
  if (!typed.trim()) return false
  // Only a row the shell has finished with: a live prompt keeps its RIGHT prompt
  // to the right of the command, and clearing there would delete it.
  if (
    rowCells(line, promptWidth + columnsOfText(typed, widthAt, promptWidth), cols).trim() !== ''
  ) {
    return false
  }
  term.write(
    `\x1b7\x1b[${delta}A\r\x1b[${promptWidth}C\x1b[0m` +
      colorizeCommand(typed) +
      `\x1b[0m\x1b[K\x1b8`,
  )
  return true
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
  let plain = stripAnsi(rawLine)
  let { prompt, command } = splitPromptCommand(plain)
  if (!prompt) {
    // A RENDERED prompt (powerlevel10k) has no marker to split on: its segments
    // share the row with the typed command and its right prompt sits past the
    // caret. Read the row cut at the caret and split on the last ornament.
    const rendered = renderedInputRow(term)
    if (!rendered) {
      // No prompt marker was found — this is program output, not a shell command
      // line. Recoloring it would strip indentation and color unrelated text (e.g.
      // network device help listings like "  install     Perform ...").
      return
    }
    plain = rendered.text
    prompt = rendered.parsed.prompt
    command = rendered.parsed.command
  }
  if (!command && !prompt) return
  // Never recolor a screen an interactive application owns (vi/nano/less/tmux, and
  // inline TUIs such as CodeBuddy CLI). Those manage their own styling; rewriting a
  // line here strips their colours and corrupts their frame — see isApplicationScreen.
  if (isApplicationScreen(term)) return
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
  // Everything after the prompt INCLUDING any trailing space. `splitPromptCommand`
  // trims those off, and rewriting the shorter text before clearing to end of line
  // deleted the space the user had just typed between two words (`echo hi` came
  // back as `echohi`).
  const typed = plain.slice(prompt.length)
  // All offsets below are CELLS, not characters. A prompt holding wide characters
  // (`[root@host 桌面]#`) is shorter than it is wide, so the character count moved
  // the rewrite that many cells too few — it landed on the prompt's own `#` and
  // erased it. Widths are read from the buffer row, i.e. from xterm's own table.
  // That row only holds the text while the line fits on one; a wrapped line is
  // rejected below anyway and the `?? 1` fallback then degrades to characters.
  const rowLine = chainTopRow === lastRow ? buffer.getLine(lastRow) : undefined
  const widthAt = (col: number) => rowLine?.getCell(col)?.getWidth() ?? 1
  const promptWidth = columnsOfText(prompt, widthAt)
  const typedWidth = columnsOfText(typed, widthAt, promptWidth)
  const logicalLen = promptWidth + typedWidth
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

  const coloredCmd = colorizeCommand(typed)
  // Selection can stick to buffer coordinates and repaint newly typed text with
  // the selection background — drop it before rewriting.
  term.clearSelection()

  // Where the user's caret was, and where this rewrite is going to leave it: the
  // rewrite types the whole command, so it ends up after the last character.
  const caretCol = buffer.cursorX
  const endCol = promptWidth + typedWidth

  // In-place recolor: move to just past the prompt, reset SGR so the prompt's
  // style doesn't leak, and rewrite the colored command. Clear the tail in case
  // the command just shrank (backspace). The move is in CELLS: see promptWidth.
  term.write(`\r\x1b[${promptWidth}C\x1b[0m` + coloredCmd)
  // Clear the tail only when nothing sits right of the caret. A rendered prompt
  // (powerlevel10k) keeps its RIGHT prompt there — the clock and branch segments —
  // and clearing to end of line would wipe them until the next prompt redraw.
  const tail = rowLine ? rowCells(rowLine, buffer.cursorX, cols) : ''
  if (!tail.trim()) term.write(`\x1b[0m\x1b[K`)
  // Put the caret back, or editing in the middle of a line would jump it to the
  // end on every echo — the recolor must be invisible, including to the caret.
  // `endCol < cols` because at exactly the last column the write wraps onto the
  // next row, where a back-move would land in the wrong place; the shell's own
  // next redraw fixes the caret there.
  if (caretCol < endCol && endCol < cols) term.write(`\x1b[${endCol - caretCol}D`)
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
  const buffer = term.buffer.active
  // An interactive application owns the screen: the line under the caret is its
  // own input, not a shell command line, so never treat it as one.
  if (isApplicationScreen(term)) return null
  // A pager prompt (`---- More ----`) sits on an output line, not an input one.
  if (isPagerPrompt(plain)) return null
  const row = buffer.baseY + buffer.cursorY
  const nextRow = row + 1 <= buffer.baseY + term.rows - 1 ? buffer.getLine(row + 1) : null
  const nextWrapped = !!(nextRow && nextRow.isWrapped)
  // The caret is at the end when nothing but blanks sits to its right on the row
  // — asked of the cells, not of a character count. `prompt.length + command.length`
  // counts characters while the caret column counts cells, so a prompt with wide
  // characters made a finished line look mid-command (no recolor, and the command
  // was not recorded either). A rendered prompt's RIGHT prompt also lives right of
  // the caret; that is not typed text (see `isRightPromptTail`).
  const line = buffer.getLine(row)
  if (!line) return null
  const right = rowCells(line, buffer.cursorX, term.cols)
  if (right.trim() !== '' && !isRightPromptTail(right)) return null
  // If the next row is a wrapped continuation, the caret is mid-wrap, not at the end.
  if (nextWrapped) return null
  const { prompt, command } = splitPromptCommand(plain)
  if (prompt) return { prompt, command }
  // No marker: a RENDERED prompt (powerlevel10k) draws its segments on this same
  // row, so read the row cut at the caret and split on the last ornament — the
  // whole-row read would carry the right prompt's clock/branch past the command.
  if (line.isWrapped) return null
  return splitRenderedPrompt(rowCells(line, 0, buffer.cursorX))
}

// The command text the user has typed on the current input line but not yet
// submitted — `null` when the caret is not on a live shell command line (program
// output, a pager prompt, or a full-screen TUI). Unlike `getInputLineAtCursorEnd`
// the caret may sit anywhere within the line, not only at its end.
export function getPendingInputText(term: Terminal): string | null {
  const rawLine = getCurrentCommandLine(term)
  if (!rawLine) return null
  const plain = stripAnsi(rawLine)
  // An interactive application manages its own screen (inline TUIs included).
  if (isApplicationScreen(term)) return null
  // A pager prompt (`---- More ----`) is device output, not a typed command.
  if (isPagerPrompt(plain)) return null
  const { prompt, command } = splitPromptCommand(plain)
  // No marker: a RENDERED prompt (powerlevel10k) still has a command on the row —
  // its segments share the line and its right prompt sits past the caret.
  if (!prompt) return renderedInputRow(term)?.parsed.command ?? null
  return command
}

/**
 * What the user has typed, taken as far as the caret itself — for anything that
 * hangs a suggestion off the caret (the ghost command completion).
 *
 * `getInputLineAtCursorEnd` cannot serve that job: it compares the caret column
 * against a line read back through `translateToString(true)`, which right-trims,
 * so a trailing space (`git `, `cd `) makes the caret look mid-line and the answer
 * is `null`. A trailing space is exactly where a completion has the most to say,
 * so this reads the caret column directly and only asks the complementary
 * question — is there any non-blank content to the RIGHT of the caret, which would
 * be what the tail tries to paint over. A rendered prompt's right prompt
 * (powerlevel10k's status/clock segments) is not typed text and is allowed
 * through (see `isRightPromptTail`).
 *
 * `null` for the same reasons the other reader is: program output, a pager prompt,
 * an application-owned screen, or no prompt marker on the row. A command wrapped
 * over several rows also answers `null` (its continuation rows carry no prompt), so
 * the completion is single-row only — like the live-line recolor.
 */
export function getInputTextBeforeCaret(term: Terminal): string | null {
  const buffer = term.buffer.active
  const line = buffer.getLine(buffer.baseY + buffer.cursorY)
  if (!line) return null
  if (isApplicationScreen(term)) return null
  const row = line.translateToString(false)
  if (isPagerPrompt(row)) return null
  // Both halves are read cell by cell: the caret position is a COLUMN while the
  // row's characters are one-per-cell only until a wide character appears, so
  // slicing the string by the column drifts past the caret on a CJK prompt.
  // Nothing but blanks (or a rendered right prompt) may sit to the right of the
  // caret, or the caret is mid-word and a tail there would be a lie.
  const right = rowCells(line, buffer.cursorX, term.cols)
  if (right.trim() !== '' && !isRightPromptTail(right)) return null
  const toCaret = rowCells(line, 0, buffer.cursorX)
  const { prompt } = splitPromptCommand(toCaret)
  // A caret sitting right after a RENDERED prompt (powerlevel10k segments) has no
  // marker to split on; fall back to the ornament boundary so the completion still
  // hangs off the caret.
  const split = prompt ? null : splitRenderedPrompt(toCaret)
  if (!prompt && !split) return null
  // Cut at the prompt's own length instead of taking `splitPromptCommand`'s second
  // half: that one `trimEnd()`s, so a line ending in a space would read back
  // shorter than it is — and the caller's not-yet-echoed-lag bookkeeping clears
  // itself only when the line it read really ends with what it sent, which a
  // trimmed line never does.
  return toCaret.slice(prompt ? prompt.length : split!.prompt.length)
}

// Capture commands submitted by the user. A single Enter commits the current
// terminal-buffer line (which holds tab-completed text); a multi-line paste
// commits each pasted line directly.
export function commitSubmittedCommands(term: Terminal, data: string, tabId: number) {
  const commit = (cmd: string) =>
    commitCommand(tabId, cmd).catch((e) => console.error('commit_command error:', e))
  if (/^[\r\n]+$/.test(data)) {
    const parsed = readSubmittedLine(term)
    if (!parsed) return
    const { prompt, command } = parsed
    // No prompt marker — not a submitted command (e.g. pager output / help text).
    if (!prompt) return
    const cmd = command.trim()
    // Nor is a program's own question with its answer on the same row, whichever
    // half of the line the question marker landed on.
    if (cmd.length > 0 && !isPagerPrompt(cmd) && !isInteractiveQuestion(prompt + cmd)) {
      commit(cmd)
    }
    return
  }
  for (const raw of data.split(/[\r\n]+/)) {
    const cmd = raw.replace(/[\x00-\x1f]/g, '').trim()
    if (cmd.length > 0) commit(cmd)
  }
}

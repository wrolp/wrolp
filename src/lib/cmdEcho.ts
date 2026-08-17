// Typed-command highlighting (terminal-highlight-plan F1).
//
// When the user submits a command, the remote shell has already echoed the
// typed line onto the screen (uncolored). We recolor that current input line
// in place — preserving any user-colored PS1 — by tokenizing the command and
// wrapping each token in SGR color codes, then rewriting just that line.
//
// The colors intentionally mirror termHighlight.ts / tableOutput.ts so the
// whole terminal uses a consistent palette.

export type CmdTokenType =
  | 'prog' // program name (first word)
  | 'opt' // -x / --xxx option
  | 'arg' // plain argument
  | 'str' // quoted string ('...' "..." `...`)
  | 'path' // path-like token
  | 'redir' // > >> < | && || ; &
  | 'env' // KEY=value assignment
  | 'num' // bare number
  | 'comment' // # ... to end of line
  | 'space'

export interface CmdToken {
  text: string
  type: CmdTokenType
}

const RESET = '\x1b[0m'

// Must stay in sync with the output highlighters' palette.
const COLORS: Record<CmdTokenType, string> = {
  prog: '\x1b[1;35m', // bold magenta
  opt: '\x1b[32m', // green
  arg: '\x1b[38;5;111m', // soft blue (plain arguments are highlighted too)
  str: '\x1b[33m', // yellow
  path: '\x1b[36m', // cyan
  redir: '\x1b[31m', // red
  env: '\x1b[34m', // blue
  num: '\x1b[38;5;208m', // orange
  comment: '\x1b[90m', // gray
  space: RESET,
}

// Operators / redirections treated as a single token.
const OPERATORS = new Set(['>', '>>', '<', '|', '&&', '||', ';', '&'])

// Operators that introduce a NEW command word (so the token after them should
// be colored as a program, e.g. `cd opt | grep a` → `grep` is magenta).
const CMD_SEPARATORS = new Set(['|', '&&', '||', ';'])

// Split a command line into typed tokens (display-only; approximate is fine).
export function tokenizeCommand(cmd: string): CmdToken[] {
  const tokens: CmdToken[] = []
  const n = cmd.length
  let i = 0
  let firstWord = true
  while (i < n) {
    const ch = cmd[i]
    if (ch === ' ' || ch === '\t') {
      let j = i
      while (j < n && (cmd[j] === ' ' || cmd[j] === '\t')) j++
      tokens.push({ text: cmd.slice(i, j), type: 'space' })
      i = j
      continue
    }
    // Quoted string: consume until the matching quote (or end of input).
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1
      while (j < n && cmd[j] !== ch) j++
      if (j < n) j++ // include the closing quote
      tokens.push({ text: cmd.slice(i, j), type: 'str' })
      i = j
      continue
    }
    // Read a word up to whitespace (operators stay attached, e.g. `a&&b`).
    let j = i
    while (j < n && cmd[j] !== ' ' && cmd[j] !== '\t') j++
    const word = cmd.slice(i, j)
    let type: CmdTokenType
    if (firstWord) {
      type = 'prog'
      firstWord = false
    } else if (word[0] === '#') {
      // A leading `#` starts a comment: color the rest of the line.
      tokens.push({ text: cmd.slice(i), type: 'comment' })
      break
    } else if (OPERATORS.has(word)) {
      type = 'redir'
    } else if (word.startsWith('-')) {
      type = 'opt'
    } else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      type = 'env'
    } else if (
      word.includes('/') ||
      word.startsWith('~') ||
      word.startsWith('./') ||
      word.startsWith('../')
    ) {
      type = 'path'
    } else if (/^\d+$/.test(word)) {
      type = 'num'
    } else {
      type = 'arg'
    }
    tokens.push({ text: word, type })
    // After a command-separating operator (`|`, `&&`, `||`, `;`) the next word is
    // a new program, so re-arm firstWord detection. File redirections (`>`, `<`)
    // are followed by filenames, not commands, so they don't reset it.
    if (type === 'redir' && CMD_SEPARATORS.has(word)) firstWord = true
    i = j
  }
  return tokens
}

// Colorize a command line for display. Spaces are written bare (no SGR) so
// cursor/column positions are unchanged from the original text.
export function colorizeCommand(cmd: string): string {
  const tokens = tokenizeCommand(cmd)
  let out = ''
  for (const t of tokens) {
    if (t.type === 'space') {
      out += t.text
      continue
    }
    out += COLORS[t.type] + t.text + RESET
  }
  return out
}

// Colorize only the trailing prompt symbol of a *plain* (uncolored) prompt:
// `#` (root) red, any other symbol (`$`/`%`/`>`/`❯`) green. The rest of the
// prompt is left as-is so a user's custom (already-colored) PS1 is untouched.
export function colorizePromptSymbol(prompt: string): string {
  const m = prompt.match(/([$#%>❯])\s*$/)
  if (!m || m.index === undefined) return prompt
  const idx = m.index
  const sym = prompt.slice(idx)
  const color = sym.startsWith('#') ? '\x1b[31m' : '\x1b[32m'
  return prompt.slice(0, idx) + color + sym + RESET
}

// Find the byte offset in `raw` (which may contain ANSI escapes) that
// corresponds to `index` visible characters. Used to split a raw buffer line
// (with a colored PS1) exactly at the prompt/command boundary.
export function splitRawLineAtVisibleIndex(
  raw: string,
  index: number,
): { before: string; after: string } {
  let visible = 0
  let i = 0
  const n = raw.length
  while (i < n && visible < index) {
    if (raw[i] === '\x1b' && i + 1 < n) {
      if (raw[i + 1] === '[') {
        // CSI \x1b[...letter
        let j = i + 2
        while (j < n && !/[A-Za-z]/.test(raw[j])) j++
        i = j + 1
        continue
      }
      if (raw[i + 1] === ']') {
        // OSC \x1b]...\x07 or \x1b]...\x1b\\
        let j = i + 2
        while (j < n && raw[j] !== '\x07' && raw[j] !== '\x1b') j++
        if (raw[j] === '\x1b' && j + 1 < n && raw[j + 1] === '\\') {
          i = j + 2
        } else {
          i = j + 1
        }
        continue
      }
      // ESC-pair we don't understand: skip two bytes so we don't spin.
      i += 2
      continue
    }
    visible++
    i++
  }
  return { before: raw.slice(0, i), after: raw.slice(i) }
}

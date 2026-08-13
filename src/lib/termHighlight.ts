/**
 * Terminal output syntax highlighting for `cat` / `head` / `tail` file views.
 *
 * A plain `cat foo.py` prints uncolored text (no `bat`/`pygmentize` on the
 * remote host). This module reuses Monaco's Monarch tokenizer (already bundled
 * for the file editor — no new dependency) and maps its token types to 24-bit
 * ANSI SGR color codes, so highlighted text can be written straight into
 * xterm.js via `term.write(...)`.
 */
import * as monaco from 'monaco-editor'
import { detectLanguage } from '../editor/languages'

const RESET = '\x1b[0m'

// ---- ANSI stripping ----

const CSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g

/**
 * Prepare a raw PTY chunk for tokenizing: remove CSI/OSC escape sequences and
 * normalize line endings (the tty's ONLCR translation makes every newline a
 * `\r\n`, which would otherwise misalign Monaco's line splitting). The capture
 * buffer holds LF-only text; the writer re-adds `\r\n` on output.
 */
export function stripAnsi(text: string): string {
  let out = text
  if (out.includes('\x1b')) out = out.replace(OSC_RE, '').replace(CSI_RE, '')
  if (out.includes('\r')) out = out.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  return out
}

// ---- command recognition ----

const PRINT_PROGRAMS = new Set(['cat', 'head', 'tail'])

export interface PrintCommandMatch {
  path: string
  /** Monaco language id, or 'plaintext' when the extension is unknown. */
  lang: string
}

/** Split a command line into shell-like tokens (handles quotes + backslash). */
function tokenizeShell(cmd: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: string | null = null
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '\\' && i + 1 < cmd.length) {
      cur += cmd[i + 1]
      i++
      continue
    }
    if (ch === ' ' || ch === '\t') {
      if (cur) {
        out.push(cur)
        cur = ''
      }
      continue
    }
    cur += ch
  }
  if (cur) out.push(cur)
  return out
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i >= 0 ? p.slice(i + 1) : p
}

/**
 * Recognize `cat` / `head` / `tail` with a single plain-file argument and map
 * the path to a Monaco language id via the shared extension table.
 *
 * Returns null for anything ambiguous: streaming (`tail -f`), multiple files,
 * pipes/redirects, globs, or empty/flag-only invocations. Interactive pagers
 * (`less`/`vi`/`more`) are excluded by not being in `PRINT_PROGRAMS`.
 */
export function parsePrintCommand(rawCmd: string): PrintCommandMatch | null {
  const tokens = tokenizeShell(rawCmd.trim())
  if (tokens.length < 2) return null
  const prog = basename(tokens[0])
  if (!PRINT_PROGRAMS.has(prog)) return null

  // `head`/`tail` take a value after `-n`/`-c` (and `--lines`/`--bytes`);
  // `cat`'s `-n` is a boolean. Treat those value-taking flags specially so
  // `head -n 20 file.py` isn't mistaken for two files.
  const takesValue = prog === 'head' || prog === 'tail'

  const files: string[] = []
  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i]
    if (
      tok === '|' ||
      tok === '>' ||
      tok === '>>' ||
      tok === '<' ||
      tok === ';' ||
      tok === '&&' ||
      tok === '||'
    ) {
      return null
    }
    if (tok === '-f' || tok === '--follow' || tok === '-F') return null // streaming — never highlight
    if (takesValue && (tok === '-n' || tok === '-c' || tok === '--lines' || tok === '--bytes')) {
      i++ // skip the flag's value
      continue
    }
    if (tok.startsWith('--lines=') || tok.startsWith('--bytes=')) continue
    if (tok.startsWith('-')) continue // other boolean flags (incl. `-20` style)
    files.push(tok)
  }
  if (files.length !== 1) return null
  const path = files[0]
  if (/[*?[\]{}]/.test(path)) return null // glob — not a plain file view
  return { path, lang: detectLanguage(path) }
}

// ---- token → color mapping (VS Code Dark+ palette, matches the terminal theme) ----

/** Map a Monarch token type to a 24-bit foreground color, or null for default. */
function tokenColor(type: string): string | null {
  if (!type) return null
  const t = type.toLowerCase()
  if (t.startsWith('keyword')) return '#569cd6'
  if (t.startsWith('string')) return '#ce9178'
  if (t.startsWith('comment')) return '#6a9955'
  if (t.startsWith('number')) return '#b5cea8'
  if (t.startsWith('type')) return '#4ec9b0'
  if (t.startsWith('function') || t.startsWith('method')) return '#dcdcaa'
  if (t.startsWith('tag')) return '#569cd6'
  if (t.startsWith('attribute.name')) return '#9cdcfe'
  if (t.startsWith('attribute.value')) return '#ce9178'
  if (t === 'key' || t.startsWith('key.')) return '#9cdcfe'
  if (t.startsWith('variable')) return '#9cdcfe'
  if (t.startsWith('regexp')) return '#d16969'
  if (t.startsWith('constant')) return '#4fc1ff'
  if (t.startsWith('metatag') || t.startsWith('meta.tag')) return '#569cd6'
  if (t.startsWith('annotation')) return '#c586c0'
  return null
}

function toAnsiFg(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `\x1b[38;2;${r};${g};${b}m`
}

interface RawToken {
  offset: number
  type: string
}

/** Colorize one line from its Monaco tokens, coalescing runs of equal color. */
function colorizeLine(line: string, tokens: RawToken[]): string {
  if (tokens.length === 0) return line
  let res = ''
  let pos = 0
  let curColor: string | null = null
  const n = tokens.length
  for (let j = 0; j < n; j++) {
    const start = tokens[j].offset
    const end = j + 1 < n ? tokens[j + 1].offset : line.length
    if (start > pos) {
      if (curColor) {
        res += RESET
        curColor = null
      }
      res += line.slice(pos, start)
    }
    const color = tokenColor(tokens[j].type)
    if (color) {
      if (color !== curColor) {
        res += toAnsiFg(color)
        curColor = color
      }
      res += line.slice(start, end)
    } else {
      if (curColor) {
        res += RESET
        curColor = null
      }
      res += line.slice(start, end)
    }
    pos = end
  }
  if (pos < line.length) {
    if (curColor) {
      res += RESET
      curColor = null
    }
    res += line.slice(pos)
  }
  if (curColor) res += RESET
  return res
}

/** Guess a language from a `#!` shebang line (for extension-less scripts). */
function detectLanguageFromShebang(text: string): string | null {
  const first = text.slice(0, 200).split('\n')[0]
  if (!first.startsWith('#!')) return null
  const interp = first.slice(2).trim().split(/\s+/)[0].toLowerCase()
  const name = (interp.split('/').pop() ?? '').replace(/[^a-z0-9]/g, '')
  if (name === 'python' || name === 'python2' || name === 'python3') return 'python'
  if (name === 'bash' || name === 'sh' || name === 'zsh' || name === 'ksh' || name === 'dash')
    return 'shell'
  if (name === 'node' || name === 'nodejs') return 'javascript'
  if (name === 'ruby') return 'ruby'
  return null
}

// Monaco registers its built-in languages lazily (the Monarch grammar loads on
// first use via a dynamic import). Until a grammar is loaded, `tokenize`
// returns empty tokens. We warm grammars up in the background so the first
// `cat` already highlights, and self-heal on any later miss.
const warmingUp = new Set<string>()

function warmupLanguage(lang: string): void {
  if (warmingUp.has(lang)) return
  warmingUp.add(lang)
  monaco.editor
    .colorize('', lang, {})
    .catch(() => {})
    .finally(() => warmingUp.delete(lang))
}

const COMMON_LANGS = [
  'python',
  'javascript',
  'typescript',
  'json',
  'yaml',
  'shell',
  'xml',
  'html',
  'css',
  'markdown',
  'rust',
  'go',
  'java',
  'c',
  'cpp',
  'csharp',
  'php',
  'ruby',
  'ini',
  'sql',
  'dockerfile',
  'lua',
]

/** Warm up the most common languages' Monarch grammars (called once at startup). */
export function preloadHighlightLanguages(): void {
  for (const lang of COMMON_LANGS) warmupLanguage(lang)
}

/**
 * Tokenize `text` for `lang` and return one colored string per line (no
 * trailing newlines, plain text left untouched). Falls back to the input lines
 * when the language has no grammar or tokenization fails.
 */
export function highlightLines(text: string, lang: string): string[] {
  let l = lang
  if (!l || l === 'plaintext') {
    const fromShebang = detectLanguageFromShebang(text)
    if (fromShebang) l = fromShebang
  }
  const lines = text.split('\n')
  if (!l || l === 'plaintext') return lines

  let tokensByLine: RawToken[][]
  try {
    tokensByLine = monaco.editor.tokenize(text, l) as unknown as RawToken[][]
  } catch {
    return lines
  }

  if (!tokensByLine.some((toks) => toks.length > 0)) {
    // Grammar not loaded yet (lazy) — warm it up for next time, stay plain now.
    warmupLanguage(l)
    return lines
  }

  const out = new Array<string>(lines.length)
  for (let i = 0; i < lines.length; i++) {
    out[i] = colorizeLine(lines[i], tokensByLine[i] ?? [])
  }
  return out
}

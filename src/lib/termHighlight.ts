/**
 * Terminal output syntax highlighting for `cat` / `head` / `tail` file views.
 *
 * A plain `cat foo.py` prints uncolored text (no `bat`/`pygmentize` on the
 * remote host). This module uses a small built-in, regex-driven tokenizer
 * (no dependency) and maps token types to 24-bit ANSI SGR color codes, so
 * highlighted text can be written straight into xterm.js via `term.write(...)`.
 *
 * NOTE: we intentionally do NOT use Monaco's `editor.tokenize`. Since
 * monaco-editor 0.52 the built-in languages (json/js/python/yaml…) register an
 * asynchronous worker-based tokenizer, so the synchronous `tokenize` API
 * returns empty tokens for them — the old approach silently produced NO
 * highlighting at all. Our own tokenizer is synchronous and always works.
 */
import { detectLanguage } from '../editor/languages'
import { parseLsBlock, LsFormat, LsEntry } from './lsParse'
import { lsListingPalette, type LsListingPalette } from './themeColors'

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

/**
 * Split a line into printable runs and the escape sequences between them. The
 * sequences are never data: cmd prepends its window-title sequence to the first
 * listing row, and touching those bytes (by parsing them as names, or by
 * colorizing around them) splices an `ESC` into the sequence, which aborts it and
 * dumps the title text onto the screen.
 */
function splitEscapeRuns(line: string): { text: string; esc: boolean }[] {
  const runs: { text: string; esc: boolean }[] = []
  let from = 0
  let i = 0
  while (i < line.length) {
    if (line[i] !== '\x1b') {
      i++
      continue
    }
    if (i > from) runs.push({ text: line.slice(from, i), esc: false })
    let j = i + 1
    if (line[j] === ']') {
      // OSC: runs to BEL or to the `ESC \` string terminator.
      j++
      while (j < line.length && line[j] !== '\x07' && line[j] !== '\x1b') j++
      if (j < line.length) j += line[j] === '\x1b' ? 2 : 1
    } else if (line[j] === '[') {
      // CSI: parameter bytes, then one final byte.
      j++
      while (j < line.length && /[0-9;?<>! ]/.test(line[j])) j++
      if (j < line.length) j++
    }
    // A sequence cut in half by the chunk boundary has already run to the end of
    // the line, so its remainder can never be data either.
    runs.push({ text: line.slice(i, j), esc: true })
    i = j
    from = j
  }
  if (from < line.length) runs.push({ text: line.slice(from), esc: false })
  return runs
}

/**
 * Remove the escape sequences from one line and report where each surviving
 * character came from. `dir` rows and `ls -l` rows are matched from column 0 (the
 * date, the mode bits), so a title sequence sitting in front of one costs the row
 * its entry unless the line is parsed without them — `src` maps the resulting
 * columns back onto the raw bytes so the colorizing still addresses the original.
 */
function stripLineEscapes(line: string): { text: string; src: number[] } {
  const chars: string[] = []
  const src: number[] = []
  let offset = 0
  for (const run of splitEscapeRuns(line)) {
    if (!run.esc) {
      for (let k = 0; k < run.text.length; k++) {
        chars.push(run.text[k])
        src.push(offset + k)
      }
    }
    offset += run.text.length
  }
  return { text: chars.join(''), src }
}

/**
 * The raw span of `name`, or null when the name is not contiguous in the raw
 * line (two tokens that an escape sequence used to separate). Painting such a
 * span would splice SGR into that sequence.
 */
function rawSpan(src: number[], col: number, len: number): { start: number; end: number } | null {
  const start = src[col]
  if (start === undefined) return null
  for (let k = 0; k < len; k++) {
    if (src[col + k] !== start + k) return null
  }
  return { start, end: start + len }
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

// ---- built-in tokenizers ----

interface TokenRule {
  /** Sticky (anchored at current position) regex; first match wins. */
  regex: RegExp
  type: string
}

type LineTokenizer = (line: string) => RawToken[]

/** Scan `line` with sticky rules; unmatched characters become plain tokens. */
function scan(line: string, rules: TokenRule[]): RawToken[] {
  const tokens: RawToken[] = []
  let pos = 0
  const len = line.length
  while (pos < len) {
    let advanced = false
    for (const rule of rules) {
      rule.regex.lastIndex = pos
      const m = rule.regex.exec(line)
      if (m && m.index === pos && m[0].length > 0) {
        tokens.push({ offset: pos, type: rule.type })
        pos += m[0].length
        advanced = true
        break
      }
    }
    if (!advanced) pos++ // plain character
  }
  return tokens
}

const s = (re: RegExp | string, type: string): TokenRule => ({
  regex: new RegExp(re instanceof RegExp ? re.source : re, 'y'),
  type,
})
const COMMENT = (re: RegExp | string): TokenRule => s(re, 'comment')
const STRING = (): TokenRule => s(/"((?:\\.|[^"\\])*)"/, 'string')
const SQ_STRING = (): TokenRule => s(/'[^']*'/, 'string')
const NUMBER = (): TokenRule => s(/-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/, 'number')
const KEYWORDS = (words: string[]): TokenRule => s(`\\b(?:${words.join('|')})\\b`, 'keyword')

/** One JSON line (keys, strings, numbers, booleans, punctuation). */
const tokenizeJson: LineTokenizer = (line) =>
  scan(line, [
    s(/[{}[\]]/, 'delimiter.bracket'),
    s(/"((?:\\.|[^"\\])*)"(?=\s*:)/, 'key'),
    STRING(),
    s(/\b(?:true|false|null)\b/, 'keyword'),
    NUMBER(),
  ])

/** YAML: comments, keys before `:`, quoted scalars, booleans, numbers. */
const tokenizeYaml: LineTokenizer = (line) =>
  scan(line, [
    COMMENT(/#.*/),
    s(/[A-Za-z_][\w.-]*(?=\s*:)/, 'key'),
    STRING(),
    SQ_STRING(),
    s(/\b(?:true|false|null|yes|no|on|off|True|False|None|Yes|No|On|Off)\b/, 'keyword'),
    NUMBER(),
  ])

/** INI / properties / env: comments, `key=value` key, quoted value, numbers. */
const tokenizeIni: LineTokenizer = (line) =>
  scan(line, [
    COMMENT(/[;#].*/),
    s(/\[[^\]]*\]/, 'type'),
    s(/[A-Za-z0-9_.-]+(?=\s*[=:])/, 'key'),
    STRING(),
    NUMBER(),
  ])

/** Shell script: comments, quoted strings, common keywords, numbers, variables. */
const tokenizeShellLang: LineTokenizer = (line) =>
  scan(line, [
    COMMENT(/#.*/),
    STRING(),
    SQ_STRING(),
    s(/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/, 'variable'),
    KEYWORDS([
      'if',
      'then',
      'else',
      'elif',
      'fi',
      'for',
      'while',
      'until',
      'do',
      'done',
      'case',
      'esac',
      'in',
      'function',
      'return',
      'exit',
      'echo',
      'cd',
      'export',
      'local',
      'read',
      'set',
      'shift',
      'source',
      'alias',
      'unset',
      'declare',
    ]),
    NUMBER(),
  ])

/** Python: comments, strings (incl. docstrings), numbers, keywords. */
const tokenizePython: LineTokenizer = (line) =>
  scan(line, [
    COMMENT(/#.*/),
    s(/"""[\s\S]*?"""|'''[\s\S]*?'''/, 'string'),
    STRING(),
    SQ_STRING(),
    KEYWORDS([
      'def',
      'class',
      'return',
      'import',
      'from',
      'as',
      'if',
      'elif',
      'else',
      'for',
      'while',
      'in',
      'not',
      'and',
      'or',
      'None',
      'True',
      'False',
      'try',
      'except',
      'finally',
      'with',
      'yield',
      'lambda',
      'global',
      'nonlocal',
      'pass',
      'break',
      'continue',
      'raise',
      'assert',
      'del',
    ]),
    NUMBER(),
  ])

/** C-like family (js/ts/go/rust/java/c/cpp/csharp/php): comments, strings, numbers, keywords. */
const C_LIKE_KEYWORDS = [
  'function',
  'const',
  'let',
  'var',
  'return',
  'if',
  'else',
  'for',
  'while',
  'do',
  'switch',
  'case',
  'break',
  'continue',
  'default',
  'class',
  'interface',
  'extends',
  'implements',
  'new',
  'this',
  'super',
  'typeof',
  'instanceof',
  'import',
  'export',
  'from',
  'as',
  'try',
  'catch',
  'finally',
  'throw',
  'void',
  'public',
  'private',
  'protected',
  'static',
  'readonly',
  'abstract',
  'enum',
  'struct',
  'trait',
  'impl',
  'fn',
  'let',
  'mut',
  'package',
  'namespace',
  'true',
  'false',
  'null',
  'undefined',
  'NaN',
  'async',
  'await',
  'yield',
]
const tokenizeCLike: LineTokenizer = (line) =>
  scan(line, [
    COMMENT(/\/\/.*|\/\*[\s\S]*?\*\//),
    STRING(),
    SQ_STRING(),
    s(/`[^`]*`/, 'string'),
    KEYWORDS(C_LIKE_KEYWORDS),
    NUMBER(),
  ])

/** XML/HTML: tags, attribute names/values. */
const tokenizeXml: LineTokenizer = (line) =>
  scan(line, [
    COMMENT(/<!--[\s\S]*?-->/),
    s(/<\/?[A-Za-z_][\w-]*/, 'tag'),
    s(/[A-Za-z_:][\w:.-]*(?==\s*["'])/, 'attribute.name'),
    STRING(),
    SQ_STRING(),
  ])

/** CSS: comments, selectors, property names, values. */
const tokenizeCss: LineTokenizer = (line) =>
  scan(line, [
    COMMENT(/\/\*[\s\S]*?\*\//),
    s(/[A-Za-z-]+(?=\s*:)/, 'key'),
    s(/#[0-9a-fA-F]{3,8}\b/, 'constant'),
    s(/\b\d+(?:\.\d+)?(?:px|em|rem|%|vh|vw|s|ms|deg|fr|ch)?\b/, 'number'),
    STRING(),
  ])

/** Markdown: headings, emphasis, inline code, links. */
const tokenizeMarkdown: LineTokenizer = (line) =>
  scan(line, [
    s(/^#{1,6}\s+.*$/, 'keyword'),
    s(/`[^`]*`/, 'string'),
    s(/\*\*[^*]+\*\*|__[^_]+__/, 'keyword'),
    s(/\*[^*]+\*|_[^_]+_/, 'function'),
    s(/\[[^\]]*\]\([^)]*\)/, 'tag'),
    s(/^[-*+]\s+/, 'keyword'),
  ])

const LANG_TOKENIZERS: Record<string, LineTokenizer> = {
  json: tokenizeJson,
  yaml: tokenizeYaml,
  ini: tokenizeIni,
  properties: tokenizeIni,
  shell: tokenizeShellLang,
  python: tokenizePython,
  javascript: tokenizeCLike,
  typescript: tokenizeCLike,
  go: tokenizeCLike,
  rust: tokenizeCLike,
  java: tokenizeCLike,
  c: tokenizeCLike,
  cpp: tokenizeCLike,
  csharp: tokenizeCLike,
  php: tokenizeCLike,
  xml: tokenizeXml,
  html: tokenizeXml,
  css: tokenizeCss,
  scss: tokenizeCss,
  less: tokenizeCss,
  markdown: tokenizeMarkdown,
  sql: tokenizeCLike,
  lua: tokenizeCLike,
}

/** Map a token type to a 24-bit foreground color, or null for default. */
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

/** No-op retained for API compatibility (previously warmed Monaco grammars). */
export function preloadHighlightLanguages(): void {
  /* built-in tokenizer needs no warm-up */
}

/**
 * Tokenize `text` for `lang` and return one colored string per line (no
 * trailing newlines, plain text left untouched). Falls back to the input lines
 * when the language has no tokenizer or tokenization fails.
 */
export function highlightLines(text: string, lang: string): string[] {
  let l = lang
  if (!l || l === 'plaintext') {
    const fromShebang = detectLanguageFromShebang(text)
    if (fromShebang) l = fromShebang
  }
  const lines = text.split('\n')
  const tokenizer = (l && LANG_TOKENIZERS[l]) || null
  if (!tokenizer) return lines

  const out = new Array<string>(lines.length)
  for (let i = 0; i < lines.length; i++) {
    out[i] = colorizeLine(lines[i], tokenizer(lines[i]))
  }
  return out
}

// ===== Multi-line aware highlighting (cat/head/tail output, diff, git, tree,
// docker, xml, heredocs, block comments) =====
//
// `highlightLines` tokenizes line-by-line, so it can never colorize a token
// that spans newlines (a `/* */` C comment, a python `"""docstring"""`, a shell
// heredoc, or a whole `diff`/`git`/`tree` block). `highlightMultiline` instead
// operates on the whole text block and is what the capture writer uses, so the
// output stays 1:1 line-aligned while multiline constructs are colored.

const ESC = '\x1b'
function wrapHex(hex: string, text: string): string {
  if (!text) return text
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `${ESC}[38;2;${r};${g};${b}m${text}${ESC}[0m`
}

// Languages whose per-line tokenizer can additionally carry multi-line tokens
// (block comments / docstrings / heredocs). For others we just fall back to the
// existing per-line tokenizer.
const C_LIKE_MULTI = new Set([
  'c',
  'cpp',
  'csharp',
  'java',
  'javascript',
  'typescript',
  'go',
  'rust',
  'php',
  'json',
  'scala',
  'kotlin',
  'sql',
  'lua',
])
const MULTILINE_SPAN_LANGS = new Set<string>([
  ...C_LIKE_MULTI,
  'python',
  'shell',
  'sh',
  'bash',
  'yaml',
  'toml',
  'ini',
  'css',
  'scss',
  'less',
])

// Whole-text block tokenizers for languages whose natural unit is the block.
const BLOCK_TOKENIZERS: Record<string, (t: string) => string[]> = {
  diff: tokenizeDiffBlock,
  git: tokenizeGitBlock,
  tree: tokenizeTreeBlock,
  xml: tokenizeXmlBlock,
  html: tokenizeXmlBlock,
  docker: tokenizeDockerBlock,
}

function tokenizeDiffBlock(text: string): string[] {
  return text.split('\n').map((line) => {
    if (line.startsWith('+++') || line.startsWith('---')) return wrapHex('#c586c0', line)
    if (line.startsWith('@@')) return wrapHex('#569cd6', line)
    if (line.startsWith('+')) return wrapHex('#4ec9b0', line)
    if (line.startsWith('-')) return wrapHex('#f48771', line)
    if (
      line.startsWith('diff --git') ||
      line.startsWith('index ') ||
      line.startsWith('similarity') ||
      line.startsWith('rename') ||
      line.startsWith('new file') ||
      line.startsWith('deleted')
    )
      return wrapHex('#9cdcfe', line)
    return line
  })
}

function tokenizeGitBlock(text: string): string[] {
  return text.split('\n').map((line) => {
    if (line.startsWith('commit '))
      return line.replace(/^commit (\S+)/, (_h, hash) => 'commit ' + wrapHex('#c586c0', hash))
    if (line.startsWith('Author:')) return wrapHex('#9cdcfe', line)
    if (line.startsWith('Date:')) return wrapHex('#6a9955', line)
    if (line.startsWith('Merge:')) return wrapHex('#9cdcfe', line)
    if (line.startsWith('diff --git') || line.startsWith('index ')) return wrapHex('#9cdcfe', line)
    if (line.startsWith('@@')) return wrapHex('#569cd6', line)
    if (line.startsWith('+')) return wrapHex('#4ec9b0', line)
    if (line.startsWith('-')) return wrapHex('#f48771', line)
    if (/^\s*(modified|new file|deleted|renamed|copied|untracked files?):/i.test(line))
      return wrapHex('#569cd6', line)
    if (/^#\s*On branch/i.test(line)) return wrapHex('#6a9955', line)
    return line
  })
}

function tokenizeTreeBlock(text: string): string[] {
  return text.split('\n').map((line) => {
    const m = line.match(/^([│\s]*[├└]──\s*)(.*)$/)
    if (!m) return line
    const prefix = wrapHex('#6a9955', m[1])
    let name = m[2]
    if (name.endsWith('/')) name = wrapHex('#4ec9b0', name)
    else if (/->/.test(name)) name = wrapHex('#c586c0', name)
    else if (/\.(sh|bash|exe|bat|cmd|ps1|bin|run|out|com|py|pl|rb|zsh|fish)$/i.test(name))
      name = wrapHex('#dcdcaa', name)
    return prefix + name
  })
}

function tokenizeXmlBlock(text: string): string[] {
  const TAG = /<\/?[A-Za-z_][\w:.-]*/g
  let s = ''
  let pos = 0
  let m: RegExpExecArray | null
  while ((m = TAG.exec(text))) {
    s += text.slice(pos, m.index)
    let tag = m[0]
    // attribute names (` name=`)
    tag = tag.replace(/(\s[A-Za-z_:][\w:.-]*)(?==)/g, (a) => wrapHex('#9cdcfe', a))
    // attribute values
    tag = tag.replace(/=("[^"]*"|'[^']*')/g, (q) => '=' + wrapHex('#ce9178', q.slice(1)))
    s += wrapHex('#569cd6', tag)
    pos = m.index + m[0].length
  }
  s += text.slice(pos)
  return s.split('\n')
}

function tokenizeDockerBlock(text: string): string[] {
  return text.split('\n').map((line, i) => {
    if (i === 0) return wrapHex('#4ec9b0', line) // header row
    if (/^[\s\-=|]+$/.test(line)) return wrapHex('#6a9955', line) // separator row
    return line
  })
}

// Colorize the "outside" text (between multi-line spans) per-line with the
// normal tokenizer, so single-line tokens keep working everywhere.
function colorizeOutside(seg: string, lang: string): string {
  return seg
    .split('\n')
    .map((l) => highlightLines(l, lang)[0] ?? l)
    .join('\n')
}

// Find and solid-colorize multi-line spans (block comments, docstrings,
// heredocs); everything else is colorized per-line. Returns 1:1 line array.
function applyMultilineSpans(text: string, lang: string): string[] {
  const defs: { re: RegExp; color: string }[] = []
  if (lang === 'python') defs.push({ re: /"""[\s\S]*?"""|'''[\s\S]*?'''/g, color: '#ce9178' })
  if (C_LIKE_MULTI.has(lang)) defs.push({ re: /\/\*[\s\S]*?\*\//g, color: '#6a9955' })
  if (lang === 'shell' || lang === 'sh' || lang === 'bash')
    defs.push({
      re: /<<[-~]?\s*["']?(\w+)["']?(?:\r?\n)([\s\S]*?)(?:\r?\n)\1\b/g,
      color: '#ce9178',
    })
  if (defs.length === 0) return highlightLines(text, lang)

  const spans: [number, number, string][] = []
  for (const d of defs) {
    d.re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = d.re.exec(text))) spans.push([m.index, m.index + m[0].length, d.color])
  }
  if (spans.length === 0) return highlightLines(text, lang)

  spans.sort((a, b) => a[0] - b[0])
  let s = ''
  let pos = 0
  for (const [start, end, color] of spans) {
    if (start > pos) s += colorizeOutside(text.slice(pos, start), lang)
    s += wrapHex(color, text.slice(start, end))
    pos = end
  }
  if (pos < text.length) s += colorizeOutside(text.slice(pos), lang)
  return s.split('\n')
}

/**
 * Tokenize a whole text block for `lang` (multi-line aware) and return one
 * colored string per line (1:1 with input lines, so it can be fed straight into
 * the capture writer). Falls back to per-line tokenizing when the language has
 * no multi-line constructs.
 */
export function highlightMultiline(text: string, lang: string): string[] {
  let l = lang
  if (!l || l === 'plaintext') {
    const fromShebang = detectLanguageFromShebang(text)
    if (fromShebang) l = fromShebang
  }
  if (BLOCK_TOKENIZERS[l]) return BLOCK_TOKENIZERS[l](text)
  return applyMultilineSpans(text, l)
}

// ---- `ls` / `dir` listing highlight ----
//
// Four hues, one per kind: directory, symlink, executable, plain file. Everything
// that is not a name — the date, time, size and path columns — keeps the ordinary
// output highlighting, which the caller hands in as `other` (the listing capture
// owns these bytes, so the highlighter never sees them otherwise).
//
// Colors are resolved from the live theme tokens (see `lsListingPalette`), which
// also means this never duplicates the palette the CSS theme table owns.

/** An extension is the only executability signal a bare name carries. */
const EXEC_EXT = new Set([
  'sh',
  'bash',
  'zsh',
  'ksh',
  'fish',
  'ps1',
  'psm1',
  'bat',
  'cmd',
  'exe',
  'com',
  'bin',
  'run',
  'appimage',
])

/**
 * True when the shell already painted colour into this text (`ls --color=auto`,
 * PowerShell's own table), in which case its hues win and we write the bytes
 * through untouched. Bold/dim/underline-only SGR doesn't count.
 */
export function outputHasColor(text: string): boolean {
  if (!text.includes('\x1b[')) return false
  const re = /\x1b\[([\d;]*)m/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    for (const raw of m[1].split(';')) {
      const p = Number(raw)
      if (p === 38 || p === 48 || (p >= 30 && p <= 37) || (p >= 40 && p <= 47)) return true
      if (p >= 90 && p <= 97) return true
      if (p >= 100 && p <= 107) return true
    }
  }
  return false
}

/** The hue for one entry, or null when the listing gives no reason to color it. */
function lsNameColor(
  entry: LsEntry,
  palette: LsListingPalette,
  dirFlags: Map<string, boolean> | null,
): string | null {
  let kind = entry.kind
  // A bare `ls` name states nothing about its type, so ask the directory
  // listing that was fetched anyway to make the names clickable.
  if (kind === 'unknown' && dirFlags) {
    const isDir = dirFlags.get(entry.name)
    if (isDir !== undefined) kind = isDir ? 'dir' : 'file'
  }
  if (kind === 'dir') return palette.dir
  if (kind === 'link') return palette.link
  // Without permission bits (a bare name) an extension is all we have to go on.
  const ext = entry.name.includes('.') ? entry.name.split('.').pop()!.toLowerCase() : ''
  if (entry.exec || EXEC_EXT.has(ext)) return palette.exec
  // `unknown` — a bare `ls` name the directory listing could not resolve either —
  // stays plain, because calling it a file would be a guess.
  return kind === 'file' ? palette.file : null
}

/**
 * Colorize an `ls` / `dir` block. Entries are resolved by column (via
 * `parseLsBlock`) so only the entry name gets wrapped — spacing/alignment is
 * preserved — and the result is a 1:1 line array.
 *
 * `dirFlags` (name → is-directory, from a real directory listing) is what lets a
 * bare `ls`, whose output carries no type information at all, still show its
 * directories.
 *
 * `skipEchoLine` must be false for a listing streamed a line at a time, where
 * the piece in hand is a real entry row rather than the echoed command — see
 * `parseLsBlock`.
 *
 * `other` colorizes everything that is NOT an entry name (the date, time, size
 * and path columns). The listing capture owns the write, so the ordinary output
 * highlighter never sees these bytes — without it a `dir` listing loses the
 * column highlighting every other line of the terminal gets.
 */
export function highlightTableText(
  text: string,
  format: LsFormat,
  dirFlags?: Map<string, boolean> | null,
  skipEchoLine = true,
  other?: (segment: string) => string,
): string[] {
  const palette = lsListingPalette()
  const lines = text.split('\n')
  // Parsed on the printable text; `src[i]` maps line i's columns back onto the
  // raw bytes (see `stripLineEscapes`).
  const stripped = lines.map(stripLineEscapes)
  const entries = parseLsBlock(stripped.map((s) => s.text).join('\n'), format, 500, skipEchoLine)
  const byLine: Record<number, LsEntry[]> = {}
  for (const e of entries) (byLine[e.line] ??= []).push(e)
  // Everything that is not an entry name keeps the ordinary output highlighting.
  // It is applied run by run, around the escape sequences rather than across them:
  // the row a title sequence is glued onto still has to have its date and size
  // colored.
  const plain = (s: string, colorize: boolean): string => {
    if (!colorize || !other) return s
    if (!s.includes('\x1b')) return other(s)
    return splitEscapeRuns(s)
      .map((run) => (run.esc ? run.text : other(run.text)))
      .join('')
  }
  return lines.map((line, i) => {
    // The echoed command line is repainted by the input-line colorizer.
    const colorizeOther = !!other && !(skipEchoLine && i === 0)
    const es = (byLine[i] ?? []).slice().sort((a, b) => a.col - b.col)
    if (!es.length) return plain(line, colorizeOther)
    const src = stripped[i].src
    let out = ''
    let pos = 0
    for (const e of es) {
      const span = rawSpan(src, e.col, e.name.length)
      if (!span || span.start < pos) continue
      const color = lsNameColor(e, palette, dirFlags ?? null)
      const name = line.slice(span.start, span.end)
      out +=
        plain(line.slice(pos, span.start), colorizeOther) + (color ? wrapHex(color, name) : name)
      pos = span.end
    }
    return out + plain(line.slice(pos), colorizeOther)
  })
}

const PRINT_READERS = new Set(['cat', 'head', 'tail', 'less', 'more', 'bat', 'nl', 'sed', 'awk'])

/** True when `cmd` is a viewer/reader whose output we should re-color. */
export function isPrintLike(cmd: string): boolean {
  const tokens = cmd.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return false
  const prog = (tokens[0].split(/[\\/]/).pop() ?? tokens[0]).toLowerCase()
  if (PRINT_READERS.has(prog)) return true
  // a reader anywhere in a pipeline (e.g. `grep x | cat`, `cat < foo`)
  return /\b(cat|head|tail|less|more)\b/.test(cmd)
}

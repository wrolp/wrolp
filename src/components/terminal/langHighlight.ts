import { highlightMultiline, isPrintLike } from '../../lib/termHighlight'

// Map a filename to a highlight language (self-contained, no async worker).
const EXT_LANG: Record<string, string> = {
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  rb: 'ruby',
  pl: 'perl',
  php: 'php',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  scala: 'scala',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  ini: 'ini',
  cfg: 'ini',
  conf: 'ini',
  properties: 'ini',
  xml: 'xml',
  html: 'html',
  htm: 'html',
  svg: 'xml',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  psm1: 'shell',
  css: 'css',
  scss: 'scss',
  less: 'less',
  sql: 'sql',
  lua: 'lua',
  md: 'markdown',
  markdown: 'markdown',
  dockerfile: 'docker',
}

const PRINT_READERS = new Set(['cat', 'head', 'tail', 'less', 'more', 'bat', 'nl', 'sed', 'awk'])

// Best-effort language for a `cat`/`head`/`tail` (or piped) command, derived
// from the file arguments it references.
export const langFromPrintCommand = (cmd: string): string => {
  const cleaned = cmd.replace(/[|<>]/g, ' ').split(/\s+/).filter(Boolean)
  const files = cleaned.filter((t) => !t.startsWith('-') && !PRINT_READERS.has(t.toLowerCase()))
  for (const f of files) {
    const base = (f.split(/[\\/]/).pop() ?? f).toLowerCase()
    const ext = base.includes('.') ? base.split('.').pop()! : ''
    if (EXT_LANG[ext]) return EXT_LANG[ext]
    if (base === 'dockerfile') return 'docker'
    if (base === 'makefile') return 'makefile'
    if (base === 'gemfile') return 'ruby'
    if (base.startsWith('.') && base.includes('git')) return 'ini'
  }
  return 'plaintext'
}

// Choose a highlighter for a submitted command, or null if it's not something
// we should recolor. Covers `cat`/`head`/`tail` (+ pipes/redirects/globs),
// `git diff/log/show/status`, `tree`, and `docker ps`/`images`.
export const commandHighlighter = (
  cmd: string,
): { lang: string; highlighter: (t: string) => string[] } | null => {
  const tokens = cmd.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return null
  const prog = (tokens[0].split(/[\\/]/).pop() ?? tokens[0]).toLowerCase()
  const sub = tokens[1]?.toLowerCase() ?? ''
  if ((prog === 'git' || prog === 'podman' || prog === 'kubectl') && sub) {
    if (['diff', 'log', 'show', 'status', 'branch', 'blame'].includes(sub))
      return { lang: 'git', highlighter: (t) => highlightMultiline(t, 'git') }
  }
  if (prog === 'tree') return { lang: 'tree', highlighter: (t) => highlightMultiline(t, 'tree') }
  if (prog === 'docker' && ['ps', 'images', 'image', 'container', 'compose', 'service'].includes(sub))
    return { lang: 'docker', highlighter: (t) => highlightMultiline(t, 'docker') }
  if (isPrintLike(cmd)) {
    const lang = langFromPrintCommand(cmd)
    return { lang, highlighter: (t) => highlightMultiline(t, lang) }
  }
  return null
}

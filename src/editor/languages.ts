export interface LanguageOption {
  id: string
  label: string
}

export const LANGUAGE_OPTIONS: LanguageOption[] = [
  { id: 'plaintext', label: 'Plain Text' },
  { id: 'javascript', label: 'JavaScript' },
  { id: 'typescript', label: 'TypeScript' },
  { id: 'json', label: 'JSON' },
  { id: 'html', label: 'HTML' },
  { id: 'css', label: 'CSS' },
  { id: 'scss', label: 'SCSS' },
  { id: 'less', label: 'Less' },
  { id: 'xml', label: 'XML' },
  { id: 'markdown', label: 'Markdown' },
  { id: 'python', label: 'Python' },
  { id: 'rust', label: 'Rust' },
  { id: 'go', label: 'Go' },
  { id: 'java', label: 'Java' },
  { id: 'c', label: 'C' },
  { id: 'cpp', label: 'C++' },
  { id: 'csharp', label: 'C#' },
  { id: 'php', label: 'PHP' },
  { id: 'ruby', label: 'Ruby' },
  { id: 'shell', label: 'Shell' },
  { id: 'yaml', label: 'YAML' },
  { id: 'ini', label: 'INI / TOML' },
  { id: 'sql', label: 'SQL' },
  { id: 'dockerfile', label: 'Dockerfile' },
  { id: 'lua', label: 'Lua' },
  { id: 'makefile', label: 'Makefile' },
  { id: 'nginx', label: 'Nginx Config' },
  { id: 'properties', label: 'Properties / .env' },
  { id: 'sshconfig', label: 'SSH Config' },
]

// Alphabetical view of the language list (by label) for the manual picker
// dropdown. Sorted at module load so the dropdown stays in a stable order;
// `LANGUAGE_OPTIONS` itself is left untouched so id mapping / auto-detect
// (which key off `id`, not this array) are unaffected.
export const LANGUAGE_OPTIONS_SORTED: LanguageOption[] = [...LANGUAGE_OPTIONS].sort((a, b) =>
  a.label.localeCompare(b.label),
)

const ExtMap: Record<string, string> = {
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  json: 'json',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  less: 'less',
  xml: 'xml',
  svg: 'xml',
  xsl: 'xml',
  md: 'markdown',
  markdown: 'markdown',
  py: 'python',
  pyw: 'python',
  pyi: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  hxx: 'cpp',
  cs: 'csharp',
  php: 'php',
  rb: 'ruby',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  ksh: 'shell',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  conf: 'ini',
  cfg: 'ini',
  sql: 'sql',
  lua: 'lua',
  properties: 'properties',
  env: 'properties',
  // systemd units and freedesktop entries are sectioned key=value files.
  service: 'ini',
  socket: 'ini',
  timer: 'ini',
  target: 'ini',
  mount: 'ini',
  path: 'ini',
  slice: 'ini',
  scope: 'ini',
  automount: 'ini',
  swap: 'ini',
  device: 'ini',
  desktop: 'ini',
}

/** Shell rc / bash-style files whose names carry no language-bearing suffix. */
const ShellNames = new Set([
  '.bashrc',
  '.bash_profile',
  '.bash_login',
  '.bash_aliases',
  '.profile',
  '.zshrc',
  '.zprofile',
  '.zshenv',
  '.zlogin',
  '.zlogout',
  '.kshrc',
  '.envrc',
  'pkgbuild',
  'apkbuild',
])

/** Files that are Ruby by convention (Bundler / rake / Vagrant / CocoaPods…). */
const RubyNames = new Set([
  'gemfile',
  'rakefile',
  'vagrantfile',
  'podfile',
  'brewfile',
  'capfile',
  'guardfile',
  'thorfile',
])

/** Dotfiles Monaco itself files under `ini` (git config syntax is ini-shaped). */
const IniNames = new Set(['.editorconfig', '.gitconfig', '.gitattributes', '.gitmodules'])

export function detectLanguage(filename: string): string {
  // Callers pass either a basename or a full path (`cat /root/.bashrc`).
  const parts = filename.split(/[\\/]/)
  const base = parts.pop()?.toLowerCase() ?? filename.toLowerCase()
  const dirs = parts.map((p) => p.toLowerCase())
  // Versioned BuildKit files (`Dockerfile.dev`, `Dockerfile.prod`) are the same language.
  if (base === 'dockerfile' || base.startsWith('dockerfile.') || base.endsWith('.dockerfile')) {
    return 'dockerfile'
  }
  if (base.endsWith('makefile')) return 'makefile'
  if (base.endsWith('nginx.conf') || base.endsWith('.nginx')) return 'nginx'
  // ssh_config / sshd_config have no extension, and so do the drop-in snippets
  // (`/etc/ssh/sshd_config.d/10-hardening.conf`). `~/.ssh/config` only counts
  // inside a `.ssh` directory — a bare `config` is any project's file.
  if (base === 'ssh_config' || base === 'sshd_config') return 'sshconfig'
  if (base === 'config' && dirs.includes('.ssh')) return 'sshconfig'
  if (base.endsWith('.conf') && dirs.some((d) => d === 'ssh_config.d' || d === 'sshd_config.d')) {
    return 'sshconfig'
  }
  if (ShellNames.has(base)) return 'shell'
  if (RubyNames.has(base)) return 'ruby'
  if (IniNames.has(base)) return 'ini'
  if (base === 'jakefile') return 'javascript'
  // `.env`, `.env.local`, `.env.production`… (checked before the extension map,
  // which would read `local` as the extension).
  if (base === '.env' || base.startsWith('.env.')) return 'properties'
  const ext = base.includes('.') ? base.split('.').pop()! : ''
  return ExtMap[ext] ?? 'plaintext'
}

// ---- Content-based detection (extension-less and unknown-extension files) ----
//
// Filename rules win whenever they name a language. Only files they leave at
// `plaintext` are sniffed, and only for signals that are explicit rather than
// statistical (a wrong guess is worse than leaving the file uncoloured):
//   * a `#!` shebang (interpreter scripts),
//   * a Vim / Emacs modeline,
//   * a markup/XML declaration on the first line.
// Everything maps onto ids the toolbar picker already knows — a guessed id
// outside that set would render as a blank option.

const SupportedLangs = new Set(LANGUAGE_OPTIONS.map((o) => o.id))

/** Interpreter basenames (after `env` handling) → language id. */
const InterpreterLang: Record<string, string> = {
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  ksh: 'shell',
  dash: 'shell',
  ash: 'shell',
  mksh: 'shell',
  python: 'python',
  ruby: 'ruby',
  node: 'javascript',
  nodejs: 'javascript',
  lua: 'lua',
  php: 'php',
}

/** Vim `ft=` / Emacs `mode:` names → language id. */
const ModeLang: Record<string, string> = {
  py: 'python',
  python: 'python',
  sh: 'shell',
  shell: 'shell',
  bash: 'shell',
  zsh: 'shell',
  ksh: 'shell',
  js: 'javascript',
  javascript: 'javascript',
  node: 'javascript',
  ts: 'typescript',
  typescript: 'typescript',
  rb: 'ruby',
  ruby: 'ruby',
  c: 'c',
  cpp: 'cpp',
  'c++': 'cpp',
  cxx: 'cpp',
  java: 'java',
  go: 'go',
  rust: 'rust',
  lua: 'lua',
  php: 'php',
  sql: 'sql',
  yaml: 'yaml',
  yml: 'yaml',
  json: 'json',
  ini: 'ini',
  conf: 'ini',
  toml: 'ini',
  make: 'makefile',
  makefile: 'makefile',
  dockerfile: 'dockerfile',
  nginx: 'nginx',
  markdown: 'markdown',
  md: 'markdown',
  xml: 'xml',
  html: 'html',
  css: 'css',
  scss: 'scss',
  less: 'less',
}

function languageFromShebang(firstLine: string): string | null {
  if (!firstLine.startsWith('#!')) return null
  const tokens = firstLine.slice(2).trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return null
  let name = (tokens[0].split('/').pop() ?? '').toLowerCase()
  if (name === 'env') {
    // `#!/usr/bin/env [-S] [VAR=x] python3`: the interpreter is the first token
    // that is neither a flag nor an assignment.
    const interp = tokens.slice(1).find((t) => !t.startsWith('-') && !t.includes('='))
    if (!interp) return null
    name = (interp.split('/').pop() ?? '').toLowerCase()
  }
  // `python3`, `python3.12`, `/usr/bin/python2.7`.
  if (/^python[0-9]*(?:\.[0-9]+)*$/.test(name)) return 'python'
  return InterpreterLang[name] ?? null
}

function languageFromModeline(text: string): string | null {
  const head = text.slice(0, 8192)
  const tail = text.length > 8192 ? text.slice(-8192) : ''
  // Vim checks the first and last five lines; an Emacs modeline lives on line 0
  // or 1. Scanning both edges costs nothing and catches either placement.
  const lines = [...head.split('\n').slice(0, 5), ...(tail ? tail.split('\n').slice(-5) : [])]
  for (const line of lines) {
    const vim = /(?:^|\s)(?:vim?|ex):.*?\b(?:ft|filetype)=([A-Za-z0-9_+.-]+)/i.exec(line)
    let name = vim?.[1]
    if (!name) {
      const emacs = /-\*-\s*(.*?)\s*-\*-/.exec(line)
      if (emacs) {
        name =
          /mode\s*:\s*([A-Za-z0-9_+.-]+)/i.exec(emacs[1])?.[1] ??
          /^([A-Za-z0-9_+.-]+)$/.exec(emacs[1])?.[1]
      }
    }
    if (!name) continue
    const lang = ModeLang[name.toLowerCase()]
    if (lang && SupportedLangs.has(lang)) return lang
  }
  return null
}

function languageFromMarkup(text: string): string | null {
  const first = text.replace(/^\uFEFF/, '').trimStart()
  if (/^<\?php\b/i.test(first)) return 'php'
  if (/^<\?xml\b/i.test(first) || /^<svg\b/i.test(first) || /^<!doctype\s+svg/i.test(first)) {
    return 'xml'
  }
  if (/^<!doctype\s+html/i.test(first) || /^<html\b/i.test(first)) return 'html'
  return null
}

/** A language for a file whose name says nothing — or null when no signal fires. */
export function detectLanguageFromText(text: string): string | null {
  if (!text) return null
  const firstLine = text.slice(0, 200).split(/\r?\n/, 1)[0]
  return languageFromShebang(firstLine) ?? languageFromModeline(text) ?? languageFromMarkup(text)
}

/**
 * The language for a file, using its content only when the name cannot tell
 * (no extension, or one nobody knows). Callers must not use this to override a
 * language the user picked by hand.
 */
export function detectLanguageForFile(filename: string, text?: string | null): string {
  const known = detectLanguage(filename)
  if (known !== 'plaintext' || !text) return known
  return detectLanguageFromText(text) ?? 'plaintext'
}

export const ENCODING_OPTIONS = [
  { id: 'utf-8', label: 'UTF-8' },
  { id: 'gbk', label: 'GBK' },
  { id: 'gb18030', label: 'GB18030' },
  { id: 'big5', label: 'Big5' },
  { id: 'shift_jis', label: 'Shift-JIS' },
  { id: 'euc-kr', label: 'EUC-KR' },
  { id: 'iso-8859-1', label: 'ISO-8859-1' },
  { id: 'windows-1252', label: 'Windows-1252' },
]

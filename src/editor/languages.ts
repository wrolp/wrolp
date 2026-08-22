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
}

export function detectLanguage(filename: string): string {
  const lower = filename.toLowerCase()
  if (lower === 'dockerfile' || lower.endsWith('.dockerfile')) return 'dockerfile'
  if (lower.endsWith('makefile') || lower === 'gnumakefile') return 'makefile'
  if (lower.endsWith('nginx.conf') || lower.endsWith('.nginx')) return 'nginx'
  const ext = lower.includes('.') ? lower.split('.').pop()! : ''
  return ExtMap[ext] ?? 'plaintext'
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

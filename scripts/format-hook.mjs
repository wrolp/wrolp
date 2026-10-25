// PostToolUse hook: format the file the agent just wrote or edited.
// Reads the hook event JSON from stdin, so it never has to guess which files changed.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const PRETTIER_BIN = path.join('node_modules', 'prettier', 'bin', 'prettier.cjs')
const RUSTFMT_CONFIG = path.join('src-tauri', 'rustfmt.toml')
const PRETTIER_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.css', '.scss'])
const SKIPPED = /(node_modules|[/\\]dist[/\\]|[/\\]target[/\\]|[/\\]coverage[/\\]|dist-check|[/\\]task[/\\]|[/\\]\.codebuddy[/\\])/

function readStdin() {
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

function candidatePaths(event) {
  return [
    event?.tool_response?.filePath,
    event?.tool_input?.file_path,
    event?.tool_input?.notebook_path,
  ].filter((value) => typeof value === 'string' && value.length > 0)
}

function toProjectRelative(rawPath) {
  const absolute = path.resolve(process.cwd(), rawPath)
  const relative = path.relative(process.cwd(), absolute)
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null
  // Prettier treats a backslash in an argument as an escape and silently formats nothing.
  return relative.split(path.sep).join('/')
}

function format(relativePath) {
  if (SKIPPED.test(relativePath) || !existsSync(path.resolve(relativePath))) return
  const extension = path.extname(relativePath).toLowerCase()

  if (extension === '.rs') {
    if (!relativePath.startsWith('src-tauri/')) return
    // Never fail the agent's turn over a format that cannot parse.
    spawnSync('rustfmt', ['--edition', '2021', '--config-path', RUSTFMT_CONFIG, '--', relativePath], {
      stdio: 'ignore',
    })
    return
  }

  if (PRETTIER_EXTENSIONS.has(extension)) {
    spawnSync(process.execPath, [PRETTIER_BIN, '--write', relativePath], { stdio: 'ignore' })
  }
}

function parseEvent(raw) {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

const event = parseEvent(readStdin())
for (const rawPath of candidatePaths(event)) {
  const relativePath = toProjectRelative(rawPath)
  if (relativePath) format(relativePath)
}

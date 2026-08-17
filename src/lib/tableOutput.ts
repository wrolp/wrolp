// Generic aligned-table output highlighting (head vs body, per-column role
// coloring). Used by the terminal's TableCaptureState for commands like
// `df -h`, `ps aux`, `free -h`, `ss -tulnp`, `mount`, `lsblk`,
// `systemctl list-units`, etc.
//
// Design follows terminal-table-highlight-plan.md:
//  - inject SGR only, never alter visible characters (cursor/alignment safe)
//  - ANSI-colored output is always passed through untouched
//  - uncertain -> passthrough, never worse than uncolored
//  - table header (first line) gets bold + bright foreground; body lines get
//    per-column role coloring (path/num/pct/status/addr/time)
//
// P1 = known-command registry only. Generic column-alignment detection (P2)
// is left as future work; `spec`/`confirmed` fields are kept for it.

export type ColumnRole =
  | 'text'
  | 'path'
  | 'num'
  | 'pct'
  | 'status'
  | 'addr'
  | 'time'

export interface TableSpec {
  columns: ColumnRole[]
}

const TABLE_PROGRAMS: Record<string, TableSpec> = {
  df: { columns: ['path', 'num', 'num', 'num', 'pct', 'path'] },
  'ps aux': { columns: ['text', 'num', 'pct', 'pct', 'num', 'num', 'text', 'text', 'text', 'time', 'text'] },
  'ps -ef': { columns: ['text', 'num', 'num', 'num', 'text', 'text', 'time', 'text'] },
  free: { columns: ['text', 'num', 'num', 'num', 'num', 'num', 'num'] },
  ss: { columns: ['text', 'status', 'num', 'num', 'addr', 'addr'] },
  netstat: { columns: ['text', 'num', 'num', 'addr', 'addr', 'status', 'text'] },
  lsblk: { columns: ['text', 'text', 'num', 'text', 'text', 'text'] },
  mount: { columns: ['path', 'path', 'text', 'text'] },
  'systemctl list-units': { columns: ['text', 'text', 'text', 'status', 'text'] },
  'systemctl list-unit-files': { columns: ['text', 'status'] },
}

// `docker ps`/`images` are intentionally NOT here — they are already handled
// by the multiline block tokenizer (terminal-highlight-plan.md), so we avoid a
// double match.

export const STATUS_GREEN =
  /^(up|running|healthy|listening|listen|established|active|enabled|ok|done|running \(.*\))$/i
export const STATUS_RED =
  /^(down|exited|dead|error|failed|refused|denied|stopped|inactive|disabled)$/i

/** Detect a known table command; null = not a table we colorize. */
export function detectTableCommand(cmd: string): TableSpec | null {
  const c = cmd.trim()
  // Only look at the command up to the first pipe/redirect — the table we
  // colorize is the first stage's output.
  const head = c.split(/\s*\|/)[0].trim()
  const tokens = head.split(/\s+/)
  if (tokens.length === 0) return null
  const prog = (tokens[0].split(/[\\/]/).pop() ?? tokens[0]).toLowerCase()

  // Two/three-token keys (e.g. "ps aux", "systemctl list-units").
  const three = tokens.slice(0, 3).join(' ')
  if (TABLE_PROGRAMS[three]) return TABLE_PROGRAMS[three]
  const two = tokens.slice(0, 2).join(' ')
  if (TABLE_PROGRAMS[two]) return TABLE_PROGRAMS[two]
  if (TABLE_PROGRAMS[prog]) return TABLE_PROGRAMS[prog]

  if (prog === 'ps') {
    const sub = tokens.slice(1).join(' ')
    if (/aux|ajx|ef/.test(sub)) return TABLE_PROGRAMS['ps aux']
    if (sub.includes('-ef')) return TABLE_PROGRAMS['ps -ef']
  }
  if (prog === 'df') return TABLE_PROGRAMS['df']
  if (prog === 'free') return TABLE_PROGRAMS['free']

  return null
}

// Split a table line into columns by runs of 2+ spaces or tabs (single spaces
// stay inside columns, e.g. a path in `ps`'s COMMAND column).
export function splitColumns(line: string): string[] {
  return line.split(/\t|\s{2,}/).filter((s) => s.length > 0)
}

/** Decide whether a line is the column header for a known table spec. */
export function looksLikeTableHeader(line: string, spec: TableSpec | null): boolean {
  if (!spec) return false
  const n = splitColumns(line).length
  // Most headers have exactly `spec.columns.length` names. Tables with a leading
  // row label (e.g. `free`: "Mem:/Swap:" labels + 6 value columns) have headers
  // with one fewer name than the spec. Allow that case while still rejecting
  // short info lines like `netstat`'s "Active Internet connections...".
  return n >= Math.max(2, spec.columns.length - 1)
}

const ANSI_RESET = '\x1b[0m'
const HEADER_FG = '\x1b[1;96m' // bold + bright cyan
const ROLE_COLORS: Record<ColumnRole, string> = {
  text: '',
  path: '\x1b[94m', // blue
  num: '\x1b[38;5;208m', // orange
  pct: '\x1b[38;5;208m', // orange
  status: '',
  addr: '\x1b[36m', // cyan
  time: '\x1b[90m', // gray
}

function wrap(color: string, text: string): string {
  return color + text + ANSI_RESET
}

function colorForRole(seg: string, role: ColumnRole | undefined): string {
  if (!role || role === 'text') return seg
  if (role === 'status') {
    if (STATUS_GREEN.test(seg.trim())) return wrap('\x1b[32m', seg) // green
    if (STATUS_RED.test(seg.trim())) return wrap('\x1b[31m', seg) // red
    return seg
  }
  if (role === 'pct') {
    const m = seg.match(/(\d+(?:\.\d+)?)\s*%/)
    if (m) {
      const v = parseFloat(m[1])
      if (v > 90) return wrap('\x1b[31m', seg) // red
      if (v > 70) return wrap('\x1b[33m', seg) // yellow
    }
    return wrap(ROLE_COLORS.pct, seg)
  }
  const color = ROLE_COLORS[role]
  if (!color) return seg
  return wrap(color, seg)
}

// Column delimiter kept as a capture group so we can split a line into
// [text, delim, text, delim, ...] and recolor only even (text) segments,
// preserving the exact original whitespace for alignment.
const COL_DELIM = /(\s{2,}|\t)/

/**
 * Colorize one table row. `isHeader` applies bold+bright to the whole line;
 * otherwise each non-empty column is tinted by its role from `spec`. If `spec`
 * is null (generic detection, future work) the line is returned unchanged.
 */
export function colorizeTableLine(line: string, spec: TableSpec | null, isHeader: boolean): string {
  if (isHeader) return wrap(HEADER_FG, line)
  if (!spec) return line
  const parts = line.split(COL_DELIM)
  let col = 0
  let out = ''
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i]
    if (i % 2 === 1) {
      out += seg // delimiter — preserve exactly
      continue
    }
    if (seg.length === 0) {
      out += seg
      continue
    }
    const role = spec.columns[col]
    col++
    out += colorForRole(seg, role)
  }
  return out
}

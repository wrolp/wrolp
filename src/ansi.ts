/**
 * Lightweight ANSI SGR → HTML converter for coloured log output.
 * Handles 3-bit, bright, bold, italic, underline.
 * 256-colour codes (38;5;n / 48;5;n) and true-colour (38;2;r;g;b)
 * are parsed but approximated to the nearest standard terminal colour.
 */

/* ---- 3-bit standard foreground (Atom One Dark palette) ---- */
const FG_3BIT: Record<number, string> = {
  30: '#abb2bf' /* black → base foreground */,
  31: '#e06c75' /* red */,
  32: '#98c379' /* green */,
  33: '#e5c07b' /* yellow */,
  34: '#61afef' /* blue */,
  35: '#c678dd' /* magenta */,
  36: '#56b6c2' /* cyan */,
  37: '#abb2bf' /* white */,
}

const FG_BRIGHT: Record<number, string> = {
  90: '#5c6370',
  91: '#f44747',
  92: '#89d185',
  93: '#f9e174',
  94: '#7daeec',
  95: '#da8cef',
  96: '#6fd2e0',
  97: '#dcdfe4',
}

const BG_3BIT: Record<number, string> = {
  40: '#282c34',
  41: '#e06c75',
  42: '#98c379',
  43: '#e5c07b',
  44: '#61afef',
  45: '#c678dd',
  46: '#56b6c2',
  47: '#abb2bf',
}

const BG_BRIGHT: Record<number, string> = {
  100: '#5c6370',
  101: '#f44747',
  102: '#89d185',
  103: '#f9e174',
  104: '#7daeec',
  105: '#da8cef',
  106: '#6fd2e0',
  107: '#dcdfe4',
}

/** 6×6×6 colour cube lookup for XTerm 256-colour (codes 16‑231). */
function xterm256ToHex(code: number): string | null {
  if (code < 16 || code > 231) return null
  const n = code - 16
  const r = Math.round((Math.floor(n / 36) % 6) * (255 / 5))
  const g = Math.round((Math.floor(n / 6) % 6) * (255 / 5))
  const b = Math.round((n % 6) * (255 / 5))
  return (
    '#' +
    r.toString(16).padStart(2, '0') +
    g.toString(16).padStart(2, '0') +
    b.toString(16).padStart(2, '0')
  )
}

/** Greyscale ramp for XTerm 232‑255. */
function xterm256Grey(code: number): string | null {
  if (code < 232 || code > 255) return null
  const v = Math.round(((code - 232) / 23) * 255)
  const h = v.toString(16).padStart(2, '0')
  return '#' + h + h + h
}

interface SgrState {
  fg: string | null
  bg: string | null
  bold: boolean
  italic: boolean
  underline: boolean
}

function renderSpan(text: string, s: SgrState): string {
  const css: string[] = []
  if (s.bold) css.push('font-weight:bold')
  if (s.italic) css.push('font-style:italic')
  if (s.underline) css.push('text-decoration:underline')
  if (s.fg) css.push(`color:${s.fg}`)
  if (s.bg) css.push(`background-color:${s.bg}`)

  const safe = escapeHtml(text)
  if (css.length === 0) return safe
  return `<span style="${css.join(';')}">${safe}</span>`
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * Convert raw text containing ANSI SGR escape sequences into coloured HTML.
 * All other escape sequences are dropped.  Text that does not contain
 * any SGR codes is returned as simple HTML-escaped plain text.
 */
export function parseAnsiToHtml(text: string): string {
  if (!text.includes('\x1b[')) {
    return escapeHtml(text)
  }

  const state: SgrState = { fg: null, bg: null, bold: false, italic: false, underline: false }
  const parts: string[] = []
  let lastIdx = 0

  // Match ANSI CSI … m (SGR) sequences.  Other CSI sequences
  // (cursor movement, screen clear, etc.) are silently dropped.
  const re = /\x1b\[([\d;]*)m/g
  let match: RegExpExecArray | null

  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIdx) {
      parts.push(renderSpan(text.slice(lastIdx, match.index), { ...state }))
    }
    lastIdx = re.lastIndex

    const raw = match[1] || '0'
    if (raw === '') {
      // \x1b[m ≡ \x1b[0m
      reset(state)
      continue
    }

    let i = 0
    const params = raw.split(';')
    while (i < params.length) {
      const n = parseInt(params[i], 10)
      if (isNaN(n)) {
        i++
        continue
      }

      if (n === 0) {
        reset(state)
        i++
        continue
      }

      // ---- 256-colour foreground: 38;5;N
      if (n === 38 && i + 2 < params.length && params[i + 1] === '5') {
        const c = parseInt(params[i + 2], 10)
        if (!isNaN(c)) {
          state.fg = xterm256ToHex(c) ?? xterm256Grey(c) ?? state.fg
        }
        i += 3
        continue
      }

      // ---- 256-colour background: 48;5;N
      if (n === 48 && i + 2 < params.length && params[i + 1] === '5') {
        const c = parseInt(params[i + 2], 10)
        if (!isNaN(c)) {
          state.bg = xterm256ToHex(c) ?? xterm256Grey(c) ?? state.bg
        }
        i += 3
        continue
      }

      // ---- true-colour foreground: 38;2;R;G;B
      if (n === 38 && i + 4 < params.length && params[i + 1] === '2') {
        const r = parseInt(params[i + 2], 10)
        const g = parseInt(params[i + 3], 10)
        const b = parseInt(params[i + 4], 10)
        if (!isNaN(r) && !isNaN(g) && !isNaN(b) && r >= 0 && g >= 0 && b >= 0) {
          state.fg =
            '#' +
            r.toString(16).padStart(2, '0') +
            g.toString(16).padStart(2, '0') +
            b.toString(16).padStart(2, '0')
        }
        i += 5
        continue
      }

      // ---- true-colour background: 48;2;R;G;B
      if (n === 48 && i + 4 < params.length && params[i + 1] === '2') {
        const r = parseInt(params[i + 2], 10)
        const g = parseInt(params[i + 3], 10)
        const b = parseInt(params[i + 4], 10)
        if (!isNaN(r) && !isNaN(g) && !isNaN(b) && r >= 0 && g >= 0 && b >= 0) {
          state.bg =
            '#' +
            r.toString(16).padStart(2, '0') +
            g.toString(16).padStart(2, '0') +
            b.toString(16).padStart(2, '0')
        }
        i += 5
        continue
      }

      // ---- standard attributes
      if (n === 1) state.bold = true
      else if (n === 3) state.italic = true
      else if (n === 4) state.underline = true
      else if (n >= 30 && n <= 37) state.fg = FG_3BIT[n] ?? null
      else if (n >= 90 && n <= 97) state.fg = FG_BRIGHT[n] ?? null
      else if (n >= 40 && n <= 47) state.bg = BG_3BIT[n] ?? null
      else if (n >= 100 && n <= 107) state.bg = BG_BRIGHT[n] ?? null
      else if (n === 39) state.fg = null
      else if (n === 49) state.bg = null

      i++
    }
  }

  if (lastIdx < text.length) {
    parts.push(renderSpan(text.slice(lastIdx), { ...state }))
  }

  return parts.join('')
}

function reset(s: SgrState) {
  s.fg = null
  s.bg = null
  s.bold = false
  s.italic = false
  s.underline = false
}

/**
 * Heuristic syntax highlighter for plain (non-ANSI) log text.
 * Detects common log patterns and colourises them so the Docker log view
 * stays readable even when the container emits no ANSI escape codes:
 *   - RFC3339 / ISO timestamps at the start of a line
 *   - log levels: TRACE/DEBUG/INFO/NOTICE/WARN/WARNING/ERROR/ERR/FATAL/CRIT
 *   - key=value pairs and JSON object/array delimiters
 * Lines that match none of the patterns are passed through unchanged.
 */
const ANSI_RE = /\x1b\[/g

export function hasAnsi(text: string): boolean {
  ANSI_RE.lastIndex = 0
  return ANSI_RE.test(text)
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

// RFC3339 / ISO-8601-ish timestamp at the start of a line, optionally wrapped
// in brackets (Log4j/Java style `[2026-08-07 19:48:06,008]`) and with an
// optional trailing Z / timezone offset. The fractional seconds separator may
// be a dot or a comma (the latter is common in Java logging frameworks).
const TS_RE =
  /^(?:\[)?(?:\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?)(?:\])? /

const LEVEL_RE =
  /\b(TRACE|DEBUG|INFO|NOTICE|WARN(?:ING)?|ERROR|ERR|FATAL|CRIT(?:ICAL)?)\b/g

const LEVEL_FG: Record<string, string> = {
  TRACE: '#7daeec',
  DEBUG: '#2dd4bf',
  INFO: '#98c379',
  NOTICE: '#56b6c2',
  WARN: '#e5c07b',
  WARNING: '#e5c07b',
  ERROR: '#e06c75',
  ERR: '#e06c75',
  FATAL: '#f44747',
  CRIT: '#f44747',
  CRITICAL: '#f44747',
}

function highlightLine(line: string): string {
  if (!line) return ''

  let html = ''
  let rest = line

  // Leading timestamp
  const tsMatch = TS_RE.exec(line)
  if (tsMatch) {
    html += `<span style="color:#61afef">${esc(tsMatch[0])}</span>`
    rest = line.slice(tsMatch[0].length)
  }

  // Levels anywhere in the line (bold + colour)
  if (LEVEL_RE.test(rest)) {
    LEVEL_RE.lastIndex = 0
    let last = 0
    let m: RegExpExecArray | null
    let lvlHtml = ''
    while ((m = LEVEL_RE.exec(rest)) !== null) {
      const key = m[1]
      const fg = LEVEL_FG[key] ?? '#e5c07b'
      lvlHtml += esc(rest.slice(last, m.index))
      lvlHtml += `<span style="color:${fg};font-weight:bold">${esc(m[0])}</span>`
      last = m.index + m[0].length
    }
    lvlHtml += esc(rest.slice(last))
    rest = lvlHtml
  } else {
    rest = esc(rest)
  }

  // key=value pairs inside the (possibly already-spanned) text are left as-is
  // to keep the markup simple; JSON braces get subtle emphasis via CSS class.
  if (rest.includes('{') || rest.includes('[')) {
    return `<span class="dlv-log-json">${html}${rest}</span>`
  }
  return html + rest
}

/**
 * Apply heuristic highlighting to plain text that contains no ANSI codes.
 * Returns `null` if the text already contains ANSI escapes (caller should
 * use `parseAnsiToHtml` instead) or is effectively empty.
 */
export function highlightPlainLog(text: string): string | null {
  if (!text || hasAnsi(text)) return null

  const lines = text.split('\n')
  let anyHighlight = false
  const out = lines.map((ln) => {
    const hl = highlightLine(ln)
    if (hl !== esc(ln)) anyHighlight = true
    return hl
  })
  // If nothing matched our patterns, don't pretend we highlighted — return the
  // plain escaped text so the view is unchanged.
  if (!anyHighlight) return null
  return out.join('\n')
}

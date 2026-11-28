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
  91: '#ea7d7d',
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
  101: '#ea7d7d',
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
  return stripInvisible(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/* ---- Invisible bytes ------------------------------------------------------
 * Raw command output (`docker logs`, `cat` of a binary, progress bars, tty
 * recordings) carries far more than colours: cursor moves, screen erases,
 * window titles, bell/backspace bytes.  Only SGR (`…m`) is rendered by the
 * parser above — everything else must be removed, otherwise the raw ESC byte
 * lands in the DOM and the reader sees junk such as `[2J` / `[?25l` glued into
 * the log line.  This is what made the "Analyze Container" log panel unreadable.
 *
 * Not `const` regex literals with the /g flag reused across calls — `replace`
 * resets `lastIndex`, and these are only ever used with `replace`.
 */
/** CSI … final byte — cursor moves, erases, mode set/reset, … */
const NON_SGR_CSI_RE = /\x1b\[[0-9;:?<>=!]*[ -/]*[@-~]/g
/** OSC … BEL|ST — window/icon titles, hyperlinks. */
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g
/** Two-byte escapes (`\x1b=` charset, `\x1b(B` designators, …). */
const SHORT_ESC_RE = /\x1b[@-Z\\-_]/g
/** Remaining C0/C1 control bytes — including any dangling ESC. TAB/LF/CR kept. */
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g

/**
 * Drop control bytes that cannot be shown: non-SGR escape sequences and stray
 * C0 control characters. TAB / LF / CR are preserved (the HTML parser folds CR
 * into a line break, so `\r\n` and `\r` progress output still read correctly).
 *
 * Exported for the plain-text path (the log viewer's "Color" toggle off), which
 * must strip the same bytes even though it does not colourise anything.
 */
export function stripInvisible(text: string): string {
  return text
    .replace(OSC_RE, '')
    .replace(NON_SGR_CSI_RE, '')
    .replace(SHORT_ESC_RE, '')
    .replace(CONTROL_RE, '')
}

/**
 * Convert raw text containing ANSI SGR escape sequences into coloured HTML.
 * All other escape sequences and control bytes are dropped.  Text that does not
 * contain any SGR codes is returned as simple HTML-escaped plain text.
 */
export function parseAnsiToHtml(text: string): string {
  return parseAnsiToHtmlLines(text).join('\n')
}

/**
 * `parseAnsiToHtml`, one entry per line, so a caller can wrap each line in its own
 * element (the log viewer's line numbers) without cutting markup apart afterwards.
 *
 * A colour run may open on one line and reset two lines later, so the line break is
 * *inside* that run: the flush below ends the current line's parts there and opens the
 * next line's, while the SGR state carries across — the colours stay where they were.
 */
export function parseAnsiToHtmlLines(text: string): string[] {
  if (!text.includes('\x1b[')) {
    return escapeHtml(text).split('\n')
  }

  const state: SgrState = { fg: null, bg: null, bold: false, italic: false, underline: false }
  const parts: string[] = []
  const lines: string[] = []
  let lastIdx = 0

  // Emit a stretch of plain text, breaking the line wherever the text does.
  const flushText = (chunk: string) => {
    chunk.split('\n').forEach((piece, i) => {
      if (i > 0) {
        lines.push(parts.join(''))
        parts.length = 0
      }
      if (piece) parts.push(renderSpan(piece, { ...state }))
    })
  }

  // Match ANSI CSI … m (SGR) sequences.  Other CSI sequences
  // (cursor movement, screen clear, etc.) are silently dropped.
  const re = /\x1b\[([\d;]*)m/g
  let match: RegExpExecArray | null

  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIdx) {
      flushText(text.slice(lastIdx, match.index))
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
    flushText(text.slice(lastIdx))
  }

  lines.push(parts.join(''))
  return lines
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
 * Detects common log patterns and colourises them so the Docker and Kubernetes
 * log views stay readable even when the workload emits no ANSI escape codes:
 *   - timestamps at the start of a line: ISO/RFC3339 (optionally bracketed),
 *     nginx's `2026/11/28 10:00:00`, syslog's `Nov 28 10:00:00` and Apache's
 *     `[Fri Nov 28 10:00:00 2026]` — plus the bracketed CLF timestamp nginx
 *     puts mid-line in its access log
 *   - log levels: bare upper-case TRACE…CRITICAL words, bracketed `[INFO]` /
 *     `[core:error]`, and structured `level=info` / `"level":"error"` pairs
 *   - JSON object lines get a CSS class for subtle emphasis
 * Lines that match none of the patterns are passed through unchanged.
 */
const ANSI_RE = /\x1b\[/g

export function hasAnsi(text: string): boolean {
  ANSI_RE.lastIndex = 0
  return ANSI_RE.test(text)
}

/** HTML-escape plain text — also drops invisible bytes (see `stripInvisible`). */
function esc(s: string): string {
  return escapeHtml(s)
}

const TS_COLOR = '#61afef'

// Leading-timestamp shapes, tried in order — the first hit is the line's timestamp.
// RFC3339 / ISO-8601-ish, optionally wrapped in brackets (Log4j/Java style
// `[2026-08-07 19:48:06,008]`) and with an optional trailing Z / timezone
// offset. The fractional-seconds separator may be a dot or a comma (the latter
// is common in Java logging frameworks).
const ISO_TS_RE =
  /^(?:\[)?\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?(?:\])? /
// nginx error log: `2026/11/28 10:00:00 [error] …`
const NGINX_TS_RE = /^\d{4}\/\d{2}\/\d{2}[ T]\d{2}:\d{2}:\d{2}/
// Classic syslog: `Nov 28 10:00:00 host app[42]: …` (single-digit days are
// space-padded, hence `{1,2}`).
const SYSLOG_TS_RE = /^[A-Z][a-z]{2} {1,2}\d{1,2} \d{2}:\d{2}:\d{2}/
// Apache error log: `[Fri Nov 28 10:00:00.123456 2026] [core:error] …`
const APACHE_TS_RE =
  /^\[[A-Z][a-z]{2} [A-Z][a-z]{2} {1,2}\d{1,2} \d{2}:\d{2}:\d{2}(?:\.\d+)? \d{4}\]/
// The CLF timestamp in the middle of an nginx access-log line:
// `10.0.0.1 - - [28/Nov/2026:10:00:00 +0800] "GET / HTTP/1.1" 200`.
const CLF_TS_RE = /\[\d{2}\/[A-Za-z]{3}\/\d{4}:\d{2}:\d{2}:\d{2} [+-]\d{4}\]/g

// The level vocabulary, shared by every detector below. Bare words stay
// upper-case-only (that was the original contract — a lowercase `error` in a
// prose message must not turn red); the bracketed and keyed forms are
// case-insensitive because that is how logfmt / JSON logs spell them.
const LEVEL_WORDS = 'TRACE|DEBUG|INFO|NOTICE|WARN(?:ING)?|ERROR|ERR|FATAL|CRIT(?:ICAL)?'
const LEVEL_RE = new RegExp(`\\b(${LEVEL_WORDS})\\b`, 'g')
const BRACKET_LEVEL_RE = new RegExp(`\\[(?:[A-Za-z0-9_.-]+:)?(${LEVEL_WORDS})\\]`, 'gi')
const KV_LEVEL_RE = new RegExp(
  `\\b(?:level|lvl|severity|sev|log\\.level)\\b["']?\\s*[=:]\\s*["']?(${LEVEL_WORDS})\\b`,
  'gi',
)

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

const levelColor = (word: string): string => LEVEL_FG[word.toUpperCase()] ?? LEVEL_FG.WARN

interface HlSpan {
  start: number
  end: number
  color: string
  bold: boolean
}

/** All colour spans of one line, plus where its leading timestamp ended. */
function collectSpans(line: string): { spans: HlSpan[]; tsEnd: number } {
  const spans: HlSpan[] = []
  let tsEnd = 0
  for (const re of [ISO_TS_RE, NGINX_TS_RE, SYSLOG_TS_RE, APACHE_TS_RE]) {
    const m = re.exec(line)
    if (m) {
      tsEnd = m[0].length
      spans.push({ start: 0, end: tsEnd, color: TS_COLOR, bold: false })
      break
    }
  }
  for (const m of line.matchAll(CLF_TS_RE)) {
    spans.push({ start: m.index, end: m.index + m[0].length, color: TS_COLOR, bold: false })
  }
  // The bracket and keyed forms run before the bare word: when both agree the
  // span is identical and the renderer keeps only one.
  for (const m of line.matchAll(BRACKET_LEVEL_RE)) {
    const start = m.index + m[0].lastIndexOf(m[1])
    spans.push({ start, end: start + m[1].length, color: levelColor(m[1]), bold: true })
  }
  for (const m of line.matchAll(KV_LEVEL_RE)) {
    const start = m.index + m[0].lastIndexOf(m[1])
    spans.push({ start, end: start + m[1].length, color: levelColor(m[1]), bold: true })
  }
  for (const m of line.matchAll(LEVEL_RE)) {
    spans.push({ start: m.index, end: m.index + m[0].length, color: levelColor(m[0]), bold: true })
  }
  return { spans, tsEnd }
}

function renderSpans(line: string, spans: HlSpan[]): string {
  if (spans.length === 0) return esc(line)
  // Earlier match wins; at the same offset the longer one does (a bracketed or
  // keyed level also satisfies the bare-word detector).
  spans.sort((a, b) => a.start - b.start || b.end - a.end)
  let html = ''
  let cur = 0
  for (const s of spans) {
    if (s.start < cur) continue
    html += esc(line.slice(cur, s.start))
    const weight = s.bold ? ';font-weight:bold' : ''
    html += `<span style="color:${s.color}${weight}">${esc(line.slice(s.start, s.end))}</span>`
    cur = s.end
  }
  return html + esc(line.slice(cur))
}

function highlightLine(line: string): string {
  if (!line) return ''
  const { spans, tsEnd } = collectSpans(line)
  const body = renderSpans(line, spans)
  // Braces/brackets in the message part get subtle emphasis via CSS class (the
  // leading timestamp is excluded, so `[2026-…]` alone does not trigger it).
  const rest = line.slice(tsEnd)
  if (rest.includes('{') || rest.includes('[')) {
    return `<span class="dlv-log-json">${body}</span>`
  }
  return body
}

/**
 * Apply heuristic highlighting to plain text that contains no ANSI codes.
 * Returns `null` if the text already contains ANSI escapes (caller should
 * use `parseAnsiToHtml` instead) or is effectively empty.
 */
export function highlightPlainLog(text: string): string | null {
  const lines = highlightPlainLogLines(text)
  return lines && lines.join('\n')
}

/** `highlightPlainLog`, one entry per line — see `parseAnsiToHtmlLines`. */
export function highlightPlainLogLines(text: string): string[] | null {
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
  return out
}

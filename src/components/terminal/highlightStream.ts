// Streaming, ANSI-safe highlighter for terminal output.
//
// Chunks arrive on arbitrary 100ms boundaries, so this class keeps two pieces of
// state across `push()` calls:
//   1. an unfinished escape sequence (CSI/OSC/DCS/…) tail,
//   2. the currently active SGR (so a highlighted token can restore the outer
//      color instead of resetting it to default).
//
// It only inserts SGR codes — visible characters and cursor movement are never
// touched, which keeps selection/copy/replay semantics intact.

import {
  compileHighlighter,
  type HighlightConfig,
  type HighlightEngine,
} from '../../lib/highlightRules'

/** Chunks larger than this are passed through untouched (same spirit as the
 * existing capture thresholds) to avoid stalling on huge bursts. */
export const HL_MAX_CHUNK = 256 * 1024

/** Hard cap for a pending partial escape sequence before we give up on it. */
const MAX_PENDING = 4096

function isSgr(raw: string): boolean {
  return raw.startsWith('\x1b[') && raw.endsWith('m')
}

/** Given the raw CSI `m` sequence, return the new active base ('' = default). */
function sgrBase(raw: string): string {
  const params = raw.slice(2, -1)
  if (params === '' || params === '0' || params === '00') return ''
  return raw
}

/**
 * Return the end offset (exclusive) of the escape sequence starting at `start`,
 * or -1 if it is incomplete at the end of `s`.
 */
function findEscapeEnd(s: string, start: number): number {
  const n = s.length
  if (start + 1 >= n) return -1
  const kind = s[start + 1]
  if (kind === '[') {
    // CSI: params/intermediates below 0x40, final byte in 0x40..0x7E.
    for (let j = start + 2; j < n; j++) {
      const c = s.charCodeAt(j)
      if (c >= 0x40 && c <= 0x7e) return j + 1
    }
    return -1
  }
  if (kind === ']' || kind === 'P' || kind === '_' || kind === '^' || kind === 'X') {
    // OSC / DCS / APC / PM / SOS: terminated by BEL or ST (ESC \).
    for (let j = start + 2; j < n; j++) {
      const c = s[j]
      if (c === '\x07') return j + 1
      if (c === '\x1b' && j + 1 < n && s[j + 1] === '\\') return j + 2
    }
    return -1
  }
  // Two-byte sequences (ESC x) and charset designators (ESC ( B, ESC % G...).
  const c2 = s.charCodeAt(start + 1)
  if (c2 >= 0x30 && c2 <= 0x7e) {
    if (
      (kind === '(' || kind === ')' || kind === '*' || kind === '#' || kind === '%') &&
      start + 2 < n
    ) {
      const c3 = s.charCodeAt(start + 2)
      if (c3 >= 0x30 && c3 <= 0x7e) return start + 3
    }
    return start + 2
  }
  return -1
}

export class AnsiHighlighter {
  private engine: HighlightEngine
  private active: boolean
  private pending = ''
  private curBase = ''

  constructor(config: HighlightConfig) {
    this.engine = compileHighlighter(config.rules, config.custom)
    this.active = config.enabled && this.engine.enabled
  }

  /** Apply new settings. Resets cross-chunk state (stream may have moved on). */
  update(config: HighlightConfig): void {
    this.engine = compileHighlighter(config.rules, config.custom)
    this.active = config.enabled && this.engine.enabled
    this.reset()
  }

  reset(): void {
    this.pending = ''
    this.curBase = ''
  }

  private colorizeRun(run: string): string {
    return this.engine.colorize(run, this.curBase)
  }

  /**
   * Decide whether a trailing whitespace-delimited `word` might actually be the
   * leading fragment of a longer token that a following chunk will complete
   * (an IPv4/IPv6/MAC/URL/path/number-with-unit, etc.). If so, the word is held
   * back instead of colorized now, so a token split across chunk boundaries
   * (which Windows ConPTY delivers, e.g. an IPv6 address arriving in pieces)
   * is colorized as one unit once it is complete.
   *
   * A word is considered a plausible fragment only when it is built purely from
   * "structured" characters (hex digits plus glue: `.` `:` `%` `/` `@` `+` `_`
   * `-`). A **pure-decimal** leading group (e.g. `2408`, `192`) is included:
   * an IPv4/IPv6 address can start with a bare decimal octet and a chunk
   * boundary may land right after it. Plain words (`done`, `node`) and prompts
   * (`Password:`, `C:\Users\x>`) contain non-structured letters and are never
   * held, so interactive/prompt text keeps flowing immediately.
   */
  private isFragment(word: string): boolean {
    if (!word) return false
    // A Windows drive-rooted path (`C:\Program`) can be completed by the next
    // chunk with a space-containing directory (`C:\Program Files\node.exe`),
    // which PATH_RE can only color as one unit once it sees the whole token.
    // Hold it so the following chunk can complete it. Prompt tails such as
    // `C:\Users\x>` are excluded — `>` is not a path character here — so
    // interactive prompts are never delayed.
    if (/^[A-Za-z]:[\\/][^\s"'<>|&;():=\u0060]*$/.test(word)) return true
    if (!/^[0-9a-fA-F.:%/@+_[\]-]+$/.test(word)) return false
    if (/[.:%/@+-]$/.test(word)) return true // ends in a glue char
    if (/[0-9a-fA-F]$/.test(word)) {
      // A bracketed token is only held when it is network-shaped (contains a
      // port colon, e.g. `[::]:`, `[fe80::1%18]:49666`). Without that guard a
      // bare `[1234` / array index would be delayed for no benefit and could
      // sit hidden until the next flush.
      if (/[[\]]/.test(word) && !word.includes(':')) return false
      return true // hex/alphanumeric end (pure decimal incl.)
    }
    return false
  }

  /**
   * Split a plain (escape-free) run into the part that is safe to colorize and
   * emit now, and a part to hold for the next chunk:
   *   - everything up to and including the last line break is always safe;
   *   - after the last line break, a trailing "continuable" last word is held.
   */
  private splitTail(text: string): { emit: string; hold: string } {
    if (!text) return { emit: '', hold: '' }
    const nl = Math.max(text.lastIndexOf('\n'), text.lastIndexOf('\r'))
    let stableEnd: number
    let tail: string
    if (nl !== -1) {
      stableEnd = nl + 1
      tail = text.slice(stableEnd)
    } else {
      stableEnd = 0
      tail = text
    }
    if (tail) {
      const ws = Math.max(tail.lastIndexOf(' '), tail.lastIndexOf('\t'))
      const word = ws === -1 ? tail : tail.slice(ws + 1)
      if (this.isFragment(word)) {
        const keepEnd = ws === -1 ? stableEnd : stableEnd + ws + 1
        return { emit: text.slice(0, keepEnd), hold: word }
      }
    }
    return { emit: text, hold: '' }
  }

  /** Feed one output chunk; returns the safe-to-write transformed chunk. */
  push(chunk: string): string {
    if (!this.active || chunk.length === 0) return chunk
    const content = this.pending + chunk
    this.pending = ''
    if (content.length === 0) return content

    // Fast path: no escape sequences in this chunk at all.
    if (!content.includes('\x1b')) {
      const { emit, hold } = this.splitTail(content)
      this.pending = hold
      return this.engine.colorize(emit, this.curBase)
    }

    let out = ''
    let run = ''
    let i = 0
    const n = content.length
    while (i < n) {
      const esc = content.indexOf('\x1b', i)
      if (esc === -1) {
        run += content.slice(i)
        break
      }
      if (esc > i) run += content.slice(i, esc)
      const end = findEscapeEnd(content, esc)
      if (end === -1) {
        const tail = content.slice(esc)
        if (tail.length <= MAX_PENDING) {
          // The run before the incomplete escape is complete; emit it fully.
          if (run) out += this.colorizeRun(run)
          this.pending = tail
          run = ''
        } else {
          // Runaway/undecodable escape — emit literally rather than buffering forever.
          run += tail
        }
        break
      }
      if (run) {
        out += this.colorizeRun(run)
        run = ''
      }
      const raw = content.slice(esc, end)
      if (isSgr(raw)) this.curBase = sgrBase(raw)
      out += raw
      i = end
    }
    if (run) {
      // Content ends in plain text: hold a possible token fragment for the next
      // chunk rather than coloring (and possibly splitting) it alone.
      const { emit, hold } = this.splitTail(run)
      out += this.engine.colorize(emit, this.curBase)
      this.pending = hold
    }
    return out
  }

  /** True when a fragment is being held back for the next chunk. */
  hasPending(): boolean {
    return this.pending.length > 0
  }

  /**
   * Emit any held-back fragment now. A partial escape sequence is passed
   * through literally.
   *
   * Plain tails follow a safety ladder:
   *   1. a fragment that already forms one complete colored token (a whole
   *      IPv4/IPv6/MAC/… that only lacked its trailing newline) is colorized —
   *      it is finished regardless of what comes next;
   *   2. anything else is emitted PLAIN, never re-held.
   *
   * Issue #26: `flush()` must never keep a fragment held. `push()` already holds
   * each chunk's tail so a token split by a chunk boundary (an IPv6 address, say)
   * is still colorized as one unit — but `flush()` only runs after
   * `HL_FLUSH_DELAY_MS` of silence, which is longer than the output-poll cadence,
   * so by then no further bytes are coming for that token. Holding it any longer
   * left a trailing number (e.g. the `50` of a command echoed without a newline
   * when a snippet is sent into a non-empty input line) invisible until the next
   * output arrived, and left the terminal out of sync with the shell. A hidden
   * tail is far worse than a token colored in pieces when a slow producer pauses
   * mid-token.
   */
  flush(): string {
    const t = this.pending
    if (!t) return ''
    if (t.includes('\x1b')) {
      this.pending = ''
      return t
    }
    const segs = this.engine.annotate(t)
    // A token is safe to auto-color at flush only when it is a complete SOLID
    // structured token (e.g. a whole IPv4/IPv6 that lacked its newline).
    // Requiring a glue char excludes a bare pure-decimal prefix like `2408` —
    // coloring that alone as a "number" is exactly the mislabeling we prevent.
    // IPv4:port is allowed as TWO fully colored segments (address + port),
    // which still form a single finished token.
    const singleComplete =
      segs.length === 1 && !!segs[0].color && segs[0].text === t && /[.:%/@+_-]/.test(t)
    const joined = segs.map((s) => s.text).join('')
    const multiComplete =
      segs.length > 1 &&
      segs.every((s) => !!s.color) &&
      joined === t &&
      /:\d{1,5}$/.test(t)
    // IPv6-in-brackets + port (`[::]:8080`, `[fe80::1%18]:135`) is a finished
    // token whose bracket characters are intentionally left plain, so neither
    // singleComplete nor multiComplete is satisfied; emit it once the trailing
    // `:port` is present instead of holding the address uncolored forever.
    // Restricted to bracketed tokens: a BARE IPv6 hextet like `…:65d8` also ends
    // in `:\d` and must NOT be emitted as a port mid-address (which would split
    // the address into yellow time / orange number fragments).
    const portEnd = /[[\]]/.test(t) && /:\d{1,5}$/.test(t)
    const complete = singleComplete || multiComplete || portEnd
    this.pending = ''
    if (complete) return this.engine.colorize(t, this.curBase)
    return t
  }
}

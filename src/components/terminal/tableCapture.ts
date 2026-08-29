import { Terminal } from '@xterm/xterm'
import {
  TableSpec,
  colorizeTableLine,
  looksLikeTableHeader,
} from '../../lib/tableOutput'
import { stripAnsi } from '../../lib/termHighlight'

// ---- generic aligned-table highlight (df / ps / free / ss / mount / ...) ----

export const TABLE_CAPTURE_TIMEOUT_MS = 1500
export const TABLE_MAX_BYTES = 512 * 1024

export interface TableCaptureState {
  spec: TableSpec
  prompt: string
  /** Incomplete trailing row (no newline yet) carried into the next chunk. */
  partial: string
  /** Total rows written so far — row 0 is the header. */
  lineCount: number
  bytes: number
  done: boolean
  timeout: ReturnType<typeof setTimeout> | null
}

// Colorize and immediately write one table row. Row 0 of the capture is the
// header (bold + bright); every later row gets per-column role coloring.
// Writing each row as it arrives guarantees every row is colored consistently
// — there is no buffering/debounced rewrite that could leave some rows plain.
export const writeTableLine = (term: Terminal, c: TableCaptureState, raw: string) => {
  // Don't assume the very first captured line is the header. Commands like
  // `netstat -tnlp` emit an info line ("Active Internet connections...")
  // before the real column header. Skip leading non-header lines plain so the
  // actual header gets the uniform bold+bright style and the body gets role
  // coloring.
  if (c.lineCount === 0 && !looksLikeTableHeader(raw, c.spec)) {
    term.write(raw + '\r\n')
    return
  }
  const isHeader = c.lineCount === 0
  // stripAnsi already removed the PTY \r; emit \r\n so xterm returns to column 1.
  term.write(colorizeTableLine(raw, c.spec, isHeader) + '\r\n')
  c.lineCount++
}

export const feedTable = (term: Terminal, c: TableCaptureState, chunk: string, onEnd: () => void) => {
  if (c.done) return
  c.bytes += chunk.length

  if (c.bytes > TABLE_MAX_BYTES) {
    // Too big — stop capturing and dump the rest of the buffer uncolored.
    if (c.partial) {
      term.write(c.partial + '\r\n')
      c.partial = ''
    }
    term.write(stripAnsi(chunk))
    c.done = true
    onEnd()
    return
  }

  // Strip ANSI so a colored PS1 in the trailing prompt still matches `c.prompt`
  // (which is the plain prompt captured on Enter).
  const text = stripAnsi(chunk)

  // Detect the next prompt ending the table.
  let endIdx = -1
  if (c.prompt) {
    const pos = text.lastIndexOf(c.prompt)
    if (pos >= 0) endIdx = pos
  }

  const body = endIdx >= 0 ? text.slice(0, endIdx) : text
  const acc = c.partial + body
  c.partial = ''

  if (endIdx >= 0) {
    // Prompt present: every line in `acc` is a complete table row (the prompt
    // follows it). Colorize and write them all, then echo the prompt back.
    for (const ln of acc.split('\n')) {
      if (ln.length > 0) writeTableLine(term, c, ln)
    }
    term.write(text.slice(endIdx))
    c.done = true
    onEnd()
    return
  }

  // Streaming: split into complete rows, hold any trailing incomplete row.
  if (acc.length > 0) {
    if (acc.endsWith('\n')) {
      const lines = acc.split('\n')
      lines.pop() // drop trailing empty produced by the final '\n'
      for (const ln of lines) writeTableLine(term, c, ln)
    } else {
      const lines = acc.split('\n')
      if (lines.length > 1) {
        c.partial = lines.pop() as string // incomplete trailing row
        for (const ln of lines) writeTableLine(term, c, ln)
      } else {
        c.partial = lines[0] // whole thing is a not-yet-complete row
      }
    }
  }

  if (c.timeout) clearTimeout(c.timeout)
  c.timeout = setTimeout(() => {
    c.timeout = null
    if (c.partial) {
      writeTableLine(term, c, c.partial)
      c.partial = ''
    }
    c.done = true
    onEnd()
  }, TABLE_CAPTURE_TIMEOUT_MS)
}

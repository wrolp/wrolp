import { Terminal } from '@xterm/xterm'
import { preloadHighlightLanguages, stripAnsi } from '../../lib/termHighlight'

// ---- terminal output syntax highlight state machine (cat/head/tail) ----
//
// When the user runs `cat file.py`, we enter "capture" mode: output chunks are
// buffered (ANSI-stripped), complete lines are re-tokenized with Monaco and
// written with ANSI colors as they stream in, and the next shell prompt (or a
// silence timeout) ends the capture. Large outputs fall back to raw passthrough.

export interface CaptureState {
  lang: string
  /** Highlighter that colorizes the whole captured buffer (multi-line aware). */
  highlighter: (text: string) => string[]
  /** Plain-text shell prompt captured from the submitted command line. */
  prompt: string
  /** ANSI-stripped output accumulated since capture started. */
  buf: string
  /** Number of `buf` lines already written to the terminal (line 0 = echo). */
  writtenLines: number
  bytes: number
  timeout: ReturnType<typeof setTimeout> | null
  flushTimer: ReturnType<typeof setTimeout> | null
}

export const MAX_HIGHLIGHT_BYTES = 512 * 1024
export const CAPTURE_TIMEOUT_MS = 800
export const FLUSH_DEBOUNCE_MS = 40

let highlightLanguagesPreloaded = false

/** One-time eager load of the syntax highlight languages (idempotent). */
export function ensureHighlightLanguagesPreloaded(): void {
  if (highlightLanguagesPreloaded) return
  highlightLanguagesPreloaded = true
  preloadHighlightLanguages()
}

export function clearCaptureTimers(c: CaptureState): void {
  if (c.timeout) {
    clearTimeout(c.timeout)
    c.timeout = null
  }
  if (c.flushTimer) {
    clearTimeout(c.flushTimer)
    c.flushTimer = null
  }
}

/**
 * Write `buf` lines in the inclusive range `[from, to)`. Line 0 is the shell's
 * echo of the command and is written plainly; the rest are colorized. When
 * `trailingNewline` is true every written line is newline-terminated (used for
 * flushing complete lines only); otherwise only interior lines get the newline.
 */
export function writeRange(
  term: Terminal,
  c: CaptureState,
  content: string,
  from: number,
  to: number,
  trailingNewline: boolean,
): void {
  if (to <= from) return
  const lines = content.split('\n')
  const colored = c.highlighter(content)
  for (let i = from; i < to; i++) {
    term.write(i === 0 ? lines[0] : colored[i])
    if (trailingNewline || i < to - 1) term.write('\r\n')
  }
  c.writtenLines = to
}

/** Flush any new *complete* lines (buffered so far) as colored output. */
export function flushCapturedLines(term: Terminal, c: CaptureState): void {
  const completeCount = c.buf.split('\n').length - 1
  writeRange(term, c, c.buf, c.writtenLines, completeCount, true)
}

/** Colorize everything remaining and stop capturing; optionally append the prompt. */
export function finalizeCapture(term: Terminal, c: CaptureState, promptEnd: string | null): void {
  clearCaptureTimers(c)
  const content = promptEnd ? c.buf.slice(0, c.buf.length - promptEnd.length) : c.buf
  writeRange(term, c, content, c.writtenLines, content.split('\n').length, false)
  if (promptEnd) term.write(promptEnd)
}

/** Abort capture (over the size threshold): dump the unwritten tail raw. */
export function giveUpCapture(term: Terminal, c: CaptureState): void {
  clearCaptureTimers(c)
  const rest = c.buf.split('\n').slice(c.writtenLines).join('\r\n')
  if (rest.length > 0) term.write(rest)
}

/**
 * Feed one output chunk while capturing. `onEnd` is invoked (synchronously for
 * prompt/size endings, or later from the silence timeout) once capture has
 * ended, so the caller can drop the capture state and resume passthrough.
 */
export function feedCapture(term: Terminal, c: CaptureState, chunk: string, onEnd: () => void): void {
  c.buf += stripAnsi(chunk)
  c.bytes += chunk.length

  if (c.bytes > MAX_HIGHLIGHT_BYTES) {
    giveUpCapture(term, c)
    onEnd()
    return
  }

  if (c.prompt && c.buf.endsWith(c.prompt)) {
    finalizeCapture(term, c, c.prompt)
    onEnd()
    return
  }

  if (c.flushTimer) clearTimeout(c.flushTimer)
  c.flushTimer = setTimeout(() => {
    c.flushTimer = null
    flushCapturedLines(term, c)
  }, FLUSH_DEBOUNCE_MS)

  if (c.timeout) clearTimeout(c.timeout)
  c.timeout = setTimeout(() => {
    c.timeout = null
    finalizeCapture(term, c, null)
    onEnd()
  }, CAPTURE_TIMEOUT_MS)
}

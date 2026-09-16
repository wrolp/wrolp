/**
 * Hidden shell `pwd` query.
 *
 * The interactive shell's real cwd is the only reliable source: the prompt shows
 * at best a relative basename, and `poll_working_dir` runs `pwd` in a *fresh*
 * exec channel, which starts in $HOME rather than in the shell's cwd. So we inject
 * a marker-wrapped `pwd` into the shell, capture the result, and keep both the
 * echoed command and the result off the screen.
 *
 * Keeping them off the screen by matching the markers inside a *single* output
 * chunk does not work: output arrives split arbitrarily — SSH packetization, and
 * decisively here the shell's own line editor, which breaks the echoed line with
 * a real CRLF once it reaches the terminal's right margin. A chunk holding only
 * part of the echoed command therefore reached the screen verbatim, and the user
 * saw this in their terminal:
 *
 *     root@host:/tmp# echo "__WROLP_CWD_BEG_bfao5wru__$(pwd)__WROLP_CWD_END
 *     _y923n77y__"
 *
 * So the strip is a tiny state machine over the character stream instead:
 *
 *   1. the echoed command (`echo "<beg>$(pwd)<end>"`) is matched character by
 *      character and swallowed — tolerating CR/LF inserted by the line editor
 *      while wrapping, and restarting at every occurrence (readline repaints the
 *      line, so it can appear more than once);
 *   2. a `beg` marker starts a *result* line, swallowed up to `end` (and its
 *      trailing newline), with the text in between handed back as the cwd;
 *   3. anything that turns out not to be one of those is emitted unchanged, so
 *      ordinary output is never touched.
 *
 * Only small indices survive a chunk boundary. The range an in-progress attempt
 * already consumed is carried over with it (and skipped on the next chunk) so a
 * failed attempt can still be replayed verbatim — re-scanning that range would
 * feed the marker text into the state machine a second time.
 */

export interface StrippedChunk {
  /** The chunk with every hidden-query line removed. */
  text: string
  /** The cwd captured in this chunk, or null when no result line completed. */
  path: string | null
}

export interface CwdQueryStripper {
  /** Begin marker, e.g. `__WROLP_CWD_BEG_bfao5wru__`. */
  readonly beg: string
  /** End marker, e.g. `__WROLP_CWD_END_y923n77y__`. */
  readonly end: string
  /**
   * The exact text injected into the interactive shell (the caller appends the
   * newline). Built here so the stripper can never drift from what was sent.
   */
  readonly command: string
  /** Remove the hidden query from an output chunk (chunk-boundary safe). */
  strip(chunk: string): StrippedChunk
}

/**
 * Longest a hidden line may get before we stop believing in it. A real one is a
 * marker plus a path plus a marker (well under 200 chars); the cap only exists so
 * that a `beg` marker appearing in *ordinary* output cannot swallow the stream.
 */
const MAX_HIDDEN_LINE = 1024

function randomMarker(kind: 'BEG' | 'END'): string {
  return `__WROLP_CWD_${kind}_${Math.random().toString(36).slice(2, 10)}__`
}

const isCrLf = (ch: string): boolean => ch === '\r' || ch === '\n'

/**
 * A real cwd starts with `/`, `~` or a Windows drive. The echoed command's
 * `$(pwd)` text does not — so this is what rejects the literal `$(pwd)` should a
 * stray marker pair ever make an echo look like a result.
 */
function looksLikePath(s: string): boolean {
  return s.startsWith('/') || s.startsWith('~') || /^[A-Za-z]:[\\/]/.test(s)
}

/**
 * @param beg Begin marker (random when omitted — markers are per stripper, so a
 *   stale one from a previous session can never match).
 * @param end End marker (random when omitted).
 */
export function createCwdQueryStripper(
  beg: string = randomMarker('BEG'),
  end: string = randomMarker('END'),
): CwdQueryStripper {
  const command = `echo "${beg}$(pwd)${end}"`

  // --- State that survives a chunk boundary ---------------------------------
  let echoPos = 0 // chars of `command` matched in the current attempt
  let begPos = 0 // chars of `beg` matched in the current attempt
  let inResult = false // inside a result line, swallowing up to `end`
  let resultPos = 0 // chars of `end` matched inside that line
  let body = '' // result text seen between `beg` and `end`
  let swallowEol = false // a hidden line was swallowed — eat its line break too
  let carry = '' // undecided range handed over to the next chunk
  let carryConsumed = 0 // how many chars of `carry` the attempt already ate

  const strip = (chunk: string): StrippedChunk => {
    const text = carry + chunk
    carry = ''
    let out = ''
    let runStart = 0 // start of the range that will be emitted as-is
    let i = carryConsumed // skip what the carried attempt already consumed
    carryConsumed = 0
    let path: string | null = null

    /** Emit the undecided range up to `upto` (real output in front of an attempt). */
    const flush = (upto: number) => {
      if (upto > runStart) out += text.slice(runStart, upto)
      runStart = upto
    }

    /** Drop the undecided range up to `upto` — it proved to be a hidden line. */
    const dropUntil = (upto: number) => {
      runStart = upto
    }

    for (; i < text.length; ) {
      const ch = text[i]

      // 1. A hidden line was fully swallowed: also eat the line break that ended
      //    it, so the terminal does not gain a blank row in its place.
      if (swallowEol) {
        if (isCrLf(ch)) {
          dropUntil(i + 1)
          i++
          continue
        }
        swallowEol = false
      }

      // 2. Inside the echoed command, `command` matched up to `echoPos`.
      if (echoPos > 0) {
        if (ch === command[echoPos]) {
          echoPos++
          if (echoPos === command.length) {
            echoPos = 0
            swallowEol = true // its trailing quote is part of `command`
            dropUntil(i + 1)
          }
          i++
          continue
        }
        // The line editor wraps the echoed line with a hard CRLF at the right
        // margin; the echo continues on the next row, so neither the break nor
        // the text after it may be shown.
        if (isCrLf(ch)) {
          i++
          continue
        }
        // Not the echo after all (an `echo "…` in ordinary output): give the
        // pending range back — the next flush emits it — and handle this char
        // normally.
        echoPos = 0
      }

      // 3. Inside a result line: swallow until the end marker.
      if (inResult) {
        if (ch === end[resultPos]) {
          resultPos++
          if (resultPos === end.length) {
            inResult = false
            resultPos = 0
            swallowEol = true
            dropUntil(i + 1)
            if (looksLikePath(body)) path = body
            body = ''
          }
          i++
          continue
        }
        if (!isCrLf(ch)) body += ch
        if (body.length > MAX_HIDDEN_LINE) {
          // Too long to be a path — this was ordinary output that merely started
          // like our marker. Hand the pending range back.
          inResult = false
          resultPos = 0
          body = ''
        }
        i++
        continue
      }

      // 4. Half a begin marker: it must win over a fresh echo attempt, since the
      //    random part of a marker can itself contain the echo's first letter.
      if (begPos > 0) {
        if (ch === beg[begPos]) {
          begPos++
          if (begPos === beg.length) {
            begPos = 0
            inResult = true
            resultPos = 0
            body = ''
          }
          i++
          continue
        }
        // Half a marker that turned out to be something else — keep it as output
        // (it is still inside the pending range) and fall through for this char.
        begPos = 0
      }

      // 5. Start of the echoed command.
      if (ch === command[0]) {
        flush(i)
        echoPos = 1
        i++
        continue
      }

      // 6. Start of a marker — the result line.
      if (ch === beg[0]) {
        flush(i)
        begPos = 1
        i++
        continue
      }

      // 7. Ordinary output: just extend the pending range.
      i++
    }

    // A pending attempt continues in the next chunk (carrying the range it already
    // consumed, so it is not scanned twice); everything before it is real output
    // and goes out now.
    if (echoPos > 0 || begPos > 0 || inResult) {
      carry = text.slice(runStart)
      carryConsumed = i - runStart
    } else {
      out += text.slice(runStart)
    }
    return { text: out, path }
  }

  return { beg, end, command, strip }
}

/**
 * Terminal line numbers (the left gutter).
 *
 * xterm.js has no gutter/line-number API at all (5.5: `registerDecoration` paints
 * *inside* `.xterm-screen`, overlapping the text), so the column is drawn by us next
 * to the terminal and kept in sync from `term.onRender` — xterm repaints its rows on
 * every scroll and every write, so "which label belongs to which screen row" can only
 * be answered by reading the buffer at render time.
 *
 * The label math lives here as pure functions so it can be pinned without an xterm
 * instance (same pattern as `wrapDetect.ts`).
 */

import type { IBuffer } from '@xterm/xterm'

/**
 * What a wrapped line's continuation rows can show instead of a number, keyed by the
 * value stored in the appearance registry (`terminal.continuationSymbol`) so the
 * settings page and the AI bridge have a stable, ASCII-safe contract. The glyph —
 * not the id — is what `computeRowLabels` receives.
 */
export const CONTINUATION_SYMBOLS = {
  /** The mark printed on an Enter key (U+21B5). */
  return: '↵',
  /** Hooked right arrow: "this row is the line above, continued" — the default. */
  arrow: '↪',
  dash: '-',
  /** Nothing at all (the pre-configuration behaviour). */
  none: '',
} as const

export type ContinuationSymbolId = keyof typeof CONTINUATION_SYMBOLS

/** Registry value → glyph to draw; unknown or missing falls back to the default. */
export function continuationGlyph(value: unknown): string {
  const id = String(value ?? '')
  return Object.prototype.hasOwnProperty.call(CONTINUATION_SYMBOLS, id)
    ? CONTINUATION_SYMBOLS[id as ContinuationSymbolId]
    : CONTINUATION_SYMBOLS.arrow
}

/**
 * The label to show for each viewport row, top to bottom: the line number, the
 * continuation marker, or `null` for "nothing on this row".
 *
 * Numbers are **absolute** (1-based, scrollback included): scrolling up shows the
 * smaller numbers of the history and output arriving below does not renumber the
 * lines already on screen. A wrapped line only numbers its first row and marks the
 * rest with `continuation` — the user sees one logical line, so the markers show which
 * physical rows it spans (an empty string means the user turned the marker off).
 *
 * Rows **below the last line of output** are not lines yet (a fresh session, or right
 * after `clear`) and get no label at all.
 *
 * `viewportY` is already the absolute buffer line sitting on the top screen row
 * ("the line within the buffer where the top of the viewport is"), so the number for
 * row `r` is simply `viewportY + r + 1` — do NOT add `baseY` as well (that is the
 * bottom page's top line, i.e. a second, unrelated absolute index). `baseY` is only
 * used to tell "at the bottom" from "scrolled back" for the blank-tail rule.
 */
export function computeRowLabels(
  buf: Pick<IBuffer, 'viewportY' | 'baseY' | 'getLine'>,
  rows: number,
  continuation: string = CONTINUATION_SYMBOLS.arrow,
): (number | string | null)[] {
  const top = buf.viewportY
  // Where the content ends on this screen. Only meaningful while the view sits at the
  // bottom: scrolled back into the scrollback there is nothing "below the content" on
  // screen, and the blank rows there are real (empty) history lines that keep their
  // numbers. Scanning up from the bottom costs one row in practice (the prompt line).
  let contentEnd = rows - 1
  if (top >= buf.baseY) {
    for (; contentEnd >= 0; contentEnd--) {
      const line = buf.getLine(top + contentEnd)
      if (line && line.translateToString(true).length > 0) break
    }
  }
  const labels: (number | string | null)[] = []
  for (let r = 0; r < rows; r++) {
    const line = buf.getLine(top + r)
    if (!line || r > contentEnd) {
      // Past the buffer's end, or an unwritten row below the last line of output.
      labels.push(null)
    } else if (line.isWrapped) {
      labels.push(continuation)
    } else {
      labels.push(top + r + 1)
    }
  }
  return labels
}

/**
 * How many digits the gutter must fit for a buffer holding `lines` rows.
 *
 * The caller only ever grows its width with this value: the width change narrows the
 * terminal and therefore triggers a `fit()` + SIGWINCH, which re-flows whatever runs
 * on the other end — worth doing when the count gains a digit, not when the scrollback
 * prunes and it would shrink back again.
 */
export function lineNumberDigits(lines: number): number {
  // 2 so a short buffer does not sit in a single-character-wide column.
  return Math.max(2, String(Math.max(1, Math.floor(lines))).length)
}

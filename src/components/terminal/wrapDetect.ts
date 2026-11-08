// Pure decision helpers for the input-line recoloring chain (see
// `promptLine.ts`). They are split out with no imports so they can be unit
// tested without an xterm instance.
//
// Background (task/BUGS.md B25): reading the logical input line has to walk
// BACK over wrapped continuation rows, and xterm only sets a row's `isWrapped`
// flag once something is written to the row BELOW it. Two heuristics used to
// compensate for that un-flagged window, but both applied unconditionally:
//
//   - the length fallback (`prevVisibleLength >= cols`) merged a *full-width
//     output row* above the caret into the input line, and
//   - the length-derived top row then pushed the redraw further up.
//
// Together they made the recolor erase the previous output row (incomplete
// echo, backspace leaving residue). Both are now limited to the one state they
// were written for: the caret sitting at column 0 of a row it has just spilled
// onto.

/**
 * Column width of `text`, measured with the terminal's own cell widths.
 *
 * Characters are NOT columns: `桌面` is two characters and four cells, so every
 * offset in the input-line chain (how far past the prompt the command starts, how
 * wide the logical line is, where the caret has to end up) is cell arithmetic.
 * Using the character count instead moved a rewrite two cells too few and erased
 * the prompt's own `#` on a Chinese prompt.
 *
 * `cellWidthAt` answers the width of the cell at a column — 2 on the first cell
 * of a wide character, 0 on its second — which is what the buffer reports for
 * what is actually drawn, so the answer follows xterm's width table rather than a
 * copy of it. A missing cell counts as 1, i.e. the plain character count.
 */
export function columnsOfText(
  text: string,
  cellWidthAt: (column: number) => number,
  startColumn = 0,
): number {
  let col = startColumn
  for (const _ of text) {
    const w = cellWidthAt(col)
    col += w > 0 ? w : 1
  }
  return col - startColumn
}

/** Inputs for {@link isWrappedContinuation}. */
export interface WrapContinuationArgs {
  /** Caret column on the row currently being read. */
  cursorX: number
  /** True while reading the caret's own row (the first read). */
  isFirstStep: boolean
  /** xterm's `isWrapped` flag on the row above. */
  prevIsWrapped: boolean
  /** Display columns of the row above (see {@link columnsOfText}). */
  prevVisibleLength: number
  cols: number
}

/**
 * Whether the row above the one being read is a wrapped continuation of the
 * same logical line.
 *
 * `isWrapped` is authoritative. The length fallback only stands in for it in
 * the fresh-wrap state — caret at column 0 with nothing typed on the new row
 * yet — where a full-width row above really is our wrapped head. Anywhere else
 * a full-width row above is unrelated output and must not be merged.
 */
export function isWrappedContinuation(args: WrapContinuationArgs): boolean {
  if (args.prevIsWrapped) return true
  return args.isFirstStep && args.cursorX === 0 && args.prevVisibleLength >= args.cols
}

/** Inputs for {@link canRecolorInPlace}. */
export interface RecolorInPlaceArgs {
  /** Rows between the caret's row and the logical line's top row (0 = single row). */
  rowOffset: number
  /** Display columns of prompt + command (see {@link columnsOfText}). */
  logicalLen: number
  cols: number
  cursorX: number
}

/**
 * Whether the input line may be recolored IN PLACE (rewrite just the command
 * after the prompt, then clear to end of line).
 *
 * That rewrite is only safe while the whole logical line occupies a single row:
 * repainting a wrapped line needs the cursor moved up and rows cleared, which
 * repeatedly corrupted the screen — erased the previous output row, left
 * residue behind after backspace, and dropped the echoed tail (task/BUGS.md
 * B25 and its follow-ups). The shell's line editor already redraws a wrapped
 * line correctly as it grows/shrinks, so we simply leave those alone.
 */
export function canRecolorInPlace(args: RecolorInPlaceArgs): boolean {
  return args.rowOffset === 0 && args.cursorX !== 0 && args.logicalLen <= args.cols
}

/** Inputs for {@link logicalTopRow}. */
export interface LogicalTopRowArgs {
  /** Cursor's physical row (absolute buffer index). */
  lastRow: number
  /** Top row implied by walking the `isWrapped` chain up from `lastRow`. */
  chainTopRow: number
  /** Display columns of prompt + command (see {@link columnsOfText}). */
  logicalLen: number
  cols: number
  /** Caret column — the length correction is only valid in the fresh-wrap state. */
  cursorX: number
}

/**
 * Top physical row of the logical input line.
 *
 * The `isWrapped` chain wins unless the caret is in the fresh-wrap state, where
 * the chain has not caught up yet and the logical length is the only source.
 * The correction may therefore only ever be applied in that state — otherwise
 * an over-estimated length would move the redraw up into unrelated output.
 */
export function logicalTopRow(args: LogicalTopRowArgs): number {
  const { lastRow, chainTopRow, logicalLen, cols, cursorX } = args
  if (cursorX !== 0) return chainTopRow
  const expected = logicalLen > 0 ? lastRow - Math.floor((logicalLen - 1) / cols) : lastRow
  return expected < chainTopRow ? expected : chainTopRow
}

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

/** Inputs for {@link isWrappedContinuation}. */
export interface WrapContinuationArgs {
  /** Caret column on the row currently being read. */
  cursorX: number
  /** True while reading the caret's own row (the first read). */
  isFirstStep: boolean
  /** xterm's `isWrapped` flag on the row above. */
  prevIsWrapped: boolean
  /** Visible (ANSI-stripped) length of the row above. */
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
  /** `prompt.length + command.length` (ANSI-stripped). */
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
  /** `prompt.length + command.length` (ANSI-stripped). */
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

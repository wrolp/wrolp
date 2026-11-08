import { test, expect } from './helpers/fixtures'
import {
  canRecolorInPlace,
  columnsOfText,
  isWrappedContinuation,
  logicalTopRow,
} from '../../src/components/terminal/wrapDetect'

// B25: reading/recoloring the logical input line must not swallow the previous
// OUTPUT row. `wrapDetect` holds that decision as pure functions so it can be
// pinned here without an xterm instance.

test.describe('input-line wrap detection (B25)', () => {
  // A prompt holding wide characters is shorter than it is wide, and every offset
  // in the recolor chain ran on the character count — which moved the rewrite two
  // cells too few and erased the prompt's own `#` (Chinese prompt, after a command).
  test('width is counted in cells, not characters', () => {
    // `A桌B`: 3 characters, 1 + 2 + 1 cells.
    expect(columnsOfText('A桌B', (col) => (col === 1 ? 2 : 1))).toBe(4)
    // A wide character's trailing cell is width 0 and must not be stepped onto.
    // Cells for `桌a`: leading half 2, trailing half 0, then `a` 1.
    const cells = [2, 0, 1]
    expect(columnsOfText('桌a', (col) => cells[col] ?? 1)).toBe(3)
    // Offsets are measured from a start column (the command after the prompt).
    expect(columnsOfText('ls', () => 1, 4)).toBe(2)
    // No cell to read (past the row) falls back to one column per character.
    expect(columnsOfText('abc', () => 0)).toBe(3)
    expect(columnsOfText('', () => 1, 7)).toBe(0)
  })

  test('a full-width row above is NOT merged while the caret is mid-line', () => {
    // The regression: caret after the prompt (column 12) with a full-width
    // output row above — that row is output, not our wrapped head.
    expect(
      isWrappedContinuation({
        cursorX: 12,
        isFirstStep: true,
        prevIsWrapped: false,
        prevVisibleLength: 120,
        cols: 120,
      }),
    ).toBe(false)
  })

  test('xterm`s isWrapped flag always wins', () => {
    expect(
      isWrappedContinuation({
        cursorX: 5,
        isFirstStep: true,
        prevIsWrapped: true,
        prevVisibleLength: 3,
        cols: 120,
      }),
    ).toBe(true)
    // …even on a later step of the walk.
    expect(
      isWrappedContinuation({
        cursorX: 0,
        isFirstStep: false,
        prevIsWrapped: true,
        prevVisibleLength: 0,
        cols: 120,
      }),
    ).toBe(true)
  })

  test('the length fallback only covers the fresh-wrap state', () => {
    // Caret at column 0 of a row it just spilled onto → a full-width row above
    // really is the wrapped head.
    expect(
      isWrappedContinuation({
        cursorX: 0,
        isFirstStep: true,
        prevIsWrapped: false,
        prevVisibleLength: 120,
        cols: 120,
      }),
    ).toBe(true)
    // Never on a later step…
    expect(
      isWrappedContinuation({
        cursorX: 0,
        isFirstStep: false,
        prevIsWrapped: false,
        prevVisibleLength: 120,
        cols: 120,
      }),
    ).toBe(false)
    // …and a short row is never a wrapped head.
    expect(
      isWrappedContinuation({
        cursorX: 0,
        isFirstStep: true,
        prevIsWrapped: false,
        prevVisibleLength: 10,
        cols: 120,
      }),
    ).toBe(false)
  })

  test('only a single-row input line is recolored in place', () => {
    // Single row, caret after the prompt → safe to rewrite in place.
    expect(canRecolorInPlace({ rowOffset: 0, logicalLen: 40, cols: 120, cursorX: 40 })).toBe(true)
    // Wrapped (2 rows) → never repaint.
    expect(canRecolorInPlace({ rowOffset: 1, logicalLen: 200, cols: 120, cursorX: 80 })).toBe(false)
    // Fresh wrap: caret at column 0 with the whole line still on one flagged row.
    expect(canRecolorInPlace({ rowOffset: 0, logicalLen: 120, cols: 120, cursorX: 0 })).toBe(false)
    // Longer than one row even though the wrap isn't flagged yet.
    expect(canRecolorInPlace({ rowOffset: 0, logicalLen: 121, cols: 120, cursorX: 1 })).toBe(false)
    // Exactly one full row is fine (xterm lets the cursor sit past the last cell).
    expect(canRecolorInPlace({ rowOffset: 0, logicalLen: 120, cols: 120, cursorX: 120 })).toBe(true)
  })

  test('the length-derived top row may only correct a fresh wrap', () => {
    // Typing (`cursorX > 0`): the isWrapped chain is authoritative even when the
    // logical length suggests the line starts higher up.
    expect(
      logicalTopRow({ lastRow: 10, chainTopRow: 10, logicalLen: 300, cols: 100, cursorX: 20 }),
    ).toBe(10)
    // Fresh wrap (`cursorX === 0`): the length is the only source, so it may
    // correct upward.
    expect(
      logicalTopRow({ lastRow: 10, chainTopRow: 10, logicalLen: 300, cols: 100, cursorX: 0 }),
    ).toBe(8)
    // Never moves below the chain's answer.
    expect(
      logicalTopRow({ lastRow: 10, chainTopRow: 8, logicalLen: 50, cols: 100, cursorX: 0 }),
    ).toBe(8)
  })
})

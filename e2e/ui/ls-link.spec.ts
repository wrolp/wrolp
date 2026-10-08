import { test, expect } from '@playwright/test'
import { pickLsLinkEntry, type LsLinkCandidate } from '../../src/components/terminal/lsCapture'

// Which listing a link is built from when two listings put the same name on the
// screen.
//
// Clickable `ls` output is matched against the TEXT of the hovered row (not the
// row an entry was stored under), so that a link survives scrolling and the few
// rows of drift a wrapped or redrawn listing introduces. The cost is that two
// listings of two different directories both match when they contain a file of
// the same name — and xterm takes the FIRST link covering the cursor
// (`Linkifier`: `links.find(…)`), i.e. the listing stored first, i.e. the older
// one. Clicking `report.csv` in the second listing then opened the first
// listing's `report.csv`.

/** `row` is a row of the entry's own listing; `order` grows with each listing. */
const cand = (name: string, row: number, order: number): LsLinkCandidate<{ name: string }> => ({
  entry: { name },
  row,
  order,
})

test('the name on the hovered row belongs to the listing that row is from', () => {
  // `/srv/a` listed first (row 40), then `/srv/b` (row 61) — both hold
  // `report.csv`, and the pointer is over the second listing's row.
  const cands = [cand('report.csv', 40, 1), cand('report.csv', 61, 2)]
  expect(pickLsLinkEntry(cands, 61)?.row).toBe(61)
  // And over the first listing's row, the first listing wins.
  expect(pickLsLinkEntry(cands, 40)?.row).toBe(40)
})

test('a row that drifted a little still beats a listing further away', () => {
  // `resolveLsRow` may have parked the newer entry a row or two off; the older
  // listing is a whole block away, so proximity still names the right one.
  expect(pickLsLinkEntry([cand('notes.txt', 12, 1), cand('notes.txt', 30, 2)], 32)?.row).toBe(30)
})

test('an exact row tie goes to the newer listing', () => {
  // Two listings that ended up on one row: what the user sees there is the
  // listing that was just printed.
  expect(pickLsLinkEntry([cand('a.txt', 20, 1), cand('a.txt', 20, 2)], 20)?.order).toBe(2)
})

test('there is always a winner, and never none', () => {
  expect(pickLsLinkEntry([], 10)).toBeNull()
  expect(pickLsLinkEntry([cand('x', 5, 1)], 99)?.row).toBe(5)
})

// Regression tests for the output category highlighter on log-shaped text
// (BUGS.md B48): the port rule must not fire on `file.c:393` source locations or
// on `image:1.26.2` docker tags, and the time rule must capture microseconds.
import { test, expect } from './helpers/fixtures'
import { compileHighlighter, cloneDefaultConfig } from '../../src/lib/highlightRules'

const engine = compileHighlighter(cloneDefaultConfig().rules, cloneDefaultConfig().custom)
// The colored segments only (plain text has no `color`).
const colored = (t: string) => engine.annotate(t).filter((s) => s.color)

test('port is not matched on a source-file line reference', () => {
  // `mod_signalwire.c:393` — `:393` is a line number, not a port. The port token
  // always carries the leading `:`; assert no colored token includes it. (`393`
  // alone may still read as a plain number — that is fine, it is not a port.)
  expect(colored('mod_signalwire.c:393').some((s) => s.text.includes(':'))).toBe(false)
})

test('port is not matched on an image:version tag', () => {
  // `nginx:1.26.2` — the `1.26.2` is a version; the leading `:1` must not be a port.
  const segs = colored('nginx:1.26.2')
  expect(segs.some((s) => s.text.includes(':'))).toBe(false)
  // and the version itself is still recognized.
  expect(segs.some((s) => s.text === '1.26.2')).toBe(true)
})

test('a real port still matches', () => {
  expect(colored('listen on :8080').some((s) => s.text.includes('8080'))).toBe(true)
  expect(colored('connect myhost:5432 now').some((s) => s.text.includes('5432'))).toBe(true)
})

test('time captures sub-second precision', () => {
  // `02:50:57.826352` must be one time token, not `02:50:57` + a stray `.826352`.
  const segs = colored('log at 02:50:57.826352 done')
  expect(segs.some((s) => s.text === '02:50:57.826352')).toBe(true)
})

test('an ISO date-time stamp is one date-colored token', () => {
  // `2026-09-19 08:06:10.086370` must be a SINGLE token (date color), not a
  // date-colored `2026-09-19` plus a separately-colored time.
  const segs = colored('2026-09-19 08:06:10.086370 92.03%')
  expect(segs.some((s) => s.text === '2026-09-19 08:06:10.086370')).toBe(true)
  // and there is no standalone time token left over.
  expect(segs.some((s) => s.text === '08:06:10.086370')).toBe(false)
})

test('a decimal percentage is one number-colored token', () => {
  // `92.03%` (docker stats CPU/mem) must be a single token, not a version-colored
  // `92.03` plus a stray `%`.
  const segs = colored('CPU 92.03% MEM 7.5%')
  expect(segs.some((s) => s.text === '92.03%')).toBe(true)
  expect(segs.some((s) => s.text === '7.5%')).toBe(true)
  // no bare-version fragment left, and no unjoined `92.03` without the percent.
  expect(segs.some((s) => s.text === '92.03')).toBe(false)
})

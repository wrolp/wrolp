// Regression tests for the netstat tcp6 address column (BUGS.md B59).
//
// netstat glues the Local Address cell as `<addr><port>`, and an IPv6 address
// that ends in its own `::` supplies the separator — so `2408:8215:2a:65c1::5080`
// is *also* a legal IPv6 whose last hextet is `5080`. The port may only be split
// off inside a socket-table row; the B23 wildcard form (`:::8021`) was already
// handled, this covers the non-wildcard one.
import { test, expect } from './helpers/fixtures'
import { AnsiHighlighter } from '../../src/components/terminal/highlightStream'
import { cloneDefaultConfig } from '../../src/lib/highlightRules'

const cfg = cloneDefaultConfig()
const colorOf = Object.fromEntries(cfg.rules.map((r) => [r.key, r.color]))

/** The SGR the streamer puts in front of a segment painted with `hex`. */
const sgr = (hex: string) => {
  const n = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  return `\x1b[38;2;${n[0]};${n[1]};${n[2]}m`
}
const ipSgr = sgr(colorOf.ip)
const portSgr = sgr(colorOf.port)
const stripSgr = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')

const ADDR = '2408:8215:2a:65c1::'
const ROW = `tcp6       0      0 ${ADDR}5080 :::*                    LISTEN`

test('a tcp6 row colors the address and its port differently', () => {
  const hl = new AnsiHighlighter(cfg)
  const out = hl.push(`${ROW}\r\n`) + hl.flush()
  expect(stripSgr(out)).toBe(`${ROW}\r\n`)
  expect(out).toContain(`${ipSgr}${ADDR}`)
  expect(out).toContain(`${portSgr}5080`)
  // The B23 wildcard row keeps working unchanged.
  const wild = new AnsiHighlighter(cfg)
  const wildOut = wild.push('tcp6       0      0 :::8021                :::*\r\n') + wild.flush()
  expect(wildOut).toContain(`${portSgr}:8021`)
})

test('a row whose head arrived in an earlier chunk still splits', () => {
  // The chunk boundary drops the `tcp6` prefix, so the wildcard Foreign Address
  // cell is what marks the row. This is the shape ConPTY/SSH actually delivers
  // when a token is held back and re-prefixed on the next push.
  const hl = new AnsiHighlighter(cfg)
  const out =
    hl.push('tcp6       0      0 ') +
    hl.push(`${ADDR}5080 :::*                    LISTEN\r\n`) +
    hl.flush()
  expect(stripSgr(out)).toBe(`${ROW}\r\n`)
  expect(out).toContain(`${portSgr}5080`)
})

test('the same address outside a socket row keeps the digits as address', () => {
  for (const line of [
    `${ADDR}5080`,
    'ping 2408:8215:2a:65c1::5080 ok',
    'tcp6 0 0 2001:db8::1:8080 :::* LISTEN',
  ]) {
    const hl = new AnsiHighlighter(cfg)
    const out = hl.push(`${line}\r\n`) + hl.flush()
    expect(out).not.toContain(`${portSgr}5080`)
    expect(out).not.toContain(`${portSgr}8080`)
    expect(stripSgr(out)).toBe(`${line}\r\n`)
  }
})

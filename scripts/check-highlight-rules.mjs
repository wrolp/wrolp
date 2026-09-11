// Self-check for the terminal output highlighting patterns (B23 + regressions).
//
// Run with:  node scripts/check-highlight-rules.mjs
//
// Node ≥ 22.18 can import TypeScript directly (type stripping). highlightRules.ts
// is side-effect free (no DOM/localStorage at module load), so it imports cleanly.

import assert from 'node:assert/strict'
import { cloneDefaultConfig, compileHighlighter } from '../src/lib/highlightRules.ts'

let checks = 0
function check(name, fn) {
  fn()
  checks += 1
  console.log(`  ok  ${name}`)
}

const cfg = cloneDefaultConfig()
const colorOf = Object.fromEntries(cfg.rules.map((r) => [r.key, r.color]))
const engine = compileHighlighter(cfg.rules, cfg.custom)

const ipColor = colorOf.ip
const portColor = colorOf.port
const numberColor = colorOf.number

/** Annotated segments (text + hex color, undefined for plain runs). */
const segs = (text) => engine.annotate(text).map((s) => ({ text: s.text, color: s.color }))
const hasColor = (text, c) => segs(text).some((s) => s.color === c)
/** Color of the FIRST segment that is EXACTLY `sub` (throws when there is none). */
function colorAt(text, sub) {
  const seg = segs(text).find((s) => s.text === sub)
  assert.ok(seg, `no segment "${sub}" in ${JSON.stringify(text)} → ${JSON.stringify(segs(text))}`)
  return seg.color
}

// ---------------------------------------------------------------------------
// B23 — netstat tcp6 `:::<port>` splits into `::` (address) + `:<port>` (port).
// ---------------------------------------------------------------------------
const PORTS = ['22', '8086', '2424', '5432', '8090', '9092', '48080', '50000', '15236']
for (const d of PORTS) {
  check(`:::${d} → :: (IPv6) + :${d} (port)`, () => {
    assert.equal(colorAt(`:::${d}`, '::'), ipColor)
    assert.equal(colorAt(`:::${d}`, `:${d}`), portColor)
  })
}
check(':::* → :: (IPv6) + :* (plain)', () => {
  assert.equal(colorAt(':::*', '::'), ipColor)
  assert.equal(colorAt(':::*', ':*'), undefined)
})
check(':::ssh → :: (IPv6) + :ssh (plain, no port color)', () => {
  assert.equal(colorAt(':::ssh', '::'), ipColor)
  assert.equal(colorAt(':::ssh', ':ssh'), undefined)
})
check('tcp6 rows split consistently for 4- and 5-digit ports', () => {
  for (const [row, portField] of [
    ['tcp6  0  0 :::8086   :::*   LISTEN', ':8086'],
    ['tcp6  0  0 :::48080  :::*   LISTEN', ':48080'],
  ]) {
    // Both the local (`:::8086`) and the foreign (`:::*`) `::` are address-colored.
    assert.ok(
      segs(row).some((s) => s.text === '::' && s.color === ipColor),
      `no :: ip segment in ${JSON.stringify(row)}`,
    )
    // Exactly ONE port-colored run: the local port. (`:*` stays plain and is
    // merged into the trailing whitespace/LISTEN run by mergePlainUnits.)
    assert.deepEqual(
      segs(row)
        .filter((s) => s.color === portColor)
        .map((s) => s.text),
      [portField],
    )
  }
})

// ---------------------------------------------------------------------------
// Regressions — real IPv6 / IPv4 / MAC must keep their coloring.
// ---------------------------------------------------------------------------
check('::1 stays IPv6', () => assert.equal(colorAt('::1', '::1'), ipColor))
check(':: stays IPv6', () => assert.equal(colorAt(':: ', '::'), ipColor))
check('fe80::1 stays IPv6', () => assert.equal(colorAt('fe80::1', 'fe80::1'), ipColor))
check('fe80::1%18 (zone) stays IPv6', () =>
  assert.equal(colorAt('fe80::1%18', 'fe80::1%18'), ipColor),
)
check('2001:db8::1 stays IPv6', () => assert.equal(colorAt('2001:db8::1', '2001:db8::1'), ipColor))
check('::ffff:127.0.0.1 (v4-mapped) stays IPv6', () =>
  assert.equal(colorAt('::ffff:127.0.0.1', '::ffff:127.0.0.1'), ipColor),
)
check('2001:db8::/64 (CIDR) stays IPv6', () =>
  assert.equal(colorAt('2001:db8::/64', '2001:db8::/64'), ipColor),
)
check('::1:8080 (real address) stays one IPv6 token', () =>
  assert.equal(colorAt('::1:8080', '::1:8080'), ipColor),
)
check('[::1]:8086 splits into ::1 (IPv6) + :8086 (port)', () => {
  assert.equal(colorAt('[::1]:8086', '::1'), ipColor)
  assert.equal(colorAt('[::1]:8086', ':8086'), portColor)
})
check('IPv4:port splits into address + port', () => {
  assert.equal(colorAt('0.0.0.0:8086', '0.0.0.0'), ipColor)
  assert.equal(colorAt('0.0.0.0:8086', ':8086'), portColor)
})
check('IPv4 wildcard-port stays address-colored only', () => {
  assert.equal(colorAt('0.0.0.0:*', '0.0.0.0'), ipColor)
  assert.equal(colorAt('0.0.0.0:*', ':*'), undefined)
})
check('IPv4 CIDR stays address-colored', () =>
  assert.equal(colorAt('192.168.33.100/24', '192.168.33.100/24'), ipColor),
)
check('MAC stays MAC-colored', () =>
  assert.equal(colorAt('aa:bb:cc:dd:ee:ff', 'aa:bb:cc:dd:ee:ff'), colorOf.mac),
)
check('a malformed `x:::8086` (word-glued) is not read as an address', () => {
  assert.equal(hasColor('x:::8086', ipColor), false)
  assert.equal(colorAt('x:::8086', '8086'), numberColor)
})
check('a full IPv4 netstat row still splits ip + port', () => {
  assert.equal(colorAt('tcp  0  0 0.0.0.0:8086  0.0.0.0:*  LISTEN', '0.0.0.0'), ipColor)
})

console.log(`\n${checks} checks passed`)

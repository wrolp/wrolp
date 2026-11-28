import { test, expect } from './helpers/fixtures'
import { highlightPlainLog } from '../../src/ansi'

// Heuristic colouring for plain (non-ANSI) logs, shared by the Kubernetes and
// Docker log views. The patterns have to recognise the shapes real workloads
// emit — ISO timestamps were the only form the first version knew, so logfmt /
// JSON levels (`level=info`, `"level":"error"`) and the nginx/syslog/Apache
// timestamp formats came out monochrome.

const TS = '<span style="color:#61afef">'
const INFO = '<span style="color:#98c379;font-weight:bold">'
const WARN = '<span style="color:#e5c07b;font-weight:bold">'
const ERROR = '<span style="color:#e06c75;font-weight:bold">'
const NOTICE = '<span style="color:#56b6c2;font-weight:bold">'
const JSON_WRAP = '<span class="dlv-log-json">'

test('ISO timestamps and upper-case levels keep their colour', () => {
  expect(highlightPlainLog('2026-09-13T10:02:11Z INFO app up')).toBe(
    `${TS}2026-09-13T10:02:11Z </span>${INFO}INFO</span> app up`,
  )
  // The bracketed Log4j/Java form was already supported; keep it pinned.
  expect(highlightPlainLog('[2026-08-07 19:48:06,008] WARN slow')).toBe(
    `${TS}[2026-08-07 19:48:06,008] </span>${WARN}WARN</span> slow`,
  )
})

test('logfmt and JSON level pairs colour the value, not the key', () => {
  expect(highlightPlainLog('time=2026-11-28T10:00:00Z level=info msg="started"')).toBe(
    `time=2026-11-28T10:00:00Z level=${INFO}info</span> msg="started"`,
  )
  expect(highlightPlainLog('{"level":"error","msg":"boom"}')).toBe(
    `${JSON_WRAP}{"level":"${ERROR}error</span>","msg":"boom"}</span>`,
  )
})

test('bracketed levels are case-insensitive, including Apache module tags', () => {
  expect(highlightPlainLog('[warn] disk almost full')).toBe(
    `${JSON_WRAP}[${WARN}warn</span>] disk almost full</span>`,
  )
  // The module prefix stays default-coloured — only the level word is tinted.
  expect(highlightPlainLog('[core:error] file not found')).toBe(
    `${JSON_WRAP}[core:${ERROR}error</span>] file not found</span>`,
  )
})

test('nginx, syslog and Apache timestamps are recognised', () => {
  // nginx access log: the CLF timestamp sits mid-line, after the remote addr.
  expect(
    highlightPlainLog('10.0.0.1 - - [28/Nov/2026:10:00:00 +0800] "GET / HTTP/1.1" 200 612'),
  ).toBe(
    `${JSON_WRAP}10.0.0.1 - - ${TS}[28/Nov/2026:10:00:00 +0800]</span> "GET / HTTP/1.1" 200 612</span>`,
  )
  // nginx error log: leading `YYYY/MM/DD` timestamp plus a bracketed level.
  expect(highlightPlainLog('2026/11/28 10:00:00 [error] 42#42: *1 open() failed')).toBe(
    `${JSON_WRAP}${TS}2026/11/28 10:00:00</span> [${ERROR}error</span>] 42#42: *1 open() failed</span>`,
  )
  // Classic syslog: space-padded single-digit day.
  expect(highlightPlainLog('Nov  8 10:00:00 web-01 app[42]: started')).toBe(
    `${JSON_WRAP}${TS}Nov  8 10:00:00</span> web-01 app[42]: started</span>`,
  )
  // Apache error log: weekday timestamp and a module-tagged level.
  expect(highlightPlainLog('[Fri Nov 28 10:00:00.123456 2026] [core:notice] ready')).toBe(
    `${JSON_WRAP}${TS}[Fri Nov 28 10:00:00.123456 2026]</span> [core:${NOTICE}notice</span>] ready</span>`,
  )
})

test('overlapping detectors produce a single span', () => {
  // The keyed detector and the bare upper-case detector both match `INFO`.
  expect(highlightPlainLog('level=INFO ready')).toBe(`level=${INFO}INFO</span> ready`)
  // Bracket and bare match the same word inside `[INFO]`.
  expect(highlightPlainLog('[INFO] ready')).toBe(`${JSON_WRAP}[${INFO}INFO</span>] ready</span>`)
})

test('markup is escaped and non-matching text is left alone', () => {
  const html = highlightPlainLog('{"level":"error","msg":"<script>alert(1)</script>"}')
  expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  expect(html).not.toContain('<script>')

  // No pattern matched: no markup is invented.
  expect(highlightPlainLog('plain text, nothing to colour')).toBeNull()
  // Lower-case prose must not turn red — bare words are upper-case-only.
  expect(highlightPlainLog('an error happened')).toBeNull()
  // ANSI input is the ANSI parser's job, not the heuristic's.
  expect(highlightPlainLog('\x1b[32mlevel=info\x1b[0m')).toBeNull()
})

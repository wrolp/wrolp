// Self-check for the `cd` directory dropdown's pure functions
// (plan: task/plans/cd-directory-dropdown-plan.md, phase P0).
//
// Run with:  node tests/check-cd-suggest.mjs
//
// Node >= 23 strips TypeScript types natively, so the pure module is imported
// directly — which is why it is kept dependency-free (see cdSuggest.ts). Every
// branch below is asserted without a browser, xterm or PTY: that is what makes
// the "echo lags one keystroke" trap testable at all.

import assert from 'node:assert/strict'
import {
  CD_MAX_CANDIDATES,
  CdListCache,
  applyKeystroke,
  buildCdCandidates,
  cdCacheKey,
  cdCommandFor,
  clearLineBytes,
  isCdSupported,
  isHistoryRecall,
  joinCdPath,
  parentDirOf,
  parseCdInput,
  planCdAccept,
  projectInputLine,
  splitCdArg,
} from '../src/components/terminal/cdSuggest.ts'

let failures = 0
let checks = 0

function check(name, fn) {
  try {
    fn()
    checks += 1
    console.log(`  ok  ${name}`)
  } catch (err) {
    failures += 1
    console.error(`  NOT OK  ${name}\n    ${err.message}`)
  }
}

const dir = (name) => ({ name, isDir: true })
const file = (name) => ({ name, isDir: false })

// ---- 1. Which lines are a `cd` in the making? -------------------------------

check('parseCdInput: the trailing space is what opens the dropdown', () => {
  assert.equal(parseCdInput('cd'), null) // no argument yet
  assert.equal(parseCdInput('cd '), '') // bare `cd ` ⇒ list cwd
  assert.equal(parseCdInput('cd lo'), 'lo')
  assert.equal(parseCdInput('cd /var/lo'), '/var/lo')
  assert.equal(parseCdInput('  cd   x'), 'x') // extra spaces collapse
})

check('parseCdInput: only cd/chdir/set-location/sl', () => {
  assert.equal(parseCdInput('Set-Location a'), 'a')
  assert.equal(parseCdInput('sl fo'), 'fo')
  assert.equal(parseCdInput('chdir ..'), '..')
  assert.equal(parseCdInput('ls '), null)
  assert.equal(parseCdInput('cdo x'), null)
})

check('parseCdInput: several arguments, flags and other commands are ignored', () => {
  assert.equal(parseCdInput('cd a b'), null)
  assert.equal(parseCdInput('cd --'), null)
  assert.equal(parseCdInput('cd -'), null)
  assert.equal(parseCdInput('cd -L x'), null)
})

// ---- 2. Where to list, what to filter ---------------------------------------

check('splitCdArg: an empty argument lists the cwd', () => {
  assert.deepEqual(splitCdArg('', '/var/www'), { base: '/var/www', prefix: '', drives: false })
  assert.deepEqual(splitCdArg('', null), { base: null, prefix: '', drives: false })
})

check('splitCdArg: the last separator divides base and prefix', () => {
  assert.deepEqual(splitCdArg('lo', '/var'), { base: '/var', prefix: 'lo', drives: false })
  assert.deepEqual(splitCdArg('/usr/lo', '/var'), { base: '/usr', prefix: 'lo', drives: false })
  assert.deepEqual(splitCdArg('/usr/', '/var'), { base: '/usr', prefix: '', drives: false })
  assert.deepEqual(splitCdArg('/', '/var'), { base: '/', prefix: '', drives: false })
})

check('splitCdArg: Windows drives and git-bash /c/x', () => {
  assert.deepEqual(splitCdArg('C:\\Us', 'D:\\x'), { base: 'C:\\', prefix: 'Us', drives: false })
  assert.deepEqual(splitCdArg('D:\\', 'D:\\x'), { base: 'D:\\', prefix: '', drives: false })
  assert.deepEqual(splitCdArg('C:', 'D:\\x'), { base: null, prefix: '', drives: true })
  assert.deepEqual(splitCdArg('/c/Us', '/x'), { base: '/c', prefix: 'Us', drives: false })
})

check('splitCdArg: relative heads resolve against the cwd, `..` included', () => {
  assert.deepEqual(splitCdArg('a/b', '/var/www'), {
    base: '/var/www/a',
    prefix: 'b',
    drives: false,
  })
  assert.deepEqual(splitCdArg('../sr', '/var/www'), { base: '/var', prefix: 'sr', drives: false })
  // No tracked cwd ⇒ nothing sensible to list, rather than a wrong guess.
  assert.deepEqual(splitCdArg('a/b', null), { base: null, prefix: 'b', drives: false })
})

check('splitCdArg: v1 refuses ~ / quotes / env vars', () => {
  for (const arg of ['~', '~/doc', '"Prog', "it's", '$HOME']) {
    assert.equal(isCdSupported(arg), false, arg)
    assert.equal(splitCdArg(arg, '/var').base, null, arg)
  }
  assert.equal(splitCdArg('C:\\Prog Files\\Git', 'C:\\').prefix, 'Git')
})

check('joinCdPath keeps the host separator', () => {
  assert.equal(joinCdPath('/var', 'log'), '/var/log')
  assert.equal(joinCdPath('/var/', 'log'), '/var/log')
  assert.equal(joinCdPath('/', 'usr'), '/usr')
  assert.equal(joinCdPath('C:\\Data', 'src'), 'C:\\Data\\src')
  assert.equal(joinCdPath('C:\\', 'src'), 'C:\\src')
})

check('parentDirOf stops at the filesystem root', () => {
  assert.equal(parentDirOf('/var/log'), '/var')
  assert.equal(parentDirOf('/var'), '/')
  assert.equal(parentDirOf('/'), null)
  assert.equal(parentDirOf('C:\\Data\\src'), 'C:\\Data')
  assert.equal(parentDirOf('C:\\'), null)
  assert.equal(parentDirOf('C:'), null)
})

// ---- 3. Candidates ----------------------------------------------------------

const sample = [
  dir('.cache'),
  dir('local'),
  dir('lock'),
  dir('log'),
  dir('Logs'),
  file('motd'),
  dir('opt'),
]

check('buildCdCandidates: directories only, parent first', () => {
  const { items, omitted } = buildCdCandidates('/var', sample, '')
  assert.equal(omitted, 0)
  assert.deepEqual(
    items.map((i) => i.name),
    ['..', 'local', 'lock', 'log', 'Logs', 'opt'],
  )
  assert.equal(items[0].fullPath, '/')
  assert.equal(items[1].fullPath, '/var/local')
})

check('buildCdCandidates: exact prefix before case-insensitive hits', () => {
  // `cd Lo` — only `Logs` literally starts with what was typed, so it is the one
  // that can be appended to; the lowercase siblings would need a rewrite and are
  // offered after it.
  const { items } = buildCdCandidates('/var', sample, 'Lo')
  assert.deepEqual(
    items.map((i) => i.name),
    ['Logs', 'local', 'lock', 'log'],
  )
  assert.deepEqual(
    items.map((i) => i.append),
    ['gs', null, null, null],
  )
  // `cd lo` — now every lowercase match is appendable.
  const lower = buildCdCandidates('/var', sample, 'lo').items
  assert.deepEqual(
    lower.map((i) => i.append),
    ['cal', 'ck', 'g', null],
  )
})

check('buildCdCandidates: hidden dirs only once a dot is typed', () => {
  assert.ok(!buildCdCandidates('/var', sample, '').items.some((i) => i.name === '.cache'))
  assert.ok(buildCdCandidates('/var', sample, '.').items.some((i) => i.name === '.cache'))
  // `..` is offered for a dot-prefixed search too.
  assert.equal(buildCdCandidates('/var', sample, '.').items[0].name, '..')
})

check('buildCdCandidates: the 200 cap reports what it dropped', () => {
  const many = Array.from({ length: 260 }, (_, i) => dir(`d${String(i).padStart(3, '0')}`))
  const { items, omitted } = buildCdCandidates('/x', many, '')
  assert.equal(items.length, CD_MAX_CANDIDATES)
  assert.equal(omitted, 61) // 260 dirs + the synthetic `..` − 200
})

// ---- 4. Applying a candidate ------------------------------------------------

check('planCdAccept appends whenever it can, rewrites otherwise', () => {
  const { items } = buildCdCandidates('/var', sample, 'lo')
  const local = items.find((i) => i.name === 'local')
  assert.equal(planCdAccept(local, 'posix'), 'cal') // `cd lo` ⇒ type `cal`
  const logs = { name: 'Logs', fullPath: '/var/Logs', append: null }
  assert.equal(planCdAccept(logs, 'posix'), `\x01\x0bcd -- '/var/Logs'`)
  assert.equal(planCdAccept(logs, 'windows'), `\x1bcd "/var/Logs"`)
})

check('cdCommandFor: one quoting rule for both entry points', () => {
  assert.equal(cdCommandFor('posix', '/var/log'), `cd -- '/var/log'`)
  // Single quotes escaped the POSIX way, and `~` stays unquoted so the shell
  // expands it.
  assert.equal(cdCommandFor('posix', "/data/it's"), `cd -- '/data/it'\\''s'`)
  assert.equal(cdCommandFor('posix', '~/doc'), 'cd -- ~/doc')
  assert.equal(cdCommandFor('windows', 'C:\\Program Files'), 'cd "C:\\Program Files"')
})

check('clearLineBytes: never send a bare Esc to a readline shell', () => {
  assert.equal(clearLineBytes('posix'), '\x01\x0b')
  assert.equal(clearLineBytes('windows'), '\x1b')
})

// ---- 5. The echo lags one keystroke (plan §4.1) ----------------------------

check('applyKeystroke: printable, backspace and kill', () => {
  assert.equal(applyKeystroke('cd', ' '), 'cd ')
  assert.equal(applyKeystroke('cd ', 'l'), 'cd l')
  assert.equal(applyKeystroke('cd l', '\x7f'), 'cd ')
  assert.equal(applyKeystroke('cd l', '\x08'), 'cd ')
  assert.equal(applyKeystroke('cd l', '\x15'), '')
  assert.equal(applyKeystroke('cd l', '\r'), '')
  assert.equal(applyKeystroke('', '\x7f'), '')
})

check('applyKeystroke: anything that edits in place is "unknown"', () => {
  for (const data of ['\x01', '\x05', '\x1b[C', '\x1b[3~', '\x0c']) {
    assert.equal(applyKeystroke('cd l', data), null, JSON.stringify(data))
  }
  assert.equal(applyKeystroke('cd ', 'lo'), 'cd lo') // a printable block (IME)
  assert.equal(applyKeystroke('cd ', 'l\x1b'), null) // mixed ⇒ unknown
})

check('projectInputLine sees the space immediately (local echo)', () => {
  // ConPTY has echoed `cd` already, but not the space that is being sent now.
  const first = projectInputLine('cd', '', ' ')
  assert.deepEqual(first, { line: 'cd ', lag: ' ' })
  // Next keystroke: the buffer caught up, so the stale lag is dropped again.
  const second = projectInputLine('cd ', ' ', 'l')
  assert.deepEqual(second, { line: 'cd l', lag: 'l' })
})

check('projectInputLine stays correct when the echo lags two keystrokes', () => {
  // SSH: neither `l` nor `o` is echoed yet, so both ride along in the lag.
  const third = projectInputLine('cd ', 'l', 'o')
  assert.deepEqual(third, { line: 'cd lo', lag: 'lo' })
  // The buffer jumps straight to the current line ⇒ no double typing.
  const caughtUp = projectInputLine('cd lo', 'lo', 'g')
  assert.deepEqual(caughtUp, { line: 'cd log', lag: 'g' })
})

check('projectInputLine: backspace shortens the projected line', () => {
  const bs = projectInputLine('cd ', 'lo', '\x7f')
  assert.equal(bs.line, 'cd l')
  assert.equal(bs.lag, 'l')
})

check('projectInputLine: no input line ⇒ nothing to guess', () => {
  // Program output / a TUI / a pager prompt (`getPendingInputText` → null).
  assert.deepEqual(projectInputLine(null, 'cd l', 'o'), { line: null, lag: '' })
})

check('projectInputLine: an escape sequence realigns on the next read', () => {
  const moved = projectInputLine('cd lo', 'o', '\x1b[C')
  assert.equal(moved.line, null)
  assert.equal(moved.lag, '') // discard the guess, trust the buffer next time
})

check('isHistoryRecall: only ↑/↓, in every encoding a shell sends them', () => {
  // CSI (normal), SS3 (readline's application-cursor form), modified, and ^P/^N.
  for (const data of ['\x1b[A', '\x1b[B', '\x1bOA', '\x1bOB', '\x1b[1;5A', '\x10', '\x0e']) {
    assert.equal(isHistoryRecall(data), true, JSON.stringify(data))
  }
  // The horizontal arrows move the caret WITHIN the line, so the tail's own
  // anchor still holds; retire it there and the completion dies on every
  // backspace-then-arrow. Page/Home/End are likewise not a recall.
  for (const data of ['\x1b[C', '\x1b[D', '\x1b[H', '\x1b[F', '\x1b[3~', '\x1b[5~', '\x1b[6~']) {
    assert.equal(isHistoryRecall(data), false, JSON.stringify(data))
  }
  // Ordinary typing, and the delimiters that must never match by prefix.
  for (const data of ['a', '\x7f', '\r', '\x1b', '\x1b[200~', '']) {
    assert.equal(isHistoryRecall(data), false, JSON.stringify(data))
  }
})

// ---- 6. Listing cache -------------------------------------------------------

check('cdCacheKey couples the session target with the directory', () => {
  assert.equal(cdCacheKey('local:1', '/var'), 'local:1|/var')
  assert.notEqual(cdCacheKey('local:1', '/var'), cdCacheKey('local:2', '/var'))
})

check('CdListCache serves a fresh hit and expires it after the TTL', () => {
  const cache = new CdListCache(1000)
  cache.set('/var', ['a', 'b'], 0)
  assert.deepEqual(cache.get('/var', 500), ['a', 'b'])
  assert.equal(cache.get('/var', 1500), null)
})

check('CdListCache evicts the least-recently-used entry first', () => {
  const cache = new CdListCache(10_000, 2)
  cache.set('a', 1, 0)
  cache.set('b', 2, 0)
  cache.get('a', 10) // touches `a` ⇒ `b` is now the LRU victim
  cache.set('c', 3, 20)
  assert.equal(cache.get('b', 30), null)
  assert.equal(cache.get('a', 30), 1)
  assert.equal(cache.get('c', 30), 3)
})

console.log(`\n${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)

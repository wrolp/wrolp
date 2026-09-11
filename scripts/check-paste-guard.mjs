// Self-check for the multi-line paste guard's pure functions (B20).
//
// Run with:  node scripts/check-paste-guard.mjs
//
// Node ≥ 22.18 / 23 can import TypeScript directly (type stripping), which is
// all `src/lib/pasteGuard.ts` needs — it has no runtime dependencies and only
// touches `localStorage` inside load/save, which this script never calls.

import assert from 'node:assert/strict'
import {
  canQuotedInsert,
  decidePasteAction,
  isMultilinePaste,
  isPosixLocalShell,
  isPosixSession,
  pasteLineCount,
  pastePreview,
  planPaste,
  sanitizePasteGuard,
  sanitizePasteText,
  toQuotedInsert,
  withLineContinuation,
  PASTE_GUARD_DEFAULTS,
} from '../src/lib/pasteGuard.ts'

let checks = 0
function check(name, fn) {
  fn()
  checks += 1
  console.log(`  ok  ${name}`)
}

const cfg = (over = {}) => ({ ...PASTE_GUARD_DEFAULTS, ...over })
const decide = (
  text,
  sessionKind = 'ssh',
  bracketedPasteMode = false,
  config = cfg(),
  localShellType = undefined,
) => decidePasteAction({ text, bracketedPasteMode, sessionKind, config, localShellType })
const plan = (
  text,
  sessionKind = 'ssh',
  bracketedPasteMode = false,
  config = cfg(),
  localShellType,
) => planPaste({ text, bracketedPasteMode, sessionKind, config, localShellType })

console.log('sanitizePasteText')
check('keeps tab / LF / CR but drops other C0 controls and DEL', () => {
  const r = sanitizePasteText('a\tb\nc\rd\u0003e\u0004f\u001ag\u007fh')
  assert.equal(r.text, 'a\tb\nc\rdefgh')
  assert.equal(r.removedControls, 4)
  assert.equal(r.removedSequences, 0)
})
check('strips bracketed-paste markers and counts them', () => {
  const r = sanitizePasteText('\u001b[200~rm -rf /\u001b[201~')
  assert.equal(r.text, 'rm -rf /')
  assert.equal(r.removedSequences, 2)
})
check('strips a quoted-insert escape smuggled in the clipboard', () => {
  assert.equal(sanitizePasteText('a\u0016b\nc').text, 'ab\nc')
})

console.log('pasteLineCount / isMultilinePaste')
check('counts lines, ignoring one trailing newline', () => {
  assert.equal(pasteLineCount('ls'), 1)
  assert.equal(pasteLineCount('ls\n'), 1)
  assert.equal(pasteLineCount('ls\r\n'), 1)
  assert.equal(pasteLineCount('a\nb'), 2)
  assert.equal(pasteLineCount('a\r\nb\r\nc'), 3)
  assert.equal(pasteLineCount(''), 0)
})
check('multiline only for 2+ real lines', () => {
  assert.equal(isMultilinePaste('ls -la\n'), false)
  assert.equal(isMultilinePaste('cd /tmp\necho hi\n'), true)
})

console.log('toQuotedInsert')
check('prefixes every newline with Ctrl-V and normalises CRLF/CR', () => {
  assert.equal(toQuotedInsert('a\r\nb\rc'), 'a\u0016\nb\u0016\nc')
})

console.log('canQuotedInsert')
check('a readline-based shell without bracketed paste can insert literally', () => {
  assert.equal(canQuotedInsert('ssh', false), true)
  assert.equal(canQuotedInsert('ssh', true), false)
  // Local POSIX shells (WSL / Git Bash / bash) have the very same readline.
  assert.equal(canQuotedInsert('local', false, 'wsl'), true)
  assert.equal(canQuotedInsert('local', false, 'gitbash'), true)
  assert.equal(canQuotedInsert('local', false, 'bash'), true)
  assert.equal(canQuotedInsert('local', false, 'C:\\Program Files\\Git\\bin\\bash.exe'), true)
  assert.equal(canQuotedInsert('local', false, 'C:\\Windows\\System32\\wsl.exe'), true)
  // cmd / PowerShell have no quoted-insert.
  assert.equal(canQuotedInsert('local', false, 'cmd'), false)
  assert.equal(canQuotedInsert('local', false, 'powershell'), false)
  assert.equal(canQuotedInsert('local', false, 'pwsh'), false)
  assert.equal(canQuotedInsert('local', false, 'cmd.exe'), false)
  assert.equal(canQuotedInsert('telnet', false), false)
  assert.equal(canQuotedInsert('serial', false), false)
})

console.log('isPosixLocalShell / isPosixSession')
check('classifies presets and user-typed executables', () => {
  for (const s of ['wsl', 'gitbash', 'bash', 'zsh', 'sh', '/bin/bash', 'C:\\git\\bin\\bash.exe']) {
    assert.equal(isPosixLocalShell(s), true, `${s} should be POSIX`)
  }
  for (const s of ['cmd', 'cmd.exe', 'pwsh', 'powershell', 'PowerShell.exe', 'nu']) {
    assert.equal(isPosixLocalShell(s), false, `${s} should not be POSIX`)
  }
  // Empty = platform default (cmd.exe on Windows, $SHELL elsewhere): both
  // spellings must agree, whatever the platform running this script.
  assert.equal(isPosixLocalShell(''), isPosixLocalShell(undefined))
})
check('ssh is assumed POSIX, serial/telnet never are', () => {
  assert.equal(isPosixSession('ssh'), true)
  assert.equal(isPosixSession('local', 'wsl'), true)
  assert.equal(isPosixSession('local', 'cmd'), false)
  assert.equal(isPosixSession('serial', 'bash'), false)
  assert.equal(isPosixSession('telnet', 'bash'), false)
})

console.log('decidePasteAction')
check('single line and below-threshold pastes pass through untouched', () => {
  assert.equal(decide('ls -la'), 'passthrough')
  assert.equal(decide('ls\n'), 'passthrough')
  assert.equal(decide('a\nb\nc', 'ssh', false, cfg({ threshold: 3 })), 'passthrough')
  assert.equal(decide('a\nb\nc\nd', 'ssh', false, cfg({ threshold: 3 })), 'ask')
})
check('master switch off restores the legacy behaviour', () => {
  assert.equal(decide('a\nb', 'ssh', false, cfg({ enabled: false })), 'passthrough')
  assert.equal(decide('a\nb', 'serial', false, cfg({ enabled: false })), 'passthrough')
})
check('bracketed paste already makes a multi-line paste safe', () => {
  assert.equal(decide('a\nb', 'ssh', true), 'passthrough')
  assert.equal(decide('a\nb', 'local', true), 'passthrough')
})
check('serial multi-line pastes are always dropped (decision 3)', () => {
  assert.equal(decide('a\nb', 'serial'), 'drop-serial')
  assert.equal(decide('a\nb', 'serial', false, cfg({ mode: 'execute' })), 'drop-serial')
  assert.equal(decide('a\nb', 'serial', false, cfg({ mode: 'insert' })), 'drop-serial')
})
check('ask mode asks for ssh / local / telnet', () => {
  assert.equal(decide('a\nb', 'ssh'), 'ask')
  assert.equal(decide('a\nb', 'local'), 'ask')
  assert.equal(decide('a\nb', 'telnet'), 'ask')
})
check('insert mode inserts on ssh / local POSIX, asks elsewhere', () => {
  assert.equal(decide('a\nb', 'ssh', false, cfg({ mode: 'insert' })), 'insert')
  assert.equal(decide('a\nb', 'telnet', false, cfg({ mode: 'insert' })), 'ask')
  assert.equal(decide('a\nb', 'local', false, cfg({ mode: 'insert' }), 'wsl'), 'insert')
  assert.equal(decide('a\nb', 'local', false, cfg({ mode: 'insert' }), 'cmd'), 'ask')
})
check('execute mode keeps line-by-line sending', () => {
  assert.equal(decide('a\nb', 'ssh', false, cfg({ mode: 'execute' })), 'execute')
  assert.equal(decide('a\nb', 'telnet', false, cfg({ mode: 'execute' })), 'execute')
})

console.log('planPaste')
check('bracketed paste into a POSIX shell also gets line continuations', () => {
  const p = plan('echo one\necho two', 'ssh', true)
  assert.equal(p.action, 'passthrough')
  assert.equal(p.text, 'echo one\necho two')
  assert.equal(p.insertText, 'echo one \\\necho two')
  assert.equal(p.continuationAdded, 1)
})
check('WSL is treated exactly like an SSH shell', () => {
  // Bracketed paste on (the WSL/bash default): continuation is applied on the
  // silent passthrough path — this was the reported gap.
  const bracketed = plan('cd\n/', 'local', true, cfg(), 'wsl')
  assert.equal(bracketed.action, 'passthrough')
  assert.equal(bracketed.insertText, 'cd \\\n/')
  assert.equal(bracketed.continuationAdded, 1)
  // Bracketed paste off → the dialog path, where insert is now available too.
  const plain = plan('cd\n/', 'local', false, cfg(), 'wsl')
  assert.equal(plain.action, 'ask')
  assert.equal(plain.canInsert, true)
  assert.equal(plain.insertText, 'cd \\\n/')
})
check('cmd / PowerShell payloads are never modified', () => {
  for (const shell of ['cmd', 'powershell', 'pwsh']) {
    const p = plan('echo one\necho two', 'local', true, cfg(), shell)
    assert.equal(p.insertText, 'echo one\necho two', shell)
    assert.equal(p.continuationAdded, 0, shell)
  }
  const dialog = plan('echo one\necho two', 'local', false, cfg(), 'cmd')
  assert.equal(dialog.canInsert, false)
  assert.equal(dialog.insertText, 'echo one\necho two')
})
check('execute / single line / disabled guard / serial never modify the payload', () => {
  assert.equal(plan('a\nb', 'ssh', false, cfg({ mode: 'execute' })).insertText, 'a\nb')
  assert.equal(plan('ls -la', 'ssh', true).continuationAdded, 0)
  assert.equal(plan('a\nb', 'ssh', true, cfg({ appendContinuation: false })).insertText, 'a\nb')
  assert.equal(plan('a\nb', 'ssh', true, cfg({ enabled: false })).insertText, 'a\nb')
  assert.equal(plan('a\nb', 'ssh', true, cfg({ threshold: 5 })).insertText, 'a\nb')
  const serial = plan('a\nb', 'serial', false)
  assert.equal(serial.action, 'drop-serial')
  assert.equal(serial.continuationAdded, 0)
})

console.log('withLineContinuation')
check('adds a space + backslash to every non-final line', () => {
  const r = withLineContinuation('echo one\necho two')
  assert.equal(r.text, 'echo one \\\necho two')
  assert.equal(r.added, 1)
  const r3 = withLineContinuation('a\nb\nc')
  assert.equal(r3.text, 'a \\\nb \\\nc')
  assert.equal(r3.added, 2)
})
check('a single trailing newline still marks the last line as final', () => {
  const r = withLineContinuation('a\nb\n')
  assert.equal(r.text, 'a \\\nb\n')
  assert.equal(r.added, 1)
})
check('never doubles an existing continuation', () => {
  const r = withLineContinuation('docker run -d \\\n  nginx')
  assert.equal(r.text, 'docker run -d \\\n  nginx')
  assert.equal(r.added, 0)
})
check('repairs a backslash that is not the last character', () => {
  // `cd \ ` (backslash + stray space, typical of copy/paste out of a doc): the
  // shell reads `\ ` as an ESCAPED SPACE, so the line runs on its own and fails
  // (`cd ' '`); moving the backslash to the EOL makes it a real continuation.
  const r = withLineContinuation('cd \\ \n/')
  assert.equal(r.text, 'cd \\\n/')
  assert.equal(r.added, 1)
  // A tab after the backslash behaves the same.
  assert.equal(withLineContinuation('cd \\\t\n/').text, 'cd \\\n/')
  // An EVEN run of backslashes is a literal `\` argument, not a continuation,
  // so such a line still gets one appended.
  assert.equal(withLineContinuation('echo foo\\\\ \n/x').text, 'echo foo\\\\ \\\n/x')
})
check('leaves open operators alone', () => {
  assert.equal(withLineContinuation('echo a |\ngrep a').added, 0)
  assert.equal(withLineContinuation('echo a &&\necho b').added, 0)
})
check('never touches a compound command / script', () => {
  // The shell already buffers `for …; do … done` as ONE command, so adding a
  // `\` would glue the body into the `do` line and break the loop.
  const loop = 'for i in 1 2; do\necho $i\ndone'
  assert.equal(withLineContinuation(loop).text, loop)
  assert.equal(withLineContinuation(loop).added, 0)
  const iff = 'if true; then\necho hi\nfi'
  assert.equal(withLineContinuation(iff).text, iff)
  assert.equal(withLineContinuation(iff).added, 0)
  // A script mixed with a plain command is left alone as a whole.
  assert.equal(withLineContinuation('echo one\ndone\necho two').added, 0)
})
check('leaves comments, empty lines and blank-separated lines alone', () => {
  assert.equal(withLineContinuation('# note\necho hi').added, 0)
  assert.equal(withLineContinuation('a\n\nb').added, 0)
  assert.equal(withLineContinuation('a\n   \nb').added, 0)
})
check('keeps multi-line strings and heredocs verbatim', () => {
  const quoted = withLineContinuation('echo "hello\nworld"')
  assert.equal(quoted.text, 'echo "hello\nworld"')
  assert.equal(quoted.added, 0)
  const heredoc = withLineContinuation("cat <<'EOF'\nline one\nline two\nEOF\necho done")
  assert.equal(heredoc.text, "cat <<'EOF'\nline one\nline two\nEOF\necho done")
  assert.equal(heredoc.added, 0)
})
check('normalises CRLF before joining', () => {
  assert.equal(withLineContinuation('a\r\nb').text, 'a \\\nb')
})

console.log('pastePreview')
check('truncates long pastes with a remainder marker', () => {
  assert.deepEqual(pastePreview('a\nb'), ['a', 'b'])
  assert.deepEqual(pastePreview('a\nb\n'), ['a', 'b'])
  const p = pastePreview('1\n2\n3\n4\n5\n6\n7', 3)
  assert.deepEqual(p, ['1', '2', '3', '… (+4)'])
})

console.log('sanitizePasteGuard')
check('falls back to defaults for garbage input', () => {
  assert.deepEqual(sanitizePasteGuard(null), PASTE_GUARD_DEFAULTS)
  assert.deepEqual(sanitizePasteGuard('nope'), PASTE_GUARD_DEFAULTS)
  assert.deepEqual(sanitizePasteGuard({ mode: 'wat', enabled: 'yes', threshold: NaN }), {
    enabled: true,
    threshold: 1,
    mode: 'ask',
    appendContinuation: true,
  })
  assert.equal(sanitizePasteGuard({ appendContinuation: false }).appendContinuation, false)
  assert.equal(sanitizePasteGuard({ appendContinuation: 'no' }).appendContinuation, true)
})
check('clamps the threshold into 1..50', () => {
  assert.equal(sanitizePasteGuard({ threshold: 0 }).threshold, 1)
  assert.equal(sanitizePasteGuard({ threshold: -5 }).threshold, 1)
  assert.equal(sanitizePasteGuard({ threshold: 999 }).threshold, 50)
  assert.equal(sanitizePasteGuard({ threshold: 2.6 }).threshold, 3)
})

console.log(`\n${checks} checks passed`)

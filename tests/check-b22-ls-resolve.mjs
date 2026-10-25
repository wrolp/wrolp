// B22 verification — drives `resolveLsEntryPath` against a REAL local filesystem.
//
// The local-shell backend (`LocalFs`) answers `fsFileExists` with the OS
// filesystem, so checking the resolution logic against real on-disk files is a
// faithful model of the local-shell "Open file" path. We build the `exists`
// predicate from `node:fs` (same truth the Rust `LocalFs` would see) and assert
// the resolved path for the B22 scenario plus the preserved behaviors.
//
// Run: node tests/check-b22-ls-resolve.mjs   (Node >= 22.18, imports the .ts)
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveLsEntryPath } from '../src/components/terminal/lsCapture.ts'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'b22-'))
const dirA = path.join(root, 'dirA')
const dirB = path.join(root, 'dirB')
fs.mkdirSync(dirA)
fs.mkdirSync(dirB)

const exists = async (p) => fs.existsSync(p)
let pass = 0
const ok = (label) => {
  pass++
  console.log(`  ok  ${label}`)
}

// Scenario 1 — B22: `ls` dirA, `mv foo.txt ../`, `cd dirB`, click stale dirA listing.
fs.writeFileSync(path.join(dirB, 'foo.txt'), 'moved')
{
  const r = await resolveLsEntryPath({
    capturedBase: dirA,
    name: 'foo.txt',
    cwd: dirB,
    nested: false,
    exists,
  })
  assert.strictEqual(r.base, dirB, 'fallback base should be cwd (dirB)')
  assert.strictEqual(r.abs, path.join(dirB, 'foo.txt'), 'B22: moved file opens from cwd')
  ok('mv → cd → click stale listing opens the file at its new dir (cwd fallback)')
}

// Scenario 2 — `cd` away but file still in original dir: click lands in original dir.
fs.writeFileSync(path.join(dirA, 'foo.txt'), 'original')
{
  const r = await resolveLsEntryPath({
    capturedBase: dirA,
    name: 'foo.txt',
    cwd: dirB,
    nested: false,
    exists,
  })
  assert.strictEqual(r.base, dirA, 'intent preserved: base stays the listing dir')
  assert.strictEqual(r.abs, path.join(dirA, 'foo.txt'), 'cd-away click still opens original dir')
  ok('cd away (file still in dirA) → click still resolves to listing dir (intent preserved)')
}

// Scenario 3 — docker / nested shell: no cwd fallback (host cwd can't describe container paths).
fs.rmSync(path.join(dirA, 'foo.txt')) // dirA now empty; file only at dirB
{
  const r = await resolveLsEntryPath({
    capturedBase: dirA,
    name: 'foo.txt',
    cwd: dirB,
    nested: true,
    exists,
  })
  assert.strictEqual(r.base, dirA, 'nested: no fallback, keep listing base')
  assert.strictEqual(r.abs, path.join(dirA, 'foo.txt'), 'nested: keep captured path even if gone')
  ok('docker/nested shell skips cwd fallback (keeps listing base)')
}

// Scenario 4 — exists() throws: trust the captured path, never break the click.
{
  const boom = async () => {
    throw new Error('backend down')
  }
  const r = await resolveLsEntryPath({
    capturedBase: dirA,
    name: 'foo.txt',
    cwd: dirB,
    nested: false,
    exists: boom,
  })
  assert.strictEqual(r.base, dirA, 'on exists() error, keep captured base')
  ok('exists() error → trust captured path (no broken click)')
}

// Scenario 5 — no captured base (relative name, no tracked cwd): abs is the bare name.
{
  const r = await resolveLsEntryPath({
    capturedBase: null,
    name: 'foo.txt',
    cwd: dirB,
    nested: false,
    exists,
  })
  assert.strictEqual(r.base, null, 'no base → null')
  assert.strictEqual(r.abs, 'foo.txt', 'no base → bare name (shell resolves)')
  ok('no captured base → bare name, no spurious fallback')
}

// Scenario 6 — pure `mv` WITHOUT `cd`: cwd is still dirA, so nothing resolves → captured (old) path.
// This is the documented design limitation (stale on-screen text), not a regression.
{
  const r = await resolveLsEntryPath({
    capturedBase: dirA,
    name: 'foo.txt',
    cwd: dirA,
    nested: false,
    exists,
  })
  assert.strictEqual(r.base, dirA, 'mv without cd: cwd==captured, no fallback possible')
  assert.strictEqual(
    r.abs,
    path.join(dirA, 'foo.txt'),
    'mv without cd: falls back to stale captured path',
  )
  ok('mv without cd → cwd==captured, no fallback (documented stale-snapshot limit)')
}

fs.rmSync(root, { recursive: true, force: true })
console.log(`\n${pass} checks passed`)

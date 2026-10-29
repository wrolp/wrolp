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
import { resolveLsEntryPath, parseMvMove } from '../src/components/terminal/lsCapture.ts'

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

// Scenario 6 — pure `mv` WITHOUT `cd`, and without an observed move: cwd is
// still dirA, so nothing resolves → captured (old) path. This control pins the
// old limitation; scenarios 7–9 add the `mv` record that now closes it.
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
  ok('mv without cd and without a move record → no fallback (control)')
}

// Scenario 7 — B22 residual: `mv foo.txt ../` then click the old listing
// without cd. The recorded destination resolves the file at its new home.
fs.writeFileSync(path.join(root, 'foo.txt'), 'moved-up')
{
  const move = parseMvMove('mv foo.txt ../', dirA)
  assert.ok(move, 'mv destination parsed')
  assert.strictEqual(move.destDir, root, 'relative destination resolved against cwd')
  assert.strictEqual(move.renamedFrom, 'foo.txt')
  assert.strictEqual(move.renamedTo, null, 'trailing slash means a directory')
  const r = await resolveLsEntryPath({
    capturedBase: dirA,
    name: 'foo.txt',
    cwd: dirA,
    nested: false,
    exists,
    moves: [move],
  })
  assert.strictEqual(r.base, root, 'move record base is the destination directory')
  assert.strictEqual(r.abs, path.join(root, 'foo.txt'), 'moved file opens at its new path')
  ok('mv without cd → click follows the recorded destination')
}

// Scenario 8 — wildcard move: the shell expands `*`, the record still names the
// destination directory, and the clicked listing name is joined to it.
fs.rmSync(path.join(root, 'foo.txt'))
fs.writeFileSync(path.join(root, 'notes.txt'), 'wildcard')
{
  const move = parseMvMove('mv * ../', dirA)
  assert.ok(move)
  assert.strictEqual(move.renamedFrom, null, 'wildcards are not a single rename source')
  const r = await resolveLsEntryPath({
    capturedBase: dirA,
    name: 'notes.txt',
    cwd: dirA,
    nested: false,
    exists,
    moves: [move],
  })
  assert.strictEqual(r.abs, path.join(root, 'notes.txt'))
  ok('mv * ../ → the clicked name resolves inside the destination (parent) dir')
}

// Scenario 9 — single-file rename (`mv a.txt b.txt`): the old name opens the
// new file, whose parent is the base for type lookup.
fs.writeFileSync(path.join(dirA, 'old.txt'), 'renamed')
fs.renameSync(path.join(dirA, 'old.txt'), path.join(dirA, 'new.txt'))
{
  const move = parseMvMove('mv old.txt new.txt', dirA)
  assert.ok(move)
  assert.strictEqual(move.renamedFrom, 'old.txt')
  assert.strictEqual(move.renamedTo, path.join(dirA, 'new.txt'))
  const r = await resolveLsEntryPath({
    capturedBase: dirA,
    name: 'old.txt',
    cwd: dirA,
    nested: false,
    exists,
    moves: [move],
  })
  assert.strictEqual(r.abs, path.join(dirA, 'new.txt'))
  assert.strictEqual(r.base, dirA)
  ok('mv old.txt new.txt → click on the old name opens the renamed file')
}

// Scenario 10 — parser refuses what it cannot attribute: compound lines and
// `~` destinations must not silently become a wrong fallback.
{
  assert.strictEqual(parseMvMove('mv a.txt ../ && echo ok', dirA), null)
  assert.strictEqual(parseMvMove('mv a.txt ~/backup', dirA), null)
  assert.strictEqual(parseMvMove('ls a.txt', dirA), null)
  const target = parseMvMove('mv -t ../ a.txt b.txt', dirA)
  assert.ok(target)
  assert.strictEqual(target.destDir, root)
  ok('compound / ~ commands are not recorded; -t destination is understood')
}

fs.rmSync(root, { recursive: true, force: true })
console.log(`\n${pass} checks passed`)

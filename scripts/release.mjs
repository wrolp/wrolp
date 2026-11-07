// Cross-platform release helper.
//
// Reads the signing private key from .tauri/priv.key (and an optional
// .tauri/priv.key.pass password file) and exports TAURI_SIGNING_PRIVATE_KEY
// (and TAURI_SIGNING_PRIVATE_KEY_PASSWORD) for the Tauri build so the MSI gets
// signed and a .sig is produced.
//
// Then it runs: tauri build -> strip _en-US suffix -> generate latest.json.
//
// It stops before any of that unless HEAD carries the tag for the version being
// built (see `release-tag-guard.mjs`), so an artifact is never labeled with a
// version its bytes do not match.

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { requireVersionTag } from './release-tag-guard.mjs'
import { releaseTargetDir } from './release-paths.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const keyPath = join(root, '.tauri', 'priv.key')

// 0. refuse to build what cannot be traced back to a commit
const conf = JSON.parse(readFileSync(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'))
requireVersionTag({
  root,
  tag: `v${conf.version}`,
  version: conf.version,
  label: 'release',
})

const env = { ...process.env }
// Build into the release-only target dir. Keeping releases out of
// `src-tauri/target` is what lets the clean step below always succeed while
// rust-analyzer has the dev target mapped (see `release-paths.mjs`), and it
// leaves the dev build cache warm.
env.CARGO_TARGET_DIR = releaseTargetDir()

if (existsSync(keyPath)) {
  const key = readFileSync(keyPath, 'utf8').trim()
  env.TAURI_SIGNING_PRIVATE_KEY = key
  // Optional password file (only if the key was generated with a password).
  const passPath = keyPath + '.pass'
  if (existsSync(passPath)) {
    env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = readFileSync(passPath, 'utf8').trim()
  }
  console.log('[release] TAURI_SIGNING_PRIVATE_KEY loaded from .tauri/priv.key')
} else {
  console.warn('[release] .tauri/priv.key not found — MSI will NOT be signed.')
}

// `npx` is a `.cmd` shim on Windows, and Node cannot spawn a batch file without a
// shell (ENOENT/EINVAL). But Node ≥22 deprecates (DEP0190) — and will eventually
// refuse — an args array passed together with `shell: true`, because the
// arguments are concatenated into one command string WITHOUT being escaped.
//
// So no shell and no shim at all: run the Tauri CLI's own entry (`bin.tauri` of
// `@tauri-apps/cli`) with the same `node` that is running this script, with every
// argument passed as a separate array element. Nothing is quoted by hand, and
// nothing can be injected through a path or a note.
const require = createRequire(import.meta.url)
const tauriCli = require.resolve('@tauri-apps/cli/tauri.js')

function run(cmd, args) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', env, cwd: root })
  if (res.status !== 0) process.exit(res.status ?? 1)
}

// 1. clean the release target, then build (signed)
//
// A release bundle must not inherit objects from earlier builds: icons and
// embedded assets are fingerprint-free, so a stale target has shipped the old
// icon before. The release target dir is used only by releases, so this clean
// cannot be blocked by rust-analyzer or a running dev build.
// `RELEASE_SKIP_CLEAN=1` is the escape hatch for iterating on the packaging
// steps themselves.
if (process.env.RELEASE_SKIP_CLEAN === '1') {
  console.log('[release] RELEASE_SKIP_CLEAN=1 — reusing the existing build output')
} else {
  console.log(`[release] cleaning ${env.CARGO_TARGET_DIR}`)
  run(process.execPath, ['scripts/clean.mjs', '--release'])
}

run(process.execPath, [tauriCli, 'build'])
// 2. strip _en-US suffix
run(process.execPath, ['scripts/strip-locale-suffix.mjs'])
// 3. generate latest.json
run(process.execPath, ['scripts/gen-latest-json.mjs'])

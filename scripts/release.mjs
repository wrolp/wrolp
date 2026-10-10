// Cross-platform release helper.
//
// Reads the signing private key from .tauri/priv.key (and an optional
// .tauri/priv.key.pass password file) and exports TAURI_SIGNING_PRIVATE_KEY
// (and TAURI_SIGNING_PRIVATE_KEY_PASSWORD) for the Tauri build so the MSI gets
// signed and a .sig is produced.
//
// Then it runs: tauri build -> strip _en-US suffix -> generate latest.json.

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const keyPath = join(root, '.tauri', 'priv.key')

const env = { ...process.env }

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

// 1. build (signed)
run(process.execPath, [tauriCli, 'build'])
// 2. strip _en-US suffix
run(process.execPath, ['scripts/strip-locale-suffix.mjs'])
// 3. generate latest.json
run(process.execPath, ['scripts/gen-latest-json.mjs'])

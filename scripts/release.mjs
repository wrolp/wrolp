// Cross-platform release helper.
//
// Reads the signing private key from .tauri/priv.key (and an optional
// .tauri/priv.key.pass password file) and exports TAURI_SIGNING_PRIVATE_KEY
// (and TAURI_SIGNING_PRIVATE_KEY_PASSWORD) for the Tauri build so the MSI gets
// signed and a .sig is produced.
//
// Then it runs: tauri build -> strip _en-US suffix -> generate latest.json.

import { spawnSync } from 'node:child_process'
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

function run(cmd, args) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', env, shell: true, cwd: root })
  if (res.status !== 0) process.exit(res.status ?? 1)
}

// 1. build (signed)
run('npx', ['tauri', 'build'])
// 2. strip _en-US suffix
run('node', ['scripts/strip-locale-suffix.mjs'])
// 3. generate latest.json
run('node', ['scripts/gen-latest-json.mjs'])

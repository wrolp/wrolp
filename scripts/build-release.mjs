// Build a shippable bundle without publishing it.
//
// Same two properties as `yarn run publish`: it cleans first (a stale object can
// otherwise carry an old icon into the MSI) and it builds every architecture in
// `RELEASE_TARGETS` into the release-only target dir, so the clean never
// collides with rust-analyzer holding the dev target's proc-macro DLLs (see
// `release-paths.mjs`).
//
// Signing is left to the caller: `yarn run publish` loads `.tauri/priv.key`
// itself, this script only builds.

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { RELEASE_TARGETS, releaseTargetDir, root } from './release-paths.mjs'

const require = createRequire(import.meta.url)
const tauriCli = require.resolve('@tauri-apps/cli/tauri.js')

const env = { ...process.env, CARGO_TARGET_DIR: releaseTargetDir() }

function run(args) {
  const res = spawnSync(process.execPath, args, { stdio: 'inherit', env, cwd: root })
  if (res.status !== 0) process.exit(res.status ?? 1)
}

console.log(`[build] target: ${env.CARGO_TARGET_DIR}`)
if (process.env.RELEASE_SKIP_CLEAN === '1') {
  console.log('[build] RELEASE_SKIP_CLEAN=1 — reusing the existing build output')
} else {
  run(['scripts/clean.mjs', '--release'])
}
for (const target of RELEASE_TARGETS) {
  console.log(`[build] building ${target.triple} (${target.arch})`)
  run([tauriCli, 'build', '--target', target.triple])
}
// Keep only each target's `release/` — see prune-release-target.mjs.
run(['scripts/prune-release-target.mjs'])

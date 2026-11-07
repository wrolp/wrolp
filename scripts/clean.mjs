// Remove build output so the next build starts from nothing.
//
// `cargo clean` (not `rm -rf src-tauri/target`) because it also honours a
// `CARGO_TARGET_DIR` override and leaves cargo's own bookkeeping consistent.
// `dist/` is Vite's output; it is emptied on every build anyway, but a release
// bundle must never be produced from a directory that still holds a previous
// installer's assets.
//
// Used by `yarn clean` and by `scripts/release.mjs` before it builds.

import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function run(cmd, args, cwd, env = process.env) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', env, cwd })
  if (res.error) {
    console.error(`[clean] failed to run ${cmd}: ${res.error.message}`)
    process.exit(1)
  }
  if (res.status !== 0) process.exit(res.status ?? 1)
}

console.log('[clean] cargo clean (src-tauri)')
run('cargo', ['clean'], join(root, 'src-tauri'))

console.log('[clean] removing dist/')
rmSync(join(root, 'dist'), { recursive: true, force: true })

console.log('[clean] done')

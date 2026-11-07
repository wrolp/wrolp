// Remove build output so the next build starts from nothing.
//
// Two targets, because they answer different questions:
//
//   `node scripts/clean.mjs`            dev output — `cargo clean` in `src-tauri`
//                                       plus Vite's `dist/`.
//   `node scripts/clean.mjs --release`  the release target dir only. Release
//                                       builds use their own directory (see
//                                       `release-paths.mjs`), so this never
//                                       fights rust-analyzer or a running app
//                                       over a mapped DLL.
//
// `cargo clean` (not `rm -rf src-tauri/target`) because it also honours a
// `CARGO_TARGET_DIR` override and keeps cargo's own bookkeeping consistent.

import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { releaseTargetDir, root } from './release-paths.mjs'

const releaseMode = process.argv.includes('--release')

function removeDir(label, dir) {
  console.log(`[clean] removing ${label}`)
  try {
    rmSync(dir, { recursive: true, force: true })
    return true
  } catch (e) {
    console.error(`[clean] could not remove ${dir}: ${e.message}`)
    return false
  }
}

if (releaseMode) {
  const dir = releaseTargetDir()
  console.log(`[clean] release target: ${dir}`)
  if (!removeDir('release target', dir)) process.exit(1)
  console.log('[clean] done')
  process.exit(0)
}

console.log('[clean] cargo clean (src-tauri)')
const res = spawnSync('cargo', ['clean'], {
  stdio: 'inherit',
  cwd: join(root, 'src-tauri'),
})
if (res.error) {
  console.error(`[clean] failed to run cargo: ${res.error.message}`)
  process.exit(1)
}
if (res.status !== 0) {
  // On Windows this is usually a mapped proc-macro DLL: rust-analyzer keeps them
  // open, so the file cannot be deleted. Say what to do instead of just failing.
  console.error(
    '[clean] cargo clean failed. On Windows this is almost always rust-analyzer\n' +
      '  (or a running `tauri dev` app) holding files in src-tauri/target:\n' +
      '    - restart rust-analyzer in the editor, or close the running app, then retry;\n' +
      '    - or leave the dev target alone — `yarn run publish` cleans its own\n' +
      '      release target (src-tauri/target-release) and does not need this step.',
  )
  process.exit(res.status ?? 1)
}

removeDir('dist/', join(root, 'dist'))
console.log('[clean] done')

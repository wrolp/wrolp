// Reclaim disk space after a release build.
//
// A release leaves a lot behind that nothing reads again: `debug/`, `tmp/`,
// cargo's `.fingerprint` / `.rustc_info.json`, and the incremental caches. Only
// the `release/` directories are kept — with `--target <triple>` builds that is
// `target-release/<triple>/release/`, which holds the bundle
// (`release/bundle/msi/…`) and the signature beside it that the packaging steps
// and `upload-release.mjs` read.
//
// Consequence: the next release compiles the dependency tree from scratch unless
// `CARGO_TARGET_DIR`/`RELEASE_SKIP_CLEAN` is used to reuse this directory.
//
// Set `RELEASE_KEEP_TARGET=1` to skip the prune (e.g. while iterating on the
// packaging steps and wanting the incremental build to stay warm).

import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { releaseTargetDir } from './release-paths.mjs'

const KEEP = 'release'

function sizeOf(path) {
  let total = 0
  const stack = [path]
  while (stack.length > 0) {
    const current = stack.pop()
    let stat
    try {
      stat = statSync(current)
    } catch {
      continue
    }
    if (stat.isDirectory()) {
      for (const entry of readdirSync(current)) stack.push(join(current, entry))
    } else {
      total += stat.size
    }
  }
  return total
}

const mb = (bytes) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`

const dir = releaseTargetDir()
if (!existsSync(dir)) {
  console.log(`[prune] nothing to prune: ${dir} does not exist`)
  process.exit(0)
}

if (process.env.RELEASE_KEEP_TARGET === '1') {
  console.log('[prune] RELEASE_KEEP_TARGET=1 — leaving the target dir as it is')
  process.exit(0)
}

let freed = 0
let removed = 0
const kept = []

function prune(full) {
  const before = sizeOf(full)
  try {
    rmSync(full, { recursive: true, force: true })
    freed += before
    removed++
  } catch (e) {
    // The build already succeeded; a locked leftover must not fail the release.
    console.warn(`[prune] could not remove ${full}: ${e.message}`)
  }
}

for (const entry of readdirSync(dir)) {
  if (entry === KEEP) {
    kept.push(join(dir, entry))
    continue
  }
  const full = join(dir, entry)
  let isDir = false
  try {
    isDir = statSync(full).isDirectory()
  } catch {
    continue
  }
  // A `--target <triple>` build dir: keep its release/ and drop the caches
  // cargo left beside it.
  if (isDir && existsSync(join(full, KEEP))) {
    kept.push(join(full, KEEP))
    for (const sub of readdirSync(full)) {
      if (sub !== KEEP) prune(join(full, sub))
    }
    continue
  }
  prune(full)
}

console.log(
  `[prune] kept ${kept.join(', ') || 'nothing'}; removed ${removed} entr${removed === 1 ? 'y' : 'ies'} (${mb(freed)})`,
)

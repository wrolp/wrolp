// Where a release build puts its artifacts.
//
// Releases build into their own target dir (`src-tauri/target-release`) instead
// of the shared `src-tauri/target`:
//
//   - `cargo clean` on the shared dir fails on Windows with `os error 5` while
//     rust-analyzer (or a running `tauri dev` app) has proc-macro DLLs mapped —
//     the clean is exactly what a release needs, so it must not depend on what
//     other tooling is doing.
//   - the dev target stays warm, so a release no longer costs the next
//     `cargo test` a full rebuild.
//
// `CARGO_TARGET_DIR` wins when it is set, so a user-configured layout (or CI)
// keeps working. Everything in the release chain reads the paths from here.

import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The Windows bundles a release ships: one MSI per architecture. A build run
 * with `--target <triple>` puts cargo output under `<target dir>/<triple>/`,
 * so these triples are both the cargo targets and a path segment.
 *
 * `arch` is the token the MSI filename carries (`_x64.msi` / `_arm64.msi`);
 * `updater` is the key the Tauri updater looks up in latest.json.
 */
export const RELEASE_TARGETS = [
  { triple: 'x86_64-pc-windows-msvc', arch: 'x64', updater: 'windows-x86_64' },
  { triple: 'aarch64-pc-windows-msvc', arch: 'arm64', updater: 'windows-aarch64' },
]

/** The target dir a release builds into, absolute. */
export function releaseTargetDir() {
  const configured = process.env.CARGO_TARGET_DIR?.trim()
  if (configured) {
    return isAbsolute(configured) ? configured : resolve(root, configured)
  }
  return join(root, 'src-tauri', 'target-release')
}

export function releaseBundleDir(triple) {
  return join(releaseTargetDir(), triple, 'release', 'bundle')
}

export function releaseMsiDir(triple) {
  return join(releaseBundleDir(triple), 'msi')
}

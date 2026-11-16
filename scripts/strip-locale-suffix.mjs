// Strip the "_en-US" (or any "_<lang>" / "_<lang>-<REGION>") suffix from built
// bundle artifacts so the MSI / signature filenames are locale-free.
//
// Usage: node scripts/strip-locale-suffix.mjs [bundleDir]
//   Without an argument every release target's bundle dir is processed
//   (see RELEASE_TARGETS in release-paths.mjs).
//
// Example:
//   wrolp-terminal_0.0.3_x64_en-US.msi   -> wrolp-terminal_0.0.3_x64.msi
//   wrolp-terminal_0.0.3_arm64_en-US.msi -> wrolp-terminal_0.0.3_arm64.msi
//   wrolp-terminal_0.0.3_x64_en-US.msi.sig -> wrolp-terminal_0.0.3_x64.msi.sig

import { readdirSync, renameSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { RELEASE_TARGETS, releaseBundleDir } from './release-paths.mjs'

const explicitDir = process.argv[2]
const bundleDirs = explicitDir
  ? [explicitDir]
  : RELEASE_TARGETS.map((t) => releaseBundleDir(t.triple))

// Matches a trailing "_en-US", "_zh-CN", "_en_US", etc., anchored right before
// the file extension (the whole filename must be tested, extension included).
// A Tauri signature is `<artifact>.sig`, so the locale sits before `msi.sig`;
// the lookahead has to accept the combined tail or signatures never get
// renamed and `gen-latest-json.mjs` starts looking for a file that is not there.
const LOCALE_RE = /_[a-zA-Z]{2,3}(?:[-_][a-zA-Z]{2,})?(?=\.(msi|exe|app|deb|rpm)(?:\.sig)?$)/

function basename(p) {
  return p.split('\\').pop().split('/').pop()
}

function walk(dir) {
  if (!existsSync(dir)) return []
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

let renamed = 0
for (const bundleDir of bundleDirs) {
  if (!existsSync(bundleDir)) {
    console.error(`[strip-locale] bundle dir not found: ${bundleDir}`)
    process.exit(1)
  }
  for (const file of walk(bundleDir)) {
    const name = basename(file)
    // Test against the FULL filename — the regex lookahead needs the extension.
    if (LOCALE_RE.test(name)) {
      const newName = name.replace(LOCALE_RE, '')
      const newPath = join(file.slice(0, file.length - name.length), newName)
      if (newPath !== file) {
        renameSync(file, newPath)
        console.log(`[strip-locale] ${name} -> ${newName}`)
        renamed++
      }
    }
  }
}
console.log(`[strip-locale] done. ${renamed} file(s) renamed.`)

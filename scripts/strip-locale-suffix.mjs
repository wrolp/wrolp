// Strip the "_en-US" (or any "_<lang>" / "_<lang>-<REGION>") suffix from built
// bundle artifacts so the MSI / signature filenames are locale-free.
//
// Usage: node scripts/strip-locale-suffix.mjs [bundleDir]
//   bundleDir defaults to src-tauri/target/release/bundle
//
// Example:
//   wrolp-terminal_0.0.3_x64_en-US.msi   -> wrolp-terminal_0.0.3_x64.msi
//   wrolp-terminal_0.0.3_x64_en-US.msi.sig -> wrolp-terminal_0.0.3_x64.msi.sig

import { readdirSync, renameSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')

const bundleDir =
  process.argv[2] || join(root, 'src-tauri', 'target', 'release', 'bundle')

// Matches a trailing "_en-US", "_zh-CN", "_en_US", etc., anchored right before
// the file extension (the whole filename must be tested, extension included).
const LOCALE_RE = /_[a-zA-Z]{2,3}(?:[-_][a-zA-Z]{2,})?(?=\.(msi|exe|app|deb|rpm|sig)$)/

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

function main() {
  if (!existsSync(bundleDir)) {
    console.error(`[strip-locale] bundle dir not found: ${bundleDir}`)
    process.exit(1)
  }
  const files = walk(bundleDir)
  let renamed = 0
  for (const file of files) {
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
  console.log(`[strip-locale] done. ${renamed} file(s) renamed.`)
}

main()

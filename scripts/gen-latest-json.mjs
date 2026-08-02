// Generate latest.json for the Tauri auto-updater from the built MSI + its .sig.
//
// Prerequisites:
//   1. Build & sign the app so a .sig file exists next to the .msi:
//        yarn release   (auto-loads .tauri/priv.key as TAURI_SIGNING_PRIVATE_KEY)
//   2. The MSI must have been renamed WITHOUT the _en-US suffix by build:release.
//
// This script also auto-loads the signing private key from .tauri/priv.key into
// the TAURI_SIGNING_PRIVATE_KEY env var (and .tauri/priv.key.pass into
// TAURI_SIGNING_PRIVATE_KEY_PASSWORD if present), so it can be reused for any
// signing step without manual `set`.
//
// Usage:
//   node scripts/gen-latest-json.mjs [--out <path>] [--notes "..."] [--tag v0.0.3]
//
// Output: latest.json in the bundle msi dir (or --out), e.g.
// {
//   "version": "0.0.3",
//   "notes": "...",
//   "pub_date": "2026-08-02T16:00:00Z",
//   "platforms": {
//     "windows-x86_64": {
//       "signature": "<contents of .sig>",
//       "url": "https://github.com/wrolp/wrolp/releases/download/v0.0.3/wrolp-terminal_0.0.3_x64.msi"
//     }
//   }
// }

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')

// ---- load signing key from .tauri/priv.key ----
const keyPath = join(root, '.tauri', 'priv.key')
if (existsSync(keyPath)) {
  process.env.TAURI_SIGNING_PRIVATE_KEY = readFileSync(keyPath, 'utf8').trim()
  console.log(`[gen-latest] TAURI_SIGNING_PRIVATE_KEY loaded from ${keyPath}`)
  console.log(`[gen-latest] TAURI_SIGNING_PRIVATE_KEY=${process.env.TAURI_SIGNING_PRIVATE_KEY}`)
  const passPath = keyPath + '.pass'
  if (existsSync(passPath)) {
    process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = readFileSync(passPath, 'utf8').trim()
  }
  console.log('[gen-latest] TAURI_SIGNING_PRIVATE_KEY loaded from .tauri/priv.key')
} else {
  console.warn('[gen-latest] .tauri/priv.key not found — no signing key loaded.')
}

// ---- parse args ----
let outPath = null
let notes = ''
let tagOverride = null
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]
  if (a === '--out') outPath = process.argv[++i]
  else if (a === '--notes') notes = process.argv[++i]
  else if (a === '--tag') tagOverride = process.argv[++i]
}

// ---- read tauri.conf.json ----
const confPath = join(root, 'src-tauri', 'tauri.conf.json')
const conf = JSON.parse(readFileSync(confPath, 'utf8'))
const productName = conf.productName
const version = conf.version
const endpoint = conf.plugins?.updater?.endpoints?.[0] || ''
// Derive the owner/repo from the endpoint, e.g.
// https://github.com/wrolp/wrolp/releases/latest/download/latest.json
const m = endpoint.match(/github\.com\/([^/]+)\/([^/]+)\/releases/)
const owner = m?.[1] || 'wrolp'
const repo = m?.[2] || 'wrolp'
const tag = tagOverride || `v${version}`

// ---- locate the built MSI (suffix-free) ----
const msiDir = join(root, 'src-tauri', 'target', 'release', 'bundle', 'msi')
if (!existsSync(msiDir)) {
  console.error(`[gen-latest] MSI dir not found: ${msiDir}\n  Run "yarn release" first.`)
  process.exit(1)
}
const msiFile = readdirSync(msiDir).find(
  (f) => f.startsWith(productName) && f.endsWith('_x64.msi')
)
if (!msiFile) {
  console.error(
    `[gen-latest] No suffix-free MSI found in ${msiDir}.\n` +
      `  Expected "${productName}_${version}_x64.msi". Did you run "yarn release"?`
  )
  process.exit(1)
}
const sigFile = msiFile + '.sig'
const sigPath = join(msiDir, sigFile)
if (!existsSync(sigPath)) {
  // Self-sign the MSI using the loaded private key so we can still produce a
  // valid .sig without a full rebuild.
  if (!process.env.TAURI_SIGNING_PRIVATE_KEY) {
    console.error(
      `[gen-latest] Signature file missing: ${sigPath}\n` +
        `  No private key available to sign. Put your key at .tauri/priv.key.`
    )
    process.exit(1)
  }
  console.log('[gen-latest] .sig missing — signing the MSI with loaded private key ...')
  // TAURI_SIGNING_PRIVATE_KEY is already set from .tauri/priv.key above, so the
  // signer will use it directly (no conflicting --private-key flag needed).
  const signArgs = ['tauri', 'signer', 'sign', join(msiDir, msiFile)]
  const res = spawnSync('npx', signArgs, { stdio: 'inherit', shell: true, cwd: root })
  if (res.status !== 0 || !existsSync(sigPath)) {
    console.error(`[gen-latest] Failed to sign MSI.`)
    process.exit(1)
  }
  console.log(`[gen-latest] signed -> ${sigPath}`)
}

const signature = readFileSync(sigPath, 'utf8').trim()
const url = `https://github.com/${owner}/${repo}/releases/download/${tag}/${msiFile}`

const latest = {
  version,
  notes: notes || `Release ${version}`,
  pub_date: new Date().toISOString(),
  platforms: {
    'windows-x86_64': {
      signature,
      url,
    },
  },
}

const out = outPath ? resolve(root, outPath) : join(msiDir, 'latest.json')
writeFileSync(out, JSON.stringify(latest, null, 2) + '\n', 'utf8')
console.log(`[gen-latest] wrote ${out}`)
console.log(`[gen-latest] version=${version} url=${url}`)

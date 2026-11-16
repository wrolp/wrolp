// Upload built artifacts (.msi + latest.json) to a GitHub Release.
// NOTE: the .sig file is intentionally NOT uploaded as a release asset —
// the signature lives inside latest.json (required by the Tauri updater),
// and the standalone .sig is kept local-only.
//
// One-shot helper that ties together the build pipeline output and publishes
// it so the Tauri auto-updater endpoint resolves correctly.
//
// Prerequisites:
//   0. HEAD carries the version tag being published (`git tag --points-at HEAD`),
//      otherwise this script stops before touching `gh` — see release-tag-guard.mjs.
//   1. Run the full release pipeline first so the artifacts exist on disk:
//        yarn release            (build -> strip _en-US -> gen latest.json)
//   or, if you only want to (re)publish existing artifacts:
//        node scripts/gen-latest-json.mjs
//   2. `gh` CLI installed and authenticated (`gh auth login`).
//      The authenticated account must have push access to the target repo.
//
// Usage:
//   node scripts/upload-release.mjs [--tag v0.0.3] [--notes "..."] [--draft] [--pre]
//     --tag   Release/tag name (default: v<version> from tauri.conf.json); it must
//             be a tag on HEAD, exactly like the default one.
//     --notes Release notes text (default: "Release <version>")
//     --draft Create as a draft release (no auto-update until published)
//     --pre   Mark the release as a pre-release
//
// The artifacts uploaded (from src-tauri/target-release/<triple>/release/bundle/msi/):
//   - <productName>_<version>_x64.msi
//   - <productName>_<version>_arm64.msi
//   - latest.json (both platforms)

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { requireVersionTag } from './release-tag-guard.mjs'
import { RELEASE_TARGETS, releaseMsiDir } from './release-paths.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')

// ---- parse args ----
let tagOverride = null
let notes = ''
let draft = false
let pre = false
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]
  if (a === '--tag') tagOverride = process.argv[++i]
  else if (a === '--notes') notes = process.argv[++i]
  else if (a === '--draft') draft = true
  else if (a === '--pre') pre = true
}

// ---- read tauri.conf.json ----
const confPath = join(root, 'src-tauri', 'tauri.conf.json')
const conf = JSON.parse(readFileSync(confPath, 'utf8'))
const productName = conf.productName
const version = conf.version
const endpoint = conf.plugins?.updater?.endpoints?.[0] || ''
const m = endpoint.match(/github\.com\/([^/]+)\/([^/]+)\/releases/)
const owner = m?.[1] || 'wrolp'
const repo = m?.[2] || 'wrolp'
const tag = tagOverride || `v${version}`

// ---- refuse to publish from an untagged workspace ----
requireVersionTag({ root, tag, version, label: 'upload' })

// ---- locate artifacts ----
const msiFiles = []
const missing = []
for (const target of RELEASE_TARGETS) {
  const msiDir = releaseMsiDir(target.triple)
  if (!existsSync(msiDir)) {
    missing.push(`${msiDir} (${target.triple})`)
    continue
  }
  const msiFile = readdirSync(msiDir).find(
    (f) => f.startsWith(productName) && f.endsWith(`_${target.arch}.msi`),
  )
  if (!msiFile) {
    missing.push(`${msiDir}/${productName}_${version}_${target.arch}.msi`)
    continue
  }
  msiFiles.push(join(msiDir, msiFile))
}
const latestPath = join(releaseMsiDir(RELEASE_TARGETS[0].triple), 'latest.json')
if (!existsSync(latestPath)) missing.push(latestPath)
if (missing.length) {
  console.error(
    `[upload] Missing artifact(s):\n  ${missing.join('\n  ')}\n` +
      `  Run "yarn release" (or "node scripts/gen-latest-json.mjs") first.`,
  )
  process.exit(1)
}

// Only the MSIs + latest.json are uploaded. The .sig files are intentionally
// NOT uploaded (they stay local; each signature is already embedded in
// latest.json).
const files = [...msiFiles, latestPath]

// ---- check gh CLI ----
// No `shell: true` anywhere below: `gh` is a real executable on every platform
// (gh.exe on Windows), so nothing here needs one — and Node ≥22 deprecates
// (DEP0190) an args array passed together with `shell: true`, because the
// arguments are then concatenated into a command string without being escaped.
const ghCheck = spawnSync('gh', ['--version'], { stdio: 'ignore' })
if (ghCheck.status !== 0) {
  console.error('[upload] `gh` CLI not found. Install it and run `gh auth login`.')
  process.exit(1)
}

// ---- ensure release exists ----
const tagArgs = ['gh', 'release', 'view', tag, '--repo', `${owner}/${repo}`]
const viewRes = spawnSync(tagArgs[0], tagArgs.slice(1), { stdio: 'ignore' })
if (viewRes.status !== 0) {
  console.log(`[upload] Release ${tag} not found — creating it ...`)
  const createArgs = [
    'gh',
    'release',
    'create',
    tag,
    '--repo',
    `${owner}/${repo}`,
    '--title',
    tag,
    '--notes',
    notes || `Release ${version}`,
  ]
  if (draft) createArgs.push('--draft')
  if (pre) createArgs.push('--prerelease')
  const res = spawnSync(createArgs[0], createArgs.slice(1), { stdio: 'inherit' })
  if (res.status !== 0) {
    console.error('[upload] Failed to create release.')
    process.exit(1)
  }
} else {
  console.log(`[upload] Release ${tag} already exists — will upload/replace files.`)
}

// ---- upload (--clobber replaces existing assets) ----
console.log(`[upload] Uploading ${files.length} files to ${owner}/${repo}@${tag} ...`)
const upArgs = [
  'gh',
  'release',
  'upload',
  tag,
  ...files.map((f) => resolve(f)),
  '--repo',
  `${owner}/${repo}`,
  '--clobber',
]
const upRes = spawnSync(upArgs[0], upArgs.slice(1), { stdio: 'inherit' })
if (upRes.status !== 0) {
  console.error('[upload] Upload failed.')
  process.exit(1)
}

console.log('[upload] Done.')
console.log(
  `[upload] latest.json: https://github.com/${owner}/${repo}/releases/download/${tag}/latest.json`,
)

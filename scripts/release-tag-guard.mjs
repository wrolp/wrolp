// Preflight for the release pipeline: build and upload only from a workspace that
// is sitting ON a version tag.
//
// Without it, `yarn publish` compiles whatever happens to be in the tree and labels
// the MSI with `version` from tauri.conf.json — so a few commits after the bump the
// artifact named `…_0.0.11.msi` no longer contains 0.0.11, and `gh release create
// v0.0.11` tags whatever commit it resolves on the remote rather than the one that
// was compiled. The auto-updater then hands every installed app a binary that
// cannot be traced back to any commit.

import { spawnSync } from 'node:child_process'

const git = (args, root) => {
  const res = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (res.status !== 0) {
    return { ok: false, out: (res.stderr || res.error?.message || '').trim() }
  }
  return { ok: true, out: res.stdout.trim() }
}

/**
 * Exit unless `ref` (HEAD by default) carries `tag`.
 *
 * `label` prefixes the message with the script that stopped, and `version` is only
 * used to tell the user what the tag ought to match.
 */
export function requireVersionTag({ root, tag, version, label, ref = 'HEAD' }) {
  const res = git(['tag', '--points-at', ref], root)
  if (!res.ok) {
    console.error(`[${label}] git tag --points-at ${ref} failed: ${res.out}`)
    process.exit(1)
  }
  const tags = res.out ? res.out.split(/\r?\n/).filter(Boolean) : []
  if (tags.includes(tag)) return tags

  const where = tags.length
    ? `${ref} carries ${tags.join(', ')} — not ${tag}`
    : `${ref} carries no tag at all`
  console.error(
    `[${label}] Refusing to continue: ${where}.\n` +
      `  A release must be built from the commit that is the version it ships` +
      ` (tauri.conf.json says ${version}).\n` +
      `  Commit the version bump, then tag that commit and publish from it:\n` +
      `    git tag ${tag} && git push origin ${tag}\n` +
      `  Publish stopped before anything was built or uploaded.`,
  )
  process.exit(1)
}

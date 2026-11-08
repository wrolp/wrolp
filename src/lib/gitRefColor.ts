// Stable colour coding for branch and tag refs, mirroring the Kubernetes
// namespace palette: the colour follows the name, not the row's position, so a
// branch keeps one hue across refreshes and hosts. Pure so tests can pin the
// mapping without mounting the panel.

/** Must match the number of `--git-ref-color-*` tokens in `_git.scss`. */
export const GIT_REF_COLOR_COUNT = 7

/** FNV-1a over the ref name, folded into the palette size. */
export function gitRefColorIndex(name: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0) % GIT_REF_COLOR_COUNT
}

/** `%D` decorations either name a branch (`HEAD -> main`) or a tag (`tag: v1`). */
export function gitRefName(ref: string): string {
  if (ref.startsWith('HEAD -> ')) return ref.slice('HEAD -> '.length)
  if (ref.startsWith('tag: ')) return ref.slice('tag: '.length)
  return ref
}

/** The CSS custom property `_git.scss` defines for this ref. */
export function gitRefColor(ref: string): string {
  return `var(--git-ref-color-${gitRefColorIndex(gitRefName(ref))})`
}

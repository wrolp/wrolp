// Stable colour coding for Kubernetes namespaces in All-namespaces mode.
//
// The colour is derived from the name, not from the row's position or from an
// ever-growing map: the same namespace keeps its colour across refreshes,
// context switches and restarts, and two rows from the same namespace always
// agree. Pure so the mapping is pinned by tests without mounting the panel.

/** Must match the number of `--*-soft-40` entries in `_k8s.scss`. */
export const NAMESPACE_COLOR_COUNT = 7

/** FNV-1a over the namespace name, folded into the palette size. */
export function namespaceColorIndex(namespace: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < namespace.length; i++) {
    hash ^= namespace.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0) % NAMESPACE_COLOR_COUNT
}

/** The class `_k8s.scss` uses to bind `--ns-color` for this namespace. */
export function namespaceColorClass(namespace: string): string {
  return `k8s-ns-color-${namespaceColorIndex(namespace)}`
}

/**
 * Colours for one screenful of namespaces, with no duplicates.
 *
 * A pure hash collides (`apps` and `prod` both land on 1), and two rows in the
 * same list must never look alike, so the hash is only the *starting* slot: each
 * name probes forward to the first free one. Names are processed in sorted order
 * so the assignment depends on the set, not on the order the rows arrived in.
 * Beyond `NAMESPACE_COLOR_COUNT` namespaces the palette has to repeat.
 */
export function namespaceColorMap(namespaces: Iterable<string>): Map<string, number> {
  const names = [...new Set([...namespaces].filter((n) => n.length > 0))].sort()
  const used = new Set<number>()
  const out = new Map<string, number>()
  for (const name of names) {
    let index = namespaceColorIndex(name)
    for (let step = 0; step < NAMESPACE_COLOR_COUNT && used.has(index); step++) {
      index = (index + 1) % NAMESPACE_COLOR_COUNT
    }
    used.add(index)
    out.set(name, index)
  }
  return out
}

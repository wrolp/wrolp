// Terminal split-tree model (Phase 2 — VSCode-style terminal panes).
//
// The tree is the source of truth for how the terminal area is laid out.
// Each leaf binds exactly one session (tabId). Branches recursively split the
// area into a row/column grid. The structure is intentionally ephemeral
// (`tabId`s are session-scoped and not persisted to layout.json).

export type SplitDirection = 'row' | 'column'

export interface SplitLeaf {
  id: string
  type: 'leaf'
  tabId: number | null
}

export interface SplitBranch {
  id: string
  type: 'split'
  dir: SplitDirection
  children: SplitNode[]
  sizes: number[]
}

export type SplitNode = SplitLeaf | SplitBranch

export function makeLeaf(id: string, tabId: number | null = null): SplitLeaf {
  return { id, type: 'leaf', tabId }
}

export function findLeaf(node: SplitNode, id: string): SplitLeaf | null {
  if (node.id === id) return node.type === 'leaf' ? node : null
  if (node.type === 'split') {
    for (const c of node.children) {
      const r = findLeaf(c, id)
      if (r) return r
    }
  }
  return null
}

export function collectLeaves(node: SplitNode, acc: SplitLeaf[] = []): SplitLeaf[] {
  if (node.type === 'leaf') acc.push(node)
  else node.children.forEach((c) => collectLeaves(c, acc))
  return acc
}

export function buildTabToLeaf(node: SplitNode, map: Map<number, string> = new Map()): Map<number, string> {
  if (node.type === 'leaf') {
    if (node.tabId != null) map.set(node.tabId, node.id)
  } else {
    node.children.forEach((c) => buildTabToLeaf(c, map))
  }
  return map
}

export function updateLeafTab(node: SplitNode, leafId: string, tabId: number | null): SplitNode {
  if (node.type === 'leaf') {
    if (node.id === leafId) return { ...node, tabId }
    return node
  }
  return { ...node, children: node.children.map((c) => updateLeafTab(c, leafId, tabId)) }
}

// Replace the leaf `leafId` with a branch containing [originalLeaf, newLeaf(tabId)].
export function splitLeaf(
  node: SplitNode,
  leafId: string,
  newTabId: number | null,
  dir: SplitDirection,
  makeId: () => string,
): { tree: SplitNode; newLeafId: string } {
  if (node.type === 'leaf') {
    if (node.id === leafId) {
      const nl = makeLeaf(makeId(), newTabId)
      return {
        tree: { id: makeId(), type: 'split', dir, children: [node, nl], sizes: [0.5, 0.5] },
        newLeafId: nl.id,
      }
    }
    return { tree: node, newLeafId: '' }
  }
  let newLeafId = ''
  const children = node.children.map((c) => {
    const r = splitLeaf(c, leafId, newTabId, dir, makeId)
    if (r.newLeafId) newLeafId = r.newLeafId
    return r.tree
  })
  if (newLeafId) return { tree: { ...node, children }, newLeafId }
  return { tree: node, newLeafId: '' }
}

// Remove a leaf entirely; collapse branches with a single remaining child.
// Returns `null` only when the root node itself was the removed leaf.
export function removeLeafById(node: SplitNode, leafId: string, makeId: () => string): SplitNode | null {
  if (node.type === 'leaf') {
    if (node.id === leafId) return null
    return node
  }
  const children = node.children
    .map((c) => removeLeafById(c, leafId, makeId))
    .filter((c): c is SplitNode => c !== null)
  if (children.length === 1) return children[0]
  if (children.length === 0) return makeLeaf(makeId())
  return { ...node, children }
}

// Remove every leaf whose `tabId` is null, then collapse branches left with a
// single child. Used after closing a pane so an empty/dead pane never lingers
// beside a live one (which would otherwise show up as a blank split side). A
// root that ends up with no leaves is replaced by a single empty leaf. A root
// that is already a single empty leaf is returned unchanged.
export function pruneEmptyLeaves(node: SplitNode, makeId: () => string): SplitNode {
  if (node.type === 'leaf') return node
  const kept = node.children
    .map((c, i) => ({ child: pruneEmptyLeaves(c, makeId), size: node.sizes[i] ?? 1 }))
    .filter((x) => !(x.child.type === 'leaf' && x.child.tabId == null))
  if (kept.length === 1) return kept[0].child
  if (kept.length === 0) return makeLeaf(makeId())
  const total = kept.reduce((s, x) => s + x.size, 0) || 1
  return { ...node, children: kept.map((x) => x.child), sizes: kept.map((x) => x.size / total) }
}

// Adjust two adjacent sibling sizes (used by the split divider drag).
export function adjustSiblingSizes(
  node: SplitNode,
  branchId: string,
  i: number,
  j: number,
  si: number,
  sj: number,
): SplitNode {
  if (node.type === 'split') {
    if (node.id === branchId) {
      const sizes = node.sizes.slice()
      sizes[i] = si
      sizes[j] = sj
      return { ...node, sizes }
    }
    return { ...node, children: node.children.map((c) => adjustSiblingSizes(c, branchId, i, j, si, sj)) }
  }
  return node
}

export type DropPosition = 'left' | 'right' | 'top' | 'bottom' | 'center'

// Swap the session (tabId) shown by two leaves. Used for a 'center' drop and as
// the robust "reorder in place" primitive for terminal panes.
export function swapLeafTabs(node: SplitNode, a: string, b: string): SplitNode {
  const la = findLeaf(node, a)
  const lb = findLeaf(node, b)
  if (!la || !lb) return node
  let n = updateLeafTab(node, a, lb.tabId)
  n = updateLeafTab(n, b, la.tabId)
  return n
}

// Insert `source` as a sibling of the node whose id is `targetId`, before or
// after it, rebuilding the tree immutably.
function insertSibling(
  node: SplitNode,
  targetId: string,
  source: SplitNode,
  before: boolean,
  makeId: () => string,
): SplitNode {
  if (node.type === 'leaf') return node
  const idx = node.children.findIndex((c) => c.id === targetId)
  if (idx >= 0) {
    const children = node.children.slice()
    const at = before ? idx : idx + 1
    children.splice(at, 0, source)
    const sizes = node.sizes.slice()
    sizes.splice(at, 0, 0.5)
    const total = sizes.reduce((s, x) => s + x, 0) || 1
    return { ...node, children, sizes: sizes.map((s) => s / total) }
  }
  return { ...node, children: node.children.map((c) => insertSibling(c, targetId, source, before, makeId)) }
}

// Move the pane `sourceId` relative to `targetId` according to `position`.
//  - 'center' swaps the two panes' sessions (reorder in place).
//  - directional ('left'/'right'/'top'/'bottom') makes `source` a sibling of
//    `target`, inserted before/after, splitting the tree as needed.
export function movePane(
  tree: SplitNode,
  sourceId: string,
  targetId: string,
  position: DropPosition,
  makeId: () => string,
): SplitNode {
  if (sourceId === targetId) return tree
  const source = findLeaf(tree, sourceId)
  if (!source) return tree
  if (position === 'center') return swapLeafTabs(tree, sourceId, targetId)
  const before = position === 'left' || position === 'top'
  const without = removeLeafById(tree, sourceId, makeId)
  if (!without) return tree
  // Target is the only remaining leaf -> wrap both in a fresh split.
  if (without.type === 'leaf' && without.id === targetId) {
    const dir: SplitDirection = position === 'top' || position === 'bottom' ? 'column' : 'row'
    const children = before ? [source, without] : [without, source]
    return { id: makeId(), type: 'split', dir, children, sizes: [0.5, 0.5] }
  }
  return insertSibling(without, targetId, source, before, makeId)
}

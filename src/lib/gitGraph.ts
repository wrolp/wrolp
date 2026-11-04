// Commit-graph lane assignment, ported from the reference implementation's
// gitGraph.ts. The history list is already in topological order (git log), so a
// single pass suffices: each commit takes the lane that holds its oid (or the
// first free one), then that lane is handed to its first parent while extra
// parents open new lanes. Pure and dependency-free so the e2e spec can assert
// the lane table directly.

export interface GitGraphCommit {
  oid: string
  parents: string[]
}

export interface GitGraphRow {
  /** Zero-based lane this commit's dot sits in. */
  lane: number
  /** Number of lanes visible on this row (dot position + pass-through lines). */
  laneCount: number
}

export function computeLanes(commits: GitGraphCommit[]): GitGraphRow[] {
  const rows: GitGraphRow[] = []
  // Each slot holds the oid expected to appear next on that lane, or null.
  const lanes: (string | null)[] = []

  for (const commit of commits) {
    let lane = lanes.indexOf(commit.oid)
    if (lane === -1) {
      lane = lanes.findIndex((l) => l === null)
      if (lane === -1) {
        lane = lanes.length
        lanes.push(null)
      }
    }

    // Hand the lane to the first parent; extra parents branch into new lanes.
    lanes[lane] = commit.parents[0] ?? null
    for (const parent of commit.parents.slice(1)) {
      const existing = lanes.indexOf(parent)
      if (existing !== -1) continue
      const free = lanes.findIndex((l) => l === null)
      if (free === -1) lanes.push(parent)
      else lanes[free] = parent
    }

    rows.push({ lane, laneCount: lanes.length })
  }

  return rows
}

/** The number of distinct lanes a whole page needs (for the column width). */
export function graphLaneCount(rows: GitGraphRow[]): number {
  return rows.reduce((max, r) => Math.max(max, r.laneCount), 1)
}

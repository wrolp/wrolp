// Commit-graph lane assignment, ported from the reference implementation's
// gitGraph.ts. The history list is already in topological order (git log), so a
// single pass suffices: each commit takes the lane that holds its oid (or the
// first free one), then that lane is handed to its first parent while extra
// parents open new lanes. Each row also records the edges the renderer has to
// draw (pass-through lanes, branch curves), so drawing never re-walks the log.
// Pure and dependency-free so the e2e spec can assert the lane table directly.

export interface GitGraphCommit {
  oid: string
  parents: string[]
}

export interface GitGraphRow {
  /** Zero-based lane this commit's dot sits in. */
  lane: number
  /** Number of lanes visible on this row (dot position + pass-through lines). */
  laneCount: number
  /** A child above already reserved this lane, so an edge enters from the top. */
  incoming: boolean
  /** The dot lane continues below (a parent inherited it), so an edge leaves downward. */
  outgoing: boolean
  /** Lanes drawn as a continuous vertical line on this row, dot lane excluded. */
  passThrough: number[]
  /** Target lane of each parent edge, in parent order; `lane` needs no curve. */
  parentLanes: number[]
}

/**
 * Number of lane colours `_git.scss` defines (`--git-graph-0…5`). Colours are
 * picked by lane index so a lane keeps its colour while it lives.
 */
export const GRAPH_PALETTE_SIZE = 6

export function computeLanes(commits: GitGraphCommit[]): GitGraphRow[] {
  const rows: GitGraphRow[] = []
  // Each slot holds the oid expected to appear next on that lane, or null.
  const lanes: (string | null)[] = []

  for (const commit of commits) {
    let lane = lanes.indexOf(commit.oid)
    const incoming = lane !== -1
    if (lane === -1) {
      lane = lanes.findIndex((l) => l === null)
      if (lane === -1) {
        lane = lanes.length
        lanes.push(null)
      }
    }

    const before = [...lanes]
    const first = commit.parents[0]
    const parentLanes: number[] = []
    if (first === undefined) {
      lanes[lane] = null
    } else {
      // A merge may have already reserved the first parent on another lane;
      // curve into that lane and free this one instead of tracking it twice.
      const reserved = lanes.findIndex((l, i) => l === first && i !== lane)
      if (reserved === -1) {
        lanes[lane] = first
        parentLanes.push(lane)
      } else {
        lanes[lane] = null
        parentLanes.push(reserved)
      }
    }

    // Extra parents branch into a waiting lane, or a new one when none is free.
    for (const parent of commit.parents.slice(1)) {
      let target = lanes.indexOf(parent)
      if (target === -1) {
        target = lanes.findIndex((l) => l === null)
        if (target === -1) {
          target = lanes.length
          lanes.push(parent)
        } else {
          lanes[target] = parent
        }
      }
      parentLanes.push(target)
    }

    // Lanes occupied both before and after this commit keep a straight line;
    // lanes opened here are reached by a curve from the dot instead.
    const passThrough: number[] = []
    lanes.forEach((oid, l) => {
      if (l !== lane && oid !== null && before[l] != null) passThrough.push(l)
    })

    rows.push({
      lane,
      laneCount: lanes.length,
      incoming,
      outgoing: lanes[lane] !== null,
      passThrough,
      parentLanes,
    })
  }

  return rows
}

/** The number of distinct lanes a whole page needs (for the column width). */
export function graphLaneCount(rows: GitGraphRow[]): number {
  return rows.reduce((max, r) => Math.max(max, r.laneCount), 1)
}

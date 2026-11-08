import { test, expect, type Page } from './helpers/fixtures'
import { installTauriMock, invokedCalls, type TauriMockOptions } from './helpers/tauriMock'
import { selectRailMode } from './helpers/sections'
import { computeLanes, graphLaneCount } from '../../src/lib/gitGraph'

// P2 batch 2: the history list grows a commit-graph lane column and a click now
// expands the commit's changed files, each opening a commit-scope diff. The lane
// rules are pure, so they are asserted directly.

const REPO = 'D:\\repos\\demo'
const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const X = 'x'.repeat(40)

const COMMITS = [
  {
    oid: A,
    shortOid: 'aaaaaaa',
    authorName: 'Ann',
    authorEmail: 'ann@example.com',
    timestamp: 1760000000,
    parents: [B, X],
    refs: ['HEAD -> main'],
    subject: 'merge feature',
  },
  {
    oid: B,
    shortOid: 'bbbbbbb',
    authorName: 'Bob',
    authorEmail: 'bob@example.com',
    timestamp: 1759990000,
    parents: [],
    refs: [],
    subject: 'initial commit',
  },
]

const FILES = [
  { path: 'src/main.ts', status: 'M' },
  { path: 'src/added.ts', status: 'A' },
]

async function boot(page: Page, opts: TauriMockOptions = {}) {
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  await installTauriMock(page, { gitCommits: COMMITS, gitCommitFiles: FILES, ...opts })
  await page.goto('/')
  await selectRailMode(page, 'hosts')
  await page.locator('.conn-item.local-term-default').click()
  await selectRailMode(page, 'git')
  await page.locator('.git-path-row input').fill(REPO)
  await page.locator('.git-path-row button[type="submit"]').click()
  await expect(page.locator('.git-repo-root span')).toHaveText('demo')
}

test('lane assignment: linear commits share lane 0, a merge opens a second lane', async () => {
  const linear = computeLanes([
    { oid: 'c1', parents: ['c2'] },
    { oid: 'c2', parents: ['c3'] },
    { oid: 'c3', parents: [] },
  ])
  expect(linear.map((r) => r.lane)).toEqual([0, 0, 0])
  expect(graphLaneCount(linear)).toBe(1)
  expect(linear.map((r) => r.incoming)).toEqual([false, true, true])

  const merge = computeLanes([
    { oid: 'c1', parents: ['c2', 'x'] },
    { oid: 'c2', parents: [] },
  ])
  expect(merge.map((r) => r.lane)).toEqual([0, 0])
  expect(merge[0].laneCount).toBe(2)
  // The merge's second parent branches into lane 1, which keeps a straight
  // line on the next row while the commit's own lane enters its dot.
  expect(merge[0]).toMatchObject({
    incoming: false,
    outgoing: true,
    passThrough: [],
    parentLanes: [0, 1],
  })
  expect(merge[1]).toMatchObject({
    incoming: true,
    outgoing: false,
    passThrough: [1],
    parentLanes: [],
  })

  // A commit whose lane is already free reuses it rather than opening a new one.
  const branchy = computeLanes([
    { oid: 'c1', parents: ['x'] },
    { oid: 'x', parents: ['c3'] },
    { oid: 'c3', parents: [] },
  ])
  expect(branchy.map((r) => r.lane)).toEqual([0, 0, 0])

  // A first parent already reserved by an earlier merge curves into that lane
  // instead of being tracked twice (which used to leave a phantom lane).
  const reconverged = computeLanes([
    { oid: 'm', parents: ['n', 'p'] },
    { oid: 'n', parents: ['p'] },
    { oid: 'p', parents: [] },
  ])
  expect(reconverged.map((r) => r.lane)).toEqual([0, 0, 1])
  expect(reconverged[1]).toMatchObject({
    incoming: true,
    outgoing: false,
    parentLanes: [1],
  })
  expect(reconverged[2].incoming).toBe(true)
})

test('clicking a commit expands its file list and a file opens its diff', async ({ page }) => {
  await boot(page)

  const first = page.locator('.git-history-item').first()
  await first.locator('.git-commit-row').click()
  const files = first.locator('.git-commit-file')
  await expect(files).toHaveCount(2)
  await expect(files.first()).toContainText('src/main.ts')

  const calls = (await invokedCalls(page)).filter((c) => c.cmd === 'git_commit_files')
  expect(calls.at(-1)?.args).toMatchObject({ root: REPO, oid: A })

  await files.first().click()
  await expect(page.locator('.git-diff-modal')).toBeVisible()

  // Clicking the commit again collapses the list (after closing the diff modal).
  await page.locator('.git-diff-modal .k8s-modal-close').click()
  await first.locator('.git-commit-row').click()
  await expect(first.locator('.git-commit-file')).toHaveCount(0)
})

test('the graph column draws the merge curve, lane lines and the HEAD ring', async ({ page }) => {
  await boot(page)

  const rows = page.locator('.git-history-item')
  const first = rows.first()
  // A's second parent opens lane 1 with a curve from the dot.
  await expect(first.locator('.git-lane-curve')).toHaveCount(1)
  await expect(first.locator('.git-lane-dot.head')).toHaveCount(1)
  // B: the incoming edge into lane 0 plus the still-open lane 1 passing through.
  await expect(rows.nth(1).locator('.git-lane-line')).toHaveCount(2)
})

test('a clipped commit subject grows a tooltip on hover, a fitting one does not', async ({
  page,
}) => {
  const longSubject = 'a very long commit subject '.repeat(11) + 'end'
  await boot(page, { gitCommits: [{ ...COMMITS[0], subject: longSubject }, COMMITS[1]] })

  const clipped = page.locator('.git-commit-subject').first()
  await expect(clipped).not.toHaveAttribute('title', /.+/)
  await clipped.hover()
  await expect(clipped).toHaveAttribute('title', longSubject)

  const fitting = page.locator('.git-commit-subject').nth(1)
  await fitting.hover()
  await expect(fitting).not.toHaveAttribute('title', /.+/)
})

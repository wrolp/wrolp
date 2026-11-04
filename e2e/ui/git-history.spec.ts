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

  const merge = computeLanes([
    { oid: 'c1', parents: ['c2', 'x'] },
    { oid: 'c2', parents: [] },
  ])
  expect(merge.map((r) => r.lane)).toEqual([0, 0])
  expect(merge[0].laneCount).toBe(2)

  // A commit whose lane is already free reuses it rather than opening a new one.
  const branchy = computeLanes([
    { oid: 'c1', parents: ['x'] },
    { oid: 'x', parents: ['c3'] },
    { oid: 'c3', parents: [] },
  ])
  expect(branchy.map((r) => r.lane)).toEqual([0, 0, 0])
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

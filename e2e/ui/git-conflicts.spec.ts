import { test, expect, type Page } from './helpers/fixtures'
import { installTauriMock, invokedCalls, type TauriMockOptions } from './helpers/tauriMock'
import { selectRailMode } from './helpers/sections'

// P2 conflict handling: the in-progress banner offers an abort, and each
// conflicted row offers ours / theirs / mark-resolved. Like the panel specs,
// these assert the invokes a real interaction makes against the mock host.

const REPO = 'D:\\repos\\demo'

const CONFLICT_ENTRY = {
  path: 'src/main.ts',
  x: 'U',
  y: 'U',
  kind: 'conflicted',
  staged: true,
  unstaged: true,
  conflicted: true,
}

async function boot(page: Page, opts: TauriMockOptions = {}) {
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  await installTauriMock(page, {
    gitStatus: { entries: [CONFLICT_ENTRY] },
    gitConflicts: { inProgress: 'merge', paths: ['src/main.ts'] },
    ...opts,
  })
  await page.goto('/')
  await selectRailMode(page, 'hosts')
  await page.locator('.conn-item.local-term-default').click()
  await selectRailMode(page, 'git')
  await page.locator('.git-path-row input').fill(REPO)
  await page.locator('.git-path-row button[type="submit"]').click()
  await expect(page.locator('.git-repo-root span')).toHaveText('demo')
}

async function resolveCalls(page: Page) {
  return (await invokedCalls(page)).filter((c) => c.cmd === 'git_resolve')
}

test('a merge in progress gets a banner whose abort is offered', async ({ page }) => {
  await boot(page)
  const banner = page.locator('.git-conflict-banner')
  await expect(banner).toContainText('A merge is in progress')
  await banner.locator('button').click()
  await expect
    .poll(async () =>
      (await invokedCalls(page)).filter((c) => c.cmd === 'git_abort').map((c) => c.args),
    )
    .toContainEqual({ host: { kind: 'local' }, root: REPO, operation: 'merge' })
})

test('a conflicted row opens the three-way view and resolves from it', async ({ page }) => {
  await boot(page, {
    gitConflictStages: {
      base: 'const a = 0',
      ours: 'const a = 1',
      theirs: 'const a = 2',
      binary: false,
      truncated: false,
    },
  })

  await page.locator('.git-row-main', { hasText: 'src/main.ts' }).first().click()

  const modal = page.locator('.git-merge-modal')
  await expect(modal).toBeVisible()
  await expect(modal.locator('.git-merge-pane')).toHaveCount(3)
  await expect(modal.locator('.git-merge-pane').nth(1)).toContainText('const a = 1')
  await expect(modal.locator('.git-merge-pane').nth(2)).toContainText('const a = 2')

  expect(
    (await invokedCalls(page)).filter((c) => c.cmd === 'git_conflict_file').at(-1)?.args,
  ).toMatchObject({ root: REPO, path: 'src/main.ts' })

  await modal.getByRole('button', { name: 'Take theirs' }).click()
  await expect
    .poll(async () => (await resolveCalls(page)).at(-1)?.args)
    .toMatchObject({
      path: 'src/main.ts',
      resolution: 'theirs',
    })
  await expect(modal).toHaveCount(0)
})

test('a conflicted row resolves ours / theirs / mark resolved', async ({ page }) => {
  await boot(page)

  const row = page.locator('.git-row', { hasText: 'src/main.ts' })
  await row.hover()
  await row.getByTitle('Take ours').click()
  await expect
    .poll(async () => (await resolveCalls(page)).at(-1)?.args)
    .toMatchObject({
      root: REPO,
      path: 'src/main.ts',
      resolution: 'ours',
    })

  await row.hover()
  await row.getByTitle('Take theirs').click()
  await expect
    .poll(async () => (await resolveCalls(page)).at(-1)?.args)
    .toMatchObject({
      path: 'src/main.ts',
      resolution: 'theirs',
    })

  await row.hover()
  await row.getByTitle('Mark resolved').click()
  await expect
    .poll(async () => (await resolveCalls(page)).at(-1)?.args)
    .toMatchObject({
      path: 'src/main.ts',
      resolution: 'resolved',
    })

  // A conflicted row never offers discard or stage — the resolution buttons own it.
  expect(await row.locator('.git-mini-btn.danger').count()).toBe(0)
})

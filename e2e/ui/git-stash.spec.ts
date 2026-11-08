import { test, expect, type Page } from './helpers/fixtures'
import { installTauriMock, invokedCalls, type TauriMockOptions } from './helpers/tauriMock'
import { selectRailMode } from './helpers/sections'

// P3 stash: the commit box can shelve the working tree, and the stash section
// pops / applies / drops entries by index — the ref is rebuilt backend-side.

const REPO = 'D:\\repos\\demo'

const STASHES = [
  { index: 0, oid: 'f'.repeat(40), timestamp: 1760000000, message: 'WIP on main: tweak client' },
]

const DIRTY = {
  path: 'src/main.ts',
  x: '.',
  y: 'M',
  kind: 'modified',
  staged: false,
  unstaged: true,
  conflicted: false,
}

async function boot(page: Page, opts: TauriMockOptions = {}) {
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  await installTauriMock(page, {
    gitStatus: { entries: [DIRTY] },
    gitStashes: STASHES,
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

test('an existing stash is listed and pops by index', async ({ page }) => {
  await boot(page)

  const section = page.locator('.git-section').filter({ hasText: 'Stashes' })
  await expect(section.locator('.git-stash-index')).toHaveText('stash@{0}')
  await expect(section).toContainText('WIP on main: tweak client')

  const row = section.locator('.git-row').first()
  await row.hover()
  await row.locator('button[title="Apply the entry and drop it"]').click()
  await expect
    .poll(async () =>
      (await invokedCalls(page)).filter((c) => c.cmd === 'git_stash_entry').map((c) => c.args),
    )
    .toContainEqual(expect.objectContaining({ root: REPO, index: 0, action: 'pop' }))
})

test('the commit box stashes the working tree with the typed message', async ({ page }) => {
  await boot(page)

  await page.locator('.git-commit-box textarea').fill('park it')
  await page.locator('.git-stash-row input[type="checkbox"]').check()
  await page.locator('.git-stash-row button').click()

  await expect
    .poll(async () =>
      (await invokedCalls(page)).filter((c) => c.cmd === 'git_stash_push').map((c) => c.args),
    )
    .toContainEqual(
      expect.objectContaining({ root: REPO, message: 'park it', includeUntracked: true }),
    )
})

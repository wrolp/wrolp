import { test, expect, type Page } from './helpers/fixtures'
import { installTauriMock, invokedCalls, type TauriMockOptions } from './helpers/tauriMock'
import { selectRailMode } from './helpers/sections'

// P3 advanced reads / writes: blame is a read-only modal per file, and a forced
// push only ever goes out as `--force-with-lease` after an explicit confirm.

const REPO = 'D:\\repos\\demo'

const DIRTY = {
  path: 'src/main.ts',
  x: '.',
  y: 'M',
  kind: 'modified',
  staged: false,
  unstaged: true,
  conflicted: false,
}

const BLAME = [
  {
    line: 1,
    oid: 'a'.repeat(40),
    shortOid: 'aaaaaaa',
    author: 'Ann',
    timestamp: 1760000000,
    summary: 'initial commit',
    text: 'const a = 1',
  },
  {
    line: 2,
    oid: 'b'.repeat(40),
    shortOid: 'bbbbbbb',
    author: 'Bob',
    timestamp: 1760000100,
    summary: 'fix the client',
    text: 'const b = 2',
  },
]

async function boot(page: Page, opts: TauriMockOptions = {}) {
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  await installTauriMock(page, {
    gitStatus: { entries: [DIRTY] },
    gitBlameLines: BLAME,
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

test('the B action opens blame for that file', async ({ page }) => {
  await boot(page)

  const row = page.locator('.git-row', { hasText: 'src/main.ts' })
  await row.hover()
  await row.getByTitle('Blame this file').click()

  const modal = page.locator('.git-blame-modal')
  await expect(modal).toBeVisible()
  await expect(modal.locator('.git-blame-row')).toHaveCount(2)
  await expect(modal.locator('.git-blame-row').first()).toContainText('aaaaaaa')
  await expect(modal.locator('.git-blame-row').first()).toContainText('const a = 1')

  expect(
    (await invokedCalls(page)).filter((c) => c.cmd === 'git_blame').at(-1)?.args,
  ).toMatchObject({ root: REPO, path: 'src/main.ts', oid: null })
})

test('a forced push asks for confirmation and sends the force flag', async ({ page }) => {
  await boot(page)

  await page.locator('.git-network-actions button[title*="Force push"]').click()
  const dialog = page.locator('.modal-overlay', { hasText: 'Force push' })
  await expect(dialog).toBeVisible()

  // Cancelling must not push at all.
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  expect((await invokedCalls(page)).filter((c) => c.cmd === 'git_push')).toHaveLength(0)

  await page.locator('.git-network-actions button[title*="Force push"]').click()
  await page.locator('.modal-overlay button', { hasText: 'Force push' }).last().click()

  await expect
    .poll(async () =>
      (await invokedCalls(page)).filter((c) => c.cmd === 'git_push').map((c) => c.args),
    )
    .toContainEqual(expect.objectContaining({ root: REPO, force: true }))
})

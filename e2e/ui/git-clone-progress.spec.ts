import { test, expect, type Page } from './helpers/fixtures'
import { installTauriMock, invokedCalls, resolvePendingCall } from './helpers/tauriMock'
import { selectRailMode } from './helpers/sections'

// While a clone runs there is no repository yet, so the panel is still on the
// picker — the repo view's own progress bar is unreachable until the clone
// finishes. The picker therefore has to carry the progress read-out and the way
// out (Cancel), or the window looks frozen for the whole transfer.

const PARENT = 'D:\\repos'
const URL = 'https://github.com/acme/demo.git'

async function boot(page: Page, opts: Parameters<typeof installTauriMock>[1] = {}) {
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  await installTauriMock(page, opts)
  await page.goto('/')
  await selectRailMode(page, 'hosts')
  await page.locator('.conn-item.local-term-default').click()
  await selectRailMode(page, 'git')
  await page.locator('.git-path-row input').fill(PARENT)
  await page.getByRole('button', { name: 'Clone a repository…' }).click()
  await page.locator('.git-clone-row input').first().fill(URL)
}

async function startClone(page: Page) {
  await page.locator('.git-clone-row button[type="submit"]').click()
}

test('a clone shows its progress in the picker', async ({ page }) => {
  await boot(page, { gitCloneHold: true })
  await startClone(page)

  const bar = page.locator('.git-empty .git-progress')
  await expect(bar).toBeVisible()
  // Percent comes from the `git-progress` stream, not from a spinner.
  await expect(bar).toContainText('42%')
  await expect(bar.getByRole('button', { name: 'Cancel' })).toBeVisible()
})

test('Cancel stops the clone, reports it and brings the form back', async ({ page }) => {
  await boot(page, { gitCloneHold: true })
  await startClone(page)
  const bar = page.locator('.git-empty .git-progress')
  await expect(bar).toBeVisible()

  await bar.getByRole('button', { name: 'Cancel' }).click()

  await expect(bar).toHaveCount(0)
  // The cancel has to name the clone's own operation id, or the backend would
  // flag an unrelated (already finished) one.
  const calls = await invokedCalls(page)
  const cloneOp = calls.find((c) => c.cmd === 'git_clone')?.args.opId
  expect(cloneOp).toBeTruthy()
  await expect
    .poll(async () => (await invokedCalls(page)).filter((c) => c.cmd === 'git_cancel').at(-1)?.args)
    .toMatchObject({ opId: cloneOp })

  // "Cancelled." rather than a raw `git_cancelled:` stage, and the fields are back
  // so the user can retry without re-typing the URL.
  await expect(page.locator('.git-error')).toContainText('Cancelled')
  await expect(page.locator('.git-clone-row input').first()).toHaveValue(URL)
})

test('a clone that completes opens the new repository', async ({ page }) => {
  await boot(page, { gitCloneHold: true })
  await startClone(page)
  await expect(page.locator('.git-empty .git-progress')).toBeVisible()

  await resolvePendingCall(page)

  await expect(page.locator('.git-repo-root span')).toHaveText('demo')
  await expect(page.locator('.git-progress')).toHaveCount(0)
})

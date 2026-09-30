import { test, expect } from './helpers/fixtures'
import { installTauriMock } from './helpers/tauriMock'

// The activity rail is where a connection is picked, so a launch that resumes
// last session's panel costs a click before anything can be opened. It now
// always starts on hosts, whatever the window was closed with — and switching a
// mode stays in the window it happened in, since nothing records it any more.

async function boot(page: import('@playwright/test').Page, savedRailMode?: string) {
  await installTauriMock(page, { pollOutputChunks: [['root@demo:~$ ']] })
  if (savedRailMode) {
    await page.addInitScript(
      (saved) => localStorage.setItem('wrolp-rail-mode', saved),
      savedRailMode,
    )
  }
  await page.goto('/')
}

const rail = (page: import('@playwright/test').Page, mode: string) =>
  page.locator(`.rail-item[data-mode="${mode}"]`)

test('a launch put the rail on hosts even though the window closed on files', async ({ page }) => {
  await boot(page, 'files')
  await expect(rail(page, 'hosts')).toHaveClass(/active/)
  await expect(page.locator('.sidebar-container.mode-panel')).toHaveAttribute(
    'data-rail-mode',
    'hosts',
  )
})

test('switching a mode is not remembered for the next launch', async ({ page }) => {
  await boot(page)
  await rail(page, 'sessions').click()
  await expect(rail(page, 'sessions')).toHaveClass(/active/)
  await expect(rail(page, 'hosts')).not.toHaveClass(/active/)
  expect(await page.evaluate(() => localStorage.getItem('wrolp-rail-mode'))).toBeNull()

  await page.reload()
  await expect(rail(page, 'hosts')).toHaveClass(/active/)
})

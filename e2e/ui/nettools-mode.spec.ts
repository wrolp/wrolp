import { test, expect } from './helpers/fixtures'
import { installTauriMock } from './helpers/tauriMock'
import { selectRailMode } from './helpers/sections'

// The built-in FTP / HTTP / TFTP servers and the TFTP client used to be a modal
// (`NetToolsPanel` + `.nt-overlay`), which is why the rail had to treat 网络工具
// as an action. They are one of the rail's modes now: the same five tools, in the
// 264px column, so they can stay open next to a terminal.

async function boot(page: import('@playwright/test').Page) {
  await installTauriMock(page, {})
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  await page.goto('/')
  await expect(page.locator('.titlebar')).toBeVisible()
}

test('the network tools are a mode in the column, not a dialog', async ({ page }) => {
  await boot(page)
  await selectRailMode(page, 'nettools')

  await expect(page.locator('.mode-panel .nt-panel')).toBeVisible()
  // Nothing floating over the window: no overlay, and no close button to press.
  await expect(page.locator('.nt-overlay')).toHaveCount(0)
  await expect(page.locator('.nt-close')).toHaveCount(0)
  await expect(page.locator('.mode-panel .panel-head.sec .panel-title')).toHaveText([
    'Network file tools',
  ])
})

test('the tab strip fits the column and mounts one tool at a time', async ({ page }) => {
  await boot(page)
  await selectRailMode(page, 'nettools')

  const tabs = page.locator('.nt-tabs .nt-tab')
  // All five tools are reachable — the strip wraps rather than scrolling them
  // out of sight in a 264px column.
  await expect(tabs).toHaveCount(5)
  await expect(tabs.first()).toBeVisible()
  await expect(tabs.last()).toBeVisible()

  // Only the selected tool is mounted: four of the five panels poll every 1-2s,
  // and a mode stays mounted for as long as it is selected.
  const ftpRoot = page.locator('#ftp-root')
  await expect(ftpRoot).toHaveCount(1)
  await page.locator('.nt-tab', { hasText: 'TFTP client' }).click()
  await expect(ftpRoot).toHaveCount(0)
  await expect(page.locator('.nt-body .nt-card').first()).toBeVisible()
})

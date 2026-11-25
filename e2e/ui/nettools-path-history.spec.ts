import { test, expect, type Page } from './helpers/fixtures'
import { installTauriMock } from './helpers/tauriMock'
import { selectRailMode } from './helpers/sections'

// The network tools' path fields keep what was typed into them: a share folder
// is picked once and reused, the history menu offers what was used before, and a
// path that no longer exists can be dropped from that list.

async function boot(page: Page) {
  await installTauriMock(page, {})
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  await page.goto('/')
  await expect(page.locator('.titlebar')).toBeVisible()
  await selectRailMode(page, 'nettools')
}

test('a path survives tab switches and a reload', async ({ page }) => {
  await boot(page)
  const root = page.locator('#ftp-root')
  await expect(root).toHaveValue('')

  await root.fill('C:/share/one')
  await root.blur()
  // Another tool tab unmounts the FTP panel.
  await page.getByRole('button', { name: 'TFTP server', exact: true }).click()
  await expect(root).toHaveCount(0)
  await page.getByRole('button', { name: 'FTP server', exact: true }).click()
  await expect(page.locator('#ftp-root')).toHaveValue('C:/share/one')

  await page.reload()
  await selectRailMode(page, 'nettools')
  await expect(page.locator('#ftp-root')).toHaveValue('C:/share/one')
})

test('the history menu picks a path and can forget one', async ({ page }) => {
  await boot(page)
  const root = page.locator('#ftp-root')

  await root.fill('C:/share/one')
  await root.blur()
  await root.fill('D:/other')
  await root.blur()

  const history = page.getByRole('button', { name: 'Recent paths' })
  await history.click()
  const menu = page.locator('.nt-path-menu')
  await expect(menu).toBeVisible()
  const rows = menu.locator('.nt-path-row')
  await expect(rows).toHaveCount(2)
  // The most recently used path is the first row.
  await expect(rows.first()).toContainText('D:/other')

  await rows.filter({ hasText: 'C:/share/one' }).click()
  await expect(menu).toHaveCount(0)
  await expect(root).toHaveValue('C:/share/one')

  await history.click()
  await expect(page.locator('.nt-path-menu .nt-path-row')).toHaveCount(2)
  await page
    .locator('.nt-path-menu .nt-path-row', { hasText: 'D:/other' })
    .getByRole('button', { name: 'Remove from history' })
    .click()
  await expect(page.locator('.nt-path-menu .nt-path-row')).toHaveCount(1)
  await expect(page.locator('.nt-path-menu .nt-path-row')).toContainText('C:/share/one')

  // The removal is persisted with the history, not just on screen.
  await page.reload()
  await selectRailMode(page, 'nettools')
  await page.getByRole('button', { name: 'Recent paths' }).click()
  await expect(page.locator('.nt-path-menu .nt-path-row')).toHaveCount(1)
})

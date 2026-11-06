import { test, expect, type Page } from './helpers/fixtures'
import { installTauriMock } from './helpers/tauriMock'

// Settings → Appearance can hide the bottom status bar (`ui.showStatusBar`).
// The choice has to survive a reload and has to be reversible from the same
// switch, so this pins visibility, persistence and the registry key.

const SWITCH = 'button.switch[aria-label="Show the status bar"]'

async function boot(page: Page) {
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  await installTauriMock(page, {})
  await page.goto('/')
}

async function openAppearance(page: Page) {
  await page.locator('.titlebar-btn.settings-btn').click()
  await expect(page.locator('.settings-content')).toBeVisible()
  await page.locator('.settings-nav-item', { hasText: 'Appearance' }).click()
  await expect(page.locator(SWITCH)).toBeVisible()
}

test('the status bar is shown by default and the switch hides it for good', async ({ page }) => {
  await boot(page)
  await expect(page.locator('.status-bar')).toHaveCount(1)

  await openAppearance(page)
  await expect(page.locator(SWITCH)).toHaveAttribute('aria-checked', 'true')
  await page.locator(SWITCH).click()
  await expect(page.locator('.status-bar')).toHaveCount(0)

  // The choice is stored, not just component state (booleans encode as '1'/'0').
  expect(await page.evaluate(() => localStorage.getItem('wrolp-show-status-bar'))).toBe('0')

  // A reload keeps it hidden…
  await page.reload()
  await expect(page.locator('.status-bar')).toHaveCount(0)

  // …and the same switch brings it back.
  await openAppearance(page)
  await expect(page.locator(SWITCH)).toHaveAttribute('aria-checked', 'false')
  await page.locator(SWITCH).click()
  await expect(page.locator('.status-bar')).toHaveCount(1)
  expect(await page.evaluate(() => localStorage.getItem('wrolp-show-status-bar'))).toBe('1')
})

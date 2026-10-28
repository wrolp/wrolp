import { test, expect, type Page } from './helpers/fixtures'
import { installTauriMock } from './helpers/tauriMock'

// The language picker is the first setting on the Appearance pane, and it starts
// on "follow system" for a fresh install. An explicit choice outranks the OS
// locale; switching back to "system" resumes following it immediately.

const select = (page: Page) => page.locator('#ui-language')
const firstNav = (page: Page) => page.locator('.settings-nav-item').first()

async function openSettings(page: Page) {
  await page.setViewportSize({ width: 1100, height: 760 })
  await installTauriMock(page, {})
  await page.goto('/')
  await page.locator('.titlebar-btn.settings-btn').click()
  await expect(page.locator('.settings-content')).toBeVisible()
}

test.describe('a Chinese system locale', () => {
  test.use({ locale: 'zh-CN' })

  test('a fresh install follows the system language and says so', async ({ page }) => {
    await openSettings(page)
    await expect(select(page)).toHaveValue('system')
    await expect(select(page).locator('option')).toHaveText(['跟随系统', 'English', '中文'])
    await expect(firstNav(page)).toHaveText('外观')
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh')
    await expect(page.locator('.settings-field:has(#ui-language) .settings-help')).toContainText(
      '当前跟随系统语言：中文',
    )
  })

  test('a saved explicit language outranks the system locale', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
    await openSettings(page)
    await expect(select(page)).toHaveValue('en')
    await expect(firstNav(page)).toHaveText('Appearance')
  })
})

test.describe('an English system locale', () => {
  test.use({ locale: 'en-US' })

  test('language is the first setting and follows English', async ({ page }) => {
    await openSettings(page)
    await expect(select(page)).toHaveValue('system')
    await expect(select(page).locator('option')).toHaveText(['Follow system', 'English', '中文'])
    await expect(page.locator('.settings-field:has(#ui-language) .settings-help')).toContainText(
      'Following the system language: English',
    )
    const language = await select(page).boundingBox()
    const theme = await page.locator('#ui-theme').boundingBox()
    expect(language!.y).toBeLessThan(theme!.y)
    await page.screenshot({ path: test.info().outputPath('settings-language.png') })
  })

  test('explicit choices persist and system following can be restored', async ({ page }) => {
    await openSettings(page)
    await select(page).selectOption('zh')
    await expect(firstNav(page)).toHaveText('外观')
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh')
    expect(await page.evaluate(() => localStorage.getItem('wrolp-lang'))).toBe('zh')

    await page.reload()
    await page.locator('.titlebar-btn.settings-btn').click()
    await expect(select(page)).toHaveValue('zh')
    await expect(firstNav(page)).toHaveText('外观')

    await select(page).selectOption('system')
    await expect(firstNav(page)).toHaveText('Appearance')
    expect(await page.evaluate(() => localStorage.getItem('wrolp-lang'))).toBe('system')
  })

  test('a system-language change applies while following system', async ({ page }) => {
    await openSettings(page)
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'languages', {
        configurable: true,
        get: () => ['zh-CN'],
      })
      window.dispatchEvent(new Event('languagechange'))
    })
    await expect(firstNav(page)).toHaveText('外观')
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh')
    // With no saved preference the UI simply follows the OS; only an explicit
    // pick (including "system") writes the key.
    expect(await page.evaluate(() => localStorage.getItem('wrolp-lang'))).toBeNull()
  })
})

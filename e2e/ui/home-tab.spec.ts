import { test, expect } from './helpers/fixtures'
import { installTauriMock } from './helpers/tauriMock'
import en from '../../src/i18n/en'

// 「一直显示首页」. Pinned, Home is a tab bar entry that outlives an open session —
// which is the only way back to it, because a stage holding a terminal used to take
// the page away for good. Unpinned, Home is only what stands behind an empty stage.
//
// The preference is seeded one way or the other rather than always driven through a
// click, because the out-of-box bar is part of what is being pinned.

const DEMO_CONN = { id: 'c1', name: 'Demo', host: 'demo.local', port: 22, username: 'root' }

const PIN_LABEL = en.alwaysShowHomeLabel

const homeTab = (page: import('@playwright/test').Page) => page.locator('.tab-item.tab-home')
const sessionTabs = (page: import('@playwright/test').Page) =>
  page.locator('.tab-item:not(.tab-home)')
const welcome = (page: import('@playwright/test').Page) =>
  page.locator('[data-testid="welcome-page"]')
const pinSwitch = (page: import('@playwright/test').Page) =>
  page.getByRole('switch', { name: PIN_LABEL })

async function boot(page: import('@playwright/test').Page, pin?: boolean) {
  await installTauriMock(page, {
    connections: [DEMO_CONN],
    pollOutputChunks: [['root@demo:~$ ']],
  })
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  if (pin !== undefined) {
    await page.addInitScript(
      (value) => {
        localStorage.setItem('wrolp-always-show-home', value)
      },
      pin ? '1' : '0',
    )
  }
  await page.goto('/')
}

const storedPin = (page: import('@playwright/test').Page) =>
  page.evaluate(() => localStorage.getItem('wrolp-always-show-home'))

test('a pinned Home is the first entry and what the window opens on', async ({ page }) => {
  await boot(page)

  await expect(page.locator('.tab-item').first()).toHaveClass(/tab-home/)
  await expect(homeTab(page)).toHaveClass(/active/)
  await expect(welcome(page)).toBeVisible()
  await expect(pinSwitch(page)).toBeChecked()
})

test('Home stays one click away while a session is open, and the session survives', async ({
  page,
}) => {
  await boot(page)
  await page.locator('.connection-item').click()
  await expect(sessionTabs(page)).toHaveCount(1)
  await expect(homeTab(page)).toHaveCount(1)

  await homeTab(page).click()
  await expect(welcome(page)).toBeVisible()
  // Hidden, not torn down: the workspace and its xterm are still mounted, so
  // looking at Home costs the session nothing.
  await expect(page.locator('.term-workspace')).toBeHidden()
  await expect(page.locator('.term-workspace .xterm')).toHaveCount(1)

  await sessionTabs(page).click()
  await expect(page.locator('.term-workspace')).toBeVisible()
  await expect(page.locator('.xterm-rows')).toBeVisible()
})

test('closing the entry unpins Home and says where it comes back from', async ({ page }) => {
  await boot(page)
  await page.locator('.connection-item').click()

  await homeTab(page).locator('.tab-close').click()
  await expect(homeTab(page)).toHaveCount(0)
  await expect(storedPin(page)).resolves.toBe('0')
  await expect(page.locator('.toast')).toContainText(en.homeUnpinnedHint)
})

test('unpinning with nothing else open leaves Home as the stage, switched off', async ({
  page,
}) => {
  await boot(page, true)
  await pinSwitch(page).click()

  await expect(homeTab(page)).toHaveCount(0)
  await expect(storedPin(page)).resolves.toBe('0')
  await expect(welcome(page)).toBeVisible()
  await expect(pinSwitch(page)).not.toBeChecked()
})

test('Settings → Appearance is the other way back on, and needs no hint', async ({ page }) => {
  await boot(page, false)
  await expect(homeTab(page)).toHaveCount(0)
  await expect(welcome(page)).toBeVisible()

  await page.locator('.settings-btn').click()
  await pinSwitch(page).click()

  await expect(homeTab(page)).toHaveCount(1)
  await expect(storedPin(page)).resolves.toBe('1')
  await expect(page.locator('.toast')).toHaveCount(0)
})

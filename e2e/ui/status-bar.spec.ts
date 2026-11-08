import { test, expect } from './helpers/fixtures'
import { installTauriMock } from './helpers/tauriMock'

// P2-1 of the redesign: the global status bar, which the old sheet had commented
// out whole (taking the only update indicator in the app with it).
//
// What is pinned here is the state language — a state is never allowed to be a
// colour alone — and the fact that the band's height is a layout token rather
// than a per-file literal, which is what lets `data-density` move it.

const DEMO_CONN = { id: 'c1', name: 'Demo', host: 'demo.local', port: 22, username: 'root' }

async function bootWithSession(
  page: import('@playwright/test').Page,
  layout?: Record<string, unknown>,
) {
  await installTauriMock(page, {
    connections: [DEMO_CONN],
    pollOutputChunks: [['root@demo:~$ ']],
    ...(layout ? { layout: JSON.stringify(layout) } : {}),
  })
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  await page.goto('/')
  await page.locator('.connection-item').click()
  await expect(page.locator('.tab-item:not(.tab-home)')).toHaveCount(1)
}

test('the status bar carries the session state, target and geometry', async ({ page }) => {
  await bootWithSession(page)
  const bar = page.locator('.status-bar')
  await expect(bar).toBeVisible()
  await expect(bar.locator('.status-bar-left .status-item').first()).toContainText(
    /Connected|Connecting/,
  )
  // The target repeats what the tab label says, but with the port it omits.
  await expect(bar).toContainText('demo.local:22')
  // `get_recording_enabled` is true in the mock, so the recording chip is the
  // cheapest proof that a state ships as shape *and* word, not as a colour.
  const rec = bar.locator('.status-item:has(.dot.rec)')
  await expect(rec).toHaveCount(1)
  await expect(rec).toContainText('Recording')
})

test('the bar is a band of the column layout, not an overlay', async ({ page }) => {
  await bootWithSession(page)
  const { top, bottom, rootBottom } = await page.locator('.status-bar').evaluate((el) => {
    const r = el.getBoundingClientRect()
    const c = document.querySelector('.app-container')!.getBoundingClientRect()
    return { top: r.top, bottom: r.bottom, rootBottom: c.bottom }
  })
  expect(bottom).toBeCloseTo(rootBottom, 0)
  expect(bottom - top).toBeGreaterThanOrEqual(22)
})

// Even collapsed, the drawer is a row of chrome that costs height. The bar's
// toggle is the control that takes that row away entirely — it is a control, not
// a read-out, so `aria-pressed` is what says whether the drawer exists.
test('the status bar toggles the whole drawer, header strip included', async ({ page }) => {
  await bootWithSession(page)
  const drawer = page.locator('.bottom-panel')
  const toggle = page.locator('.status-bar .status-panel-toggle')

  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect(drawer).toHaveCount(1)
  await expect(drawer.locator('.bottom-panel-tabs')).toBeVisible()

  await toggle.click()
  await expect(drawer).toHaveCount(0)
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')

  await toggle.click()
  await expect(drawer).toHaveCount(1)
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  // Back the way it was: the strip returns, the content does not.
  await expect(drawer.locator('.bottom-panel-tabs')).toBeVisible()
  await expect(drawer.locator('.bottom-panel-content')).toHaveCount(0)
})

test('hiding an expanded drawer takes its divider with it, and restores expanded', async ({
  page,
}) => {
  await bootWithSession(page, { bottomPanel: { visible: true } })
  const drawer = page.locator('.bottom-panel')
  const toggle = page.locator('.status-bar .status-panel-toggle')

  await expect(drawer).toHaveClass(/expanded/)
  await expect(page.locator('.panel-divider-h')).toHaveCount(1)

  await toggle.click()
  await expect(drawer).toHaveCount(0)
  await expect(page.locator('.panel-divider-h')).toHaveCount(0)

  // `visible` is left alone, so showing it again is the state it was hidden in.
  await toggle.click()
  await expect(drawer).toHaveClass(/expanded/)
  await expect(page.locator('.panel-divider-h')).toHaveCount(1)
})

test('the panel shortcut opens a hidden drawer expanded', async ({ page }) => {
  await bootWithSession(page)
  const drawer = page.locator('.bottom-panel')
  await page.locator('.status-bar .status-panel-toggle').click()
  await expect(drawer).toHaveCount(0)

  await page.keyboard.press('Control+j')
  await expect(drawer).toHaveCount(1)
  await expect(drawer).toHaveClass(/expanded/)
})

test('density moves every chrome band together', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('wrolp-density', 'comfy'))
  await bootWithSession(page)
  const [statusbar, tabbar, titlebar] = await page.evaluate(() => {
    const h = (sel: string) => document.querySelector(sel)!.getBoundingClientRect().height
    return [h('.status-bar'), h('.tab-bar'), h('.titlebar')]
  })
  // Compact is 22 / 28 / 28; comfy is 26 / 32 / 34.
  expect(statusbar).toBeGreaterThanOrEqual(26)
  expect(tabbar).toBeGreaterThanOrEqual(32)
  expect(titlebar).toBeGreaterThanOrEqual(34)
})

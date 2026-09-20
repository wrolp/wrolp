import { test, expect } from './helpers/fixtures'
import { installTauriMock } from './helpers/tauriMock'

// The workspace selector's dropdown arrow must render at a visible size
// (it used to be a 10px `▾` glyph that was hard to see).

const WORKSPACES = {
  workspaces: [
    { id: 'default', name: 'Default', createdAt: '2026-08-01T00:00:00Z' },
    { id: 'w2', name: 'Staging', createdAt: '2026-08-01T00:00:00Z' },
  ],
  activeWorkspaceId: 'default',
}

test('workspace selector shows the active name and a visible dropdown arrow', async ({ page }) => {
  await installTauriMock(page, { workspaces: WORKSPACES })
  await page.goto('/')

  const trigger = page.locator('.workspace-selector-trigger')
  await expect(trigger).toBeVisible()
  await expect(trigger.locator('.workspace-name')).toHaveText('Default')

  const chevron = trigger.locator('.workspace-chevron svg')
  await expect(chevron).toBeVisible()
  const box = await chevron.boundingBox()
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(12)
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(12)

  // Opening the menu rotates the arrow (still the same SVG icon).
  await trigger.click()
  await expect(page.locator('.workspace-dropdown')).toBeVisible()
  await expect(trigger.locator('.workspace-chevron')).toHaveClass(/open/)
})

test('the switcher lives in the titlebar, so hiding the sidebar keeps it', async ({ page }) => {
  // It used to be the first row of the sidebar, which meant the sidebar's own
  // hide button took the workspace switcher with it.
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  await installTauriMock(page, { workspaces: WORKSPACES })
  await page.goto('/')

  await expect(page.locator('.titlebar-actions .workspace-selector')).toBeVisible()
  await page.getByRole('button', { name: 'Hide sidebar' }).click()
  await expect(page.locator('.workspace-selector-trigger')).toBeVisible()
})

test('the dropdown opens inside the window', async ({ page }) => {
  await installTauriMock(page, { workspaces: WORKSPACES })
  await page.goto('/')

  // Right-anchored to the pill: the pill sits near the right edge of a wide
  // titlebar, so a left-anchored menu — or the old `left: 0; right: 0`, sized to
  // the sidebar column this control left behind — would hang off the window.
  const trigger = page.locator('.workspace-selector-trigger')
  await trigger.click()
  const pill = await trigger.boundingBox()
  const menu = await page.locator('.workspace-dropdown').boundingBox()
  expect(pill).not.toBeNull()
  expect(menu).not.toBeNull()
  expect(Math.abs(menu!.x + menu!.width - (pill!.x + pill!.width))).toBeLessThanOrEqual(1)
  expect(menu!.x).toBeGreaterThanOrEqual(0)
  await expect(page.locator('.workspace-item')).toHaveCount(2)
})

test('a narrow window keeps the window controls and lets the pill give way', async ({ page }) => {
  // The pill is a new neighbour in a row that used to hold only buttons. With no
  // shrink path the whole action row — close button included — spills past the
  // right edge, and the window can no longer be closed.
  await page.setViewportSize({ width: 520, height: 500 })
  await installTauriMock(page, { workspaces: WORKSPACES })
  await page.goto('/')

  await expect(page.locator('.titlebar-close')).toBeInViewport()
  const pill = await page.locator('.workspace-selector-trigger').boundingBox()
  const name = await page.locator('.workspace-name').boundingBox()
  const nameFull = await page.locator('.workspace-name').evaluate((el) => el.scrollWidth)
  expect(pill).not.toBeNull()
  expect(name).not.toBeNull()
  expect(name!.width).toBeLessThan(nameFull)
})

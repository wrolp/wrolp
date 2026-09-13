import { test, expect } from '@playwright/test'
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

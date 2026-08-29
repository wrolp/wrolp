import { test, expect } from '@playwright/test'
import { installTauriMock } from './helpers/tauriMock'

// Smoke tests: the app must boot with the Tauri backend stubbed and render the
// core shell (titlebar, sidebar, settings tab) without crashing.

test.beforeEach(async ({ page }) => {
  await installTauriMock(page, {})
})

test('renders the titlebar with the app name', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.titlebar-title')).toContainText('Wrolp Terminal')
})

test('shows the connections empty state when the backend has no connections', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.empty-state')).toContainText('No connections yet')
})

test('opens the Settings tab from the titlebar', async ({ page }) => {
  await page.goto('/')
  await page.locator('.settings-btn').click()

  await expect(page.locator('.tab-item.active')).toContainText('Settings')
  await expect(page.locator('.settings-layout')).toBeVisible()
  // Opacity slider is part of the General settings pane.
  await expect(page.locator('.settings-range')).toBeVisible()
})

test('sidebar toggle hides and restores the sidebar', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.sidebar')).toBeVisible()

  await page.keyboard.press('Control+b')
  await expect(page.locator('.sidebar')).toBeHidden()

  await page.keyboard.press('Control+b')
  await expect(page.locator('.sidebar')).toBeVisible()
})

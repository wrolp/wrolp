import { test, expect } from '@playwright/test'
import { installTauriMock } from './helpers/tauriMock'

// Floating command-list (Ctrl+Shift+P) with a stubbed backend.

const SNIPPETS = [
  {
    id: 's1',
    command: 'docker ps',
    alias: 'containers',
    favorite: true,
    hidden: false,
    sortOrder: 0,
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-01T00:00:00Z',
  },
]

test('Ctrl+Shift+P opens the command list showing saved snippets', async ({ page }) => {
  await installTauriMock(page, { commandSnippets: SNIPPETS })
  await page.goto('/')

  await page.keyboard.press('Control+Shift+p')
  await expect(page.locator('.cmd-list-float')).toBeVisible()
  await expect(page.locator('.cmd-list-item')).toHaveCount(1)
  await expect(page.locator('.cmd-list-alias')).toHaveText('containers')
  await expect(page.locator('.cmd-list-command')).toHaveText('docker ps')
})

test('command list shows the empty state when no snippets exist', async ({ page }) => {
  await installTauriMock(page, {})
  await page.goto('/')

  await page.locator('.cmd-list-btn').click()
  await expect(page.locator('.cmd-list-float')).toBeVisible()
  await expect(page.locator('.cmd-list-empty')).toContainText('No commands saved yet')
})

import { test, expect, type Page } from './helpers/fixtures'
import { installTauriMock } from './helpers/tauriMock'
import { selectRailMode } from './helpers/sections'

// The session row's six action icons need ~178px on their own, so the panel — a
// column the user can drag between 160 and 500px — collapses them into one menu
// button below a width where they would squeeze the title and meta out.

const SESSION = {
  id: 's1',
  connectionId: 'c1',
  connectionName: 'demo',
  startedAt: '2026-10-24T10:00:00Z',
  endedAt: '2026-10-24T10:05:00Z',
  durationSeconds: 300,
  title: 'web-01',
  eventCount: 12,
  workspaceName: 'Default',
  groupName: 'WSL',
  eventsFile: 'C:/recordings/s1.events',
}

async function boot(page: Page, sidebarWidth: number) {
  await installTauriMock(page, {
    // The persisted layout is what App merges onto its defaults; the divider only
    // writes the same field.
    layout: JSON.stringify({ sidebar: { width: sidebarWidth } }),
    sessions: [SESSION],
  })
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  await page.goto('/')
  await selectRailMode(page, 'sessions')
  await expect(page.locator('.session-row')).toHaveCount(1)
}

test('a wide panel keeps both strips inline', async ({ page }) => {
  await boot(page, 420)
  await expect(page.locator('.session-row-actions button')).toHaveCount(6)
  await expect(page.locator('.panel-toolbar button')).toHaveCount(4)
  await expect(page.locator('.session-more-btn')).toHaveCount(0)
})

test('a narrow panel collapses the row into one menu that still does the work', async ({
  page,
}) => {
  await boot(page, 240)
  const row = page.locator('.session-row')
  await expect(row.locator('.session-row-actions button')).toHaveCount(1)

  const more = row.locator('.session-more-btn')
  await expect(more).toBeVisible()
  await more.click()

  const menu = page.locator('.session-action-menu')
  await expect(menu).toBeVisible()
  // Every action the inline strip had is in the menu, reveal included.
  await expect(menu.locator('.context-menu-item')).toHaveCount(6)
  await expect(menu).toContainText('Show in folder')
  await expect(menu).toContainText('Rename')

  // The menu is not decoration: delete still opens the confirmation.
  await menu.locator('.context-menu-item', { hasText: /^Delete$/ }).click()
  await expect(page.locator('.confirm-dialog')).toBeVisible()
  await expect(page.locator('.session-action-menu')).toHaveCount(0)
})

// The toolbar needs more room than a row (its filter and count stay on the line), so
// it collapses at a higher width — one menu button beside the filter.
test('the toolbar collapses its four verbs too', async ({ page }) => {
  await boot(page, 340)
  // 340 keeps the row actions inline but is below the toolbar's own threshold.
  await expect(page.locator('.session-row-actions button')).toHaveCount(6)

  const toolbar = page.locator('.panel-toolbar')
  await expect(toolbar.locator('button')).toHaveCount(1)
  const more = toolbar.locator('.session-more-btn')
  await expect(more).toBeVisible()
  await more.click()

  const menu = page.locator('.session-action-menu')
  await expect(menu.locator('.context-menu-item')).toHaveCount(4)
  await expect(menu).toContainText('Rescan recordings')

  await menu.locator('.context-menu-item', { hasText: /^Delete All Sessions$/ }).click()
  await expect(page.locator('.confirm-dialog')).toBeVisible()
})

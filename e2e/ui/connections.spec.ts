import { test, expect } from '@playwright/test'
import { installTauriMock, type MockConnection } from './helpers/tauriMock'

// Real SSH/SFTP is out of scope for this phase — the backend is stubbed via
// __TAURI_INTERNALS__, but the connection-management UI (CRUD, grouping,
// persistence round-trip) runs the full frontend logic.

const BASE_CONNS: MockConnection[] = [
  { id: 'c1', name: 'Web Server', host: '192.168.1.10', port: 22, username: 'root' },
  { id: 'c2', name: 'DB Server', host: '10.0.0.5', port: 22, username: 'admin' },
]

// Connection rows in the sidebar (`.connection-item`); local-terminal entries
// use a different `.conn-item.local-term-item` class.
const connRows = (page: import('@playwright/test').Page) => page.locator('.connection-item')

test('renders the connection list from the backend', async ({ page }) => {
  await installTauriMock(page, { connections: BASE_CONNS })
  await page.goto('/')

  await expect(connRows(page)).toHaveCount(2)
  await expect(page.locator('.conn-name')).toHaveText(['Web Server', 'DB Server'])
  await expect(connRows(page).locator('.conn-host').first()).toHaveText('192.168.1.10:22')
})

test('renders connections grouped by group name', async ({ page }) => {
  await installTauriMock(page, {
    connections: [
      ...BASE_CONNS,
      { id: 'c3', name: 'Backup', host: '10.1.2.3', port: 22, group: 'Production' },
    ],
  })
  await page.goto('/')

  // Group headers render in sidebar order: Local Terminals, then Ungrouped
  // (c1, c2), then Production (c3).
  await expect(page.locator('.conn-group-name')).toHaveText(['Local', 'Ungrouped', 'Production'])
  const production = page.locator('.conn-group').filter({ hasText: 'Production' })
  await expect(production.locator('.connection-item')).toContainText('Backup')
  await expect(production.locator('.connection-item').locator('.conn-host')).toHaveText(
    '10.1.2.3:22',
  )
})

test('creates a new connection through the modal', async ({ page }) => {
  await installTauriMock(page, {})
  await page.goto('/')
  await expect(page.locator('.empty-state')).toBeVisible()

  await page.locator('.sidebar-header button').click()
  const modal = page.locator('.modal')
  await expect(modal).toBeVisible()
  await expect(modal).toContainText('New Connection')

  await page.locator('input[placeholder="192.168.1.100"]').fill('10.1.1.99')
  await page.locator('input[placeholder="22"]').fill('2222')
  await page.locator('input[placeholder="My Server"]').fill('Prod Host')
  await page.locator('input[placeholder="root"]').fill('ubuntu')
  await modal.locator('.btn-primary').click()

  // Save -> backend mutate -> list refresh: the new row must appear.
  await expect(modal).toBeHidden()
  await expect(connRows(page)).toContainText('Prod Host')
  await expect(connRows(page).locator('.conn-host').last()).toHaveText('10.1.1.99:2222')
})

test('edits an existing connection', async ({ page }) => {
  await installTauriMock(page, { connections: BASE_CONNS })
  await page.goto('/')

  await connRows(page).first().hover()
  await connRows(page).first().locator('.conn-item-edit').click()

  const modal = page.locator('.modal')
  await expect(modal).toBeVisible()
  await expect(modal).toContainText('Edit Connection')
  await expect(page.locator('input[placeholder="192.168.1.100"]')).toHaveValue('192.168.1.10')

  await page.locator('input[placeholder="My Server"]').fill('Web Prod')
  await modal.locator('.btn-primary').click()

  await expect(modal).toBeHidden()
  await expect(connRows(page).first()).toContainText('Web Prod')
})

test('deletes a connection after confirmation', async ({ page }) => {
  await installTauriMock(page, { connections: BASE_CONNS })
  await page.goto('/')

  await connRows(page).first().hover()
  await connRows(page).first().locator('.conn-item-del').click()

  const confirm = page.locator('.modal-actions')
  await expect(confirm).toBeVisible()
  await expect(page.locator('.modal')).toContainText('Delete connection "Web Server"?')
  await confirm.locator('.danger').click()

  await expect(connRows(page)).toHaveCount(1)
  await expect(connRows(page)).not.toContainText('Web Server')
})

import { test, expect } from './helpers/fixtures'
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

  // The "+" button adds a connection. It used to be a literal "+" glyph on an
  // unlabelled button; it is now an icon whose accessible name is the action, so
  // the test reaches it by that name instead of by a header class that no longer
  // exists (the nav sections share `.panel-head`).
  await page.getByRole('button', { name: 'New Connection' }).click()
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

test('a row keeps its actions out of the flow until hovered', async ({ page }) => {
  await installTauriMock(page, {
    connections: [
      {
        id: 'c1',
        name: 'Production web server (eu-west-1)',
        host: 'prod-web-01.eu-west-1.internal',
        port: 22,
        username: 'root',
      },
    ],
  })
  await page.goto('/')
  const row = connRows(page).first()
  await expect(row).toBeVisible()

  // Unhovered the buttons take no room, so the name gets the whole row; hovering
  // brings them back and the name is squeezed (it truncates).
  await page.mouse.move(5, 5)
  await expect(row.locator('.conn-item-edit')).toBeHidden()
  const name = row.locator('.conn-name')
  const idleWidth = await name.evaluate((el) => el.clientWidth)

  await row.hover()
  await expect(row.locator('.conn-item-edit')).toBeVisible()
  await expect(row.locator('.conn-item-copy')).toBeVisible()
  await expect(row.locator('.conn-item-del')).toBeVisible()
  const hoverWidth = await name.evaluate((el) => el.clientWidth)

  expect(hoverWidth).toBeLessThan(idleWidth)
})

test('a row spaces its actions like the local-terminal row does', async ({ page }) => {
  await installTauriMock(page, {
    connections: BASE_CONNS,
    localTerminals: [{ id: 'lt1', name: 'repo', cwd: 'C:/repo', shell: 'cmd' }],
  })
  await page.goto('/')

  // The local row puts its buttons straight into the row's flex container, so
  // their spacing is the row's gap. The remote row wraps them in
  // `.conn-item-actions`, which used to pin its own 2px gap and made the pencil
  // and × read as one shape.
  const gaps = await connRows(page)
    .first()
    .evaluate((el) => {
      const actions = el.querySelector('.conn-item-actions') as HTMLElement
      return [getComputedStyle(el).gap, getComputedStyle(actions).gap]
    })
  expect(gaps[1]).toBe(gaps[0])
})

test('duplicates a connection into a prefilled new row', async ({ page }) => {
  await installTauriMock(page, { connections: BASE_CONNS })
  await page.goto('/')

  const row = connRows(page).first()
  await row.hover()
  await row.locator('.conn-item-copy').click()

  const modal = page.locator('.modal')
  await expect(modal).toContainText('Duplicate Connection')
  await expect(page.locator('input[placeholder="192.168.1.100"]')).toHaveValue('192.168.1.10')
  await expect(page.locator('input[placeholder="22"]')).toHaveValue('22')
  await expect(page.locator('input[placeholder="root"]')).toHaveValue('root')
  await expect(page.locator('input[placeholder="My Server"]')).toHaveValue('Web Server copy')

  await modal.locator('.btn-primary').click()
  await expect(modal).toBeHidden()

  // A copy is a create, not an overwrite: the list grows and the original stays.
  await expect(connRows(page)).toHaveCount(3)
  const copyRow = connRows(page).last()
  await expect(copyRow.locator('.conn-name')).toHaveText('Web Server copy')
  await expect(copyRow.locator('.conn-host')).toHaveText('192.168.1.10:22')
})

test('duplicates a saved local terminal right below its source', async ({ page }) => {
  await installTauriMock(page, {
    localTerminals: [{ id: 'lt1', name: 'repo', cwd: 'C:/repo', shell: 'cmd' }],
  })
  await page.goto('/')

  const entry = page.locator('.local-term-item').filter({ hasText: 'repo' })
  await expect(entry).toHaveCount(1)
  await entry.hover()
  await entry.locator('.conn-item-copy').click()

  const rows = page.locator('.local-term-item').filter({ hasText: 'repo' })
  await expect(rows).toHaveCount(2)
  await expect(rows.first().locator('.conn-item-name')).toHaveText('repo')
  await expect(rows.last().locator('.conn-item-name')).toHaveText('repo copy')
})

// Hovering a group header must not change its height. The hover-only "+" used to
// be 18px tall inside a 16px line box, so the header grew 2px and pushed the
// first row down — right under the pointer that triggered it.
test('hovering a group header does not shift the rows below it', async ({ page }) => {
  await installTauriMock(page, { connections: BASE_CONNS })
  await page.goto('/')

  const header = page.locator('.conn-group-header').first()
  const row = connRows(page).first()
  await expect(row).toBeVisible()

  await page.mouse.move(0, 0)
  const beforeHeader = await header.boundingBox()
  const beforeRow = await row.boundingBox()

  await header.hover()
  await expect
    .poll(async () => (await header.boundingBox())?.height ?? 0)
    .toBe(beforeHeader?.height ?? -1)

  expect((await row.boundingBox())?.y).toBe(beforeRow?.y)
})

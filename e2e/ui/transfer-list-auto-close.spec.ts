import { test, expect, type Page } from './helpers/fixtures'
import { selectRailMode } from './helpers/sections'
import { installTauriMock, resolvePendingCall } from './helpers/tauriMock'

// The file panel's transfer list closes itself once nothing is in flight, but it
// only *hides*: the rows belong to the app-wide queue (v8-P4) and the drawer's
// transfer tab still holds them. What these cases pin is both halves — the list
// goes away, the rows do not — plus the two ways it comes back: a new transfer
// starts, or the pointer was resting on it when the timer ran.

const DEMO_CONN = { id: 'c1', name: 'Demo', host: 'demo.local', port: 22, username: 'root' }
const REMOTE_FILE = {
  name: 'app.log',
  path: '/home/root/app.log',
  isDir: false,
  size: 10,
  mode: '-rw-r--r--',
  modified: '',
}

const list = (page: Page) => page.locator('.file-panel .file-transfers')
const queueTab = (page: Page) =>
  page.locator('.bottom-panel-tabs .tab-btn', { hasText: 'Transfer Queue' })

async function boot(page: Page) {
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  await installTauriMock(page, {
    connections: [DEMO_CONN],
    pollOutputChunks: [['root@demo:~$ ']],
    fileEntries: [REMOTE_FILE],
    // The save dialog is what names the local target; without an answer the
    // download never starts and there is no list to close.
    dialogPath: 'C:/downloads/app.log',
    // The transfer stays in flight until the test releases it, so "settled" has a
    // known start instead of racing a mock that resolves instantly.
    holdDownload: true,
    layout: JSON.stringify({ bottomPanel: { visible: true, pos: 'bottom', size: 200 } }),
  })
  await page.goto('/')
  await page.locator('.connection-item').click()
  await expect(page.locator('.titlebar')).toBeVisible()
  await selectRailMode(page, 'files')
  await expect(page.locator('.file-panel')).toBeVisible()
}

/** Right-click the file row and pick Download. */
async function downloadTheFile(page: Page) {
  await page.locator('.tree-row.file').first().click({ button: 'right' })
  await page.locator('.context-menu-item', { hasText: 'Download' }).click()
  // Park the pointer away from the list: hovering is what holds it open, and a
  // click that happens to land on it would make every assertion below a lie.
  await page.mouse.move(4, 4)
}

test('a settled list closes itself while the queue keeps the row', async ({ page }) => {
  await boot(page)
  await downloadTheFile(page)
  await expect(list(page).locator('.file-transfer-row')).toHaveCount(1)

  await resolvePendingCall(page)
  await expect(list(page).locator('.file-transfer-row.done')).toHaveCount(1)
  await expect(list(page)).toHaveCount(0, { timeout: 12_000 })

  // Hiding is not clearing: the drawer still lists what the panel stopped showing.
  await queueTab(page).click()
  await expect(page.locator('.dq-row')).toHaveCount(1)
  await expect(page.locator('.dq-row .dq-name')).toHaveText('app.log')
})

test('an in-flight list does not close', async ({ page }) => {
  await boot(page)
  await downloadTheFile(page)

  // Well past the auto-close delay, with the transfer still running.
  await page.waitForTimeout(7000)
  await expect(list(page)).toBeVisible()
  await expect(list(page).locator('.file-transfer-row.queued')).toHaveCount(1)
})

test('hovering the list holds it open, leaving it starts the delay again', async ({ page }) => {
  await boot(page)
  await downloadTheFile(page)
  await resolvePendingCall(page)
  await expect(list(page).locator('.file-transfer-row.done')).toHaveCount(1)

  await list(page).hover()
  await page.waitForTimeout(7000)
  await expect(list(page)).toBeVisible()

  await page.mouse.move(4, 4)
  await expect(list(page)).toHaveCount(0, { timeout: 12_000 })
})

test('the next transfer brings the list back', async ({ page }) => {
  await boot(page)
  await downloadTheFile(page)
  await resolvePendingCall(page)
  await expect(list(page)).toHaveCount(0, { timeout: 12_000 })

  await downloadTheFile(page)
  await expect(list(page)).toBeVisible()
  await expect(list(page).locator('.file-transfer-row')).toHaveCount(1)
})

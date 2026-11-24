import { test, expect, type Page } from './helpers/fixtures'
import { selectRailMode } from './helpers/sections'
import {
  installTauriMock,
  emitTauriEvent,
  resolvePendingCall,
  type MockConnection,
} from './helpers/tauriMock'

// The file panel's transfer list closes itself once nothing is in flight, but it
// only *hides*: the rows belong to the app-wide queue (v8-P4) and the drawer's
// transfer tab still holds them. What these cases pin is both halves — the list
// goes away, the rows do not — plus the two ways it comes back: a new transfer
// starts, or the pointer was resting on it when the timer ran.

const DEMO_CONN = { id: 'c1', name: 'Demo', host: 'demo.local', port: 22, username: 'root' }
// A second connection, so a spec can put another tab's panel in front of the
// first tab's finished rows.
const SECOND_CONN: MockConnection = {
  id: 'c2',
  name: 'Second',
  host: 'second.local',
  port: 22,
  username: 'root',
}
const REMOTE_FILE = {
  name: 'app.log',
  path: '/home/root/app.log',
  isDir: false,
  size: 10,
  mode: '-rw-r--r--',
  modified: '',
}
// A second file so one transfer can stay queued while another has finished.
const SECOND_FILE = {
  name: 'b.log',
  path: '/home/root/b.log',
  isDir: false,
  size: 10,
  mode: '-rw-r--r--',
  modified: '',
}

const list = (page: Page) => page.locator('.file-panel .file-transfers')
const queueTab = (page: Page) =>
  page.locator('.bottom-panel-tabs .tab-btn', { hasText: 'Transfer Queue' })

async function boot(page: Page, extraConnections: MockConnection[] = []) {
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  await installTauriMock(page, {
    connections: [DEMO_CONN, ...extraConnections],
    pollOutputChunks: [['root@demo:~$ ']],
    fileEntries: [REMOTE_FILE, SECOND_FILE],
    // The save dialog is what names the local target; without an answer the
    // download never starts and there is no list to close.
    dialogPath: 'C:/downloads/app.log',
    // The transfer stays in flight until the test releases it, so "settled" has a
    // known start instead of racing a mock that resolves instantly.
    holdDownload: true,
    layout: JSON.stringify({ bottomPanel: { visible: true, pos: 'bottom', size: 200 } }),
  })
  await page.goto('/')
  await page.locator('.connection-item').first().click()
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

/** Same, but for a named file (used when two transfers must coexist). */
async function downloadNamedFile(page: Page, name: string) {
  await page.locator('.tree-row.file', { hasText: name }).click({ button: 'right' })
  await page.locator('.context-menu-item', { hasText: 'Download' }).click()
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

// The regression this guards: a finished row used to stay visible as long as any
// other transfer was still in flight, because the whole list only closed once it
// had *fully* settled ("the completed download item never goes away").
test('a finished row drops while another transfer is still queued', async ({ page }) => {
  await boot(page)
  await downloadNamedFile(page, 'app.log')
  await resolvePendingCall(page)
  await expect(list(page).locator('.file-transfer-row.done')).toHaveCount(1)

  // A second transfer stays queued (the mock holds it), so the panel stays open.
  await downloadNamedFile(page, 'b.log')
  await expect(list(page).locator('.file-transfer-row.queued')).toHaveCount(1)
  // Live rows float to the top; the finished one drops below them.
  await expect(list(page).locator('.file-transfer-row').first()).toHaveClass(/queued/)
  await expect(list(page).locator('.file-transfer-row').last()).toHaveClass(/done/)

  // The finished row leaves on its own timer; the queued one keeps the panel up.
  await expect(list(page).locator('.file-transfer-row.done')).toHaveCount(0, { timeout: 12_000 })
  await expect(list(page).locator('.file-transfer-row.queued')).toHaveCount(1)
  await expect(list(page)).toBeVisible()
})

// Same idea, but the sibling is *streaming progress* rather than sitting queued.
// Every tick used to replace the queue snapshot and restart the shared dismiss
// timer, so a finished row outlived the whole batch — the "batch delete only
// disappears once everything is done" report.
test('a finished row drops on its own clock while a sibling keeps ticking', async ({ page }) => {
  await boot(page)
  await downloadNamedFile(page, 'app.log')
  await resolvePendingCall(page)
  await expect(list(page).locator('.file-transfer-row.done')).toHaveCount(1)

  await downloadNamedFile(page, 'b.log')
  await expect(list(page).locator('.file-transfer-row.queued')).toHaveCount(1)
  // The queued row only turns `active` on its first backend tick.
  let transferred = 1024
  await emitTauriEvent(page, 'transfer-progress', {
    tabId: 1,
    op: 'download',
    filename: 'b.log',
    transferred,
    total: 10 * 1024 * 1024,
    elapsed: 1000,
  })
  const live = list(page).locator('.file-transfer-row.active')
  await expect(live).toHaveCount(1)

  // Keep the second transfer busy for longer than the dismiss delay: on the old
  // shared-timer logic this alone keeps the done row alive.
  const until = Date.now() + 6500
  while (Date.now() < until) {
    transferred += 1024
    await emitTauriEvent(page, 'transfer-progress', {
      tabId: 1,
      op: 'download',
      filename: 'b.log',
      transferred,
      total: 10 * 1024 * 1024,
      elapsed: 1000,
    })
    await page.waitForTimeout(250)
  }

  await expect(list(page).locator('.file-transfer-row.done')).toHaveCount(0)
  await expect(live).toHaveCount(1)
})

// Reconnects and rail switches remount the panel but leave the app-wide queue
// alone; a row that already had its result shown must not replay for another
// delay ("断开重连时又弹出来").
test('a dismissed row stays gone after the panel remounts', async ({ page }) => {
  await boot(page)
  await downloadTheFile(page)
  await resolvePendingCall(page)
  await expect(list(page).locator('.file-transfer-row.done')).toHaveCount(1)
  await expect(list(page)).toHaveCount(0, { timeout: 12_000 })

  // Leave the files rail and come back: the panel unmounts and remounts.
  await selectRailMode(page, 'hosts')
  await selectRailMode(page, 'files')
  await expect(page.locator('.file-panel')).toBeVisible()
  await expect(list(page)).toHaveCount(0)
})

// The queue is app-wide (the drawer's transfer tab needs that), but the panel's
// list is per connection. It used to read the whole queue, so opening a second
// connection replayed the first one's "Transfers complete" rows — and the panel
// remounts while the new session comes up, which reset the auto-close bookkeeping
// and brought them back for a full delay each time.
test("a new connection does not inherit the previous one's finished list", async ({ page }) => {
  await boot(page, [SECOND_CONN])
  await downloadTheFile(page)
  await resolvePendingCall(page)
  await expect(list(page).locator('.file-transfer-row.done')).toHaveCount(1)

  // Open the second connection: the file panel follows the focused tab.
  await selectRailMode(page, 'hosts')
  await page.locator('.connection-item', { hasText: 'Second' }).click()
  await selectRailMode(page, 'files')
  await expect(page.locator('.file-panel')).toBeVisible()
  await expect(list(page)).toHaveCount(0)
})

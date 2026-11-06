import { test, expect, type Page } from './helpers/fixtures'
import { selectRailMode } from './helpers/sections'
import { installTauriMock, emitTauriEvent } from './helpers/tauriMock'

// The backend ticks `transfer-progress` while a file moves; the row is only
// informative if those ticks reach it as bytes + speed. Uploads had no ticks at
// all on the non-session targets (Docker / WSL / K8s / local), so the row sat on
// an indeterminate bar with no speed — this pins the event → row wiring.

const DEMO_CONN = { id: 'c1', name: 'Demo', host: 'demo.local', port: 22, username: 'root' }

const list = (page: Page) => page.locator('.file-panel .file-transfers')
const row = (page: Page) => list(page).locator('.file-transfer-row').first()

async function boot(page: Page) {
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  await installTauriMock(page, {
    connections: [DEMO_CONN],
    pollOutputChunks: [['root@demo:~$ ']],
    // The upload button reads its source path from the native picker.
    dialogPath: 'C:/uploads/app.log',
    holdUpload: true,
    fileEntries: [],
  })
  await page.goto('/')
  await page.locator('.connection-item').click()
  await expect(page.locator('.titlebar')).toBeVisible()
  await selectRailMode(page, 'files')
  await expect(page.locator('.file-panel')).toBeVisible()
}

test('an upload tick fills in transferred / total and the speed', async ({ page }) => {
  await boot(page)
  await page.locator('.file-panel .icon-btn[aria-label="Upload"]').click()
  await expect(row(page)).toHaveCount(1)
  // Before any tick there is nothing honest to show: no bar, no speed.
  await expect(row(page).locator('.file-transfer-meta')).toHaveText('')

  await emitTauriEvent(page, 'transfer-progress', {
    tabId: 1,
    op: 'upload',
    filename: 'app.log',
    transferred: 5 * 1024 * 1024,
    total: 10 * 1024 * 1024,
    elapsed: 500,
  })

  await expect(row(page)).toHaveClass(/active/)
  await expect(row(page).locator('.file-transfer-meta')).toContainText('5.0 MB / 10.0 MB')
  await expect(row(page).locator('.file-transfer-meta')).toContainText('MB/s')
})

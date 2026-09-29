import { test, expect, type Page } from './helpers/fixtures'
import { selectRailMode } from './helpers/sections'
import { installTauriMock, type MockConnection } from './helpers/tauriMock'

// v8-P4: the drawer's transfer queue.
//
// Before this, the transfer rows lived in `FilePanel` and died with it — closing
// the panel (or switching the rail off "files") threw away what was in flight,
// and a finished list quietly erased itself 2.5s later. The rows are app state
// now, so what these cases pin is the *lifetime*: a transfer started in one
// place is still listed after that place is gone.
//
// The row source here is the dual-pane seam (the only dialog-free way to start a
// transfer in a test — upload/download buttons both go through OS dialogs), but
// nothing in the queue knows that: it reads the same app-wide list the file
// panel writes into.

const CONNS: MockConnection[] = [
  { id: 'c1', name: 'Demo', host: 'demo.local', port: 22, username: 'root' },
]
const LOCAL_FILE = {
  name: 'deploy.ps1',
  path: 'C:/work/deploy.ps1',
  isDir: false,
  size: 2048,
  mode: '-rw-r--r--',
  modified: '',
}
const REMOTE_FILE = {
  name: 'app.log',
  path: '/home/root/app.log',
  isDir: false,
  size: 10,
  mode: '-rw-r--r--',
  modified: '',
}

async function boot(page: Page) {
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  await installTauriMock(page, {
    connections: CONNS,
    pollOutputChunks: [['root@demo:~$ ']],
    fileEntries: [REMOTE_FILE],
    filesByDir: { '': [LOCAL_FILE] },
    // Selecting a file row opens it in the editor, and the read has to answer.
    fileContent: {
      path: 'C:/work/deploy.ps1',
      content: 'echo hi',
      size: 7,
      mode: '-rw-r--r--',
      isBinary: false,
      isTooLarge: false,
      encoding: 'utf-8',
      needsEncoding: false,
    },
    layout: JSON.stringify({ bottomPanel: { visible: true, pos: 'bottom', size: 240 } }),
  })
  await page.goto('/')
  await page.locator('.connection-item').click()
  await expect(page.locator('.titlebar')).toBeVisible()
}

const queueTab = (page: Page) =>
  page.locator('.bottom-panel-tabs .tab-btn', { hasText: 'Transfer Queue' })

/** Start one upload through the dual-pane seam and leave its row in the queue. */
async function startOneTransfer(page: Page) {
  await page.keyboard.press('Control+Shift+F')
  await expect(page.locator('.dual-pane-overlay')).toBeVisible()
  await page.locator('.dual-side').nth(0).locator('.tree-row.file').first().click()
  await page.locator('.dual-arrow.up').click()
}

test('the queue opens empty and says what fills it', async ({ page }) => {
  await boot(page)
  await queueTab(page).click()

  await expect(page.locator('.drawer-transfers')).toBeVisible()
  await expect(page.locator('.dq-empty')).toHaveText(
    'No transfers yet — upload or download from the file panel.',
  )
  // Nothing finished, so there is nothing to clear — and no summary line either:
  // an empty queue is not a queue with zeroed counters.
  await expect(page.locator('.dq-clear')).toBeDisabled()
  await expect(page.locator('.dq-note')).toHaveCount(0)
})

test('rows outlive the panel that started them', async ({ page }) => {
  await boot(page)
  await startOneTransfer(page)
  await expect(page.locator('.dq-row')).toHaveCount(1)
  await expect(page.locator('.dq-row .dq-name')).toHaveText('deploy.ps1')

  // Close the view that started it, then leave the files mode entirely — both
  // used to unmount the panel holding the rows, which took the rows with it.
  await page.locator('.dual-close').click()
  await selectRailMode(page, 'hosts')
  await expect(page.locator('.file-panel')).toHaveCount(0)
  await expect(page.locator('.dq-row')).toHaveCount(1)

  // The finished row is never swept away on a timer either; clearing it is an
  // explicit action.
  await page.waitForTimeout(3000)
  await expect(page.locator('.dq-row')).toHaveCount(1)
  await expect(page.locator('.dq-note')).toContainText('0 active · 1 done · 0 failed')
})

test('filters count the queue, and clear finished empties it', async ({ page }) => {
  await boot(page)
  await startOneTransfer(page)
  await expect(page.locator('.dq-row.done')).toHaveCount(1)

  const all = page.locator('.dq-seg', { hasText: 'All' })
  const done = page.locator('.dq-seg', { hasText: 'Done' })
  const failed = page.locator('.dq-seg', { hasText: 'Failed' })
  await expect(all.locator('.dq-chip')).toHaveText('1')
  await expect(done.locator('.dq-chip')).toHaveText('1')
  await expect(failed.locator('.dq-chip')).toHaveCount(0)

  await failed.click()
  await expect(page.locator('.dq-row')).toHaveCount(0)
  await expect(page.locator('.dq-empty')).toBeVisible()
  await done.click()
  await expect(page.locator('.dq-row')).toHaveCount(1)

  await page.locator('.dq-clear').click()
  await expect(page.locator('.dq-empty')).toBeVisible()
  await expect(all.locator('.dq-chip')).toHaveCount(0)
  await expect(page.locator('.dq-clear')).toBeDisabled()
})

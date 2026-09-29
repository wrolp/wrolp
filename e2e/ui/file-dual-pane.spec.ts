import { test, expect, type Page } from './helpers/fixtures'
import { installTauriMock, invokedCalls } from './helpers/tauriMock'

// v8-P5: the dual-pane file view.
//
// Local on the left, the session's filesystem on the right, and the seam between
// them holds the two arrows that move a selection across. It takes the main area
// (the mode column is 264px — two panes do not fit there), and it is opened from
// the command palette or Ctrl+Shift+F.
//
// What is worth pinning is the *seam*: each pane keeps its own browsing and
// selection, so the only way a transfer happens is that both sides report where
// they are. A pane that stopped reporting would leave the arrows permanently
// disabled, which is the failure mode these cases watch for.

const DEMO_CONN = { id: 'c1', name: 'Demo', host: 'demo.local', port: 22, username: 'root' }
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
  // Leaving the pane's root directory is a deliberate confirm in the app; the
  // test navigates out of it the way a user would — by accepting.
  page.on('dialog', (d) => d.accept())
  await installTauriMock(page, {
    connections: [DEMO_CONN],
    pollOutputChunks: [['root@demo:~$ ']],
    // `list_files` (session target) answers with `fileEntries`; the local pane is
    // a `target_list_files` on path '' and gets its own listing.
    fileEntries: [REMOTE_FILE],
    filesByDir: { '': [LOCAL_FILE] },
    // Clicking a file row opens it in the editor, so the read has to answer —
    // without this the panel's click path is what fails, not the seam.
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
  })
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  await page.goto('/')
  await page.locator('.connection-item').click()
  // Ctrl+Shift+F is an app-level listener: it only exists once React has mounted.
  await expect(page.locator('.titlebar')).toBeVisible()
}

const openDualPane = async (page: Page) => {
  await page.keyboard.press('Control+Shift+F')
  await expect(page.locator('.dual-pane-overlay')).toBeVisible()
}

test('Ctrl+Shift+F opens two panes over the main area', async ({ page }) => {
  await boot(page)
  await openDualPane(page)

  await expect(page.locator('.dual-side .file-panel')).toHaveCount(2)
  await expect(page.locator('.dual-label')).toHaveText(['Local', 'Remote'])
  await expect(page.locator('.dual-arrow')).toHaveCount(2)

  // It is a main-area overlay: it covers the whole terminal surface, drawers
  // included — the split root is the box the terminals live in.
  const overlay = (await page.locator('.dual-pane-overlay').boundingBox())!
  const area = (await page.locator('.terminal-split-root').boundingBox())!
  expect(overlay.width).toBeCloseTo(area.width, 0)
  expect(overlay.height).toBeGreaterThan(200)

  // Opening it also opens the drawer: a transfer you cannot see the queue for is
  // only half a transfer.
  await expect(page.locator('.bottom-panel')).toHaveClass(/expanded/)
})

test('the seam cannot transfer until a pane has a selection', async ({ page }) => {
  await boot(page)
  await openDualPane(page)

  const up = page.locator('.dual-arrow.up')
  const down = page.locator('.dual-arrow.down')
  // Both panes report an empty selection on mount, so both arrows start disabled
  // — and say why, rather than being a dead button.
  await expect(up).toBeDisabled()
  await expect(down).toBeDisabled()
  await expect(up).toHaveAttribute('title', 'Select files in the source pane first')
})

test('the up arrow uploads the local selection into the remote directory', async ({ page }) => {
  await boot(page)
  await openDualPane(page)

  const localPane = page.locator('.dual-side').nth(0)
  await localPane.locator('.tree-row.file', { hasText: 'deploy.ps1' }).click()
  const up = page.locator('.dual-arrow.up')
  await expect(up).toBeEnabled()
  await up.click()

  // The mock has no failure path, so the row completes — and the destination is
  // the *remote* pane's directory, not wherever the local pane was.
  const upload = (await invokedCalls(page)).filter((c) => c.cmd === 'upload_file').pop()
  expect(upload).toBeTruthy()
  expect(upload!.args.localPath).toBe('C:/work/deploy.ps1')
  expect(String(upload!.args.remotePath)).toMatch(/deploy\.ps1$/)

  // The row is the app-wide queue's, so the drawer shows it.
  await expect(page.locator('.dq-row')).toHaveCount(1)
  await expect(page.locator('.dq-row .dq-name')).toHaveText('deploy.ps1')
})

test('the down arrow downloads the remote selection into the local directory', async ({ page }) => {
  await boot(page)
  await openDualPane(page)

  const remotePane = page.locator('.dual-side').nth(1)
  await remotePane.locator('.tree-row.file', { hasText: 'app.log' }).click()
  const down = page.locator('.dual-arrow.down')
  await expect(down).toBeEnabled()
  await down.click()

  const dl = (await invokedCalls(page)).filter((c) => c.cmd === 'download_file').pop()
  expect(dl).toBeTruthy()
  expect(dl!.args.remotePath).toBe('/home/root/app.log')
  // The local pane opened at home — a path the frontend only ever knows as ""
  // — so the destination is taken from the listing itself (the parent of the
  // entries it returned), not from a path string nobody can name.
  expect(dl!.args.localPath).toBe('C:/work/app.log')
  await expect(page.locator('.dq-row')).toHaveCount(1)
})

test('closing the view leaves the queue alone', async ({ page }) => {
  await boot(page)
  await openDualPane(page)

  await page.locator('.dual-side').nth(0).locator('.tree-row.file').first().click()
  await page.locator('.dual-arrow.up').click()
  await expect(page.locator('.dq-row')).toHaveCount(1)

  await page.locator('.dual-close').click()
  await expect(page.locator('.dual-pane-overlay')).toHaveCount(0)
  // The rows outlive the view that started them — the whole point of the queue
  // being app state rather than a panel's.
  await expect(page.locator('.dq-row')).toHaveCount(1)
})

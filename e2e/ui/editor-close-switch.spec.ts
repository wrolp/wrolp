import { test, expect, type Page } from './helpers/fixtures'
import { installTauriMock } from './helpers/tauriMock'

// Closing a file tab must always leave a live view behind: pick the neighbouring
// file tab when the session still has one, and fall back to the terminal when it
// does not. The pane's overlay is chosen by `shellView` while the editor reads
// `activeEditorKey`, so a close that only updates one of the two points the pane
// at a key that no longer exists — the terminal is hidden (sv !== 'terminal')
// and the editor is not rendered (its tab is gone): an empty pane.
// See task/BUGS.md → B37.

const DEMO_CONN = { id: 'c1', name: 'Demo', host: 'demo.local', port: 22, username: 'root' }

const ALPHA = 'alpha.txt'
const BETA = 'beta.txt'
const CONTENT = 'shared body\n'

const entries = [ALPHA, BETA].map((name) => ({
  name,
  path: `/home/root/${name}`,
  isDir: false,
  size: CONTENT.length,
  mode: '-rw-r--r--',
  modified: '',
}))

/** The file shown by the Monaco toolbar (its tab's name). */
function shownFile(page: Page) {
  return page.locator('.editor-filename')
}

/** The pane's own terminal surface — always mounted, hidden behind an overlay. */
function terminalSurface(page: Page) {
  return page.locator('.term-pane-term')
}

async function openConnection(page: Page) {
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  await installTauriMock(page, {
    connections: [DEMO_CONN],
    pollOutputChunks: [['root@demo:~$ ']],
    fileEntries: entries,
    fileContent: {
      path: '/home/root/stub',
      content: CONTENT,
      size: CONTENT.length,
      mode: '-rw-r--r--',
      isBinary: false,
      isTooLarge: false,
      encoding: 'utf-8',
      needsEncoding: false,
    },
  })
  await page.goto('/')
  await page.locator('.connection-item').click()
  await expect(page.locator('.term-pane')).toHaveCount(1)
}

async function openFile(page: Page, name: string) {
  const file = page.locator('.tree-row.file', { hasText: name })
  await expect(file).toBeVisible()
  await file.click()
  await expect(shownFile(page)).toContainText(name)
}

function closeFileTab(page: Page, name: string) {
  return page
    .locator('.term-pane-file-tab', { hasText: name })
    .locator('.term-pane-file-tab-close')
    .click()
}

test('closing a file falls back to the neighbouring file, then to the terminal', async ({
  page,
}) => {
  await openConnection(page)
  await openFile(page, ALPHA)
  await openFile(page, BETA)
  // Two file tabs, the second one active; the terminal is hidden behind them.
  await expect(page.locator('.term-pane-file-tab', { hasText: ALPHA })).toHaveCount(1)
  await expect(terminalSurface(page)).not.toBeVisible()

  // Close the active file → the pane must switch to the file that is left, not
  // go blank (the terminal stays hidden; the editor shows alpha).
  await closeFileTab(page, BETA)
  await expect(page.locator('.term-pane-file-tab', { hasText: BETA })).toHaveCount(0)
  await expect(shownFile(page)).toContainText(ALPHA)
  await expect(terminalSurface(page)).not.toBeVisible()

  // Close the last file → back to the terminal.
  await closeFileTab(page, ALPHA)
  await expect(page.locator('.editor-toolbar')).toHaveCount(0)
  await expect(page.locator('.term-pane-file-tab', { hasText: 'Terminal' })).toHaveClass(/active/)
  await expect(terminalSurface(page)).toBeVisible()
})

test('closing an inactive file leaves the shown file alone', async ({ page }) => {
  await openConnection(page)
  await openFile(page, ALPHA)
  await openFile(page, BETA)

  // alpha closes in the background: beta (the active one) must stay on screen.
  await closeFileTab(page, ALPHA)
  await expect(page.locator('.term-pane-file-tab', { hasText: ALPHA })).toHaveCount(0)
  await expect(shownFile(page)).toContainText(BETA)
  await expect(terminalSurface(page)).not.toBeVisible()
})

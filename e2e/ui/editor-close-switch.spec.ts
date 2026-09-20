import { test, expect, type Page } from './helpers/fixtures'
import { installTauriMock } from './helpers/tauriMock'

// Closing a file tab must always leave a live view behind: pick the neighbouring
// file tab when the session still has one, and fall back to the workspace tab when
// it does not. A file is a first-class tab bar entry that owns an editor buffer,
// so the two have to be dropped together — a tab left behind points at a buffer
// that no longer exists, and a buffer without its tab is unreachable.
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

/** A tab bar entry for an open file, by name. */
function fileTab(page: Page, name: string) {
  return page.locator('.tab-item', { hasText: name })
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
  return fileTab(page, name).locator('.tab-close').click()
}

test('closing a file falls back to the neighbouring file, then to the terminal', async ({
  page,
}) => {
  await openConnection(page)
  await openFile(page, ALPHA)
  await openFile(page, BETA)
  // Opening a file adds a tab of its own, and it covers the terminal.
  await expect(fileTab(page, ALPHA)).toHaveCount(1)
  await expect(fileTab(page, BETA)).toHaveCount(1)
  await expect(terminalSurface(page)).not.toBeVisible()

  // Close the active file → switch to the file that is left, not go blank (the
  // terminal stays hidden; the editor shows alpha).
  await closeFileTab(page, BETA)
  await expect(fileTab(page, BETA)).toHaveCount(0)
  await expect(shownFile(page)).toContainText(ALPHA)
  await expect(fileTab(page, ALPHA)).toHaveClass(/active/)
  await expect(terminalSurface(page)).not.toBeVisible()

  // Close the last file → the workspace tab is selected again and reveals itself.
  await closeFileTab(page, ALPHA)
  await expect(page.locator('.editor-toolbar')).toHaveCount(0)
  await expect(page.locator('.tab-item', { hasText: 'Demo' })).toHaveClass(/active/)
  await expect(terminalSurface(page)).toBeVisible()
})

test('closing an inactive file leaves the shown file alone', async ({ page }) => {
  await openConnection(page)
  await openFile(page, ALPHA)
  await openFile(page, BETA)

  // alpha closes in the background: beta (the active one) must stay on screen.
  await closeFileTab(page, ALPHA)
  await expect(fileTab(page, ALPHA)).toHaveCount(0)
  await expect(shownFile(page)).toContainText(BETA)
  await expect(terminalSurface(page)).not.toBeVisible()
})

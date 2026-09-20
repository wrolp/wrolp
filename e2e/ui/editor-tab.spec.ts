import { test, expect, type Page } from './helpers/fixtures'
import { installTauriMock } from './helpers/tauriMock'

// A remote file is a first-class tab bar entry: it shares the global bar with the
// workspaces, owns its own unsaved marker, and can be popped out into a floating
// window. The pane it came from is never covered by it — selecting the file shows
// the editor, selecting the workspace shows the shell.

const DEMO_CONN = { id: 'c1', name: 'Demo', host: 'demo.local', port: 22, username: 'root' }

const FILE_NAME = 'notes.txt'
const FILE_PATH = `/home/root/${FILE_NAME}`
const CONTENT = 'hello world\n'

async function openFile(page: Page) {
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  await installTauriMock(page, {
    connections: [DEMO_CONN],
    pollOutputChunks: [['root@demo:~$ ']],
    fileEntries: [
      {
        name: FILE_NAME,
        path: FILE_PATH,
        isDir: false,
        size: CONTENT.length,
        mode: '-rw-r--r--',
        modified: '',
      },
    ],
    fileContent: {
      path: FILE_PATH,
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
  const file = page.locator('.tree-row.file', { hasText: FILE_NAME })
  await expect(file).toBeVisible()
  await file.click()
  await expect(page.locator('.editor-toolbar')).toBeVisible()
}

const tab = (page: Page, name: string) => page.locator('.tab-item', { hasText: name })

test('an open file is a tab bar entry, and the terminal is only hidden while it is selected', async ({
  page,
}) => {
  await openFile(page)

  await expect(tab(page, FILE_NAME)).toHaveClass(/active/)
  await expect(page.locator('.term-pane-term')).not.toBeVisible()

  // The shell is still there behind it: switching back reveals it, and the file
  // keeps its place in the bar.
  await tab(page, 'Demo').click()
  await expect(page.locator('.term-pane-term')).toBeVisible()
  await expect(page.locator('.editor-toolbar')).not.toBeVisible()
  await expect(tab(page, FILE_NAME)).toHaveCount(1)

  await tab(page, FILE_NAME).click()
  await expect(page.locator('.editor-toolbar')).toBeVisible()
})

test('the tab carries the unsaved marker of its file', async ({ page }) => {
  await openFile(page)

  await expect(tab(page, FILE_NAME).locator('.tab-dirty')).toHaveCount(0)
  await page.locator('.monaco-editor').click()
  await page.keyboard.type('!')
  await expect(tab(page, FILE_NAME).locator('.tab-dirty')).toHaveCount(1)

  await page.keyboard.press('Control+s')
  await expect(tab(page, FILE_NAME).locator('.tab-dirty')).toHaveCount(0)
})

test('a file tab can float, and closing the float docks it back', async ({ page }) => {
  await openFile(page)

  await page.locator('.editor-float-btn').click()
  const float = page.locator('.floating-window')
  await expect(float).toBeVisible()
  await expect(float.locator('.editor-filename')).toHaveText(FILE_NAME)
  // Popping the editor out hands the main area to the session it came from.
  await expect(page.locator('.term-pane-term')).toBeVisible()

  await float.locator('.floating-window-close').click()
  await expect(float).toHaveCount(0)
  await expect(tab(page, FILE_NAME)).toHaveClass(/active/)
  await expect(page.locator('.editor-toolbar')).toBeVisible()
})

test('closing a floated file tab takes its window with it', async ({ page }) => {
  await openFile(page)
  await page.locator('.editor-float-btn').click()
  await expect(page.locator('.floating-window')).toBeVisible()

  await tab(page, FILE_NAME).locator('.tab-close').click()
  await expect(page.locator('.floating-window')).toHaveCount(0)
  await expect(tab(page, FILE_NAME)).toHaveCount(0)
  await expect(page.locator('.term-pane-term')).toBeVisible()
})

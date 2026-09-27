import { test, expect, type Page } from './helpers/fixtures'
import { installTauriMock } from './helpers/tauriMock'

// Which terminal an open file came from. The same path can be open from two hosts at
// once and the tab label is the only thing that used to say so — the editor itself
// stayed silent. `EditorTab.sshTabId` has always carried the owner session; these
// cases pin that it reaches the two surfaces that show it.

const DEMO_CONN = { id: 'c1', name: 'Demo', host: 'demo.local', port: 22, username: 'root' }
const FILE_PATH = '/home/root/notes.txt'

async function openFile(page: Page) {
  await installTauriMock(page, {
    connections: [DEMO_CONN],
    pollOutputChunks: [['root@demo:~$ ']],
    fileEntries: [
      {
        name: 'notes.txt',
        path: FILE_PATH,
        isDir: false,
        size: 11,
        mode: '-rw-r--r--',
        modified: '',
      },
    ],
    fileContent: {
      path: FILE_PATH,
      content: 'hello world',
      size: 11,
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
  await page.locator('.tree-row.file', { hasText: 'notes.txt' }).click()
  await expect(page.locator('.monaco-editor')).toBeVisible()
}

test('the editor toolbar names the session the file was opened from', async ({ page }) => {
  await openFile(page)
  const origin = page.locator('.editor-origin')
  await expect(origin).toBeVisible()
  // The host, not just the connection name: two connections can share a name.
  await expect(origin).toContainText('demo.local')
  await expect(origin).toHaveAttribute('title', /Opened from the terminal/)
})

test('the file tab tooltip says it too', async ({ page }) => {
  await openFile(page)
  const tab = page.locator('.tab-item', { hasText: 'notes.txt' })
  await expect(tab).toHaveAttribute('title', new RegExp(`${FILE_PATH}.*from Demo`))
})

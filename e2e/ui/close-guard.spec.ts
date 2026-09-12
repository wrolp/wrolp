import { test, expect, type Page } from '@playwright/test'
import { installTauriMock } from './helpers/tauriMock'

// Closing a terminal / pane that still has open files must ask first, so an
// accidental click cannot silently discard them (and any unsaved edits).
// See task/todo.md → 「有打开文件时关闭终端/pane 需二次确认」.

const DEMO_CONN = { id: 'c1', name: 'Demo', host: 'demo.local', port: 22, username: 'root' }

const FILE_PATH = '/home/root/notes.txt'

const MOCK = {
  connections: [DEMO_CONN],
  pollOutputChunks: [['root@demo:~$ ']],
  fileEntries: [
    {
      name: 'notes.txt',
      path: FILE_PATH,
      isDir: false,
      size: 12,
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
}

/** Open the demo connection and open the mock file in the pane's editor. */
async function openFileInEditor(page: Page) {
  await installTauriMock(page, MOCK)
  await page.goto('/')
  await page.locator('.connection-item').click()
  await expect(page.locator('.term-pane')).toHaveCount(1)

  // The file panel lists the mock file; a plain click opens it in the editor.
  const file = page.locator('.tree-row.file', { hasText: 'notes.txt' })
  await expect(file).toBeVisible()
  await file.click()
  await expect(page.locator('.term-pane-file-tab', { hasText: 'notes.txt' })).toHaveCount(1)
}

test('closing a pane with an open file asks first; cancel keeps it', async ({ page }) => {
  await openFileInEditor(page)

  await page.locator('.term-pane-close').click()
  const dialog = page.locator('.confirm-dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('open file')

  // Cancel: nothing is discarded.
  await dialog.locator('.btn-cancel').click()
  await expect(dialog).toHaveCount(0)
  await expect(page.locator('.term-pane')).toHaveCount(1)
  await expect(page.locator('.term-pane-file-tab', { hasText: 'notes.txt' })).toHaveCount(1)

  // Confirm: the (last) pane and its workspace close.
  await page.locator('.term-pane-close').click()
  await page.locator('.confirm-dialog .btn-danger').click()
  await expect(page.locator('.term-pane')).toHaveCount(0)
})

test('closing the workspace tab with an open file asks first', async ({ page }) => {
  await openFileInEditor(page)

  await page.locator('.tab-close').click()
  const dialog = page.locator('.confirm-dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('open file')
  await dialog.locator('.btn-danger').click()
  await expect(page.locator('.tab-item')).toHaveCount(0)
})

test('with the guard disabled, closing the pane does not ask', async ({ page }) => {
  // Seed the display preference BEFORE the app boots (localStorage key is the
  // user-data contract for this setting).
  await page.addInitScript(() => {
    try {
      localStorage.setItem('wrolp-confirm-close-terminal', '0')
    } catch {
      /* ignore */
    }
  })
  await openFileInEditor(page)

  await page.locator('.term-pane-close').click()
  await expect(page.locator('.confirm-dialog')).toHaveCount(0)
  await expect(page.locator('.term-pane')).toHaveCount(0)
})

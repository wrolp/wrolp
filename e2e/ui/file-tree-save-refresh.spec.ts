import { test, expect, type Page } from './helpers/fixtures'
import { installTauriMock, invokedCalls } from './helpers/tauriMock'

// Regression for BUGS.md B36 — "保存文件整个目录刷新, 只应局部刷新".
//
// `handleSaveEditorTab` used to call `FileTreeHandle.refresh()`, which re-lists
// the current directory *and* recursively re-lists every expanded directory —
// one `list_files` per expanded directory per save, plus a whole-panel loading
// flash. It now calls `refreshForFile(path)`, which resolves the saved file's
// own directory (see `getParentDir`) and does a partial refresh instead.
//
// The count of `list_files` invocations is the discriminator: with one
// subdirectory expanded, a full refresh makes TWO new calls (root + subdir)
// while a partial one makes exactly ONE.

const DEMO_CONN = { id: 'c1', name: 'Demo', host: 'demo.local', port: 22, username: 'root' }
const DIR_PATH = '/home/root/sub'
const FILE_PATH = '/home/root/notes.txt'

const SUB_DIR = {
  name: 'sub',
  path: DIR_PATH,
  isDir: true,
  size: 0,
  mode: 'drwxr-xr-x',
  modified: '',
}
const NOTES_FILE = {
  name: 'notes.txt',
  path: FILE_PATH,
  isDir: false,
  size: 11,
  mode: '-rw-r--r--',
  modified: '',
}
const INNER_FILE = {
  name: 'inner.txt',
  path: `${DIR_PATH}/inner.txt`,
  isDir: false,
  size: 3,
  mode: '-rw-r--r--',
  modified: '',
}

const listFilesCalls = async (page: Page) =>
  (await invokedCalls(page)).filter((c) => c.cmd === 'list_files')

/** Open the demo connection, expand `sub`, then open `notes.txt` in the editor. */
async function openFileWithExpandedDir(page: Page) {
  await installTauriMock(page, {
    connections: [DEMO_CONN],
    pollOutputChunks: [['root@demo:~$ ']],
    // Any path that is not the subdirectory lists the root; the subdirectory has
    // a listing of its own, so expanding it is observable and distinct.
    fileEntries: [SUB_DIR, NOTES_FILE],
    filesByDir: { [DIR_PATH]: [INNER_FILE] },
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
  await page.goto('/')
  await page.locator('.connection-item').click()

  const dir = page.locator('.tree-row.dir', { hasText: 'sub' })
  await expect(dir).toBeVisible()
  await dir.click()
  await expect(page.locator('.tree-row.file', { hasText: 'inner.txt' })).toBeVisible()

  await page.locator('.tree-row.file', { hasText: 'notes.txt' }).click()
  await expect(page.locator('.term-pane-file-tab', { hasText: 'notes.txt' })).toHaveCount(1)
  await expect(page.locator('.monaco-editor')).toBeVisible()
}

/** Make the open file dirty (so Save is enabled) and save it with Ctrl+S. */
async function editAndSave(page: Page) {
  await page.locator('.monaco-editor').click()
  await page.keyboard.type('!')
  await expect(page.locator('.editor-btn.primary')).toBeEnabled()
  await page.keyboard.press('Control+s')
}

test('saving a file re-lists only its own directory (B36)', async ({ page }) => {
  await openFileWithExpandedDir(page)

  const before = (await listFilesCalls(page)).length
  // Root listing + the one expanded subdirectory.
  expect(before).toBeGreaterThanOrEqual(2)

  await editAndSave(page)
  await expect
    .poll(async () => (await listFilesCalls(page)).length)
    .toBeGreaterThan(before)
  // Give a full tree refresh the chance to fire its second (recursive) listing.
  await page.waitForTimeout(500)

  const after = await listFilesCalls(page)
  expect(after.length - before).toBe(1)
  // …and it is the saved file's own directory, not the expanded subdirectory.
  const lastPath = String(after[after.length - 1].args.path).replace(/\/$/, '')
  expect(lastPath).toBe('/home/root')
})

test('an untouched expanded directory keeps its state after a save (B36)', async ({ page }) => {
  await openFileWithExpandedDir(page)

  const before = (await listFilesCalls(page)).length
  await editAndSave(page)
  await expect
    .poll(async () => (await listFilesCalls(page)).length)
    .toBeGreaterThan(before)
  await page.waitForTimeout(500)

  // The subdirectory is still expanded with its children in place — a partial
  // refresh must not collapse the user's expanded subtree.
  await expect(page.locator('.tree-row.file', { hasText: 'inner.txt' })).toBeVisible()
  await expect(page.locator('.tree-row.dir', { hasText: 'sub' })).toBeVisible()
})

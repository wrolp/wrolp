import { test, expect, type Page } from './helpers/fixtures'
import { selectRailMode } from './helpers/sections'
import { installTauriMock, invokedCalls } from './helpers/tauriMock'

// A failed write used to be stored in `EditorTab.error`, the same field the OPEN
// failure uses — which swaps the whole editing surface for the message, so a
// permission denial made the user's text look gone. Save failures now live in
// `saveError`: the editor stays, and a banner offers "copy content" / "save as
// another user".

const DEMO_CONN = { id: 'c1', name: 'Demo', host: 'demo.local', port: 22, username: 'root' }
const FILE_PATH = '/home/root/notes.txt'
const SAVE_DENIED = 'Permission denied (os error 13)'

async function openFile(page: Page, sudoWriteError?: string) {
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
    saveFileError: SAVE_DENIED,
    sudoWriteError,
  })
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  await page.goto('/')
  await page.locator('.connection-item').click()
  await selectRailMode(page, 'files')
  await page.locator('.tree-row.file', { hasText: 'notes.txt' }).click()
  await expect(page.locator('.monaco-editor')).toBeVisible()
}

/** Type one character so the tab is dirty, then hit the toolbar's Save. */
async function dirtyAndSave(page: Page) {
  await page.locator('.monaco-editor').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('!')
  const save = page.locator('.editor-btn.primary')
  await expect(save).toBeEnabled()
  await save.click()
}

test('a denied save keeps the text on screen and offers a copy escape hatch', async ({ page }) => {
  await openFile(page)
  await dirtyAndSave(page)

  const banner = page.locator('.editor-save-error')
  await expect(banner).toBeVisible()
  await expect(banner).toContainText(SAVE_DENIED)

  // The editor — and what the user typed — is still there, not replaced by the
  // error message.
  await expect(page.locator('.monaco-editor')).toBeVisible()
  await expect(page.locator('.monaco-editor')).toContainText('hello world!')

  const copy = banner.getByRole('button', { name: 'Copy content' })
  await expect(copy).toBeVisible()
  await copy.click()
  await expect(banner.getByRole('button', { name: 'Copied' })).toBeVisible()
})

test('the banner can switch the SFTP user and retry the save', async ({ page }) => {
  await openFile(page)
  await dirtyAndSave(page)

  const banner = page.locator('.editor-save-error')
  await banner.getByRole('button', { name: 'Save as another user' }).click()

  await banner.locator('input').first().fill('deploy')
  await banner.locator('input[type="password"]').fill('secret')
  await banner.getByRole('button', { name: 'Switch and save' }).click()

  // `oneShot` is the whole point: the borrowed identity is good for the retried
  // save and nothing after it, so it can never become standing root access.
  await expect
    .poll(async () => {
      const calls = (await invokedCalls(page)).filter((c) => c.cmd === 'switch_sftp_user')
      expect(calls.length).toBe(1)
      return calls.at(-1)?.args ?? null
    })
    .toMatchObject({ username: 'deploy', oneShot: true })

  // The save is retried (and still denied by the mock, so the banner stays).
  await expect
    .poll(
      async () => (await invokedCalls(page)).filter((c) => c.cmd === 'write_file_content').length,
    )
    .toBeGreaterThan(1)
  await expect(banner).toBeVisible()
})

test('the banner can save the file with sudo', async ({ page }) => {
  await openFile(page)
  await dirtyAndSave(page)

  const banner = page.locator('.editor-save-error')
  await banner.getByRole('button', { name: 'Save with sudo' }).click()
  await banner.locator('input[type="password"]').first().fill('s3cret')
  await banner.getByRole('button', { name: 'Save', exact: true }).click()

  // The password goes to the backend only (never into the command line, and
  // never into a second normal write that would be denied again).
  await expect
    .poll(async () => {
      const calls = (await invokedCalls(page)).filter((c) => c.cmd === 'sudo_write_file')
      return calls.at(-1)?.args ?? null
    })
    .toMatchObject({ path: FILE_PATH, content: 'hello world!', password: 's3cret' })

  // Sudo wrote as root, so a normal retry is neither needed nor possible: the
  // banner clears and the tab is no longer dirty.
  await expect(banner).toHaveCount(0)
  await expect(page.locator('.editor-btn.primary')).toBeDisabled()
  await expect(page.locator('.monaco-editor')).toContainText('hello world!')
})

test('Enter in the sudo password field saves without reaching for the button', async ({ page }) => {
  await openFile(page)
  await dirtyAndSave(page)

  const banner = page.locator('.editor-save-error')
  await banner.getByRole('button', { name: 'Save with sudo' }).click()
  await banner.locator('input[type="password"]').first().fill('s3cret')
  await page.keyboard.press('Enter')

  await expect
    .poll(async () => {
      const calls = (await invokedCalls(page)).filter((c) => c.cmd === 'sudo_write_file')
      return calls.at(-1)?.args ?? null
    })
    .toMatchObject({ path: FILE_PATH, content: 'hello world!', password: 's3cret' })

  // Same outcome as the button: the banner clears and no second write is tried.
  await expect(banner).toHaveCount(0)
})

test('a failed sudo save explains why and keeps the text', async ({ page }) => {
  await openFile(page, 'sudo: 1 incorrect password attempt')
  await dirtyAndSave(page)

  const banner = page.locator('.editor-save-error')
  await banner.getByRole('button', { name: 'Save with sudo' }).click()
  await banner.locator('input[type="password"]').first().fill('wrong')
  await banner.getByRole('button', { name: 'Save', exact: true }).click()

  await expect(banner).toContainText('incorrect password attempt')
  await expect(page.locator('.monaco-editor')).toContainText('hello world!')
  await expect(banner).toBeVisible()
})

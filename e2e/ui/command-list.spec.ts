import { test, expect, type Page } from '@playwright/test'
import { installTauriMock, invokedCalls } from './helpers/tauriMock'

// Floating command-list (Ctrl+Shift+P) with a stubbed backend.

const DEMO_CONN = { id: 'c1', name: 'Demo', host: 'demo.local', port: 22, username: 'root' }

const SNIPPETS = [
  {
    id: 's1',
    command: 'docker ps',
    alias: 'containers',
    favorite: true,
    hidden: false,
    sortOrder: 0,
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-01T00:00:00Z',
  },
]

const sentInput = async (page: Page) =>
  (await invokedCalls(page)).filter((c) => c.cmd === 'send_input').map((c) => String(c.args.data))

test('Ctrl+Shift+P opens the command list showing saved snippets', async ({ page }) => {
  await installTauriMock(page, { commandSnippets: SNIPPETS })
  await page.goto('/')

  await page.keyboard.press('Control+Shift+p')
  await expect(page.locator('.cmd-list-float')).toBeVisible()
  await expect(page.locator('.cmd-list-item')).toHaveCount(1)
  await expect(page.locator('.cmd-list-alias')).toHaveText('containers')
  await expect(page.locator('.cmd-list-command')).toHaveText('docker ps')
})

test('command list shows the empty state when no snippets exist', async ({ page }) => {
  await installTauriMock(page, {})
  await page.goto('/')

  await page.locator('.cmd-list-btn').click()
  await expect(page.locator('.cmd-list-float')).toBeVisible()
  await expect(page.locator('.cmd-list-empty')).toContainText('No commands saved yet')
})

// A multi-line snippet must be sent the SAME way as a Ctrl+V paste: the guard
// opens for a non-bracketed POSIX shell, and "insert without executing" applies
// the `\` continuation + quoted-insert so the block is one buffered command.
test('a multi-line snippet is inserted like a paste (guard + quoted-insert)', async ({
  page,
}) => {
  const MULTI = [
    {
      id: 'm1',
      command: 'echo one\necho two',
      alias: 'block',
      favorite: false,
      hidden: false,
      sortOrder: 0,
      createdAt: '2026-08-01T00:00:00Z',
      updatedAt: '2026-08-01T00:00:00Z',
    },
  ]
  await installTauriMock(page, { connections: [DEMO_CONN], commandSnippets: MULTI })
  await page.goto('/')
  await page.locator('.connection-item').click()
  await expect(page.locator('.tab-item')).toContainText('Demo')
  await page.waitForSelector('.xterm-helper-textarea', { state: 'attached' })

  await page.keyboard.press('Control+Shift+p')
  await expect(page.locator('.cmd-list-float')).toBeVisible()
  await expect(page.locator('.cmd-list-item')).toHaveCount(1)

  await page.locator('.cmd-list-item').click()
  const dialog = page.locator('.paste-confirm-dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: /insert without executing/i }).click()

  await expect(dialog).toHaveCount(0)
  await expect
    .poll(async () => await sentInput(page))
    .toEqual(['echo one \\\u0016\necho two', '\u0005'])
})

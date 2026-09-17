import { test, expect, type Page } from './helpers/fixtures'
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

// "Add to command list" from the terminal's right-click menu must show up in a
// command list that is ALREADY open: the panel stays mounted while open, so
// `open` does not change and its load effect never re-runs — the app therefore
// bumps a reload key once the row is persisted.
test('a snippet added from the terminal context menu appears in the open list', async ({
  page,
}) => {
  await installTauriMock(page, {
    connections: [DEMO_CONN],
    // A bare command line (no prompt) so a triple-click selects exactly it.
    pollOutputChunks: ['docker ps -a\r\n'],
  })
  await page.goto('/')
  await page.locator('.connection-item').click()
  await expect
    .poll(() => page.locator('.term-pane-term .xterm-rows').innerText())
    .toContain('docker ps -a')

  // Open the command list FIRST — it must refresh itself, not just on re-open.
  await page.keyboard.press('Control+Shift+p')
  await expect(page.locator('.cmd-list-float')).toBeVisible()
  await expect(page.locator('.cmd-list-item')).toHaveCount(0)

  // Triple click is xterm's "select the whole line" gesture; the menu's
  // "Add to command list" entry is a no-op without a selection.
  const row = (await page.locator('.term-pane-term .xterm-rows > div').first().boundingBox())!
  await page.mouse.click(row.x + 30, row.y + row.height / 2, { clickCount: 3 })

  await page.locator('.term-pane-term .xterm-screen').click({
    button: 'right',
    position: { x: 30, y: row.height / 2 },
  })
  await expect(page.locator('.context-menu')).toBeVisible()
  await page.locator('.context-menu-item', { hasText: 'Add to command list' }).click()

  await expect(page.locator('.cmd-list-item')).toHaveCount(1)
  await expect(page.locator('.cmd-list-command')).toHaveText('docker ps -a')
})

// A multi-line snippet must be sent the SAME way as a Ctrl+V paste: the guard
// opens for a non-bracketed POSIX shell, and "insert without executing" applies
// the `\` continuation + quoted-insert so the block is one buffered command.
test('a multi-line snippet is inserted like a paste (guard + quoted-insert)', async ({ page }) => {
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

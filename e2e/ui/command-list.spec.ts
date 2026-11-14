import { test, expect, type Page } from './helpers/fixtures'
import { expandAllGroups } from './helpers/commandList'
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
  // Ctrl+Shift+P is an app-level listener, so it only exists once React has
  // mounted — and `goto` resolving is earlier than that.
  await expect(page.locator('.titlebar')).toBeVisible()

  await page.keyboard.press('Control+Shift+p')
  await expect(page.locator('.cmd-list-float')).toBeVisible()
  await expandAllGroups(page)
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

  // The panel refreshed itself (that is what this test is about); its groups are
  // collapsed by default, so open them to see the row.
  await expandAllGroups(page)
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
  await expect(page.locator('.tab-item:not(.tab-home)')).toContainText('Demo')
  await page.waitForSelector('.xterm-helper-textarea', { state: 'attached' })

  await page.keyboard.press('Control+Shift+p')
  await expect(page.locator('.cmd-list-float')).toBeVisible()
  await expandAllGroups(page)
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

// The footer used to stack the hint above the slider, costing a whole extra line
// on the panel's least important row. They now share one line, with the hint
// yielding space first (ellipsis) so the slider stays reachable.
test('the footer keeps the hint and the opacity slider on one line', async ({ page }) => {
  await installTauriMock(page, { commandSnippets: SNIPPETS })
  await page.goto('/')
  await expect(page.locator('.titlebar')).toBeVisible()
  await page.keyboard.press('Control+Shift+p')
  await expect(page.locator('.cmd-list-float')).toBeVisible()

  const hint = await page.locator('.cmd-list-hint').boundingBox()
  const slider = await page.locator('.cmd-list-opacity').boundingBox()
  if (!hint || !slider) throw new Error('footer controls not found')

  // One row: vertical centres agree. A wrapped hint would sit a row above.
  const hintMid = hint.y + hint.height / 2
  const sliderMid = slider.y + slider.height / 2
  expect(Math.abs(hintMid - sliderMid)).toBeLessThan(3)
  expect(hint.x).toBeLessThan(slider.x)
})

// The trailing row actions used to reserve their width even while invisible, so
// the command text stopped short of the right edge. They now collapse to zero
// width and expand on hover — the expansion is what pushes the text left.
test('row actions take no width until the row is hovered', async ({ page }) => {
  await installTauriMock(page, { commandSnippets: SNIPPETS })
  await page.goto('/')
  await expect(page.locator('.titlebar')).toBeVisible()
  await page.keyboard.press('Control+Shift+p')
  await expect(page.locator('.cmd-list-float')).toBeVisible()
  await expandAllGroups(page)

  const row = page.locator('.cmd-list-item').first()
  const actions = row.locator('.cmd-list-item-actions')

  await page.mouse.move(0, 0)
  await expect.poll(async () => (await actions.boundingBox())?.width ?? -1).toBeLessThan(1)

  await row.hover()
  await expect.poll(async () => (await actions.boundingBox())?.width ?? 0).toBeGreaterThan(20)
})

// A row carries its own tooltip and each action button carries another. The
// button must win, and the row's `title` must stay suppressed while the pointer
// is on a button — restoring it early is what let the browser draw the native
// row tooltip on top of the custom one.
test('a row action tooltip replaces the command tooltip', async ({ page }) => {
  await installTauriMock(page, { commandSnippets: SNIPPETS })
  await page.goto('/')
  await expect(page.locator('.titlebar')).toBeVisible()
  await page.keyboard.press('Control+Shift+p')
  await expect(page.locator('.cmd-list-float')).toBeVisible()
  await expandAllGroups(page)

  const row = page.locator('.cmd-list-item').first()
  const tip = page.locator('.wl-tooltip')

  // The command's tooltip is the custom one, not the native title.
  await row.hover()
  await expect(tip).toHaveAttribute('data-visible', 'true')
  await expect(tip).toContainText('docker ps')

  // The third trailing action is Edit; its tooltip replaces the command's.
  await row.locator('.cmd-list-item-actions button').nth(2).hover()
  await expect(tip).toHaveText('Edit')
  await expect(row).not.toHaveAttribute('title', /.+/)

  // Back over the command itself: the button's text must not linger. The row's
  // `title` is still suppressed here, so this only works if the chain keeps the
  // text it captured on the way in.
  await row.hover()
  await expect(tip).toContainText('docker ps')
})

// Hovering a row also reveals the group header's "+". That button used to be
// 18px tall inside a 16px line box, so the header grew 2px and pushed every row
// down — then back up when the pointer left.
test('hovering a command row does not shift it vertically', async ({ page }) => {
  await installTauriMock(page, { commandSnippets: SNIPPETS })
  await page.goto('/')
  await expect(page.locator('.titlebar')).toBeVisible()
  await page.keyboard.press('Control+Shift+p')
  await expect(page.locator('.cmd-list-float')).toBeVisible()
  await expandAllGroups(page)

  const row = page.locator('.cmd-list-item').first()
  const header = page.locator('.cmd-list-section-header').first()
  await page.mouse.move(0, 0)
  const beforeRow = await row.boundingBox()
  const beforeHeader = await header.boundingBox()

  await row.hover()
  await expect
    .poll(async () => (await header.boundingBox())?.height ?? 0)
    .toBe(beforeHeader?.height ?? -1)
  expect((await row.boundingBox())?.y).toBe(beforeRow?.y)

  await page.mouse.move(0, 0)
  expect((await row.boundingBox())?.y).toBe(beforeRow?.y)
})

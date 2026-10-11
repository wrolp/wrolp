import { test, expect, type Page } from './helpers/fixtures'
import { installTauriMock } from './helpers/tauriMock'

// The combos used to be spelled out inside the listener that acted on them, so
// nothing could change one and the app could not say what it bound. They live in
// one table now (`src/lib/keybindings.ts`), which these tests pin from both
// sides: the pane edits the table, and the keystroke obeys whatever the table
// says next.

const DEMO_CONN = { id: 'c1', name: 'Demo', host: 'demo.local', port: 22, username: 'root' }

async function openShortcuts(page: Page) {
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  await installTauriMock(page, {})
  await page.goto('/')
  await page.locator('.titlebar-btn.settings-btn').click()
  await page.locator('.settings-nav-item').filter({ hasText: 'Shortcuts' }).click()
  await expect(page.locator('.shortcut-row').first()).toBeVisible()
}

const row = (page: Page, action: string) =>
  page.locator('.shortcut-row').filter({ hasText: action })
const chip = (page: Page, action: string) => row(page, action).locator('.shortcut-kbd kbd')

/** Click the chip and answer the recorder with a real combination. */
async function rebind(page: Page, action: string, combo: string) {
  await row(page, action).locator('.shortcut-kbd').click()
  await expect(row(page, action).locator('.shortcut-press')).toBeVisible()
  await page.keyboard.press(combo)
}

test('the pane lists every bound action with its built-in combo', async ({ page }) => {
  await openShortcuts(page)
  await expect(chip(page, 'Command palette')).toHaveText('Ctrl+K')
  await expect(chip(page, 'Show or hide the sidebar')).toHaveText('Ctrl+B')
  // `ctrl+alt+b` is a different binding from `ctrl+b`, not a second match of it:
  // exact modifier matching is what lets both coexist.
  await expect(chip(page, 'Move the sidebar to the other side')).toHaveText('Ctrl+Alt+B')
  await expect(chip(page, 'Command completion list')).toHaveText('Alt+/')
  await expect(chip(page, 'Close a pop-up')).toHaveText('Esc')
  await expect(page.locator('.shortcut-group-header h4')).toHaveText([
    'Interface panels',
    'Commands',
    'Inside the terminal',
    'File editor',
    'Pop-ups',
  ])
})

test('a rebound combo is the one the keystroke obeys', async ({ page }) => {
  await openShortcuts(page)
  await rebind(page, 'Show or hide the sidebar', 'Control+Alt+u')
  await expect(chip(page, 'Show or hide the sidebar')).toHaveText('Ctrl+Alt+U')

  // The keystroke follows the table, and the old combo stops working.
  await expect(page.locator('.sidebar')).toBeVisible()
  await page.keyboard.press('Control+Alt+u')
  await expect(page.locator('.sidebar')).toBeHidden()
  await page.keyboard.press('Control+b')
  await expect(page.locator('.sidebar')).toBeHidden()
  await page.keyboard.press('Control+Alt+u')
  await expect(page.locator('.sidebar')).toBeVisible()

  // The row says which combo is the built-in one, so the change is undoable by
  // reading the screen rather than by remembering it.
  await expect(row(page, 'Show or hide the sidebar')).toContainText('Default: Ctrl+B')
})

test('the binding survives a reload', async ({ page }) => {
  await openShortcuts(page)
  await rebind(page, 'Command palette', 'Control+Shift+d')
  await page.reload()
  await page.locator('.titlebar-btn.settings-btn').click()
  await page.locator('.settings-nav-item').filter({ hasText: 'Shortcuts' }).click()
  await expect(chip(page, 'Command palette')).toHaveText('Ctrl+Shift+D')
  await page.keyboard.press('Control+Shift+d')
  await expect(page.locator('.palette-panel')).toBeVisible()
})

test('the titlebar trigger quotes the live combo, not the default', async ({ page }) => {
  await openShortcuts(page)
  // The chip has always spelled its keys with spaces (`Ctrl K`); the tooltip
  // beside it uses the `+` spelling.
  await expect(page.locator('.cmd-trigger kbd')).toHaveText('Ctrl K')
  await rebind(page, 'Command palette', 'Control+Shift+d')
  await expect(page.locator('.cmd-trigger kbd')).toHaveText('Ctrl Shift D')
  await expect(page.locator('.cmd-trigger')).toHaveAttribute('title', /Ctrl\+Shift\+D/)
})

test('a combo already in use is refused, naming its owner', async ({ page }) => {
  await openShortcuts(page)
  await rebind(page, 'Show or hide the sidebar', 'Control+k')
  await expect(row(page, 'Show or hide the sidebar').locator('.shortcut-notice.error')).toHaveText(
    'That combination is already bound to Command palette.',
  )
  // Refused means unchanged: the palette keeps its key.
  await expect(chip(page, 'Show or hide the sidebar')).toHaveText('Ctrl+B')
})

test('keys the shell owns cannot be traded away', async ({ page }) => {
  await openShortcuts(page)
  await rebind(page, 'Show or hide the sidebar', 'Control+c')
  await expect(row(page, 'Show or hide the sidebar').locator('.shortcut-notice.error')).toHaveText(
    'That key belongs to the shell or the system — interrupt, copy, paste, Tab, Enter.',
  )
  await expect(chip(page, 'Show or hide the sidebar')).toHaveText('Ctrl+B')

  // And a bare letter is not a shortcut: it is typing.
  await rebind(page, 'Command palette', 'k')
  await expect(row(page, 'Command palette').locator('.shortcut-notice.error')).toHaveText(
    'Add Ctrl or Alt, or use a function key or Esc.',
  )
})

test('unbinding frees the key, and a row can be restored on its own', async ({ page }) => {
  await openShortcuts(page)
  await rebind(page, 'Show or hide the sidebar', 'Control+Alt+u')
  await row(page, 'Show or hide the sidebar').locator('.shortcut-kbd').click()
  await page.keyboard.press('Escape')
  // Cancelling the recorder changes nothing.
  await expect(chip(page, 'Show or hide the sidebar')).toHaveText('Ctrl+Alt+U')

  await row(page, 'Show or hide the sidebar').locator('.shortcut-clear').click()
  await expect(chip(page, 'Show or hide the sidebar')).toHaveText('Unbound')
  await page.keyboard.press('Control+Alt+u')
  await expect(page.locator('.sidebar')).toBeVisible()

  // Restoring one row leaves the others alone.
  await rebind(page, 'Command palette', 'Control+Shift+d')
  await row(page, 'Show or hide the sidebar').locator('.shortcut-reset').click()
  await expect(chip(page, 'Show or hide the sidebar')).toHaveText('Ctrl+B')
  await expect(chip(page, 'Command palette')).toHaveText('Ctrl+Shift+D')

  await page.locator('.shortcut-reset-all').click()
  await expect(chip(page, 'Command palette')).toHaveText('Ctrl+K')
  await page.keyboard.press('Control+b')
  await expect(page.locator('.sidebar')).toBeHidden()
})

test('a terminal-scoped binding is answered by the terminal, not the window', async ({ page }) => {
  // Scrollback is the case a global listener cannot serve: xterm only sees the key
  // through its one custom key handler, and it has Shift+PageUp compiled in.
  // Binding the action to a combo xterm knows nothing about proves the table — not
  // the built-in default — is what moved the view.
  const lines = Array.from({ length: 80 }, (_, i) => `line ${i}\r\n`).join('')
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  await page.addInitScript(() =>
    localStorage.setItem('wrolp-shortcuts', JSON.stringify({ scrollPageUp: 'ctrl+alt+u' })),
  )
  await installTauriMock(page, {
    connections: [DEMO_CONN],
    pollOutputChunks: [[lines]],
  })
  await page.goto('/')
  await page.locator('.connection-item').first().click()
  await expect(page.locator('.xterm-rows')).toContainText('line 79')
  await page.locator('.xterm-screen').click()

  const viewport = page.locator('.xterm-viewport')
  // xterm fits to the row grid after the write lands, so the resting position is
  // read once the viewport has stopped moving rather than immediately.
  const scrollTop = () => viewport.evaluate((el) => el.scrollTop)
  await expect.poll(scrollTop, { timeout: 5000 }).toBeGreaterThan(0)
  const atBottom = await scrollTop()
  await page.keyboard.press('Control+Alt+u')
  await expect
    .poll(scrollTop, { timeout: 5000, message: 'the rebound combo did not scroll back' })
    .toBeLessThan(atBottom)
})

test('an unbound action leaves the key to the terminal', async ({ page }) => {
  // The negative half of the same rule: nothing may consume a key no action
  // claims, or unbinding would still eat it.
  const lines = Array.from({ length: 80 }, (_, i) => `line ${i}\r\n`).join('')
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  await page.addInitScript(() =>
    localStorage.setItem('wrolp-shortcuts', JSON.stringify({ scrollPageUp: null })),
  )
  await installTauriMock(page, { connections: [DEMO_CONN], pollOutputChunks: [[lines]] })
  await page.goto('/')
  await page.locator('.connection-item').first().click()
  await expect(page.locator('.xterm-rows')).toContainText('line 79')
  await page.locator('.xterm-screen').click()

  const viewport = page.locator('.xterm-viewport')
  await expect
    .poll(() => viewport.evaluate((el) => el.scrollTop), { timeout: 5000 })
    .toBeGreaterThan(0)
  const atBottom = await viewport.evaluate((el) => el.scrollTop)
  await page.keyboard.press('Control+Alt+u')
  await page.waitForTimeout(200)
  expect(await viewport.evaluate((el) => el.scrollTop)).toBe(atBottom)
})

test('search narrows the list to the actions that match', async ({ page }) => {
  await openShortcuts(page)
  const rows = page.locator('.shortcut-row')
  const total = await rows.count()
  await page.locator('.shortcut-search').fill('inspector')
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText('Show or hide the inspector')

  // Matching on the combo is what makes "what is bound to Ctrl+K?" answerable.
  await page.locator('.shortcut-search').fill('ctrl+shift+p')
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText('Command snippets list')

  await page.locator('.shortcut-search').fill('nothing matches this')
  await expect(rows).toHaveCount(0)
  await expect(page.locator('.shortcut-empty')).toBeVisible()

  await page.locator('.shortcut-search').fill('')
  await expect(rows).toHaveCount(total)
})

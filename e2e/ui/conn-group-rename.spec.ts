/**
 * Renaming a connection group uses the app's own modal, not `window.prompt`.
 *
 * The native prompt is an OS dialog inside the WebView: unthemed, modal to the
 * whole process and impossible to style. The rename now runs through the same
 * `modal-overlay` / `modal` markup as the other connection dialogs; this spec
 * also proves the browser prompt is never called.
 */
import { test, expect, type Page } from './helpers/fixtures'
import { selectRailMode } from './helpers/sections'
import { installTauriMock, invokedCalls } from './helpers/tauriMock'

const DEMO_CONN = {
  id: 'c1',
  name: 'Demo',
  host: 'demo.local',
  port: 22,
  username: 'root',
  group: 'Network',
}

async function boot(page: Page) {
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  await installTauriMock(page, { connections: [DEMO_CONN] })
  await page.goto('/')
  await selectRailMode(page, 'hosts')
  // A `window.prompt` call would mean the old OS dialog is still wired up.
  await page.evaluate(() => {
    const w = window as unknown as { __promptCalls: number }
    w.__promptCalls = 0
    window.prompt = () => {
      w.__promptCalls += 1
      return null
    }
  })
}

async function openRenameDialog(page: Page) {
  await page.locator('.conn-group-header', { hasText: 'Network' }).click({ button: 'right' })
  await page.locator('.context-menu-item', { hasText: 'Rename Group' }).click()
  const dialog = page.locator('.modal').filter({
    has: page.locator('.modal-title', { hasText: 'Rename Group' }),
  })
  await expect(dialog).toBeVisible()
  return dialog
}

test('the group rename dialog is the app modal and renames the group', async ({ page }) => {
  await boot(page)
  const dialog = await openRenameDialog(page)

  const input = dialog.locator('input')
  await expect(input).toHaveValue('Network')
  await input.fill('Lab')
  await page.keyboard.press('Enter')

  await expect(dialog).toHaveCount(0)
  await expect
    .poll(async () =>
      (await invokedCalls(page))
        .filter((c) => c.cmd === 'rename_group')
        .map((c) => [c.args.oldName, c.args.newName]),
    )
    .toContainEqual(['Network', 'Lab'])
  // The sidebar re-reads the connections, so the header follows the rename.
  await expect(page.locator('.conn-group-header', { hasText: 'Lab' })).toBeVisible()
  expect(
    await page.evaluate(() => (window as unknown as { __promptCalls: number }).__promptCalls),
  ).toBe(0)
})

test('an empty name is refused in place; Esc closes the dialog', async ({ page }) => {
  await boot(page)
  const dialog = await openRenameDialog(page)

  await dialog.locator('input').fill('   ')
  await dialog.locator('button.primary').click()
  await expect(dialog.locator('.form-error')).toHaveText('Group name cannot be empty.')
  await expect(dialog).toBeVisible()
  expect((await invokedCalls(page)).filter((c) => c.cmd === 'rename_group')).toHaveLength(0)

  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  expect(
    await page.evaluate(() => (window as unknown as { __promptCalls: number }).__promptCalls),
  ).toBe(0)
})

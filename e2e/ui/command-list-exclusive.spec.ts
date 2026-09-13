import { test, expect, type Page } from '@playwright/test'
import { installTauriMock, invokedCalls } from './helpers/tauriMock'

// Mutually-exclusive command-snippet options/params: items sharing a non-empty
// `exclusiveGroup` may have at most one enabled in the fill dialog — checking
// one unchecks the other members of its group (across options and params).

const DEMO_CONN = { id: 'c1', name: 'Demo', host: 'demo.local', port: 22, username: 'root' }
const OTHER_CONN = { id: 'c2', name: 'Other', host: 'other.local', port: 22, username: 'root' }

const baseSnippet = (over: Record<string, unknown>) => ({
  alias: null,
  favorite: false,
  hidden: false,
  sortOrder: 0,
  connectionId: null,
  params: [],
  options: [],
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-08-01T00:00:00Z',
  ...over,
})

/** Connect to Demo so a focused terminal exists, then open the panel. */
async function openPanelWithTerminal(page: Page, snippets: unknown[]) {
  await installTauriMock(page, { connections: [DEMO_CONN, OTHER_CONN], commandSnippets: snippets })
  await page.goto('/')
  await page.locator('.connection-item').first().click()
  await expect(page.locator('.tab-item')).toContainText('Demo')
  await page.waitForSelector('.xterm-helper-textarea', { state: 'attached' })
  await page.keyboard.press('Control+Shift+p')
  await expect(page.locator('.cmd-list-float')).toBeVisible()
}

test('checking one exclusive option unchecks the other', async ({ page }) => {
  await openPanelWithTerminal(page, [
    baseSnippet({
      id: 'x1',
      command: 'tool -a -b',
      options: [
        { id: 'oa', text: '-a', defaultEnabled: true, exclusiveGroup: 'pick' },
        { id: 'ob', text: '-b', defaultEnabled: false, exclusiveGroup: 'pick' },
      ],
    }),
  ])

  await page.locator('.cmd-list-item').click()
  const dialog = page.locator('.snip-fill-modal')
  await expect(dialog).toBeVisible()
  // Only the first option is enabled initially.
  await expect(dialog.locator('.snip-fill-command-preview')).toHaveText('tool -a')

  const rows = dialog.locator('.snip-fill-group').first().locator('.snip-fill-row')
  const checkA = rows.nth(0).locator('input[type="checkbox"]')
  const checkB = rows.nth(1).locator('input[type="checkbox"]')
  await expect(checkA).toBeChecked()
  await expect(checkB).not.toBeChecked()

  await checkB.check()
  await expect(checkB).toBeChecked()
  await expect(checkA).not.toBeChecked()
  await expect(dialog.locator('.snip-fill-command-preview')).toHaveText('tool -b')
})

test('conflicting exclusive defaults are collapsed to the first on open', async ({ page }) => {
  await openPanelWithTerminal(page, [
    baseSnippet({
      id: 'x2',
      command: 'tool -a -b',
      options: [
        { id: 'oa', text: '-a', defaultEnabled: true, exclusiveGroup: 'pick' },
        { id: 'ob', text: '-b', defaultEnabled: true, exclusiveGroup: 'pick' },
      ],
    }),
  ])

  await page.locator('.cmd-list-item').click()
  const dialog = page.locator('.snip-fill-modal')
  const rows = dialog.locator('.snip-fill-group').first().locator('.snip-fill-row')
  await expect(rows.nth(0).locator('input[type="checkbox"]')).toBeChecked()
  await expect(rows.nth(1).locator('input[type="checkbox"]')).not.toBeChecked()
  await expect(dialog.locator('.snip-fill-command-preview')).toHaveText('tool -a')
})

test('an exclusive option and parameter are mutually exclusive across groups', async ({ page }) => {
  await openPanelWithTerminal(page, [
    baseSnippet({
      id: 'x3',
      command: 'tool -a ${mode}',
      params: [
        {
          name: 'mode',
          type: 'text',
          defaultValue: 'm',
          options: [],
          defaultEnabled: false,
          exclusiveGroup: 'pick',
        },
      ],
      options: [{ id: 'oa', text: '-a', defaultEnabled: true, exclusiveGroup: 'pick' }],
    }),
  ])

  await page.locator('.cmd-list-item').click()
  const dialog = page.locator('.snip-fill-modal')
  // Option enabled, param disabled -> the option survives, the placeholder is dropped.
  await expect(dialog.locator('.snip-fill-command-preview')).toHaveText('tool -a')

  // Enabling the param must disable the option (same group, different section).
  const optionCheck = dialog
    .locator('.snip-fill-group')
    .first()
    .locator('.snip-fill-row input[type="checkbox"]')
    .first()
  const paramCheck = dialog
    .locator('.snip-fill-group')
    .nth(1)
    .locator('.snip-fill-row input[type="checkbox"]')
    .first()
  await paramCheck.check()
  await expect(paramCheck).toBeChecked()
  await expect(optionCheck).not.toBeChecked()
  await expect(dialog.locator('.snip-fill-command-preview')).toHaveText('tool m')
})

test('the editor persists an option exclusive group on save', async ({ page }) => {
  await openPanelWithTerminal(page, [
    baseSnippet({
      id: 'x4',
      command: 'tool -a -b',
      options: [
        { id: 'oa', text: '-a', defaultEnabled: true },
        { id: 'ob', text: '-b', defaultEnabled: false },
      ],
    }),
  ])

  // Open the editor for the snippet via its context menu.
  await page.locator('.cmd-list-item').click({ button: 'right' })
  await page.locator('.cmd-list-menu .context-menu-item').filter({ hasText: 'Edit' }).click()

  const editor = page.locator('.cmd-list-modal-drag')
  await expect(editor).toBeVisible()
  await editor.locator('.snip-option-row').first().locator('input.snip-exclusive').fill('pick')
  await editor.locator('.modal-footer .btn-primary').click()

  await expect
    .poll(async () => {
      const calls = (await invokedCalls(page)).filter((c) => c.cmd === 'save_command_snippet')
      const snippet = calls.at(-1)?.args.snippet as
        | { options?: Array<{ id: string; exclusiveGroup?: string }> }
        | undefined
      return snippet?.options?.[0]?.exclusiveGroup
    })
    .toBe('pick')
})

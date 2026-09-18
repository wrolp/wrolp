import { test, expect, type Page } from './helpers/fixtures'
import { expandAllGroups } from './helpers/commandList'
import { installTauriMock, invokedCalls } from './helpers/tauriMock'

// Linked command-snippet items ("enabling A also enables B"): an item's `enables`
// list holds namespaced keys (`param:<name>` / `option:<id>`). Switching an item
// on switches its targets on too, transitively; switching one OFF never cascades.

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
  // Groups open collapsed; these tests work with the rows.
  await expandAllGroups(page)
}

/** Option rows of the open fill dialog (options are the first group). */
const optionChecks = (page: Page) =>
  page.locator('.snip-fill-modal .snip-fill-group').first().locator('.snip-fill-row')
const paramChecks = (page: Page) =>
  page.locator('.snip-fill-modal .snip-fill-group').nth(1).locator('.snip-fill-row')

test('enabling a linked option enables its target; unchecking never cascades', async ({ page }) => {
  await openPanelWithTerminal(page, [
    baseSnippet({
      id: 'l1',
      command: 'tool -a -b',
      options: [
        { id: 'oa', text: '-a', defaultEnabled: false, enables: ['option:ob'] },
        { id: 'ob', text: '-b', defaultEnabled: false },
      ],
    }),
  ])

  await page.locator('.cmd-list-item').click()
  const preview = page.locator('.snip-fill-command-preview')
  await expect(preview).toHaveText('tool')

  const rows = optionChecks(page)
  const checkA = rows.nth(0).locator('input[type="checkbox"]')
  const checkB = rows.nth(1).locator('input[type="checkbox"]')

  // A -> B.
  await checkA.check()
  await expect(checkB).toBeChecked()
  await expect(preview).toHaveText('tool -a -b')
  // Both rows advertise the linkage.
  await expect(page.locator('.snip-fill-link')).toHaveCount(1)

  // Unchecking A must NOT take B with it.
  await checkA.uncheck()
  await expect(checkA).not.toBeChecked()
  await expect(checkB).toBeChecked()
  await expect(preview).toHaveText('tool -b')

  // Directional: B does not link back to A.
  await checkB.uncheck()
  await checkB.check()
  await expect(checkA).not.toBeChecked()
  await expect(preview).toHaveText('tool -b')
})

test('linkage follows the chain transitively (A -> B -> C)', async ({ page }) => {
  await openPanelWithTerminal(page, [
    baseSnippet({
      id: 'l2',
      command: 'tool -a -b -c',
      options: [
        { id: 'oa', text: '-a', defaultEnabled: false, enables: ['option:ob'] },
        { id: 'ob', text: '-b', defaultEnabled: false, enables: ['option:oc'] },
        { id: 'oc', text: '-c', defaultEnabled: false },
      ],
    }),
  ])

  await page.locator('.cmd-list-item').click()
  const rows = optionChecks(page)
  await rows.nth(0).locator('input[type="checkbox"]').check()
  await expect(rows.nth(1).locator('input[type="checkbox"]')).toBeChecked()
  await expect(rows.nth(2).locator('input[type="checkbox"]')).toBeChecked()
  await expect(page.locator('.snip-fill-command-preview')).toHaveText('tool -a -b -c')
})

test('two items pointing at each other behave as a pair', async ({ page }) => {
  await openPanelWithTerminal(page, [
    baseSnippet({
      id: 'l3',
      command: 'tool -a -b',
      options: [
        { id: 'oa', text: '-a', defaultEnabled: false, enables: ['option:ob'] },
        { id: 'ob', text: '-b', defaultEnabled: false, enables: ['option:oa'] },
      ],
    }),
  ])

  await page.locator('.cmd-list-item').click()
  const rows = optionChecks(page)
  // Checking the SECOND one pulls the first in (that is the reverse direction).
  await rows.nth(1).locator('input[type="checkbox"]').check()
  await expect(rows.nth(0).locator('input[type="checkbox"]')).toBeChecked()
  await expect(page.locator('.snip-fill-command-preview')).toHaveText('tool -a -b')
})

test('an option can link to a parameter across the two sections', async ({ page }) => {
  await openPanelWithTerminal(page, [
    baseSnippet({
      id: 'l4',
      command: 'tool -a ${mode}',
      params: [
        {
          name: 'mode',
          type: 'text',
          defaultValue: 'm',
          options: [],
          defaultEnabled: false,
        },
      ],
      options: [{ id: 'oa', text: '-a', defaultEnabled: false, enables: ['param:mode'] }],
    }),
  ])

  await page.locator('.cmd-list-item').click()
  await expect(page.locator('.snip-fill-command-preview')).toHaveText('tool')
  await optionChecks(page).nth(0).locator('input[type="checkbox"]').check()
  await expect(paramChecks(page).nth(0).locator('input[type="checkbox"]')).toBeChecked()
  await expect(page.locator('.snip-fill-command-preview')).toHaveText('tool -a m')
})

test('mutual exclusion wins over linkage for the linked target', async ({ page }) => {
  await openPanelWithTerminal(page, [
    baseSnippet({
      id: 'l5',
      command: 'tool -a -b -c',
      options: [
        { id: 'oa', text: '-a', defaultEnabled: false, enables: ['option:oc'] },
        { id: 'ob', text: '-b', defaultEnabled: true, exclusiveGroup: 'pick' },
        { id: 'oc', text: '-c', defaultEnabled: false, exclusiveGroup: 'pick' },
      ],
    }),
  ])

  await page.locator('.cmd-list-item').click()
  // B is the only enabled member of the exclusive group to start with.
  await expect(page.locator('.snip-fill-command-preview')).toHaveText('tool -b')

  const rows = optionChecks(page)
  await rows.nth(0).locator('input[type="checkbox"]').check()
  // C came on through the link and, being in B's exclusive group, turned B off.
  await expect(rows.nth(2).locator('input[type="checkbox"]')).toBeChecked()
  await expect(rows.nth(1).locator('input[type="checkbox"]')).not.toBeChecked()
  await expect(page.locator('.snip-fill-command-preview')).toHaveText('tool -a -c')
})

test('a default-enabled item expands its links when the dialog opens', async ({ page }) => {
  await openPanelWithTerminal(page, [
    baseSnippet({
      id: 'l6',
      command: 'tool -a -b',
      options: [
        { id: 'oa', text: '-a', defaultEnabled: true, enables: ['option:ob'] },
        { id: 'ob', text: '-b', defaultEnabled: false },
      ],
    }),
  ])

  await page.locator('.cmd-list-item').click()
  const rows = optionChecks(page)
  await expect(rows.nth(0).locator('input[type="checkbox"]')).toBeChecked()
  await expect(rows.nth(1).locator('input[type="checkbox"]')).toBeChecked()
  await expect(page.locator('.snip-fill-command-preview')).toHaveText('tool -a -b')
})

test('the editor saves the linkage picked for an option', async ({ page }) => {
  await openPanelWithTerminal(page, [
    baseSnippet({
      id: 'l7',
      command: 'tool -a -b',
      options: [
        { id: 'oa', text: '-a', defaultEnabled: true },
        { id: 'ob', text: '-b', defaultEnabled: false },
      ],
    }),
  ])

  await page.locator('.cmd-list-item').click({ button: 'right' })
  await page.locator('.cmd-list-menu .context-menu-item').filter({ hasText: 'Edit' }).click()

  const editor = page.locator('.cmd-list-modal-drag')
  await expect(editor).toBeVisible()
  const firstRow = editor.locator('.snip-option-row').first()
  await firstRow.locator('.snip-link-btn').click()
  // The picker lists the OTHER rows, labelled by their flag text.
  const panel = firstRow.locator('.snip-link-panel')
  await expect(panel.locator('.snip-link-chip')).toHaveCount(1)
  await panel.locator('.snip-link-chip', { hasText: '-b' }).click()
  await expect(panel.locator('.snip-link-chip input')).toBeChecked()

  await editor.locator('.modal-footer .btn-primary').click()

  await expect
    .poll(async () => {
      const calls = (await invokedCalls(page)).filter((c) => c.cmd === 'save_command_snippet')
      const snippet = calls.at(-1)?.args.snippet as
        | { options?: Array<{ id: string; enables?: string[] }> }
        | undefined
      return snippet?.options?.[0]?.enables
    })
    .toEqual(['option:ob'])
})

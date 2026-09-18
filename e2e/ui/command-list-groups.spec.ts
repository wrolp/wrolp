import { test, expect, type Page } from './helpers/fixtures'
import { expandAllGroups } from './helpers/commandList'
import { installTauriMock, invokedCalls } from './helpers/tauriMock'

// Custom command-list groups (task/plans/COMMAND-LIST-CUSTOM-GROUPS-PLAN.md).
//
// A group is nothing but a `groupName` label on the snippet plus a name order
// list in localStorage (`wrolp.cmdGroupOrder`); existence is the union of the
// two. All mutations reuse `save_command_snippet` — no new IPC.

const DEMO_CONN = { id: 'c1', name: 'Demo', host: 'demo.local', port: 22, username: 'root' }
const OTHER_CONN = { id: 'c2', name: 'Other', host: 'other.local', port: 22, username: 'root' }

const baseSnippet = (over: Record<string, unknown>) => ({
  alias: null,
  favorite: false,
  hidden: false,
  sortOrder: 0,
  connectionId: null,
  groupName: null,
  params: [],
  options: [],
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-08-01T00:00:00Z',
  ...over,
})

/**
 * Connect to Demo so a focused terminal exists, then open the panel. Groups
 * start collapsed, so the rows are expanded by default — pass
 * `{ expand: false }` to assert the collapsed default itself.
 */
async function openPanel(page: Page, snippets: unknown[], opts: { expand?: boolean } = {}) {
  await installTauriMock(page, { connections: [DEMO_CONN, OTHER_CONN], commandSnippets: snippets })
  await page.goto('/')
  await page.locator('.connection-item').first().click()
  await expect(page.locator('.tab-item')).toContainText('Demo')
  await page.waitForSelector('.xterm-helper-textarea', { state: 'attached' })
  await page.keyboard.press('Control+Shift+p')
  await expect(page.locator('.cmd-list-float')).toBeVisible()
  if (opts.expand !== false) await expandAllGroups(page)
}

/**
 * The default view is "by connection"; every group test starts by switching.
 * The group view has its OWN (collapsed) expand state, so the rows are expanded
 * here too unless the caller asks otherwise.
 */
async function switchToGroups(page: Page, opts: { expand?: boolean } = {}) {
  await page.locator('.cmd-list-mode-btn', { hasText: 'By group' }).click()
  await expect(page.locator('.cmd-list-mode-btn', { hasText: 'By group' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  if (opts.expand !== false) await expandAllGroups(page)
}

const sectionTitles = (page: Page) => page.locator('.cmd-list-section-title')
const groupOrder = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('wrolp.cmdGroupOrder') ?? '[]'))
const saveCalls = async (page: Page) =>
  (await invokedCalls(page)).filter((c) => c.cmd === 'save_command_snippet')

/** Right-click a group header and pick an entry from its menu. */
async function groupMenu(page: Page, title: string, entry: string) {
  await page.locator('.cmd-list-section-header', { hasText: title }).click({ button: 'right' })
  await page.locator('.cmd-list-menu .context-menu-item').filter({ hasText: entry }).click()
}

/** HTML5 drag & drop: Playwright's mouse cannot synthesise these events. */
async function dragTo(page: Page, fromText: string, toText: string) {
  await page.evaluate(
    ([from, to]) => {
      const fromEl = Array.from(
        document.querySelectorAll('.cmd-list-item, .cmd-list-section-header'),
      ).find((el) => el.textContent?.includes(from)) as HTMLElement | undefined
      const toEl = Array.from(
        document.querySelectorAll('.cmd-list-section-header, .cmd-list-section'),
      ).find((el) => el.textContent?.includes(to)) as HTMLElement | undefined
      if (!fromEl || !toEl) throw new Error(`drag: ${from} -> ${to} not found`)
      const dt = new DataTransfer()
      fromEl.dispatchEvent(
        new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }),
      )
      toEl.dispatchEvent(
        new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }),
      )
      toEl.dispatchEvent(
        new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }),
      )
      fromEl.dispatchEvent(
        new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }),
      )
    },
    [fromText, toText] as const,
  )
}

test('the group view buckets by label with "Ungrouped" always last', async ({ page }) => {
  await openPanel(page, [
    baseSnippet({ id: 'g1', command: 'echo ops', groupName: 'Ops' }),
    baseSnippet({ id: 'g2', command: 'echo free', groupName: null }),
    baseSnippet({ id: 'g3', command: 'echo net', groupName: 'Net' }),
  ])

  // Default view is unchanged: connection-derived titles.
  await expect(sectionTitles(page)).toHaveText(['General'])

  await switchToGroups(page)
  await expect(sectionTitles(page)).toHaveText(['Ops', 'Net', 'Ungrouped'])
  await expect(page.locator('.cmd-list-section-count')).toHaveText(['1', '1', '1'])
})

test('groups start collapsed, and a search reveals its matches', async ({ page }) => {
  await openPanel(
    page,
    [
      baseSnippet({ id: 'g1', command: 'echo one', groupName: 'Ops' }),
      baseSnippet({ id: 'g2', command: 'df -h', groupName: 'Net' }),
    ],
    { expand: false },
  )
  await switchToGroups(page, { expand: false })

  // The default: titles only, no rows.
  await expect(sectionTitles(page)).toHaveText(['Ops', 'Net'])
  await expect(page.locator('.cmd-list-item')).toHaveCount(0)

  // Clicking a header expands just that group.
  await page.locator('.cmd-list-section-header', { hasText: 'Ops' }).click()
  await expect(page.locator('.cmd-list-item')).toHaveCount(1)

  // A search shows what it matched without expanding anything…
  await page.locator('.cmd-list-search input').fill('df -h')
  await expect(sectionTitles(page)).toHaveText(['Net'])
  await expect(page.locator('.cmd-list-item')).toHaveCount(1)

  // …and clearing it restores the manual state (Ops open, Net closed).
  await page.locator('.cmd-list-search input').fill('')
  await expect(sectionTitles(page)).toHaveText(['Ops', 'Net'])
  await expect(page.locator('.cmd-list-item')).toHaveCount(1)
})

test('the two views keep separate expand state', async ({ page }) => {
  await openPanel(
    page,
    [
      baseSnippet({ id: 'g1', command: 'echo one', groupName: 'Ops' }),
      baseSnippet({ id: 'g2', command: 'echo two', groupName: 'Net' }),
    ],
    { expand: false },
  )

  // Expand the connection view's only group…
  await page.locator('.cmd-list-section-header', { hasText: 'General' }).click()
  await expect(page.locator('.cmd-list-item')).toHaveCount(2)

  // …the group view has its own set and is still collapsed…
  await switchToGroups(page, { expand: false })
  await expect(page.locator('.cmd-list-item')).toHaveCount(0)
  await page.locator('.cmd-list-section-header', { hasText: 'Ops' }).click()
  await expect(page.locator('.cmd-list-item')).toHaveCount(1)

  // …and switching back keeps whatever the connection view had.
  await page.locator('.cmd-list-mode-btn', { hasText: 'By connection' }).click()
  await expect(page.locator('.cmd-list-item')).toHaveCount(2)
})

// Regression: the draggable headers used to show a `grab` (open hand) while the
// non-draggable "Ungrouped" bucket showed a pointer — same list, two cursors.
test('every group header uses the same cursor', async ({ page }) => {
  await openPanel(page, [
    baseSnippet({ id: 'g1', command: 'echo ops', groupName: 'Ops' }),
    baseSnippet({ id: 'g2', command: 'echo free', groupName: null }),
  ])
  await switchToGroups(page)

  const cursors = await page
    .locator('.cmd-list-section-header')
    .evaluateAll((els) => els.map((el) => getComputedStyle(el).cursor))
  expect(cursors).toEqual(['pointer', 'pointer'])
})

test('a new group is stored in the order list and listed while empty', async ({ page }) => {
  await openPanel(page, [baseSnippet({ id: 'g1', command: 'echo one', groupName: 'Ops' })])
  await switchToGroups(page)

  await page.locator('.cmd-list-newgroup-btn').click()
  await expect(page.locator('.cmd-list-newgroup-btn')).toHaveAttribute('aria-expanded', 'true')
  await page.locator('.cmd-list-new-group input').fill('Deploy')
  await page.locator('.cmd-list-new-group input').press('Enter')

  await expect.poll(() => groupOrder(page)).toEqual(['Ops', 'Deploy'])
  await expect(sectionTitles(page)).toHaveText(['Ops', 'Deploy'])
  await expect(
    page.locator('.cmd-list-section', { hasText: 'Deploy' }).locator('.cmd-list-section-count'),
  ).toHaveText('0')
  await expect(page.locator('.cmd-list-empty-group')).toBeVisible()

  // Empty groups must not clutter search results.
  await page.locator('.cmd-list-search input').fill('echo')
  await expect(sectionTitles(page)).toHaveText(['Ops'])
})

test('the editor saves the group typed into the dialog', async ({ page }) => {
  await openPanel(page, [baseSnippet({ id: 'g1', command: 'echo one', groupName: null })])

  await page.locator('.cmd-list-item').click({ button: 'right' })
  await page.locator('.cmd-list-menu .context-menu-item').filter({ hasText: 'Edit' }).click()
  const dialog = page.locator('.cmd-list-modal-drag')
  await expect(dialog).toBeVisible()
  await dialog.locator('input[list="snippet-groups"]').fill('Deploy')
  await dialog.locator('.modal-footer .btn-primary').click()

  await expect
    .poll(async () => {
      const calls = await saveCalls(page)
      return (calls.at(-1)?.args.snippet as { groupName?: string | null } | undefined)?.groupName
    })
    .toBe('Deploy')
})

test('renaming a group relabels every member and merges into an existing name', async ({
  page,
}) => {
  await openPanel(page, [
    baseSnippet({ id: 'g1', command: 'echo ops one', groupName: 'Ops' }),
    baseSnippet({ id: 'g2', command: 'echo ops two', groupName: 'Ops' }),
    baseSnippet({ id: 'g3', command: 'echo net', groupName: 'Net' }),
  ])
  await switchToGroups(page)
  await expect(sectionTitles(page)).toHaveText(['Ops', 'Net'])

  await groupMenu(page, 'Ops', 'Rename group')
  const input = page.locator('.cmd-list-group-rename-input')
  await expect(input).toBeVisible()
  await input.fill('Net')
  await input.press('Enter')

  // Every member of the renamed group is re-labelled (one save per snippet)…
  await expect
    .poll(async () =>
      (await saveCalls(page))
        .map((c) => c.args.snippet as { id: string; groupName?: string | null })
        .filter((s) => s.groupName === 'Net')
        .map((s) => s.id)
        .sort(),
    )
    .toEqual(['g1', 'g2'])
  // …and the two groups are one (the untouched member kept its label).
  await expect(sectionTitles(page)).toHaveText(['Net'])
  await expect(page.locator('.cmd-list-item')).toHaveCount(3)
})

test('deleting a group returns its members to "Ungrouped" without deleting them', async ({
  page,
}) => {
  page.on('dialog', (d) => void d.accept())
  await openPanel(page, [
    baseSnippet({ id: 'g1', command: 'echo ops', groupName: 'Ops' }),
    baseSnippet({ id: 'g2', command: 'echo free', groupName: null }),
  ])
  await switchToGroups(page)
  await expect(sectionTitles(page)).toHaveText(['Ops', 'Ungrouped'])

  await groupMenu(page, 'Ops', 'Delete group')

  await expect.poll(async () => groupOrder(page)).toEqual([])
  await expect(sectionTitles(page)).toHaveText(['Ungrouped'])
  // The snippet survives — its label is just cleared.
  await expect(page.locator('.cmd-list-item')).toHaveCount(2)
  await expect
    .poll(async () =>
      (await saveCalls(page)).map(
        (c) => (c.args.snippet as { id: string; groupName?: string | null }).groupName,
      ),
    )
    .toEqual([null])
})

test('dragging a snippet onto another group re-labels it', async ({ page }) => {
  await openPanel(page, [
    baseSnippet({ id: 'g1', command: 'echo ops', groupName: 'Ops' }),
    baseSnippet({ id: 'g2', command: 'echo net', groupName: 'Net' }),
  ])
  await switchToGroups(page)

  await dragTo(page, 'echo ops', 'Net')

  await expect
    .poll(async () => {
      const calls = await saveCalls(page)
      const last = calls.at(-1)?.args.snippet as
        | { id: string; groupName?: string | null }
        | undefined
      return last && `${last.id}:${last.groupName}`
    })
    .toBe('g1:Net')
  // "Ops" had no other member and was never registered in the order list, so it
  // disappears; both commands now sit in "Net".
  await expect(sectionTitles(page)).toHaveText(['Net'])
  await expect(page.locator('.cmd-list-item')).toHaveCount(2)
})

test('dragging a group header reorders the order list only', async ({ page }) => {
  await openPanel(page, [
    baseSnippet({ id: 'g1', command: 'echo ops', groupName: 'Ops' }),
    baseSnippet({ id: 'g2', command: 'echo net', groupName: 'Net' }),
  ])
  await switchToGroups(page)
  await expect(sectionTitles(page)).toHaveText(['Ops', 'Net'])

  await dragTo(page, 'Net', 'Ops')

  await expect.poll(() => groupOrder(page)).toEqual(['Net', 'Ops'])
  await expect(sectionTitles(page)).toHaveText(['Net', 'Ops'])
  // Reordering is a display preference: no snippet is touched.
  expect(await saveCalls(page)).toHaveLength(0)
})

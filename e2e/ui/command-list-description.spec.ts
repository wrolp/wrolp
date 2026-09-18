import { test, expect, type Page } from './helpers/fixtures'
import { installTauriMock, invokedCalls } from './helpers/tauriMock'

// Command-snippet description (task/plans/COMMAND-SNIPPET-DESCRIPTION-PLAN.md):
// a free-form, possibly multi-line note that joins the row's hover tooltip
// (alias / command / description) and the search haystack. Persisted in the
// snippet row (`description` column) — no new IPC.

const DEMO_CONN = { id: 'c1', name: 'Demo', host: 'demo.local', port: 22, username: 'root' }
const OTHER_CONN = { id: 'c2', name: 'Other', host: 'other.local', port: 22, username: 'root' }

const baseSnippet = (over: Record<string, unknown>) => ({
  alias: null,
  favorite: false,
  hidden: false,
  sortOrder: 0,
  connectionId: null,
  groupName: null,
  description: null,
  params: [],
  options: [],
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-08-01T00:00:00Z',
  ...over,
})

async function openPanel(page: Page, snippets: unknown[]) {
  await installTauriMock(page, { connections: [DEMO_CONN, OTHER_CONN], commandSnippets: snippets })
  await page.goto('/')
  await page.locator('.connection-item').first().click()
  await expect(page.locator('.tab-item')).toContainText('Demo')
  await page.waitForSelector('.xterm-helper-textarea', { state: 'attached' })
  await page.keyboard.press('Control+Shift+p')
  await expect(page.locator('.cmd-list-float')).toBeVisible()
}

const tooltipOf = (page: Page, command: string) =>
  page.locator('.cmd-list-item', { hasText: command }).getAttribute('title')

/** The description textarea is the second one (the command box has `rows={4}`). */
const descriptionBox = (page: Page) => page.locator('.cmd-list-modal-drag textarea').nth(1)

test('the tooltip merges alias, command and description into one per line', async ({ page }) => {
  await openPanel(page, [
    baseSnippet({
      id: 'd1',
      command: 'df -h',
      alias: 'disk',
      description: 'Disk usage of the current directory',
    }),
  ])

  expect(await tooltipOf(page, 'df -h')).toBe('disk\ndf -h\nDisk usage of the current directory')
})

test('a snippet without a description keeps a two-line tooltip and no blank lines', async ({
  page,
}) => {
  await openPanel(page, [
    baseSnippet({ id: 'd1', command: 'df -h', alias: null, description: null }),
    baseSnippet({ id: 'd2', command: 'free -m', alias: 'mem', description: null }),
  ])

  // Legacy row: the tooltip is the command itself, nothing added.
  expect(await tooltipOf(page, 'df -h')).toBe('df -h')
  // Alias present, no description: exactly two segments.
  expect(await tooltipOf(page, 'free -m')).toBe('mem\nfree -m')
  // Never a blank line, whatever the combination.
  expect(await tooltipOf(page, 'free -m')).not.toContain('\n\n')
})

test('a multi-line description keeps its line breaks in the tooltip', async ({ page }) => {
  await openPanel(page, [
    baseSnippet({
      id: 'd1',
      command: 'du -sh *',
      description: 'Disk usage per entry\nNeeds root for other users',
    }),
  ])

  expect(await tooltipOf(page, 'du -sh *')).toBe(
    'du -sh *\nDisk usage per entry\nNeeds root for other users',
  )
})

test('the editor saves a multi-line description unchanged', async ({ page }) => {
  await openPanel(page, [baseSnippet({ id: 'd1', command: 'du -sh *', description: null })])

  await page.locator('.cmd-list-item').click({ button: 'right' })
  await page.locator('.cmd-list-menu .context-menu-item').filter({ hasText: 'Edit' }).click()
  const dialog = page.locator('.cmd-list-modal-drag')
  await expect(dialog).toBeVisible()
  await descriptionBox(page).fill('line one\nline two')
  await dialog.locator('.modal-footer .btn-primary').click()

  await expect
    .poll(async () => {
      const calls = (await invokedCalls(page)).filter((c) => c.cmd === 'save_command_snippet')
      return (calls.at(-1)?.args.snippet as { description?: string | null } | undefined)
        ?.description
    })
    .toBe('line one\nline two')
})

test('reopening the editor refills the description textarea', async ({ page }) => {
  await openPanel(page, [
    baseSnippet({ id: 'd1', command: 'du -sh *', description: 'kept note\nsecond line' }),
  ])

  await expect(page.locator('.cmd-list-item')).toHaveAttribute(
    'title',
    'du -sh *\nkept note\nsecond line',
  )
  await page.locator('.cmd-list-item').click({ button: 'right' })
  await page.locator('.cmd-list-menu .context-menu-item').filter({ hasText: 'Edit' }).click()
  await expect(page.locator('.cmd-list-modal-drag')).toBeVisible()
  await expect(descriptionBox(page)).toHaveValue('kept note\nsecond line')
})

test('the search matches words that only exist in the description', async ({ page }) => {
  await openPanel(page, [
    baseSnippet({
      id: 'd1',
      command: 'du -sh *',
      alias: 'usage',
      description: 'Disk usage report',
    }),
    baseSnippet({ id: 'd2', command: 'ps aux', alias: 'procs', description: 'Running processes' }),
  ])
  await expect(page.locator('.cmd-list-item')).toHaveCount(2)

  await page.locator('.cmd-list-search input').fill('report')
  await expect(page.locator('.cmd-list-item')).toHaveCount(1)
  await expect(page.locator('.cmd-list-command')).toHaveText('du -sh *')
})

test('command and alias still match (the haystack kept its old parts)', async ({ page }) => {
  await openPanel(page, [
    baseSnippet({
      id: 'd1',
      command: 'du -sh *',
      alias: 'usage',
      description: 'Disk usage report',
    }),
    baseSnippet({ id: 'd2', command: 'ps aux', alias: 'procs', description: 'Running processes' }),
  ])

  await page.locator('.cmd-list-search input').fill('ps aux')
  await expect(page.locator('.cmd-list-item')).toHaveCount(1)
  await expect(page.locator('.cmd-list-command')).toHaveText('ps aux')

  await page.locator('.cmd-list-search input').fill('usage')
  await expect(page.locator('.cmd-list-item')).toHaveCount(1)
  await expect(page.locator('.cmd-list-command')).toHaveText('du -sh *')
})

// The fill dialog shows the note next to the command preview (plan §3.5).
test('the fill dialog shows the description above the parameter rows', async ({ page }) => {
  await openPanel(page, [
    baseSnippet({
      id: 'd1',
      command: 'du -sh ${path}',
      description: 'Disk usage for a path\nNeeds root',
      params: [
        { name: 'path', type: 'text', defaultValue: '/tmp', options: [], defaultEnabled: true },
      ],
    }),
  ])

  await page.locator('.cmd-list-item').click()
  const dialog = page.locator('.snip-fill-modal')
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('.snip-fill-snippet-desc')).toHaveText(
    'Disk usage for a path\nNeeds root',
  )
})

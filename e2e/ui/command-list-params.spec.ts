import { test, expect, type Page } from '@playwright/test'
import { installTauriMock, invokedCalls } from './helpers/tauriMock'

// Floating command-list (Ctrl+Shift+P): per-command parameters & options,
// the fill dialog, connection grouping and the last-selection memory.

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

const sentInput = async (page: Page) =>
  (await invokedCalls(page)).filter((c) => c.cmd === 'send_input').map((c) => String(c.args.data))

const sentJoined = async (page: Page) => (await sentInput(page)).join('|')

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

test('a select option value is substituted before sending', async ({ page }) => {
  await openPanelWithTerminal(page, [
    baseSnippet({
      id: 'p1',
      command: 'deploy --env=${env} ${image}',
      params: [
        {
          name: 'image',
          type: 'text',
          defaultValue: 'ubuntu',
          options: [],
          defaultEnabled: true,
        },
      ],
      options: [
        {
          id: 'o1',
          text: '--env=${env}',
          label: 'Env',
          value: { type: 'select', options: ['prod', 'dev'], defaultValue: 'prod' },
          defaultEnabled: true,
        },
      ],
    }),
  ])

  await page.locator('.cmd-list-item').click()
  const dialog = page.locator('.snip-fill-modal')
  await expect(dialog).toBeVisible()

  // The option group renders first; its select holds the value.
  await dialog.locator('.snip-fill-group').first().locator('select').selectOption('dev')
  await expect(dialog.locator('.snip-fill-command-preview')).toHaveText('deploy --env=dev ubuntu')

  await dialog.getByRole('button', { name: 'Send' }).click()
  await expect.poll(() => sentJoined(page)).toContain('deploy --env=dev ubuntu')
})

test('unchecking a parameter removes its placeholder', async ({ page }) => {
  await openPanelWithTerminal(page, [
    baseSnippet({
      id: 'p2',
      command: 'echo ${a} tail',
      params: [{ name: 'a', type: 'text', defaultValue: 'X', options: [], defaultEnabled: true }],
    }),
  ])

  await page.locator('.cmd-list-item').click()
  const dialog = page.locator('.snip-fill-modal')
  await dialog.locator('.snip-fill-row input[type="checkbox"]').uncheck()
  await expect(dialog.locator('.snip-fill-command-preview')).toHaveText('echo tail')

  await dialog.getByRole('button', { name: 'Send' }).click()
  await expect.poll(() => sentJoined(page)).toContain('echo tail')
  expect(await sentJoined(page)).not.toContain('${a}')
})

test('unchecking an option removes its whole fragment', async ({ page }) => {
  await openPanelWithTerminal(page, [
    baseSnippet({
      id: 'p3',
      command: 'docker run -it ${image}',
      params: [
        { name: 'image', type: 'text', defaultValue: 'ubuntu', options: [], defaultEnabled: true },
      ],
      options: [{ id: 'o2', text: '-it', defaultEnabled: true }],
    }),
  ])

  await page.locator('.cmd-list-item').click()
  const dialog = page.locator('.snip-fill-modal')
  await expect(dialog.locator('.snip-fill-command-preview')).toHaveText('docker run -it ubuntu')
  await dialog.locator('.snip-fill-row input[type="checkbox"]').first().uncheck()
  await expect(dialog.locator('.snip-fill-command-preview')).toHaveText('docker run ubuntu')

  await dialog.getByRole('button', { name: 'Send' }).click()
  await expect.poll(() => sentJoined(page)).toContain('docker run ubuntu')
  expect(await sentJoined(page)).not.toContain('-it')
})

test('a parameter can be reset to its default value', async ({ page }) => {
  await openPanelWithTerminal(page, [
    baseSnippet({
      id: 'p4',
      command: 'echo ${a}',
      params: [{ name: 'a', type: 'text', defaultValue: 'DEF', options: [], defaultEnabled: true }],
    }),
  ])

  await page.locator('.cmd-list-item').click()
  const dialog = page.locator('.snip-fill-modal')
  const input = dialog
    .locator('.snip-fill-group')
    .first()
    .locator('.snip-fill-row input:not([type="checkbox"])')
  await input.fill('XYZ')
  await expect(dialog.locator('.snip-fill-command-preview')).toHaveText('echo XYZ')

  await dialog.locator('.snip-fill-reset').first().click()
  await expect(input).toHaveValue('DEF')
  await expect(dialog.locator('.snip-fill-command-preview')).toHaveText('echo DEF')
})

// Regression: typing the name inside an already-typed `${}` used to spawn one
// parameter row per keystroke (`a`, `al`, `alp`, ...).
test('typing a placeholder inside ${} declares a single parameter', async ({ page }) => {
  await openPanelWithTerminal(page, [])

  await page.locator('.cmd-list-add-btn').click()
  const editor = page.locator('.cmd-list-modal-drag')
  const textarea = editor.locator('textarea')
  await textarea.click()
  await page.keyboard.insertText('echo ${}')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.insertText('alpha')

  await expect(editor.locator('.snip-param-row')).toHaveCount(1)
  await expect(editor.locator('.snip-param-row .snip-var-name')).toHaveValue('alpha')
})

test('groups snippets by connection and filters to the active connection', async ({ page }) => {
  await openPanelWithTerminal(page, [
    baseSnippet({ id: 'g1', command: 'echo general', connectionId: null }),
    baseSnippet({ id: 'g2', command: 'echo demo', connectionId: 'c1' }),
    baseSnippet({ id: 'g3', command: 'echo other', connectionId: 'c2' }),
  ])

  // Filter is ON by default with an active connection: general + Demo only.
  await expect(page.locator('.cmd-list-section')).toHaveCount(2)
  await expect(page.locator('.cmd-list-section-title')).toHaveText(['General', 'Demo'])
  await expect(page.locator('.cmd-list-item')).toHaveCount(2)

  // Turning the filter off reveals the other connection's group.
  await page.getByText('This connection only').click()
  await expect(page.locator('.cmd-list-section')).toHaveCount(3)
  await expect(page.locator('.cmd-list-item')).toHaveCount(3)
})

// Each param/option is drawn as its own bordered card, so one entry's inputs
// don't visually run into the next in the add/edit dialog.
test('param and option rows are each drawn as a bordered card', async ({ page }) => {
  await openPanelWithTerminal(page, [
    baseSnippet({
      id: 'b1',
      command: 'tool --env=${env} ${image}',
      params: [
        { name: 'image', type: 'text', defaultValue: 'x', options: [], defaultEnabled: true },
      ],
      options: [{ id: 'o1', text: '--env=${env}', defaultEnabled: true }],
    }),
  ])
  await page.locator('.cmd-list-item').click({ button: 'right' })
  await page.locator('.cmd-list-menu .context-menu-item').filter({ hasText: 'Edit' }).click()
  const editor = page.locator('.cmd-list-modal-drag')
  await expect(editor).toBeVisible()

  const borderOf = (sel: string) =>
    editor
      .locator(sel)
      .first()
      .evaluate((el) => getComputedStyle(el).borderTopWidth)
  expect(await borderOf('.snip-param-row')).toBe('1px')
  expect(await borderOf('.snip-option-row')).toBe('1px')
})

// Regression: the floating panel is moved with a CSS `transform` (drag/resize
// offset), which made it the containing block for the fill dialog's
// `position: fixed` overlay — so a tall dialog (many params) was clamped to the
// small panel box and pushed out of the window. The overlay is now portaled to
// <body>, so it stays fixed within the app window.
test('the fill dialog stays inside the window when the panel is transformed', async ({ page }) => {
  // Seed a dragged/resized panel so `.cmd-list-float` carries a transform.
  await page.addInitScript(() => {
    localStorage.setItem(
      'wrolp.cmdListPrefs',
      JSON.stringify({
        pos: { x: 0, y: 300 },
        size: { w: 360, h: 260 },
        opacity: 1,
        favoriteOnly: false,
        showHidden: false,
        activeConnectionOnly: false,
      }),
    )
  })

  const params = Array.from({ length: 14 }, (_, i) => ({
    name: `p${i}`,
    type: 'text',
    defaultValue: `v${i}`,
    options: [],
    defaultEnabled: true,
  }))
  await installTauriMock(page, {
    connections: [DEMO_CONN],
    commandSnippets: [
      baseSnippet({
        id: 'big',
        command: 'tool ' + params.map((p) => `\${${p.name}}`).join(' '),
        params,
      }),
    ],
  })
  await page.goto('/')
  await page.locator('.connection-item').first().click()
  await expect(page.locator('.tab-item')).toContainText('Demo')
  await page.waitForSelector('.xterm-helper-textarea', { state: 'attached' })
  await page.keyboard.press('Control+Shift+p')
  await expect(page.locator('.cmd-list-float')).toHaveAttribute('style', /transform/)

  await page.locator('.cmd-list-item').click()
  const dialog = page.locator('.snip-fill-modal')
  await expect(dialog).toBeVisible()

  // Portaled to <body> so the panel's transform cannot clip it.
  expect(
    await page
      .locator('.cmd-list-modal-overlay')
      .evaluate((el) => el.parentElement === document.body),
  ).toBe(true)

  // …and the dialog fits inside the window.
  const vp = page.viewportSize()!
  const box = (await dialog.boundingBox())!
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.y + box.height).toBeLessThanOrEqual(vp.height + 1)
})

import { test, expect, type Page } from './helpers/fixtures'
import { installTauriMock, emitTauriEvent, invokedCalls } from './helpers/tauriMock'

// AI appearance / system-config tools round-trip through the frontend bridge:
//   Rust emit('ai-ui-tool-request', {id, op, args})
//     → src/lib/aiUiBridge.ts applies it via src/lib/appSettings.ts
//       → invoke('ai_ui_tool_result', {id, result})
// See task/plans/AI-UI-CONFIG-PLAN.md.

let uid = 1000

/** Drive one UI-tool request and return the parsed bridge result. */
async function uiTool(page: Page, op: string, args: Record<string, unknown>) {
  const id = uid++
  await emitTauriEvent(page, 'ai-ui-tool-request', { id, op, args })
  await expect
    .poll(
      async () =>
        (await invokedCalls(page)).filter((c) => c.cmd === 'ai_ui_tool_result' && c.args.id === id)
          .length,
    )
    .toBe(1)
  const call = (await invokedCalls(page)).find(
    (c) => c.cmd === 'ai_ui_tool_result' && c.args.id === id,
  )!
  return JSON.parse(String(call.args.result)) as Record<string, unknown>
}

const ls = (page: Page, key: string) => page.evaluate((k) => localStorage.getItem(k), key)

const setAppearanceConfig = async (page: Page, cfg: Record<string, unknown>) => {
  await page.addInitScript((c) => {
    try {
      localStorage.setItem('wrolp-ai-appearance', JSON.stringify(c))
    } catch {
      /* ignore */
    }
  }, cfg)
}

test('get_ui_settings returns the registry (no AI panel needed)', async ({ page }) => {
  await installTauriMock(page, {})
  await page.goto('/')
  const res = await uiTool(page, 'get', {})
  const settings = res.settings as Record<string, { value: unknown; kind: string }>
  expect(settings['theme.mode'].value).toBe('system')
  expect(settings['terminal.fontSize'].value).toBe(14)
  expect(settings['highlight.scheme'].value).toBe('default')
  // A representative per-category colour entry exists.
  expect(settings['highlight.color.ip'].value).toBeTruthy()
})

test('set_ui_settings applies live and records an undo snapshot', async ({ page }) => {
  await installTauriMock(page, {})
  await page.goto('/')

  const res = await uiTool(page, 'set', { changes: { 'theme.mode': 'light', 'ui.language': 'zh' } })
  expect(res.undoId).toBeTruthy()
  expect((res.applied as Record<string, unknown>)['theme.mode']).toBe('light')

  expect(await ls(page, 'wrolp-theme')).toBe('light')
  expect(await ls(page, 'wrolp-lang')).toBe('zh')
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('light')

  const history = JSON.parse((await ls(page, 'wrolp-appearance-history')) ?? '[]')
  expect(history).toHaveLength(1)
  expect(history[0].undoId).toBe(res.undoId)
  expect(history[0].previous['theme.mode']).toBe('system')
})

test('invalid / unknown values are rejected with a readable error', async ({ page }) => {
  await installTauriMock(page, {})
  await page.goto('/')

  const outOfRange = await uiTool(page, 'set', { changes: { 'terminal.fontSize': 999 } })
  expect(String(outOfRange.error)).toContain('maximum')
  expect(await ls(page, 'wrolp-terminal-font-size')).toBeNull()

  const badColor = await uiTool(page, 'set', { changes: { 'highlight.color.ip': '#zzz' } })
  expect(String(badColor.error)).toContain('invalid colour')

  // A security-domain key simply is not in the registry.
  const forbidden = await uiTool(page, 'set', { changes: { 'vault.apiKey': 'x' } })
  expect(String(forbidden.error)).toContain('Unknown setting key')
})

test('the master switch blocks every write', async ({ page }) => {
  await setAppearanceConfig(page, { enabled: false })
  await installTauriMock(page, {})
  await page.goto('/')
  const res = await uiTool(page, 'set', { changes: { 'theme.mode': 'light' } })
  expect(String(res.error)).toContain('disabled')
  expect(await ls(page, 'wrolp-theme')).not.toBe('light')
})

test('the per-group whitelist blocks a disabled category', async ({ page }) => {
  await setAppearanceConfig(page, {
    enabled: true,
    groups: { theme: false, terminal: true, highlight: true, ui: true },
  })
  await installTauriMock(page, {})
  await page.goto('/')
  const res = await uiTool(page, 'set', { changes: { 'theme.mode': 'light' } })
  expect(String(res.error)).toContain('theme')
  expect(await ls(page, 'wrolp-theme')).not.toBe('light')
})

test('requireConfirm routes a set through the needsConfirmation loop', async ({ page }) => {
  await setAppearanceConfig(page, { enabled: true, requireConfirm: true })
  await installTauriMock(page, {})
  await page.goto('/')

  const first = await uiTool(page, 'set', { changes: { 'theme.mode': 'light' } })
  expect(first.needsConfirmation).toBe(true)
  expect(await ls(page, 'wrolp-theme')).not.toBe('light')

  // Rust re-runs the very same call with force=true after the user approves.
  const second = await uiTool(page, 'set', { changes: { 'theme.mode': 'light' }, force: true })
  expect(second.undoId).toBeTruthy()
  expect(await ls(page, 'wrolp-theme')).toBe('light')
})

test('a live terminal re-applies a font-size change without error', async ({ page }) => {
  await installTauriMock(page, {
    connections: [{ id: 'c1', name: 'Demo', host: 'demo.local', port: 22, username: 'root' }],
    pollOutputChunks: [['root@demo:~$ ']],
  })
  await page.goto('/')
  await page.locator('.connection-item').click()
  await expect(page.locator('.xterm')).toHaveCount(1)

  const res = await uiTool(page, 'set', {
    changes: { 'terminal.fontSize': 20, 'terminal.cursorStyle': 'bar' },
  })
  expect(res.undoId).toBeTruthy()
  expect(await ls(page, 'wrolp-terminal-font-size')).toBe('20')
  expect(await ls(page, 'wrolp-terminal-cursor-style')).toBe('bar')
})

test('reset_ui_settings restores defaults and the settings page can undo', async ({ page }) => {
  await installTauriMock(page, {})
  await page.goto('/')

  await uiTool(page, 'set', { changes: { 'theme.mode': 'light' } })
  const reset = await uiTool(page, 'reset', { keys: ['theme.mode'] })
  expect(reset.undoId).toBeTruthy()
  expect(await ls(page, 'wrolp-theme')).toBe('system')

  // The most recent snapshot resets to the default; undo it from the settings card.
  await page.locator('.settings-btn').click()
  // The card lives in the AI pane now that General is split by theme.
  await page.locator('.settings-nav-item', { hasText: 'AI Assistant' }).click()
  const card = page.locator('.settings-card', { hasText: 'AI appearance & settings' })
  await expect(card).toBeVisible()

  // Usage examples are surfaced in the card so users know what to ask for.
  await expect(card).toContainText('Try asking the AI:')
  await expect(card).toContainText('Switch to the light theme')
  await expect(card).toContainText('Reset the appearance to defaults')

  await card.locator('button', { hasText: 'Undo' }).first().click()
  expect(await ls(page, 'wrolp-theme')).toBe('light')
})

test('set_ui_settings writes the terminal font family', async ({ page }) => {
  await installTauriMock(page, {})
  await page.goto('/')

  const res = await uiTool(page, 'set', { changes: { 'terminal.fontFamily': 'JetBrains Mono' } })
  expect(res.undoId).toBeTruthy()
  expect(await ls(page, 'wrolp-terminal-font-family')).toBe('JetBrains Mono')
})

test('reset_ui_settings restores the long default font stack (not rejected)', async ({ page }) => {
  await installTauriMock(page, {})
  await page.goto('/')

  await uiTool(page, 'set', { changes: { 'terminal.fontFamily': 'Consolas' } })
  expect(await ls(page, 'wrolp-terminal-font-family')).toBe('Consolas')

  // The default stack is ~295 chars — longer than the old 200-char cap, which made
  // "reset" fail-fast and reject the whole change.
  const reset = await uiTool(page, 'reset', { keys: ['terminal.fontFamily'] })
  expect(reset.undoId).toBeTruthy()
  const restored = await ls(page, 'wrolp-terminal-font-family')
  expect(restored).toBeTruthy()
  expect(restored!.length).toBeGreaterThan(200)
})

test('the Terminal settings pane exposes the font controls', async ({ page }) => {
  await installTauriMock(page, {})
  await page.goto('/')

  await page.locator('.settings-btn').click()
  await page.locator('.settings-nav-item', { hasText: 'Terminal' }).click()

  const family = page.locator('#term-font-family')
  await expect(family).toBeVisible()

  // Type a custom font — the registry stores the raw input (the Nerd Font fallback
  // is re-appended at read time, not here).
  await family.fill('Cascadia Code')
  await family.blur()
  expect(await ls(page, 'wrolp-terminal-font-family')).toBe('Cascadia Code')

  // The other font controls render too.
  await expect(page.locator('#term-font-size')).toBeVisible()
  await expect(page.locator('#term-line-height')).toBeVisible()
  await expect(page.locator('#term-cursor-style')).toBeVisible()

  // "Restore default" writes the full default stack back. (`exact` disambiguates
  // from the "Restore default colors" button on the highlight pane.)
  await page.getByRole('button', { name: 'Restore default', exact: true }).click()
  const restored = await ls(page, 'wrolp-terminal-font-family')
  expect(restored).toBeTruthy()
  expect(restored!.length).toBeGreaterThan(200)
})

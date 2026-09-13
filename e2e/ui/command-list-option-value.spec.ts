import { test, expect, type Page } from '@playwright/test'
import { installTauriMock, invokedCalls } from './helpers/tauriMock'

// Command-list option values: forcing a value on a bare flag (`--tail`) gives
// the fragment a `${...}` slot — adopting one from the command when present,
// else composing one (and inserting it into the command). The per-option
// checkbox chooses between `--x=v` and `--x v`.

const DEMO_CONN = { id: 'c1', name: 'Demo', host: 'demo.local', port: 22, username: 'root' }

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

/** Open the command list with a terminal, then the edit dialog for its item. */
async function openEditor(page: Page, snippets: unknown[]) {
  await installTauriMock(page, { connections: [DEMO_CONN], commandSnippets: snippets })
  await page.goto('/')
  await page.locator('.connection-item').click()
  await expect(page.locator('.tab-item')).toContainText('Demo')
  await page.waitForSelector('.xterm-helper-textarea', { state: 'attached' })
  await page.keyboard.press('Control+Shift+p')
  await expect(page.locator('.cmd-list-float')).toBeVisible()

  await page.locator('.cmd-list-item').click({ button: 'right' })
  await page.locator('.cmd-list-menu .context-menu-item').filter({ hasText: 'Edit' }).click()
  const editor = page.locator('.cmd-list-modal-drag')
  await expect(editor).toBeVisible()
  return editor
}

test('setting a value type gives a bare flag a ${...} slot (fragment and command)', async ({
  page,
}) => {
  const editor = await openEditor(page, [
    baseSnippet({
      id: 'v1',
      command: 'docker logs --tail',
      options: [{ id: 'oa', text: '--tail', defaultEnabled: true }],
    }),
  ])
  const row = editor.locator('.snip-option-row').first()
  const text = row.locator('input.snip-option-text')
  const command = editor.locator('textarea')

  await expect(text).toHaveValue('--tail')
  // No error dialog: the slot is composed with the default `=` separator.
  await row.locator('select').first().selectOption('text')
  await expect(text).toHaveValue('--tail=${tail}')
  await expect(command).toHaveValue('docker logs --tail=${tail}')

  // Ticking "Space" rewrites both the fragment and the command.
  await row.locator('.snip-opt-sep input').check()
  await expect(text).toHaveValue('--tail ${tail}')
  await expect(command).toHaveValue('docker logs --tail ${tail}')

  await editor.locator('.modal-footer .btn-primary').click()
  await expect
    .poll(async () => {
      const calls = (await invokedCalls(page)).filter((c) => c.cmd === 'save_command_snippet')
      const snippet = calls.at(-1)?.args.snippet as
        | { options?: Array<{ text?: string; value?: { type?: string } | null }> }
        | undefined
      return `${snippet?.options?.[0]?.text}|${snippet?.options?.[0]?.value?.type}`
    })
    .toBe('--tail ${tail}|text')
})

test('setting a value type adopts an existing ${...} slot from the command', async ({ page }) => {
  const editor = await openEditor(page, [
    baseSnippet({
      id: 'v2',
      command: 'docker logs --tail ${tail}',
      options: [{ id: 'oa', text: '--tail', defaultEnabled: true }],
    }),
  ])
  const row = editor.locator('.snip-option-row').first()
  // The command's `${tail}` is first auto-declared as a parameter…
  await expect(editor.locator('.snip-param-row')).toHaveCount(1)

  await row.locator('select').first().selectOption('text')

  // …then the option takes over the existing slot, keeping the command's
  // space separator, and the now-redundant parameter is pruned.
  await expect(row.locator('input.snip-option-text')).toHaveValue('--tail ${tail}')
  await expect(row.locator('.snip-opt-sep input')).toBeChecked()
  await expect(editor.locator('.snip-param-row')).toHaveCount(0)
})

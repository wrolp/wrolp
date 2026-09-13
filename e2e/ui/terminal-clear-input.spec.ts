import { test, expect, type Page } from '@playwright/test'
import { installTauriMock, invokedCalls } from './helpers/tauriMock'

// "Clear input" in the terminal context menu erases the shell's current input
// line without submitting it: Ctrl+A (line start) + Ctrl+K (kill to end).

const DEMO_CONN = { id: 'c1', name: 'Demo', host: 'demo.local', port: 22, username: 'root' }
const CLEAR_SEQ = '\u0001\u000b'

const sentInput = async (page: Page) =>
  (await invokedCalls(page)).filter((c) => c.cmd === 'send_input').map((c) => String(c.args.data))

async function connect(page: Page, prompt: string) {
  await installTauriMock(page, {
    connections: [DEMO_CONN],
    pollOutputChunks: [[prompt]],
  })
  await page.goto('/')
  await page.locator('.connection-item').click()
  await page.waitForSelector('.xterm-helper-textarea', { state: 'attached' })
  // Let the polled prompt reach the xterm buffer before opening the menu (the
  // menu snapshots the input line when it opens).
  await expect
    .poll(async () => (await invokedCalls(page)).filter((c) => c.cmd === 'poll_output').length)
    .toBeGreaterThanOrEqual(1)
  await page.waitForTimeout(400)
}

const clearItem = (page: Page) =>
  page.locator('.context-menu .context-menu-item').filter({ hasText: 'Clear input' })

test('clear input erases a typed command line', async ({ page }) => {
  await connect(page, 'root@demo:~$ apt-get install foo')

  await page.locator('.xterm-screen').click({ button: 'right' })
  const item = clearItem(page)
  await expect(item).toBeVisible()
  await expect(item).not.toHaveClass(/disabled/)

  await item.click()
  await expect.poll(() => sentInput(page)).toContain(CLEAR_SEQ)
})

test('clear input is disabled when the input line is empty', async ({ page }) => {
  await connect(page, 'root@demo:~$ ')

  await page.locator('.xterm-screen').click({ button: 'right' })
  const item = clearItem(page)
  await expect(item).toBeVisible()
  await expect(item).toHaveClass(/disabled/)

  await item.click()
  await page.waitForTimeout(200)
  expect(await sentInput(page)).not.toContain(CLEAR_SEQ)
})

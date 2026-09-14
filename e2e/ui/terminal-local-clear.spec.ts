import { test, expect, type Page } from './helpers/fixtures'
import { installTauriMock, invokedCalls } from './helpers/tauriMock'

// Regression for BUGS.md B34 — "本地终端右键 clear 后光标还在原来位置".
//
// A local shell's peer is ConPTY, which repaints with ABSOLUTE cursor
// positioning relative to its own screen buffer. A local-only `term.clear()`
// therefore desynced the two: ConPTY still believed the prompt sat on the
// pre-clear row, so its next repaint put cursor and prompt straight back there.
// The fix runs the shell's *native* clear command instead, so ConPTY wipes its
// own buffer and its origin returns to row 0 — `clear` for POSIX local shells
// (WSL / git-bash / bash / zsh …), `cls` for cmd / PowerShell.

const POSIX_ENTRY = { id: 'lt-bash', name: 'Bash', cwd: '', shell: 'bash' }
const CMD_ENTRY = { id: 'lt-cmd', name: 'Cmd', cwd: '', shell: 'cmd' }

/** Raw bytes the app sent to the local shell (PTY), in order. */
const localSentInput = async (page: Page) =>
  (await invokedCalls(page))
    .filter((c) => c.cmd === 'local_send_input')
    .map((c) => String(c.args.data))

/** Open a local terminal from a specific sidebar entry and wait until the
 *  backend shell is registered (`connectedRef` gates the Clear branch). */
async function connectLocal(page: Page, entry: typeof POSIX_ENTRY, prompt: string) {
  await installTauriMock(page, {
    localTerminals: [entry],
    pollOutputChunks: [[prompt]],
  })
  await page.goto('/')
  await page
    .locator('.conn-item.local-term-item')
    .filter({ hasText: entry.name })
    .click()
  await page.waitForSelector('.xterm-helper-textarea', { state: 'attached' })
  await expect
    .poll(async () =>
      (await invokedCalls(page)).filter((c) => c.cmd === 'open_local_shell').length,
    )
    .toBeGreaterThanOrEqual(1)
  await page.waitForTimeout(400)
}

/** The context menu's 🧹 "Clear" entry (there is also a "Clear input" one). */
const clearItem = (page: Page) =>
  page.locator('.context-menu .context-menu-item').filter({ hasText: /🧹/ })

test('clear on a POSIX local terminal runs `clear` in the shell', async ({ page }) => {
  await connectLocal(page, POSIX_ENTRY, 'user@host:~$ ls -la')

  await page.locator('.xterm-screen').click({ button: 'right' })
  const item = clearItem(page)
  await expect(item).toBeVisible()
  await item.click()

  await expect.poll(() => localSentInput(page)).toContain('clear\r')
  // POSIX branch only — never the cmd/PowerShell builtin.
  expect(await localSentInput(page)).not.toContain('cls\r')
})

test('clear on a cmd/PowerShell local terminal runs `cls` in the shell', async ({ page }) => {
  await connectLocal(page, CMD_ENTRY, 'C:\\Users\\user>dir')

  await page.locator('.xterm-screen').click({ button: 'right' })
  const item = clearItem(page)
  await expect(item).toBeVisible()
  await item.click()

  await expect.poll(() => localSentInput(page)).toContain('cls\r')
  expect(await localSentInput(page)).not.toContain('clear\r')
})

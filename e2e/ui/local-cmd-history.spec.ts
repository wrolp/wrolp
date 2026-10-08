import { test, expect, type Page } from './helpers/fixtures'
import { installTauriMock, invokedCalls } from './helpers/tauriMock'

// A LOCAL shell's commands belong in the command history too (the pane's 历史
// dropdown and the persisted `command_history` table). ConPTY re-serializes the
// whole console screen, so its echo of the typed line can land AFTER the Enter
// that submitted it — the buffer still reads a bare prompt at that instant.

const BASH_ENTRY = { id: 'lt-bash', name: 'Bash', cwd: '/var/www', shell: 'bash' }
const PROMPT = 'user@host:~$ '

const button = (page: Page) => page.locator('[data-setting="terminal.commandHistory"]')
const items = (page: Page) => page.locator('.tsb-history-item')

/** Commands the app persisted into `command_history`. */
const recorded = async (page: Page) =>
  (await invokedCalls(page))
    .filter((c) => c.cmd === 'record_command_history')
    .map((c) => `${c.args.command}|${c.args.tabType}|${c.args.host}`)

/**
 * Echo typed input back through `poll_output`, so the buffer looks like a PTY.
 *
 * `silent` models the worst ConPTY case: the typed characters are never echoed at
 * all, so the buffer still reads a bare prompt when Enter arrives. Chosen over a
 * "one poll late" echo, which tests the same code path but depends on how the
 * polls happen to interleave with the typing — flaky under a loaded machine.
 */
async function installEcho(page: Page, mode: 'echo' | 'silent') {
  await page.evaluate(
    ([prompt, silent]) => {
      const internals = (
        window as unknown as {
          __TAURI_INTERNALS__: {
            invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
          }
        }
      ).__TAURI_INTERNALS__
      const orig = internals.invoke.bind(internals)
      const pending: string[] = []
      internals.invoke = async (cmd: string, args: Record<string, unknown> = {}) => {
        if (cmd === 'local_send_input') {
          const visible = String(args.data ?? '')
            .replace(/\x1b\[20[01]~/g, '')
            .replace(/[\x00-\x1f\x7f]/g, '')
          // Enter always advances the line; typed text only when the shell echoes.
          if (!visible || !silent) pending.push(visible ? visible : '\r\n' + prompt)
        }
        const res = await orig(cmd, args)
        if (cmd === 'poll_output') return [...(res as string[]), ...pending.splice(0)]
        return res
      }
    },
    [PROMPT, mode === 'silent'] as [string, boolean],
  )
}

async function openLocalShell(page: Page, echo: 'echo' | 'silent' = 'echo') {
  await installTauriMock(page, {
    localTerminals: [BASH_ENTRY],
    pollOutputChunks: [[PROMPT]],
  })
  await page.goto('/')
  await page.locator('.conn-item.local-term-item').filter({ hasText: BASH_ENTRY.name }).click()
  await page.waitForSelector('.xterm-helper-textarea', { state: 'attached' })
  await expect
    .poll(async () => (await invokedCalls(page)).filter((c) => c.cmd === 'open_local_shell').length)
    .toBeGreaterThanOrEqual(1)
  await page.waitForTimeout(400)
  await installEcho(page, echo)
  await page.locator('.xterm-screen').click()
}

test('a local shell command reaches the pane history and the saved history', async ({ page }) => {
  await openLocalShell(page)

  await page.keyboard.type('docker ps', { delay: 40 })
  await page.keyboard.press('Enter')

  await expect.poll(() => recorded(page)).toContain('docker ps|localShell|localhost')
  await button(page).click()
  await expect(items(page)).toHaveText(['docker ps'])
})

test('a command submitted before ConPTY echoed it is still recorded whole', async ({ page }) => {
  // Nothing the user types ever comes back: the buffer reads a bare prompt at the
  // moment of Enter, so only the typed-line projection can know the command.
  await openLocalShell(page, 'silent')

  await page.keyboard.type('docker ps', { delay: 40 })
  await page.keyboard.press('Enter')

  await expect.poll(() => recorded(page)).toContain('docker ps|localShell|localhost')
})

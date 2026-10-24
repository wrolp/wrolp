import { test, expect, type Page } from './helpers/fixtures'
import { installTauriMock, invokedCalls, pasteIntoTerminal } from './helpers/tauriMock'

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

/** Commands the app committed to the session recording (`commit_command`). */
const committed = async (page: Page) =>
  (await invokedCalls(page))
    .filter((c) => c.cmd === 'commit_command')
    .map((c) => String(c.args.command))

/**
 * Echo typed input back through `poll_output`, so the buffer looks like a PTY.
 *
 * `silent` models the worst ConPTY case: the typed characters are never echoed at
 * all, so the buffer still reads a bare prompt when Enter arrives. Chosen over a
 * "one poll late" echo, which tests the same code path but depends on how the
 * polls happen to interleave with the typing — flaky under a loaded machine.
 */
async function installEcho(page: Page, mode: 'echo' | 'silent') {
  await installShellScript(page, {
    echoTyped: mode === 'echo',
    // Every Enter moves to a fresh prompt line, exactly like a repainting shell.
    enterReplies: mode === 'echo' ? ['\r\n' + PROMPT] : [],
  })
}

interface ShellScript {
  /** Whether the stub shell echoes what was typed. */
  echoTyped: boolean
  /** What the shell writes back per Enter, in order; running out means silence. */
  enterReplies?: (string | null)[]
}

/**
 * The same echo machine, driven by a script, so a test can hold back the repaint
 * a real ConPTY delivers a poll late. Silence after an Enter is what leaves the
 * submitted row as the only thing under the caret — the window that used to glue
 * the next character onto the command already in the history.
 */
async function installShellScript(page: Page, script: ShellScript) {
  await page.evaluate(
    ([prompt, echoTyped, enterReplies]) => {
      const internals = (
        window as unknown as {
          __TAURI_INTERNALS__: {
            invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
          }
        }
      ).__TAURI_INTERNALS__
      const orig = internals.invoke.bind(internals)
      const pending: string[] = []
      let enters = 0
      internals.invoke = async (cmd: string, args: Record<string, unknown> = {}) => {
        if (cmd === 'local_send_input') {
          const data = String(args.data ?? '')
          if (/^[\r\n]+$/.test(data)) {
            const reply = enterReplies[enters] ?? null
            enters += 1
            if (reply) pending.push(reply)
          } else if (echoTyped) {
            const visible = data.replace(/\x1b\[20[01]~/g, '').replace(/[\x00-\x1f\x7f]/g, '')
            if (visible) pending.push(visible)
          }
        }
        const res = await orig(cmd, args)
        if (cmd === 'poll_output') return [...(res as string[]), ...pending.splice(0)]
        return res
      }
    },
    [PROMPT, script.echoTyped, script.enterReplies ?? []] as [string, boolean, (string | null)[]],
  )
}

/** Boot a local bash pane and hand it to the caller's stub shell. */
async function bootLocalShell(page: Page, firstChunk = PROMPT) {
  await installTauriMock(page, {
    localTerminals: [BASH_ENTRY],
    pollOutputChunks: [[firstChunk]],
  })
  await page.goto('/')
  await page.locator('.conn-item.local-term-item').filter({ hasText: BASH_ENTRY.name }).click()
  await page.waitForSelector('.xterm-helper-textarea', { state: 'attached' })
  await expect
    .poll(async () => (await invokedCalls(page)).filter((c) => c.cmd === 'open_local_shell').length)
    .toBeGreaterThanOrEqual(1)
  await page.waitForTimeout(400)
  await page.locator('.xterm-screen').click()
}

async function openLocalShell(page: Page, echo: 'echo' | 'silent' = 'echo') {
  await bootLocalShell(page)
  await installEcho(page, echo)
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

test('an Enter landing before the repaint records nothing, not the old command plus one character', async ({
  page,
}) => {
  // ConPTY re-serializes the whole screen a poll late, so until it repaints the row
  // under the caret still holds the command that was just submitted. The typed-line
  // projection then appends whatever comes next to it, which is how a `yarn tauri
  // dev` followed by the `y` of an answer landed in the history as `yarn tauri devy`.
  await bootLocalShell(page)
  await installShellScript(page, { echoTyped: true, enterReplies: [] })

  await page.keyboard.type('yarn tauri dev', { delay: 30 })
  await page.keyboard.press('Enter')
  await expect.poll(() => recorded(page)).toContain('yarn tauri dev|localShell|localhost')

  await page.keyboard.type('y', { delay: 30 })
  await page.keyboard.press('Enter')
  await page.waitForTimeout(300)

  expect(await recorded(page)).toEqual(['yarn tauri dev|localShell|localhost'])
  expect(await committed(page)).toEqual(['yarn tauri dev'])
  await button(page).click()
  await expect(items(page)).toHaveText(['yarn tauri dev'])
})

test("a program's y/n answer on the question row is not recorded", async ({ page }) => {
  await bootLocalShell(page)
  await installShellScript(page, { echoTyped: true, enterReplies: ['\r\nOverwrite? [y/n] ', null] })

  await page.keyboard.type('rm x', { delay: 30 })
  await page.keyboard.press('Enter')
  await page.keyboard.type('y', { delay: 30 })
  await page.keyboard.press('Enter')
  await page.waitForTimeout(300)

  expect(await recorded(page)).toEqual(['rm x|localShell|localhost'])
  expect(await committed(page)).toEqual(['rm x'])
})

test('an answer to a bracketed question is not committed to the recording either', async ({
  page,
}) => {
  // `[y/n] ` used to read as a shell prompt (a bracket-terminated prompt shape), so
  // the answer became the "command" that followed it — for the recording too.
  await bootLocalShell(page)
  await installShellScript(page, { echoTyped: true, enterReplies: ['\r\n[y/n] ', null] })

  await page.keyboard.type('ls', { delay: 30 })
  await page.keyboard.press('Enter')
  await page.keyboard.type('y', { delay: 30 })
  await page.keyboard.press('Enter')
  await page.waitForTimeout(300)

  expect(await committed(page)).toEqual(['ls'])
  expect(await recorded(page)).toEqual(['ls|localShell|localhost'])
})

test('Enter on an output row does not turn that line into a saved command', async ({ page }) => {
  // Pressing Enter while the caret sits on a line of program output used to record
  // the whole line, warnings and progress rows included.
  await bootLocalShell(page)
  await installShellScript(page, {
    echoTyped: true,
    enterReplies: [
      '\r\n28Z  WARN bevy_ecs::world::command_queue: CommandQueue has un-applied commands being dropped.',
      null,
    ],
  })

  await page.keyboard.type('cargo run', { delay: 30 })
  await page.keyboard.press('Enter')
  await page.waitForTimeout(200)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(300)

  expect(await recorded(page)).toEqual(['cargo run|localShell|localhost'])
  expect(await committed(page)).toEqual(['cargo run'])
})

test('a pasted block still records every line of it', async ({ page }) => {
  await bootLocalShell(page)
  await installShellScript(page, { echoTyped: true, enterReplies: [] })

  await pasteIntoTerminal(page, 'echo one\necho two')
  const dialog = page.locator('.paste-confirm-dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: /execute line by line/i }).click()

  await expect.poll(() => committed(page)).toEqual(['echo one', 'echo two'])
})

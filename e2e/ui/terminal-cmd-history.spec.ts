import { test, expect, type Page } from './helpers/fixtures'
import { installTauriMock, invokedCalls } from './helpers/tauriMock'

// The pane's status bar carries a command-history dropdown: what has been run in
// that shell, newest first, and picking an entry puts it on the input line
// WITHOUT executing it.

const DEMO_CONN = { id: 'c1', name: 'Demo', host: 'demo.local', port: 22, username: 'root' }
const PROMPT = '[root@sip ~]# '

const button = (page: Page) => page.locator('[data-setting="terminal.commandHistory"]')
const items = (page: Page) => page.locator('.tsb-history-item')

/** Raw bytes the app sent to the shell, in order. */
const sent = async (page: Page) =>
  (await invokedCalls(page)).filter((c) => c.cmd === 'send_input').map((c) => String(c.args.data))

/** Echo typed input back through `poll_output`, so the buffer looks like a PTY. */
async function installEcho(page: Page) {
  await page.evaluate((prompt) => {
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
      if (cmd === 'send_input') {
        const visible = String(args.data ?? '')
          .replace(/\x1b\[20[01]~/g, '')
          .replace(/[\x00-\x1f\x7f]/g, '')
        pending.push(visible ? visible : '\r\n' + prompt)
      }
      const res = await orig(cmd, args)
      if (cmd === 'poll_output') return [...(res as string[]), ...pending.splice(0)]
      return res
    }
  }, PROMPT)
}

async function openTerminal(page: Page) {
  await installTauriMock(page, {
    connections: [DEMO_CONN],
    pollOutputChunks: [[PROMPT]],
  })
  await page.goto('/')
  await page.locator('.connection-item').first().click()
  await expect(page.locator('.xterm-rows')).toContainText(PROMPT)
  await installEcho(page)
  await page.locator('.xterm-screen').click()
}

/** Commands the terminal reported as submitted (what feeds the dropdown). */
const committed = async (page: Page) =>
  (await invokedCalls(page))
    .filter((c) => c.cmd === 'commit_command')
    .map((c) => String(c.args.command))

async function run(page: Page, command: string) {
  await page.keyboard.type(command, { delay: 40 })
  await page.keyboard.press('Enter')
  await expect.poll(() => committed(page), { timeout: 10_000 }).toContain(command)
}

test('the dropdown lists what was run, newest first and without duplicates', async ({ page }) => {
  await openTerminal(page)
  await run(page, 'docker ps')
  await run(page, 'ls')
  await run(page, 'docker ps')

  await expect(button(page)).toBeVisible()
  await button(page).click()
  // Re-running `docker ps` moves it to the top instead of repeating it.
  await expect(items(page)).toHaveText(['docker ps', 'ls'])
})

test('picking an entry inserts it on the input line without running it', async ({ page }) => {
  await openTerminal(page)
  await run(page, 'git status')

  await button(page).click()
  await items(page).first().click()

  const bytes = await sent(page)
  // The paste pipeline may trail a quoted-insert / continuation byte, but it must
  // never send the Enter — picking is "put it on the line", not "run it".
  const at = bytes.lastIndexOf('git status')
  expect(at).toBeGreaterThan(-1)
  expect(bytes.slice(at).filter((b) => b.includes('\r'))).toEqual([])
})

test('an untouched terminal says so, and clicking away closes the list', async ({ page }) => {
  await openTerminal(page)
  await button(page).click()
  await expect(page.locator('.tsb-history-empty')).toBeVisible()

  await page.locator('.xterm-screen').click()
  await expect(button(page)).not.toHaveAttribute('aria-expanded', 'true')
  await expect(items(page)).toHaveCount(0)
})

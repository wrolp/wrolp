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

  // And each submission reached the persisted store, with where it came from
  // (`TabInfo.host` carries the port, which is what the row shows).
  const recorded = (await invokedCalls(page))
    .filter((c) => c.cmd === 'record_command_history')
    .map((c) => `${c.args.command}|${c.args.tabType}|${c.args.host}`)
  expect(recorded).toEqual([
    'docker ps|terminal|demo.local:22',
    'ls|terminal|demo.local:22',
    'docker ps|terminal|demo.local:22',
  ])
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

test('the saved history of every terminal shows below this terminal’s own', async ({ page }) => {
  await installTauriMock(page, {
    connections: [DEMO_CONN],
    pollOutputChunks: [[PROMPT]],
    commandHistory: [
      { command: 'df -h', tabType: 'terminal', host: 'other.example', usedAtMs: 10 },
      // Already run here, so it must appear once — in the top section.
      { command: 'git status', tabType: 'terminal', host: 'other.example', usedAtMs: 20 },
    ],
  })
  await page.goto('/')
  await page.locator('.connection-item').first().click()
  await expect(page.locator('.xterm-rows')).toContainText(PROMPT)
  await installEcho(page)
  await page.locator('.xterm-screen').click()
  await run(page, 'git status')

  await button(page).click()
  await expect(page.locator('.tsb-history-group')).toHaveText(['This terminal', 'All terminals'])
  await expect(items(page)).toHaveText(['git status', 'df -hother.example'])
})

test('the arrows walk the list and Enter picks, so the mouse stays optional', async ({ page }) => {
  await openTerminal(page)
  await run(page, 'ls -la')
  await run(page, 'git status')

  await button(page).click()
  await expect(items(page).first()).toHaveAttribute('data-active', 'true')

  await page.keyboard.press('ArrowDown')
  await expect(items(page).first()).not.toHaveAttribute('data-active')
  await expect(items(page).nth(1)).toHaveAttribute('data-active', 'true')

  await page.keyboard.press('Enter')
  const bytes = await sent(page)
  expect(bytes.lastIndexOf('ls -la')).toBeGreaterThan(-1)
  await expect(button(page)).toHaveAttribute('aria-expanded', 'false')
})

test('Ctrl+Shift+H opens the focused pane’s list', async ({ page }) => {
  await openTerminal(page)
  await run(page, 'uptime')
  await page.keyboard.press('Control+Shift+h')
  await expect(button(page)).toHaveAttribute('aria-expanded', 'true')
  await expect(items(page)).toHaveText(['uptime'])
})

test('the ✕ forgets a command, here and in the saved history', async ({ page }) => {
  await installTauriMock(page, {
    connections: [DEMO_CONN],
    pollOutputChunks: [[PROMPT]],
    commandHistory: [
      { command: 'df -h', tabType: 'terminal', host: 'other.example', usedAtMs: 10 },
      { command: 'uptime', tabType: 'terminal', host: 'other.example', usedAtMs: 20 },
    ],
  })
  await page.goto('/')
  await page.locator('.connection-item').first().click()
  await expect(page.locator('.xterm-rows')).toContainText(PROMPT)
  await installEcho(page)
  await page.locator('.xterm-screen').click()
  await run(page, 'ls -la')

  await button(page).click()
  // The mock answers in the order given, which is what the list shows.
  await expect(items(page)).toHaveText(['ls -la', 'df -hother.example', 'uptimeother.example'])

  await items(page).filter({ hasText: 'df -h' }).locator('.tsb-history-del').click()
  await expect(items(page)).toHaveText(['ls -la', 'uptimeother.example'])
  const deleted = (await invokedCalls(page))
    .filter((c) => c.cmd === 'delete_command_history')
    .map((c) => String(c.args.command))
  expect(deleted).toEqual(['df -h'])
  // The list stays open: deleting one row should not cost the user the whole view.
  await expect(items(page)).toHaveCount(2)
})

test('Delete on the highlighted row forgets it too', async ({ page }) => {
  await openTerminal(page)
  await run(page, 'ls -la')
  await run(page, 'git status')

  await button(page).click()
  await expect(items(page)).toHaveText(['git status', 'ls -la'])
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Delete')
  await expect(items(page)).toHaveText(['git status'])
  expect(
    (await invokedCalls(page))
      .filter((c) => c.cmd === 'delete_command_history')
      .map((c) => String(c.args.command)),
  ).toEqual(['ls -la'])
})

test('a long list scrolls instead of squashing its rows', async ({ page }) => {
  // The panel is a flex column with a max-height; a row allowed to shrink gets
  // compressed to a sliver and nothing overflows, so no scrollbar ever appears
  // and every line reads as half a line of text.
  await installTauriMock(page, {
    connections: [DEMO_CONN],
    pollOutputChunks: [[PROMPT]],
    commandHistory: Array.from({ length: 24 }, (_, i) => ({
      command: `cmd${i} --some-long-option value`,
      tabType: 'terminal',
      host: 'localhost',
      usedAtMs: 1000 - i,
    })),
  })
  await page.goto('/')
  await page.locator('.connection-item').first().click()
  await expect(page.locator('.xterm-rows')).toContainText(PROMPT)
  await page.locator('[data-setting="terminal.commandHistory"]').click()
  const list = page.locator('.tsb-history-list')
  await expect(list).toBeVisible()

  const box = await list.evaluate((el) => ({
    client: el.clientHeight,
    content: el.scrollHeight,
    row: (el.querySelector('.tsb-history-item') as HTMLElement).getBoundingClientRect().height,
  }))
  expect(box.content).toBeGreaterThan(box.client)
  // A real line of text, not a compressed band.
  expect(box.row).toBeGreaterThanOrEqual(18)
})

test('an untouched terminal says so, and clicking away closes the list', async ({ page }) => {
  await openTerminal(page)
  await button(page).click()
  await expect(page.locator('.tsb-history-empty')).toBeVisible()

  await page.locator('.xterm-screen').click()
  await expect(button(page)).not.toHaveAttribute('aria-expanded', 'true')
  await expect(items(page)).toHaveCount(0)
})

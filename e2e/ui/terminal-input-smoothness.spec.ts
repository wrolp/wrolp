/**
 * Input-path smoothness guards.
 *
 * Two failures the UI cannot show as an error:
 *  1. an IME candidate window and the completion both want →/↑/↓/Enter — consuming
 *     them while composing makes Chinese input unselectable;
 *  2. a keystroke's echo flush used to call `poll_output` directly, beside the
 *     100 ms interval loop, so two rounds could resolve out of order and interleave
 *     chunks in xterm.
 */
import { test, expect, type Page } from './helpers/fixtures'
import { installTauriMock, invokedCalls } from './helpers/tauriMock'

const DEMO_CONN = { id: 'c1', name: 'Demo', host: 'demo.local', port: 22, username: 'root' }
const PROMPT = '[root@sip ~]# '
const BASH_ENTRY = { id: 'lt-bash', name: 'Bash', cwd: '/var/www', shell: 'bash' }
const LOCAL_PROMPT = 'user@host:~$ '

const SNIPPETS = [
  {
    id: 's1',
    command: 'git status -sb',
    alias: null,
    hidden: false,
    connectionId: null,
    description: null,
  },
]

const sentInput = async (page: Page) =>
  (await invokedCalls(page)).filter((c) => c.cmd === 'send_input').map((c) => String(c.args.data))

const localSentInput = async (page: Page) =>
  (await invokedCalls(page))
    .filter((c) => c.cmd === 'local_send_input')
    .map((c) => String(c.args.data))

async function installEchoingShell(page: Page) {
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
        const data = String(args.data ?? '')
        const visible = data
          .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
          .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
          .replace(/[\x00-\x1f\x7f]/g, '')
        if (visible) pending.push(visible)
        else if (/[\r\n]/.test(data)) pending.push('\r\n' + prompt)
      }
      const res = await orig(cmd, args)
      if (cmd === 'poll_output') return [...(res as string[]), ...pending.splice(0)]
      return res
    }
  }, PROMPT)
}

async function openSshTerminal(page: Page) {
  await installTauriMock(page, {
    connections: [DEMO_CONN],
    pollOutputChunks: [[PROMPT]],
    commandSnippets: SNIPPETS,
  })
  await page.goto('/')
  await page.locator('.connection-item').first().click()
  await expect(page.locator('.xterm-rows')).toContainText(PROMPT)
  await installEchoingShell(page)
  await page.locator('.xterm-screen').click()
}

async function bootLocalShell(page: Page) {
  await installTauriMock(page, {
    localTerminals: [BASH_ENTRY],
    pollOutputChunks: [[LOCAL_PROMPT]],
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

/**
 * Dispatch → on xterm's helper textarea with (or without) an open composition.
 * `keyCode` cannot be set through the constructor; `isComposing` is what the
 * router checks first, and it is also what Chromium reports for IME-owned keys.
 */
const pressArrowRight = (page: Page, composing: boolean) =>
  page.evaluate((isComposing) => {
    const textarea = document.querySelector('.xterm-helper-textarea')
    if (!textarea) throw new Error('no xterm helper textarea')
    textarea.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowRight',
        code: 'ArrowRight',
        bubbles: true,
        cancelable: true,
        isComposing,
      }),
    )
  }, composing)

test('a → that belongs to an IME composition is left to the candidate window', async ({ page }) => {
  await openSshTerminal(page)
  await page.keyboard.type('git s', { delay: 60 })
  await expect(page.locator('.term-ghost')).toHaveText('tatus -sb')

  const before = await sentInput(page)
  await pressArrowRight(page, true)
  await page.waitForTimeout(150)

  // Nothing was accepted and nothing reached the shell: the key belonged to the
  // candidate window, so the completion had to leave it alone.
  expect(await sentInput(page)).toEqual(before)
  await expect(page.locator('.term-ghost')).toHaveText('tatus -sb')
  await expect(page.locator('.xterm-rows')).toContainText(`${PROMPT}git s`)
})

test('the same → still accepts the tail when no composition is open', async ({ page }) => {
  await openSshTerminal(page)
  await page.keyboard.type('git s', { delay: 60 })
  await expect(page.locator('.term-ghost')).toHaveText('tatus -sb')

  await pressArrowRight(page, false)

  await expect.poll(() => sentInput(page)).toContain('tatus')
  await expect(page.locator('.xterm-rows')).toContainText(`${PROMPT}git status`)
})

test('a keystroke flush never opens a second concurrent poll', async ({ page }) => {
  await bootLocalShell(page)

  // Widen the window between issue and resolve, so an overlapping round cannot be
  // missed just because the mock answers instantly.
  await page.evaluate(() => {
    const internals = (
      window as unknown as {
        __TAURI_INTERNALS__: {
          invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
        }
      }
    ).__TAURI_INTERNALS__
    const orig = internals.invoke.bind(internals)
    const state = { active: 0, max: 0, total: 0 }
    ;(window as unknown as { __POLL_STATE__: typeof state }).__POLL_STATE__ = state
    internals.invoke = async (cmd: string, args: Record<string, unknown> = {}) => {
      if (cmd !== 'poll_output') return orig(cmd, args)
      state.active += 1
      state.total += 1
      state.max = Math.max(state.max, state.active)
      try {
        await new Promise((resolve) => setTimeout(resolve, 25))
        return await orig(cmd, args)
      } finally {
        state.active -= 1
      }
    }
  })

  await page.keyboard.type('docker ps -a', { delay: 15 })
  await page.keyboard.press('Enter')
  await page.waitForTimeout(600)

  const state = await page.evaluate(
    () => (window as unknown as { __POLL_STATE__: { max: number; total: number } }).__POLL_STATE__,
  )
  expect(state.total).toBeGreaterThan(1)
  expect(state.max).toBe(1)
  // The shell receives the typing one keystroke at a time; concatenated it is whole.
  expect((await localSentInput(page)).join('')).toContain('docker ps -a')
})

/**
 * Regression for the live input line recolor.
 *
 * The live line is repainted by reading the xterm buffer back, but xterm parses
 * `write()` asynchronously (its WriteBuffer defers to a later macrotask unless
 * the write directly follows user input). Repainting *inline* therefore read the
 * line as it was BEFORE the chunk and its trailing `\x1b[K` erased the bytes it
 * had just written — a snippet appended to a non-empty input line (` && …`)
 * never showed up on screen, while ordinary typing was unaffected (a
 * post-keystroke echo happens to be parsed synchronously).
 *
 * The mock IPC has no shell, so these tests wrap `__TAURI_INTERNALS__.invoke` to
 * echo `send_input` payloads back through `poll_output`, like a real PTY.
 */
import { test, expect, type Page } from '@playwright/test'
import { installTauriMock, invokedCalls } from './helpers/tauriMock'

const DEMO_CONN = { id: 'c1', name: 'Demo', host: 'demo.local', port: 22, username: 'root' }
const CMD = './fs_light_sound.sh ./560.mp3 252 on 50'
const PROMPT = '[root@sip ~]# '

const sentInput = async (page: Page) =>
  (await invokedCalls(page)).filter((c) => c.cmd === 'send_input').map((c) => String(c.args.data))

/** Echo every `send_input` payload back through `poll_output`, like a shell. */
async function installEchoingShell(page: Page) {
  await page.evaluate(() => {
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
        // Drop bracketed-paste markers, quoted-insert prefixes and control chars:
        // only what a shell would echo back counts.
        const visible = String(args.data ?? '')
          .replace(/\x1b\[20[01]~/g, '')
          .replace(/\x16/g, '')
          .replace(/[\x00-\x1f\x7f]/g, '')
        if (visible) pending.push(visible)
      }
      const res = await orig(cmd, args)
      if (cmd === 'poll_output') return [...(res as string[]), ...pending.splice(0)]
      return res
    }
  })
}

async function openTerminal(page: Page) {
  await page.goto('/')
  await installEchoingShell(page)
  await page.locator('.connection-item').first().click()
  await expect(page.locator('.xterm-rows')).toContainText(PROMPT)
}

test('the echo of ordinary typing stays on the input line', async ({ page }) => {
  await installTauriMock(page, {
    connections: [DEMO_CONN],
    pollOutputChunks: [[PROMPT]],
  })
  await openTerminal(page)
  await page.locator('.xterm-screen').click()
  await page.keyboard.type('echo hi', { delay: 90 })
  await expect(page.locator('.xterm-rows')).toContainText(`${PROMPT}echo hi`)
})

test('a second one-click send appends ` && ` and the echo survives the recolor', async ({
  page,
}) => {
  await installTauriMock(page, {
    connections: [DEMO_CONN],
    commandSnippets: [
      {
        id: 'q1',
        command: CMD,
        alias: null,
        favorite: false,
        hidden: false,
        sortOrder: 0,
        connectionId: null,
        params: [],
        options: [],
        createdAt: '2026-08-01T00:00:00Z',
        updatedAt: '2026-08-01T00:00:00Z',
      },
    ],
    pollOutputChunks: [[PROMPT]],
  })
  await openTerminal(page)
  await page.keyboard.press('Control+Shift+p')
  await expect(page.locator('.cmd-list-float')).toBeVisible()

  const send = page.locator('.cmd-list-send')
  await expect(send).toHaveCount(1)

  // 1st click: empty input line → the snippet is only inserted (no Enter).
  await send.click()
  await expect(page.locator('.xterm-rows')).toContainText(CMD)

  // 2nd click: non-empty input line → ` && <command>` is appended to it.
  await send.click()
  await expect.poll(() => sentInput(page)).toContain(` && ${CMD}`)
  await expect(page.locator('.xterm-rows')).toContainText(`${CMD} && ${CMD}`)
})

import { test, expect, type Page } from './helpers/fixtures'
import { installTauriMock } from './helpers/tauriMock'

// The category highlighter never ran on a LOCAL terminal's output. ConPTY
// re-serializes the *screen*, so the echo of the line you submitted arrives as
// `ESC[4;20Hping ESC[4;24H`; `CURSOR_REPOSITION` cannot tell that apart from an
// application frame, and its 600 ms hold swallowed everything the command then
// printed — numbers and IP addresses stayed plain.

const CMD_ENTRY = { id: 'lt-cmd', name: 'Cmd', cwd: '', shell: 'cmd' }
const PROMPT = 'D:\\wrolp\\wrolp-win>'
const IP_RGB = 'rgb(86, 182, 194)' // the default scheme's ip tone (#56b6c2)
const NUM_RGB = 'rgb(209, 154, 102)' // number tone (#d19a66)

/** Echo typed input back through `poll_output`; answer the Enter with `reply`. */
async function installConpty(page: Page, reply: string[]) {
  await page.evaluate((frame) => {
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
        const data = String(args.data ?? '')
        if (/[\r\n]/.test(data)) pending.push(...frame)
        else {
          const visible = data.replace(/[\x00-\x1f\x7f]/g, '')
          if (visible) pending.push(visible)
        }
      }
      const res = await orig(cmd, args)
      if (cmd === 'poll_output') return [...(res as string[]), ...pending.splice(0)]
      return res
    }
  }, reply)
}

async function runLocalCmd(page: Page, command: string, reply: string[]) {
  await installTauriMock(page, {
    localTerminals: [CMD_ENTRY],
    pollOutputChunks: [[PROMPT]],
  })
  await page.goto('/')
  await page.locator('.conn-item.local-term-item').filter({ hasText: CMD_ENTRY.name }).click()
  await expect(page.locator('.xterm-rows')).toContainText(PROMPT)
  await page.locator('.xterm-screen').click()
  await installConpty(page, reply)
  await page.keyboard.type(command)
  await page.keyboard.press('Enter')
  await expect
    .poll(() => page.locator('.xterm-rows').innerText(), { timeout: 10_000 })
    .toContain('Pinging')
  // The highlighter holds a chunk's trailing word back until it is complete.
  await page.waitForTimeout(600)
}

const rowHtml = (page: Page, needle: string) =>
  page.locator('.xterm-rows > div').filter({ hasText: needle }).first().innerHTML()

// What ConPTY actually sends after an Enter, read off a live PTY: the repaint of
// the submitted line first (absolute moves, no newline of its own), then the CRLF,
// then the command's output as plain text.
const ECHO = '\x1b[4;20Hping\x1b[4;24H'
const OUTPUT = 'Pinging demo.local [192.168.1.10] with 32 bytes of data:\r\n'

test('a local command’s own output is highlighted', async ({ page }) => {
  await runLocalCmd(page, 'ping', [ECHO, '\r\n', OUTPUT, '\r\n', PROMPT])

  const html = await rowHtml(page, 'Pinging')
  expect(html).toContain(IP_RGB)
  expect(html).toContain(NUM_RGB) // the `32`
})

test('the exemption covers the echo only: a later frame still stops it', async ({ page }) => {
  await runLocalCmd(page, 'ping', [
    ECHO,
    '\r\n',
    OUTPUT,
    // An app redrawing a frame (BUGS.md B46). The echo window is closed by the
    // CRLF above, so this move must arm the application-frame hold again and the
    // row it rewrites must reach the screen untouched.
    '\x1b[2A',
    'rewritten by the app: 10.0.0.9 took 42.5%\r\n',
    '\r\n',
    PROMPT,
  ])

  expect(await rowHtml(page, 'Pinging')).toContain(IP_RGB)
  expect(await rowHtml(page, 'rewritten')).not.toContain('color:')
})

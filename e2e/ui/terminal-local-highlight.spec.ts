import { test, expect, type Page } from './helpers/fixtures'
import { installTauriMock } from './helpers/tauriMock'
import { VERTICAL_MOVE } from '../../src/components/terminal/promptLine'

// The category highlighter never ran on a LOCAL terminal's output. ConPTY
// re-serializes the *screen*, so every keystroke echo — and the repaint of the
// line you submitted — arrives wrapped in absolute cursor moves
// (`ESC[4;20Hping ESC[4;32H`). `CURSOR_REPOSITION` cannot tell that apart from an
// application frame, so the last keystroke before Enter kept the first 600 ms —
// usually a command's whole output — out of the highlighter.

const CMD_ENTRY = { id: 'lt-cmd', name: 'Cmd', cwd: '', shell: 'cmd' }
const PROMPT = 'D:\\wrolp\\wrolp-win>'
const IP_RGB = 'rgb(86, 182, 194)' // the default scheme's ip tone (#56b6c2)
const NUM_RGB = 'rgb(209, 154, 102)' // number tone (#d19a66)

/**
 * Echo keystrokes the way ConPTY does — repaint the input line (row 1 here) with
 * absolute moves — and answer the Enter with `reply`.
 */
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
    let typed = ''
    internals.invoke = async (cmd: string, args: Record<string, unknown> = {}) => {
      if (cmd === 'local_send_input') {
        const data = String(args.data ?? '')
        if (/[\r\n]/.test(data)) {
          pending.push(`\x1b[1;1H${typed}\x1b[1;${typed.length + 1}H`, ...frame)
        } else {
          const visible = data.replace(/[\x00-\x1f\x7f]/g, '')
          if (visible) {
            typed += visible
            pending.push(`\x1b[1;1H${typed}\x1b[1;${typed.length + 1}H`)
          }
        }
      }
      const res = await orig(cmd, args)
      if (cmd === 'poll_output') return [...(res as string[]), ...pending.splice(0)]
      return res
    }
  }, reply)
}

async function runLocalCmd(page: Page, command: string, reply: string[], typeDelay = 0) {
  await installTauriMock(page, {
    localTerminals: [CMD_ENTRY],
    pollOutputChunks: [[PROMPT]],
  })
  await page.goto('/')
  await page.locator('.conn-item.local-term-item').filter({ hasText: CMD_ENTRY.name }).click()
  await expect(page.locator('.xterm-rows')).toContainText(PROMPT)
  await page.locator('.xterm-screen').click()
  await installConpty(page, reply)
  // A real delay puts each keystroke's echo in its own 100ms poll, the way typing
  // actually reaches the screen; batched together, they all arrive after Enter and
  // the shape that broke the highlighter never appears.
  await page.keyboard.type(command, { delay: typeDelay })
  await page.keyboard.press('Enter')
  await expect
    .poll(() => page.locator('.xterm-rows').innerText(), { timeout: 10_000 })
    .toContain('Pinging')
  // The highlighter holds a chunk's trailing word back until it is complete.
  await page.waitForTimeout(600)
}

const rowHtml = (page: Page, needle: string) =>
  page.locator('.xterm-rows > div').filter({ hasText: needle }).first().innerHTML()

// What ConPTY actually sends after an Enter, read off a live PTY (5001 chunks of
// `netstat -ano`, of which exactly one carried a cursor move): the repaint of the
// submitted line, then the CRLF, then the output as plain text.
const ECHO = '\x1b[1;20Hping\x1b[1;24H'
const OUTPUT = 'Pinging demo.local [192.168.1.10] with 32 bytes of data:\r\n'

test('a local command’s own output is highlighted', async ({ page }) => {
  await runLocalCmd(page, 'ping', [ECHO, '\r\n', OUTPUT, '\r\n', PROMPT])

  const html = await rowHtml(page, 'Pinging')
  expect(html).toContain(IP_RGB)
  expect(html).toContain(NUM_RGB) // the `32`
})

test('the echo of each keystroke does not swallow the output either', async ({ page }) => {
  // The shape that actually reaches the wire while typing: a repaint per
  // character, then Enter. Without the row test the last of those arms the
  // application-frame hold and the output that lands 100ms later is passed
  // through unhighlighted — the reported symptom.
  await runLocalCmd(page, 'ping', [ECHO, '\r\n', OUTPUT, '\r\n', PROMPT], 150)

  expect(await rowHtml(page, 'Pinging')).toContain(IP_RGB)
})

test('the exemption covers echoes only: a later frame still stops it', async ({ page }) => {
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

test('a prompt that follows ConPTY’s input-column move is still highlighted', async ({ page }) => {
  // Recorded from a live PTY: after a listing, cmd prints its prompt, then ConPTY
  // sends a *lone* `ESC[8;20H` to park the cursor on the input column, then the
  // next prompt. That move is not an app frame, but arming the hold from it left
  // every following prompt line uncoloured ("执行ls 后提示符没匹配分类高亮").
  await runLocalCmd(page, 'ping', [
    ECHO,
    '\r\n',
    OUTPUT,
    '\r\n',
    PROMPT,
    '\x1b[8;20H',
    '\r\n',
    PROMPT,
    '\x1b[9;20H',
    '\r\n',
    PROMPT,
  ])

  const prompts = await page
    .locator('.xterm-rows > div')
    .filter({ hasText: 'wrolp' })
    .evaluateAll((els) => els.map((e) => !!e.querySelector('span[style*="color:"]')))
  expect(prompts.length).toBeGreaterThanOrEqual(3)
  expect(prompts.every((p) => p)).toBe(true)
})

test('a local repaint signal is a row change, not any cursor move', () => {
  // ConPTY's input-line repaints: absolute moves, with or without text.
  expect(VERTICAL_MOVE.test('\x1b[8;20H')).toBe(false)
  expect(VERTICAL_MOVE.test('\x1b[1;20Hnetstat -ano\x1b[1;32H')).toBe(false)
  // An inline TUI redrawing above itself (BUGS.md B46) must still count.
  expect(VERTICAL_MOVE.test('\x1b[2A')).toBe(true)
  expect(VERTICAL_MOVE.test('\x1b[1;1Hframe\x1b[3A')).toBe(true)
})

/**
 * An interactive application (TUI) that renders INLINE — i.e. without switching
 * to the alternate screen buffer (CodeBuddy CLI, Claude Code, …) — must not be
 * mistaken for a shell prompt (BUGS.md B46).
 *
 * Its input line looks exactly like a prompt (`> …`), so every shell-oriented
 * heuristic used to fire on it: the line was recoloured, its Enter was recorded
 * as a submitted command, and — worst — an `ls`/print capture started, which
 * BUFFERS and re-emits the app's output with the cursor/clear sequences
 * stripped, corrupting the app's frames (stale rows, broken box borders).
 *
 * These tests pin the discrimination: a real prompt at the bottom of the screen
 * still counts, an app with chrome *below* its input line does not.
 */
import { test, expect, type Page } from './helpers/fixtures'
import { installTauriMock, invokedCalls } from './helpers/tauriMock'

const DEMO_CONN = { id: 'c1', name: 'Demo', host: 'demo.local', port: 22, username: 'root' }
const PROMPT = '[root@sip ~]# '

/**
 * An inline TUI frame: mouse tracking on (which is what marks it as an
 * application — see `isApplicationScreen`), a bordered box, the app's own input
 * line (`> ls`, caret at its end) and a status line below it.
 */
const TUI_FRAME =
  '\x1b[2J\x1b[H' +
  '\x1b[?1000h\x1b[?1006h' +
  '\x1b[1;1H╭─ Tips for getting started ─╮' +
  '\x1b[2;1H│ Use AGENTS.md files         │' +
  '\x1b[3;1H╰─────────────────────────────╯' +
  '\x1b[5;1HShift+Tab to Accept Edits' +
  // Footer written BEFORE the input line, so the caret can be left ON the input
  // (a shell-oriented heuristic reads the line under the caret).
  '\x1b[7;1HQwen3.8-Flash Model · ctx 0%' +
  '\x1b[6;1H> ls' +
  '\x1b[6;5H'

/** What the app draws in response to the Enter, positioned absolutely. */
const TUI_REPLY = '\x1b[9;1HZZZ_MARKER'

const commitCalls = async (page: Page) =>
  (await invokedCalls(page)).filter((c) => c.cmd === 'commit_command')

/** Echo the reply frame back through `poll_output` right after an Enter. */
async function installReplyOnEnter(page: Page, reply: string) {
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
      if (cmd === 'send_input' && /[\r\n]/.test(String(args.data ?? ''))) pending.push(frame)
      const res = await orig(cmd, args)
      if (cmd === 'poll_output') return [...(res as string[]), ...pending.splice(0)]
      return res
    }
  }, reply)
}

test('a real shell prompt at the bottom still records the submitted command', async ({ page }) => {
  await installTauriMock(page, {
    connections: [DEMO_CONN],
    pollOutputChunks: [[`${PROMPT}ls`]],
  })
  await page.goto('/')
  await page.locator('.connection-item').first().click()
  await expect(page.locator('.xterm-rows')).toContainText(`${PROMPT}ls`)

  await page.locator('.xterm-screen').click()
  await page.keyboard.press('Enter')

  await expect.poll(async () => (await commitCalls(page)).length).toBeGreaterThanOrEqual(1)
  expect(String((await commitCalls(page))[0].args.command)).toBe('ls')
})

test("an inline TUI's input line is not treated as a shell command", async ({ page }) => {
  await installTauriMock(page, {
    connections: [DEMO_CONN],
    pollOutputChunks: [[TUI_FRAME]],
  })
  await page.goto('/')
  await page.locator('.connection-item').first().click()
  await expect(page.locator('.xterm-rows')).toContainText('Tips for getting started')
  await installReplyOnEnter(page, TUI_REPLY)

  await page.locator('.xterm-screen').click()
  await page.keyboard.press('Enter')

  // The app's own reply is applied verbatim: had an `ls` capture started (the
  // input line is `> ls`), the chunk would be buffered/stripped of its cursor
  // positioning and never reach row 9.
  await expect(page.locator('.xterm-rows > div').nth(8)).toContainText('ZZZ_MARKER')
  // …and the app's input was NOT recorded as a submitted shell command.
  expect(await commitCalls(page)).toHaveLength(0)
})

/**
 * Tail room shifts the whole grid with `translateY` and pads the scroll area. For
 * an app-owned screen that lands every frame at a different offset (the app
 * repaints on its own), which is what ghosts its rows and breaks its borders —
 * so the room must be suppressed there, exactly like on the alternate buffer.
 */
test('an inline TUI gets no tail room (its grid must not be shifted)', async ({ page }) => {
  await installTauriMock(page, {
    connections: [DEMO_CONN],
    pollOutputChunks: [[TUI_FRAME]],
  })
  // Tail room is opt-in; enable it globally so the test would see its padding if
  // the guard were missing.
  await page.addInitScript(() => localStorage.setItem('wrolp-terminal-tail-room', '1'))
  await page.goto('/')
  await page.locator('.connection-item').first().click()
  await expect(page.locator('.xterm-rows')).toContainText('Tips for getting started')

  const padding = () =>
    page
      .locator('.xterm-scroll-area')
      .evaluate((el) => (el as HTMLElement).style.paddingBottom)
  await expect.poll(padding).toBe('')
  expect(
    await page.locator('.xterm-screen').evaluate((el) => (el as HTMLElement).style.transform),
  ).toBe('')
})

/**
 * The category highlighter re-colours structured tokens (an IPv4 address, say) and
 * holds back a trailing token until its boundary is seen. Both are meaningless — and
 * actively harmful — on an app-owned screen, where the app repaints frames with
 * absolute cursor positioning: a delayed or recoloured byte lands in the wrong cell
 * and ghosts the frame. So on such a screen output must bypass the highlighter.
 */
test('an inline TUI frame is not passed through the highlighter (no recolour)', async ({ page }) => {
  // Two polls: the app first turns on mouse tracking (marking it an application
  // screen), THEN repaints content — exactly the real TUI sequence. The bypass
  // reads the mode flag before applying a chunk, so content must arrive in a
  // later chunk than the one that enabled tracking.
  await installTauriMock(page, {
    connections: [DEMO_CONN],
    pollOutputChunks: [
      ['\x1b[?1000h\x1b[?1006h'],
      ['\x1b[2J\x1b[H\x1b[5;1Hping 10.0.0.1 ok'],
    ],
  })
  await page.goto('/')
  await page.locator('.connection-item').first().click()
  await expect(page.locator('.xterm-rows')).toContainText('ping 10.0.0.1 ok')

  // Past the highlighter flush delay: a coloured token would have landed by now.
  await page.waitForTimeout(800)
  const html = await page.locator('.xterm-rows > div').nth(4).innerHTML()
  expect(html).not.toContain('color:')
})

/** Same IPv4 on a plain shell screen IS highlighted — proves the bypass is scoped. */
test('the same token on a shell screen is highlighted', async ({ page }) => {
  await installTauriMock(page, {
    connections: [DEMO_CONN],
    pollOutputChunks: [[`${PROMPT}ping 10.0.0.1 ok\r\n`]],
  })
  await page.goto('/')
  await page.locator('.connection-item').first().click()
  await expect(page.locator('.xterm-rows')).toContainText('ping 10.0.0.1 ok')

  await expect
    .poll(async () => (await page.locator('.xterm-rows > div').nth(0).innerHTML()).includes('color:'))
    .toBe(true)
})

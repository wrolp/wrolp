/**
 * A REAL zsh + powerlevel10k prompt, replayed byte for byte (see
 * `helpers/p10kCapture.ts`, captured from the test server through a 120x30 PTY).
 *
 * What makes p10k different from every prompt the older specs mock:
 *   * the prompt is TWO rows — a status line above the input row;
 *   * the input row is `❯ <command>` (green `❯`, one space);
 *   * ZLE REDRAWS the accepted line with cursor moves (`ESC[A`, `ESC[K`, `ESC[J`)
 *     as soon as Enter is pressed, and p10k repaints its status line on every
 *     prompt — so whatever the app paints on that row before Enter is overwritten
 *     by the shell's own plain redraw if the recolor is not re-applied.
 *
 * The specs below therefore check the line AFTER the shell has repainted it, which
 * is what the user actually sees.
 */
import { test, expect, type Page } from './helpers/fixtures'
import { installTauriMock, invokedCalls } from './helpers/tauriMock'
import { p10kChunks } from './helpers/p10kCapture'

const DEMO_CONN = { id: 'c1', name: 'Demo', host: 'demo.local', port: 22, username: 'root' }

const entry = (name: string, path: string) => ({
  name,
  path,
  isDir: true,
  size: 0,
  mode: 'drwxr-xr-x',
  modified: '',
})

/**
 * Replay the captured stream one chunk per input, exactly as it arrived. The
 * pairing is explicit: a click or a focus change can produce an extra `send_input`
 * and a naive counter would shift every following chunk onto the wrong keystroke.
 */
const SCRIPT: Array<{ input: string; chunk: number }> = [
  ...'cd "/opt"'.split('').map((ch, i) => ({ input: ch, chunk: i + 1 })),
  { input: '\r', chunk: 10 },
  { input: 'l', chunk: 11 },
  { input: 's', chunk: 12 },
  { input: '\r', chunk: 13 },
]

async function replayCapture(page: Page) {
  await page.evaluate(
    ({ chunks, script }) => {
      const internals = (
        window as unknown as {
          __TAURI_INTERNALS__: {
            invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
          }
        }
      ).__TAURI_INTERNALS__
      const orig = internals.invoke.bind(internals)
      let step = 0
      const pending: string[] = []
      internals.invoke = async (cmd: string, args: Record<string, unknown> = {}) => {
        if (cmd === 'send_input') {
          const data = String(args.data ?? '')
          const want = script[step]
          if (want && data.startsWith(want.input)) {
            pending.push(chunks[want.chunk])
            step++
          }
        }
        const res = await orig(cmd, args)
        if (cmd === 'poll_output') return [...((res as string[]) ?? []), ...pending.splice(0)]
        return res
      }
    },
    { chunks: p10kChunks, script: SCRIPT },
  )
}

async function openZsh(page: Page) {
  // The capture came from a 120x30 PTY and p10k's status line is ~105 cells wide.
  // A narrower pane wraps it onto a second row, which moves the pressed line and
  // makes every assertion below test the wrap instead of the prompt.
  await page.setViewportSize({ width: 1900, height: 900 })
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  await installTauriMock(page, {
    connections: [DEMO_CONN],
    pollOutputChunks: [[p10kChunks[0]]],
    filesByDir: {
      '/root': [],
      '/opt': [entry('wrolp', '/opt/wrolp'), entry('wrolp-editor', '/opt/wrolp-editor')],
    },
  })
  await page.goto('/')
  await page.locator('.connection-item').first().click()
  await expect(page.locator('.xterm-rows')).toContainText('with root@user')
  await replayCapture(page)
  await page.locator('.xterm-screen').click()
}

/** The rows whose text contains `needle`, bottom-most first. */
const rowsWith = (page: Page, needle: string) =>
  page.locator('.xterm-rows > div').filter({ hasText: needle })

test.describe('zsh + powerlevel10k prompt', () => {
  test('the typed command is recolored on the input row', async ({ page }) => {
    await openZsh(page)
    await page.keyboard.type('cd "/opt"', { delay: 30 })
    await expect(page.locator('.xterm-rows')).toContainText('cd "/opt"')
    await page.waitForTimeout(500)
    const html = await rowsWith(page, 'cd "/opt"').last().innerHTML()
    // `colorizeCommand` paints the program word bold magenta (SGR 1;35 → fg-13).
    // Asserting a bare `xterm-fg` would also pass on p10k's own segment colours,
    // which is exactly the difference this spec has to tell apart.
    expect(html, 'the command after the prompt must be syntax-coloured').toContain('xterm-fg-13')
  })

  test('the submitted command stays coloured after ZLE redraws it', async ({ page }) => {
    await openZsh(page)
    await page.keyboard.type('cd "/opt"', { delay: 30 })
    await page.keyboard.press('Enter')
    // p10k repaints the accepted line + its status line; the row the user keeps
    // looking at must still carry the command colour.
    await page.waitForTimeout(800)
    const html = await rowsWith(page, 'cd "/opt"').last().innerHTML()
    expect(html, 'the accepted line must keep its colours after the shell redraw').toContain(
      'xterm-fg-13',
    )
  })

  test('`cd` is tracked and the listing is clickable', async ({ page }) => {
    await openZsh(page)
    await page.keyboard.type('cd "/opt"', { delay: 30 })
    await page.keyboard.press('Enter')
    // `cd` is verified through the existence probe the tracker runs on the target
    // before it adopts it — `list_files` is only reached when a panel asks for it.
    await expect
      .poll(async () =>
        (await invokedCalls(page))
          .filter((c) => c.cmd === 'target_file_exists' || c.cmd === 'file_exists')
          .map((c) => String(c.args.path)),
      )
      .toContain('/opt')

    await page.keyboard.type('ls', { delay: 30 })
    await page.keyboard.press('Enter')
    await expect(page.locator('.xterm-rows')).toContainText('wrolp-editor')

    const row = rowsWith(page, 'wrolp-editor').last()
    const box = await row.boundingBox()
    expect(box).not.toBeNull()
    await page.mouse.move(box!.x + 6, box!.y + box!.height / 2)
    await expect(page.locator('.term-link-tooltip')).toContainText('Enter folder', {
      timeout: 6_000,
    })
  })
})

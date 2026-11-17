/**
 * The `ls` hover card is anchored to the entry's own row. That anchor was
 * computed from `buffer.baseY` — the top of the *bottom* page — instead of the
 * live viewport top, so after scrolling back into the scrollback every card
 * opened `baseY - viewportY` rows above the name under the cursor (reported
 * against `fuse.conf`: the card landed ~12 rows up, near the window top).
 */
import { test, expect, type Page } from './helpers/fixtures'
import { installTauriMock } from './helpers/tauriMock'

const DEMO_CONN = {
  id: 'c1',
  name: 'Demo',
  host: 'demo.local',
  port: 22,
  username: 'root',
  startupDir: '/srv/a',
}
const PROMPT = '[root@srv a]# '
const NAMES = ['alpha.conf', 'beta.conf', 'gamma.conf', 'delta.conf', 'epsilon.conf']

/** Echo typed input like a PTY: `ls` prints a listing, `run` prints 12 lines. */
async function installShell(page: Page) {
  await page.evaluate(
    ({ prompt, listing }) => {
      const internals = (
        window as unknown as {
          __TAURI_INTERNALS__: {
            invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
          }
        }
      ).__TAURI_INTERNALS__
      const orig = internals.invoke.bind(internals)
      const pending: string[] = []
      let line = ''
      internals.invoke = async (cmd: string, args: Record<string, unknown> = {}) => {
        if (cmd === 'send_input') {
          const data = String(args.data ?? '')
          if (/[\r\n]/.test(data)) {
            const submitted = line.trim()
            line = ''
            pending.push('\r\n')
            if (submitted === 'ls') pending.push(listing, '\r\n')
            if (submitted === 'run') {
              for (let i = 0; i < 12; i++) pending.push(`after ${i}\r\n`)
            }
            pending.push(prompt)
          } else {
            const visible = data.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
            line += visible
            if (visible) pending.push(visible)
          }
        }
        const res = await orig(cmd, args)
        if (cmd === 'poll_output') return [...(res as string[]), ...pending.splice(0)]
        return res
      }
    },
    { prompt: PROMPT, listing: NAMES.join('  ') },
  )
}

test('the hover card stays on the hovered row after scrolling back', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  // A prelude taller than the viewport, so the buffer has real scrollback.
  const prelude = Array.from({ length: 120 }, (_, i) => `init ${i}\r\n`).join('')
  await installTauriMock(page, {
    connections: [DEMO_CONN],
    pollOutputChunks: [[prelude, PROMPT]],
  })
  await page.goto('/')
  await installShell(page)
  await page.locator('.connection-item').first().click()
  await expect(page.locator('.xterm-rows')).toContainText(PROMPT)
  await page.locator('.xterm-screen').click()

  await page.keyboard.type('ls')
  await page.keyboard.press('Enter')
  await expect(page.locator('.xterm-rows')).toContainText('epsilon.conf')
  // More output below the listing, so scrolling back leaves it on screen.
  await page.keyboard.type('run')
  await page.keyboard.press('Enter')
  await expect(page.locator('.xterm-rows')).toContainText('after 11')

  const row = page.locator('.xterm-rows > div').filter({ hasText: 'gamma.conf' }).first()
  await expect(row).toBeVisible()
  const bottomY = (await row.boundingBox())!.y

  // Park the view 10 rows higher, the way a wheel-up over the pane does.
  await page.mouse.move(10, 10)
  await page.evaluate(() => {
    const vp = document.querySelector('.xterm-viewport') as HTMLElement
    const rowEl = document.querySelector('.xterm-rows > div') as HTMLElement
    vp.scrollTop = vp.scrollHeight - vp.clientHeight - 10 * rowEl.offsetHeight
  })
  const view = await page.evaluate(() => {
    const vp = document.querySelector('.xterm-viewport') as HTMLElement
    return { top: vp.scrollTop, room: vp.scrollHeight - vp.clientHeight }
  })
  expect(view.top).toBeLessThan(view.room - 4)
  // The repaint followed the scroll: the listing row moved down the pane.
  await expect.poll(async () => (await row.boundingBox())!.y).toBeGreaterThan(bottomY + 100)

  const rowBox = (await row.boundingBox())!
  await page.mouse.move(rowBox.x + 6, rowBox.y + rowBox.height / 2)
  const card = page.locator('.term-link-tooltip')
  await expect(card).toContainText('Open file', { timeout: 5_000 })
  const cardBox = (await card.boundingBox())!

  // The card hugs the row: above it (bottom just over the row top) or, when
  // flipped, below it. Anything further than one row means the anchor drifted.
  expect(cardBox.y + cardBox.height).toBeGreaterThan(rowBox.y - 4)
  expect(cardBox.y).toBeLessThan(rowBox.y + rowBox.height + 4)
})

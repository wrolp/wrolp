import { test, expect, type Page } from './helpers/fixtures'
import { installTauriMock, invokedCalls } from './helpers/tauriMock'

// Terminal tail room (task/plans/terminal-tail-room-plan.md).
//
// xterm does not translate the DOM when scrolling — `ydisp` is clamped to the buffer
// bottom and the rows are repainted — so the room needs two pieces: `padding-bottom`
// on `.xterm-scroll-area` (real scroll range below the buffer) plus a `translateY`
// applied to `.xterm` by the overflow past the buffer bottom (what actually reveals
// the blank space).

const DEMO_CONN = { id: 'c1', name: 'Demo', host: 'demo.local', port: 22, username: 'root' }

// Far more lines than the pane has rows, so there is real scrollback to scroll through.
const FIRST_OUTPUT =
  Array.from({ length: 120 }, (_, i) => `line-${i}\r\n`).join('') + 'root@demo:~$ '
const SECOND_OUTPUT = 'more-output\r\nroot@demo:~$ '

const ROOM_KEY = 'wrolp-terminal-tail-room'

async function openTerminal(page: Page, opts: { tailRoom?: boolean } = {}) {
  // Stable language for the context-menu assertion (the status-bar switch is matched by
  // class, so it does not care). No value written = the registry default, which is ON.
  await page.addInitScript((lang) => {
    try {
      localStorage.setItem('wrolp-lang', lang)
    } catch {
      /* ignore */
    }
  }, 'en')
  if (opts.tailRoom !== undefined) {
    await page.addInitScript(
      ([key, value]) => {
        try {
          localStorage.setItem(key, value)
        } catch {
          /* ignore */
        }
      },
      [ROOM_KEY, opts.tailRoom ? '1' : '0'] as const,
    )
  }

  await installTauriMock(page, {
    connections: [DEMO_CONN],
    pollOutputChunks: [FIRST_OUTPUT, SECOND_OUTPUT],
  })
  await page.goto('/')
  await page.locator('.connection-item').click()
  await expect(page.locator('.xterm-helper-textarea')).toBeAttached()

  // Wait for the output to land in the buffer: the scroll area is taller than the
  // viewport once there is scrollback.
  await expect
    .poll(async () => (await geom(page)).scrollHeight - (await geom(page)).clientHeight)
    .toBeGreaterThan(100)
  await page.waitForTimeout(200)
}

/** Geometry of the *visible* pane's terminal (the hidden pool has instances too). */
async function geom(page: Page) {
  return page.evaluate(() => {
    const vp = document.querySelector('.term-pane-term .xterm-viewport') as HTMLElement | null
    const area = document.querySelector('.term-pane-term .xterm-scroll-area') as HTMLElement | null
    const term = document.querySelector('.term-pane-term .xterm') as HTMLElement | null
    const screen = document.querySelector('.term-pane-term .xterm-screen') as HTMLElement | null
    const paneRect = document.querySelector('.term-pane-term')?.getBoundingClientRect()
    const screenRect = screen?.getBoundingClientRect()
    return {
      pad: area?.style.paddingBottom ?? '',
      /** Shift of the terminal *content* — it lives on `.xterm-screen`. */
      transform: screen?.style.transform ?? '',
      /** The outer element must stay put: it keeps the wheel/click surface over the pane. */
      termTransform: term?.style.transform ?? '',
      scrollHeight: vp?.scrollHeight ?? 0,
      clientHeight: vp?.clientHeight ?? 0,
      scrollTop: vp?.scrollTop ?? 0,
      paneTop: paneRect?.top ?? 0,
      paneBottom: paneRect?.bottom ?? 0,
      /** Bottom edge of the painted content — the last line's baseline end. */
      contentBottom: screenRect?.bottom ?? 0,
    }
  })
}

/** Wheel over the middle of the pane (the centre may sit in the revealed room). */
async function wheel(page: Page, notches: number, deltaY: number) {
  const box = await page.locator('.term-pane-term').boundingBox()
  if (!box) throw new Error('terminal pane is not visible')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  for (let i = 0; i < notches; i++) await page.mouse.wheel(0, deltaY)
  await page.waitForTimeout(250)
}

/**
 * Click the middle of the visible terminal pane. With a tall scrollback (42 rows here)
 * `.xterm-screen` overflows the pane, so Playwright's element-centred click can land
 * behind the app's title bar — the pane itself is always where the user clicks.
 */
async function clickPaneCenter(page: Page, button: 'left' | 'right' = 'left') {
  const box = await page.locator('.term-pane-term').boundingBox()
  if (!box) throw new Error('terminal pane is not visible')
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button })
  await page.waitForTimeout(100)
}

/** The per-terminal switch in the pane's status bar. */
const statusSwitch = (page: Page) => page.locator('.term-pane-statusbar .tsb-toggle')

/** Flip the room through the status-bar switch (the primary path). */
async function toggleViaStatusBar(page: Page) {
  await statusSwitch(page).click()
  await page.waitForTimeout(150)
}

/** Flip it through the terminal's own context menu (kept for floated terminals). */
async function toggleViaContextMenu(page: Page) {
  await clickPaneCenter(page, 'right')
  await expect(page.locator('.context-menu')).toBeVisible()
  await page.locator('.context-menu-item', { hasText: 'Tail room' }).click()
  await page.waitForTimeout(150)
}

/** Scroll the terminal's viewport all the way down (into the room, when there is one). */
async function scrollToBottom(page: Page) {
  await page.evaluate(() => {
    const vp = document.querySelector('.term-pane-term .xterm-viewport') as HTMLElement | null
    if (vp) vp.scrollTop = vp.scrollHeight
  })
  await page.waitForTimeout(150)
}

const shiftOf = (transform: string) => {
  const m = /translateY\(-([\d.]+)px\)/.exec(transform)
  return m ? Number(m[1]) : 0
}

/**
 * Fake PTY echo, like `terminal-live-line-recolor.spec.ts` wraps `send_input` — but
 * here Enter is answered with a real newline + prompt, so a submitted command grows
 * the buffer (which is what makes xterm re-pin the view).
 */
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
        const raw = String(args.data ?? '')
        if (/[\r\n]/.test(raw)) {
          pending.push('\r\nroot@demo:~$ ')
        } else {
          const visible = raw.replace(/\x1b\[20[01]~/g, '').replace(/[\x00-\x1f\x7f]/g, '')
          if (visible) pending.push(visible)
        }
      }
      const res = await orig(cmd, args)
      if (cmd === 'poll_output') return [...(res as string[]), ...pending.splice(0)]
      return res
    }
  })
}

test('the last line stays in view and the wheel can scroll back', async ({ page }) => {
  await openTerminal(page)
  // Let the buffered output settle: the room alone already satisfies the scrollback wait.
  await page.waitForTimeout(500)

  await wheel(page, 25, 200)
  const deep = await geom(page)
  expect(shiftOf(deep.transform)).toBeGreaterThan(0)
  // The last line must not leave the view — the content stays inside the pane…
  expect(deep.contentBottom).toBeLessThanOrEqual(deep.paneBottom + 1)
  expect(deep.contentBottom).toBeGreaterThan(deep.paneTop)
  // …and only the content moves, so the revealed strip is not a dead zone.
  expect(deep.termTransform).toBe('')

  // The reported bug: once the content had scrolled up, the wheel could not bring it
  // back (the strip below `.xterm` swallowed the events).
  await wheel(page, 6, -300)
  expect(shiftOf((await geom(page)).transform)).toBeLessThan(shiftOf(deep.transform))
  await wheel(page, 40, -300)
  await expect.poll(async () => shiftOf((await geom(page)).transform)).toBe(0)
})

test('tail room is on by default, with the switch in the pane status bar', async ({ page }) => {
  await openTerminal(page)

  const g = await geom(page)
  expect(parseFloat(g.pad)).toBeGreaterThan(0)
  await expect(statusSwitch(page)).toBeVisible()
  await expect(statusSwitch(page)).toHaveAttribute('aria-pressed', 'true')
})

test('the status-bar switch turns the room off for this pane only', async ({ page }) => {
  await openTerminal(page)

  const on = await geom(page)
  expect(parseFloat(on.pad)).toBeGreaterThan(0)

  // Off: no extra scroll range, nothing shifts, the switch reports it.
  await toggleViaStatusBar(page)
  await expect(statusSwitch(page)).toHaveAttribute('aria-pressed', 'false')
  const off = await geom(page)
  expect(off.pad).toBe('')
  expect(off.transform).toBe('')
  await scrollToBottom(page)
  expect((await geom(page)).transform).toBe('')

  // On again: the room is back (vs. the default state, one viewport of scroll range).
  await toggleViaStatusBar(page)
  const back = await geom(page)
  expect(parseFloat(back.pad)).toBeGreaterThan(0)
  expect(back.scrollHeight - off.scrollHeight).toBeGreaterThan(back.clientHeight * 0.8)

  // Scrolled all the way down the overflow past the buffer bottom is shifted up —
  // about a viewport, i.e. the last line comes to rest at the top of the view.
  await scrollToBottom(page)
  await expect.poll(async () => (await geom(page)).transform).toMatch(/translateY\(-/)
  const shifted = await geom(page)
  expect(shiftOf(shifted.transform)).toBeGreaterThan(shifted.clientHeight * 0.8)
})

test('the global setting seeds the switch, and the switch still overrides it', async ({ page }) => {
  await openTerminal(page, { tailRoom: false })

  // Global default switched off in Settings → no room, the switch shows that.
  expect((await geom(page)).pad).toBe('')
  await expect(statusSwitch(page)).toHaveAttribute('aria-pressed', 'false')

  // …and this pane can still turn it on for itself.
  await toggleViaStatusBar(page)
  await expect(statusSwitch(page)).toHaveAttribute('aria-pressed', 'true')
  expect(parseFloat((await geom(page)).pad)).toBeGreaterThan(0)
})

test('the terminal context menu still toggles the room', async ({ page }) => {
  await openTerminal(page)

  await toggleViaContextMenu(page)
  await expect(statusSwitch(page)).toHaveAttribute('aria-pressed', 'false')
  expect((await geom(page)).pad).toBe('')
})

test('typing still reaches the shell and new output re-pins the view', async ({ page }) => {
  await openTerminal(page)
  await installEchoingShell(page)
  await scrollToBottom(page)
  await expect.poll(async () => (await geom(page)).transform).toMatch(/translateY\(-/)

  // Input is untouched by the room (nothing in the buffer/PTY path changed).
  const beforeInput = (await invokedCalls(page)).filter((c) => c.cmd === 'send_input').length
  await clickPaneCenter(page)
  await page.keyboard.type('ls')
  await page.keyboard.press('Enter')
  await expect
    .poll(async () => (await invokedCalls(page)).filter((c) => c.cmd === 'send_input').length)
    .toBeGreaterThan(beforeInput)

  // New output follows the buffer bottom again: xterm re-syncs the scroll area from
  // `ydisp`, which drops the shift — the room can never hide incoming output.
  await expect.poll(async () => (await geom(page)).transform).toBe('')
  await expect(page.locator('.term-pane-term .xterm-rows')).toContainText('ls')
})

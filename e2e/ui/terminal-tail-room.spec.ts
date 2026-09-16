import { test, expect, type Page } from './helpers/fixtures'
import { installTauriMock, invokedCalls } from './helpers/tauriMock'

// Terminal tail room (task/plans/terminal-tail-room-plan.md).
//
// xterm does not translate the DOM when scrolling — `ydisp` is clamped to the buffer
// bottom and the rows are repainted — so the room needs three pieces: `padding-bottom`
// on `.xterm-scroll-area` (real scroll range below the buffer), a `translateY` applied to
// `.xterm-screen` by the overflow past the buffer bottom (what actually reveals the blank
// space) and a hold on that offset, because xterm re-pins `scrollTop` to the buffer bottom
// on every write (which used to wipe the room out on any output — a Windows local shell
// repaints on every keystroke, so it looked broken there).

const DEMO_CONN = { id: 'c1', name: 'Demo', host: 'demo.local', port: 22, username: 'root' }

// A local (PTY / ConPTY) shell from the sidebar, like `terminal-local-clear.spec.ts`.
const LOCAL_ENTRY = { id: 'lt-bash', name: 'Bash', cwd: '', shell: 'bash' }

// Far more lines than the pane has rows, so there is real scrollback to scroll through.
const FIRST_OUTPUT =
  Array.from({ length: 120 }, (_, i) => `line-${i}\r\n`).join('') + 'root@demo:~$ '
const SECOND_OUTPUT = 'more-output\r\nroot@demo:~$ '

const ROOM_KEY = 'wrolp-terminal-tail-room'

/** Seed the *global* tail-room setting (the registry default is OFF, so tests that
 *  exercise the room have to ask for it). */
async function seedTailRoom(page: Page, on: boolean) {
  await page.addInitScript(
    ([key, value]) => {
      try {
        localStorage.setItem(key, value)
      } catch {
        /* ignore */
      }
    },
    [ROOM_KEY, on ? '1' : '0'] as const,
  )
}

/** Opens the demo connection. `tailRoom` seeds the *global* setting in localStorage;
 *  omit it to leave the registry default in place (which is OFF — the room is opt-in per
 *  terminal, so the tests that exercise it pass `{ tailRoom: true }` explicitly). */
async function openTerminal(page: Page, opts: { tailRoom?: boolean } = {}) {
  // Stable language for the context-menu assertion (the status-bar switch is matched by
  // class, so it does not care).
  await page.addInitScript((lang) => {
    try {
      localStorage.setItem('wrolp-lang', lang)
    } catch {
      /* ignore */
    }
  }, 'en')
  if (opts.tailRoom !== undefined) await seedTailRoom(page, opts.tailRoom)

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

/** The same, opened from a sidebar local-terminal entry (a PTY / ConPTY shell) — the
 *  environment the room was reported broken in (BUGS.md B40). */
async function openLocalShell(page: Page) {
  await seedTailRoom(page, true)
  await installTauriMock(page, {
    localTerminals: [LOCAL_ENTRY],
    pollOutputChunks: [FIRST_OUTPUT, SECOND_OUTPUT],
  })
  await page.goto('/')
  await page.locator('.conn-item.local-term-item').filter({ hasText: LOCAL_ENTRY.name }).click()
  await expect(page.locator('.xterm-helper-textarea')).toBeAttached()
  await expect
    .poll(async () => (await invokedCalls(page)).filter((c) => c.cmd === 'open_local_shell').length)
    .toBeGreaterThanOrEqual(1)
  await expect
    .poll(async () => (await geom(page)).scrollHeight - (await geom(page)).clientHeight)
    .toBeGreaterThan(100)
  await page.waitForTimeout(200)
}

/** A connection whose only output is a couple of lines: the buffer never grows scrollback
 *  (`baseY === 0`), i.e. "内容还没满一屏" (BUGS.md B41). */
async function openShortTerminal(page: Page) {
  await seedTailRoom(page, true)
  await installTauriMock(page, {
    connections: [DEMO_CONN],
    pollOutputChunks: [['first line\r\nsecond line\r\nroot@demo:~$ ']],
  })
  await page.goto('/')
  await page.locator('.connection-item').click()
  await expect(page.locator('.xterm-helper-textarea')).toBeAttached()
  await expect.poll(async () => (await geom(page)).lastTextRow).toContain('root@demo')
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
    // The lowest row that actually holds text — what the room must never push out of the
    // pane. `.xterm-screen`'s own bottom edge moves with the shift, so it cannot tell
    // whether the last line is still visible.
    const rows = Array.from(document.querySelectorAll('.term-pane-term .xterm-rows > div'))
    let lastTextRow = ''
    let lastTextRowTop = 0
    let lastTextRowBottom = 0
    for (let i = rows.length - 1; i >= 0; i--) {
      // Monaco/xterm render leading whitespace as `\u00a0`; trailing blanks are padding.
      const text = (rows[i].textContent ?? '').replace(/\u00a0/g, ' ').replace(/\s+$/, '')
      if (!text) continue
      const rect = rows[i].getBoundingClientRect()
      lastTextRow = text.slice(0, 24)
      lastTextRowTop = rect.top
      lastTextRowBottom = rect.bottom
      break
    }
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
      /** Lowest row holding text, and where its edges sit relative to the pane top. */
      lastTextRow,
      lastTextRowTopOffset: paneRect ? Math.round(lastTextRowTop - paneRect.top) : null,
      lastTextRowBottomOffset: paneRect ? Math.round(lastTextRowBottom - paneRect.top) : null,
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

/** Wheel the viewport all the way down (into the room, when there is one). It has to be
 *  a real gesture: only a scroll gesture counts as "the user parked here", which is the
 *  position the room holds on to (see the tail-room hold in `Terminal.tsx`). */
async function wheelToBottom(page: Page) {
  await wheel(page, 40, 200)
}

/** Push a chunk into the terminal after the initial drain (`poll_output` traffic). */
async function pushOutput(page: Page, chunk: string) {
  await page.evaluate((c) => {
    const internals = (
      window as unknown as {
        __TAURI_INTERNALS__: {
          invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
        }
      }
    ).__TAURI_INTERNALS__
    const orig = internals.invoke.bind(internals)
    let sent = false
    internals.invoke = async (cmd: string, args: Record<string, unknown> = {}) => {
      const res = await orig(cmd, args)
      if (cmd === 'poll_output' && !sent) {
        sent = true
        return [...(res as string[]), c]
      }
      return res
    }
  }, chunk)
  await page.waitForTimeout(300)
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
  await openTerminal(page, { tailRoom: true })
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

test('tail room is off by default, with the switch in the pane status bar', async ({ page }) => {
  // No global value written: the registry default (OFF) applies. The room changes how
  // scrolling feels, so it is opt-in — per terminal, from the status bar.
  await openTerminal(page)

  expect((await geom(page)).pad).toBe('')
  await expect(statusSwitch(page)).toBeVisible()
  await expect(statusSwitch(page)).toHaveAttribute('aria-pressed', 'false')

  // …and this pane can switch it on for itself.
  await toggleViaStatusBar(page)
  await expect(statusSwitch(page)).toHaveAttribute('aria-pressed', 'true')
  expect(parseFloat((await geom(page)).pad)).toBeGreaterThan(0)
})

test('the status-bar switch turns the room off for this pane only', async ({ page }) => {
  await openTerminal(page, { tailRoom: true })

  const on = await geom(page)
  expect(parseFloat(on.pad)).toBeGreaterThan(0)

  // Off: no extra scroll range, nothing shifts, the switch reports it.
  await toggleViaStatusBar(page)
  await expect(statusSwitch(page)).toHaveAttribute('aria-pressed', 'false')
  const off = await geom(page)
  expect(off.pad).toBe('')
  expect(off.transform).toBe('')
  await wheelToBottom(page)
  expect((await geom(page)).transform).toBe('')

  // On again: the room is back (vs. the default state, one viewport of scroll range).
  await toggleViaStatusBar(page)
  const back = await geom(page)
  expect(parseFloat(back.pad)).toBeGreaterThan(0)
  expect(back.scrollHeight - off.scrollHeight).toBeGreaterThan(back.clientHeight * 0.8)

  // Wheeled all the way down the overflow past the buffer bottom is shifted up — about
  // a viewport, i.e. the last line comes to rest at the top of the view.
  await wheelToBottom(page)
  await expect.poll(async () => (await geom(page)).transform).toMatch(/translateY\(-/)
  const shifted = await geom(page)
  expect(shiftOf(shifted.transform)).toBeGreaterThan(shifted.clientHeight * 0.8)
})

test('the global setting seeds the switch, and the switch still overrides it', async ({ page }) => {
  await openTerminal(page, { tailRoom: false })

  // Global setting off (that is also the default) → no room, the switch shows that.
  expect((await geom(page)).pad).toBe('')
  await expect(statusSwitch(page)).toHaveAttribute('aria-pressed', 'false')

  // …and this pane can still turn it on for itself.
  await toggleViaStatusBar(page)
  await expect(statusSwitch(page)).toHaveAttribute('aria-pressed', 'true')
  expect(parseFloat((await geom(page)).pad)).toBeGreaterThan(0)
})

test('the terminal context menu still toggles the room', async ({ page }) => {
  await openTerminal(page, { tailRoom: true })

  await toggleViaContextMenu(page)
  await expect(statusSwitch(page)).toHaveAttribute('aria-pressed', 'false')
  expect((await geom(page)).pad).toBe('')
})

test('output while parked in the room keeps the view parked there', async ({ page }) => {
  await openTerminal(page, { tailRoom: true })
  await installEchoingShell(page)
  await wheelToBottom(page)
  const parked = await geom(page)
  expect(shiftOf(parked.transform)).toBeGreaterThan(parked.clientHeight * 0.8)

  // Input is untouched by the room (nothing in the buffer/PTY path changed).
  const beforeInput = (await invokedCalls(page)).filter((c) => c.cmd === 'send_input').length
  await clickPaneCenter(page)
  await page.keyboard.type('ls')
  await page.keyboard.press('Enter')
  await expect
    .poll(async () => (await invokedCalls(page)).filter((c) => c.cmd === 'send_input').length)
    .toBeGreaterThan(beforeInput)

  // The echo reaches the buffer…
  await expect(page.locator('.term-pane-term .xterm-rows')).toContainText('ls')
  // …but the view is NOT yanked back to the buffer bottom: xterm re-pins `scrollTop`
  // from `ydisp` on every write (and `ydisp` is already clamped to the bottom while the
  // room is shown), which used to make the room unusable — a Windows local shell repaints
  // on every keystroke, so the room vanished there immediately.
  await page.waitForTimeout(300)
  const after = await geom(page)
  expect(shiftOf(after.transform)).toBeGreaterThan(after.clientHeight * 0.8)
  expect(parseFloat(after.pad)).toBeGreaterThan(0)
})

test('a repaint that rewrites the last line does not drop the room either', async ({ page }) => {
  await openTerminal(page, { tailRoom: true })
  await wheelToBottom(page)
  expect(shiftOf((await geom(page)).transform)).toBeGreaterThan(0)

  // What ConPTY does on every keystroke: cursor home + rewrite the prompt line.
  await pushOutput(page, '\x1b[H\x1b[2Kroot@demo:~$ ')
  const after = await geom(page)
  expect(shiftOf(after.transform)).toBeGreaterThan(after.clientHeight * 0.8)
})

test('scrolling back out of the room resumes following the output', async ({ page }) => {
  await openTerminal(page, { tailRoom: true })
  await installEchoingShell(page)
  await wheelToBottom(page)
  expect(shiftOf((await geom(page)).transform)).toBeGreaterThan(0)

  // Back to the buffer bottom: a plain terminal again…
  await wheel(page, 40, -300)
  await expect.poll(async () => shiftOf((await geom(page)).transform)).toBe(0)

  // …so new output follows the bottom instead of being held in the room.
  await clickPaneCenter(page)
  await page.keyboard.type('ls')
  await page.keyboard.press('Enter')
  await expect(page.locator('.term-pane-term .xterm-rows')).toContainText('ls')
  await page.waitForTimeout(300)
  expect(shiftOf((await geom(page)).transform)).toBe(0)
})

test('a local shell gets the same room, and its constant repaints keep it', async ({ page }) => {
  await openLocalShell(page)
  expect(parseFloat((await geom(page)).pad)).toBeGreaterThan(0)

  await wheelToBottom(page)
  expect(shiftOf((await geom(page)).transform)).toBeGreaterThan(0)

  // What a Windows local shell does constantly: cursor home + a reprinted prompt line
  // (ConPTY repaints on every keystroke). This is the reported case — the room used to
  // vanish the moment anything was written, so it never seemed to work locally.
  await pushOutput(page, '\x1b[H\x1b[2Kuser@host:~$ ls')
  await pushOutput(page, '\r\nfile-a  file-b\r\nuser@host:~$ ')

  const after = await geom(page)
  expect(shiftOf(after.transform)).toBeGreaterThan(after.clientHeight * 0.8)
  expect(parseFloat(after.pad)).toBeGreaterThan(0)
})

test('no room while a full-screen app owns the alternate buffer', async ({ page }) => {
  await openTerminal(page, { tailRoom: true })
  expect(parseFloat((await geom(page)).pad)).toBeGreaterThan(0)

  // `\x1b[?1049h` — what vim / less / top do. The room would push the app out of the pane.
  await pushOutput(page, '\x1b[?1049h')
  await expect.poll(async () => (await geom(page)).pad).toBe('')
  expect((await geom(page)).transform).toBe('')

  // Leaving it brings the room back.
  await pushOutput(page, '\x1b[?1049l')
  await expect.poll(async () => parseFloat((await geom(page)).pad)).toBeGreaterThan(0)
})

// ---- B41: the room is capped by the content, not by the buffer ----------------------
//
// `bufferBottom = baseY * rowHeight` only equals "the bottom of the content" while the
// buffer is at least one page tall. In a partly filled screen (`baseY = 0`) it is the
// screen *top*, so the old formula pushed the handful of real lines a whole screen up.

test('a screen that is not full gives only as much room as the content', async ({ page }) => {
  await openShortTerminal(page)

  // Three lines of content: a couple of rows of room at most, not a whole viewport.
  const before = await geom(page)
  expect(parseFloat(before.pad)).toBeLessThan(before.clientHeight * 0.4)
  expect(before.lastTextRowBottomOffset).toBeGreaterThan(0)

  await wheel(page, 20, 200)
  const after = await geom(page)
  // The last line may come up to the top edge of the pane, never above it — and the
  // shift stays within the content's own height (the old bug moved it a whole screen).
  expect(after.lastTextRowBottomOffset).toBeGreaterThanOrEqual(0)
  expect(after.lastTextRowBottomOffset).toBeLessThan(after.clientHeight)
  expect(shiftOf(after.transform)).toBeLessThan(after.clientHeight * 0.4)
})

test('cls/reset leaves nothing to scroll past and cannot move the prompt', async ({ page }) => {
  await openTerminal(page, { tailRoom: true })
  expect(parseFloat((await geom(page)).pad)).toBeGreaterThan(0)

  // `\x1b[2J\x1b[H` is what `cls` / `reset` / `clear` do to xterm: screen wiped, cursor home.
  await pushOutput(page, '\x1b[2J\x1b[Hroot@demo:~$ ')
  await expect.poll(async () => (await geom(page)).lastTextRow).toContain('root@demo')

  // Wheeling now: syncTailRoom runs on the scroll, finds only the prompt, and drops the
  // room — so the viewport cannot be scrolled and the prompt does not budge.
  const resting = await geom(page)
  await wheel(page, 20, 200)
  const after = await geom(page)
  expect(after.pad).toBe('')
  expect(after.transform).toBe('')
  expect(after.lastTextRowBottomOffset).toBe(resting.lastTextRowBottomOffset)
  expect(after.lastTextRowBottomOffset).toBeGreaterThan(0)
  expect(after.lastTextRowBottomOffset).toBeLessThan(after.clientHeight)
})

test('the room comes back once the content fills a screen again', async ({ page }) => {
  await openTerminal(page, { tailRoom: true })
  await pushOutput(page, '\x1b[2J\x1b[Hroot@demo:~$ ')
  await wheel(page, 20, 200)
  expect((await geom(page)).pad).toBe('')

  // 60 more lines push the content past one screen.
  await pushOutput(
    page,
    Array.from({ length: 60 }, (_, i) => `line-${i}\r\n`).join('') + 'root@demo:~$ ',
  )
  await expect
    .poll(async () => parseFloat((await geom(page)).pad))
    .toBeGreaterThan((await geom(page)).clientHeight * 0.5)

  await wheelToBottom(page)
  const bottom = await geom(page)
  expect(shiftOf(bottom.transform)).toBeGreaterThan(bottom.clientHeight * 0.5)
  expect(bottom.lastTextRowBottomOffset).toBeGreaterThanOrEqual(0)
  expect(bottom.lastTextRowBottomOffset).toBeLessThanOrEqual(bottom.clientHeight)
})

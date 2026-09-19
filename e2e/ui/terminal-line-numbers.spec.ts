import { test, expect, type Page } from './helpers/fixtures'
import { installTauriMock, emitTauriEvent, invokedCalls } from './helpers/tauriMock'
import {
  CONTINUATION_SYMBOLS,
  computeRowLabels,
  continuationGlyph,
  lineNumberDigits,
} from '../../src/components/terminal/lineNumbers'

// Terminal line numbers (task/finished/TERMINAL-LINE-NUMBERS-PLAN.md).
//
// xterm has no gutter API, so the column is our own DOM in front of the terminal — a real
// flex item that takes width away from it (see `syncGutter` in `Terminal.tsx`). The label
// math is a pure function (`src/components/terminal/lineNumbers.ts`) and the UI cases
// below read the gutter's DOM text, which is the one place in this renderer where
// asserting on the screen means reading DOM instead of a canvas.

const DEMO_CONN = { id: 'c1', name: 'Demo', host: 'demo.local', port: 22, username: 'root' }

// More lines than the pane has rows, so there is real scrollback to move through.
const FIRST_OUTPUT =
  Array.from({ length: 120 }, (_, i) => `line-${i}\r\n`).join('') + 'root@demo:~$ '

const LN_KEY = 'wrolp-terminal-line-numbers'
const ROOM_KEY = 'wrolp-terminal-tail-room'
const SYMBOL_KEY = 'wrolp-terminal-continuation-symbol'

const switchFor = (page: Page, key: string) =>
  page.locator(`.term-pane-statusbar [data-setting="${key}"]`)

async function seedRaw(page: Page, key: string, value: string) {
  await page.addInitScript(
    ([k, v]) => {
      try {
        localStorage.setItem(k, v)
      } catch {
        /* ignore */
      }
    },
    [key, value] as const,
  )
}

async function seed(page: Page, key: string, on: boolean) {
  await seedRaw(page, key, on ? '1' : '0')
}

/** Open the demo terminal. `lineNumbers` seeds the *global* setting; omit it to leave the
 *  registry default in place (which is OFF — the gutter is opt-in per terminal). */
async function openTerminal(
  page: Page,
  opts: { lineNumbers?: boolean; tailRoom?: boolean; continuation?: string; output?: string } = {},
) {
  await page.addInitScript((lang) => {
    try {
      localStorage.setItem('wrolp-lang', lang)
    } catch {
      /* ignore */
    }
  }, 'en')
  if (opts.lineNumbers !== undefined) await seed(page, LN_KEY, opts.lineNumbers)
  if (opts.tailRoom !== undefined) await seed(page, ROOM_KEY, opts.tailRoom)
  if (opts.continuation !== undefined) await seedRaw(page, SYMBOL_KEY, opts.continuation)

  await installTauriMock(page, {
    connections: [DEMO_CONN],
    pollOutputChunks: [opts.output ?? FIRST_OUTPUT],
  })
  await page.goto('/')
  await page.locator('.connection-item').click()
  await expect(page.locator('.xterm-helper-textarea')).toBeAttached()
  if (opts.output === undefined) {
    // Long output: wait for it to land in the buffer (the tail-room spec's wait).
    await expect
      .poll(async () => (await geom(page)).scrollHeight - (await geom(page)).clientHeight)
      .toBeGreaterThan(100)
  } else {
    // Short output: nothing to scroll, so just wait for the text to be on screen.
    await expect
      .poll(() => page.locator('.term-pane-term .xterm-rows').innerText())
      .toContain('root@demo')
  }
  await page.waitForTimeout(250)
}

/** Push a chunk into the terminal after the initial drain. */
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

let uiToolId = 1000

/** Drive one UI-tool request through the frontend bridge (same helper as
 *  `ai-ui-config.spec.ts`): Rust emits `ai-ui-tool-request`, `lib/aiUiBridge.ts` applies
 *  it through `appSettings.ts` and answers with `ai_ui_tool_result`. */
async function uiTool(page: Page, op: string, args: Record<string, unknown>) {
  const id = uiToolId++
  await emitTauriEvent(page, 'ai-ui-tool-request', { id, op, args })
  await expect
    .poll(
      async () =>
        (await invokedCalls(page)).filter((c) => c.cmd === 'ai_ui_tool_result' && c.args.id === id)
          .length,
    )
    .toBe(1)
  const call = (await invokedCalls(page)).find(
    (c) => c.cmd === 'ai_ui_tool_result' && c.args.id === id,
  )!
  return JSON.parse(String(call.args.result)) as Record<string, unknown>
}

/** Open the terminal with line numbers on and one line long enough to wrap onto several
 *  physical rows (the run is located by its `xxxx` text). */
async function openWrapped(page: Page, continuation?: string) {
  await openTerminal(page, { lineNumbers: true, continuation })
  await pushOutput(page, `${'x'.repeat(600)}\r\nroot@demo:~$ `)
}

/** Gutter labels + the rows taken by the wrapped line. */
async function wrappedRun(page: Page) {
  return page.evaluate(() => {
    const labels = Array.from(document.querySelectorAll('.term-pane-term .term-ln-row')).map((el) =>
      (el.textContent ?? '').trim(),
    )
    const rows = Array.from(document.querySelectorAll('.term-pane-term .xterm-rows > div')).map(
      (el) => (el.textContent ?? '').replace(/\u00a0/g, ' '),
    )
    const hashes = rows.map((t) => t.includes('xxxx'))
    const first = hashes.indexOf(true)
    const run: number[] = []
    for (let i = first; i >= 0 && i < rows.length && hashes[i]; i++) run.push(i)
    return { labels, run }
  })
}

/** The visible pane's gutter + terminal geometry. */
async function geom(page: Page) {
  return page.evaluate(() => {
    const root = document.querySelector(
      '.term-pane-term .term-scrollbar-wrapper',
    ) as HTMLElement | null
    const gutter = document.querySelector('.term-pane-term .term-ln-gutter') as HTMLElement | null
    const rowsBox = document.querySelector('.term-pane-term .term-ln-rows') as HTMLElement | null
    const screen = document.querySelector('.term-pane-term .xterm-screen') as HTMLElement | null
    const xterm = document.querySelector('.term-pane-term .xterm') as HTMLElement | null
    const vp = document.querySelector('.term-pane-term .xterm-viewport') as HTMLElement | null
    const nodes = Array.from(document.querySelectorAll('.term-pane-term .term-ln-row'))
    const labels = nodes.map((el) => (el.textContent ?? '').trim())
    const rowHeight = screen && nodes.length > 0 ? screen.clientHeight / nodes.length : 0
    return {
      /** `data-term-line-numbers` on the wrapper — on/off as the component sees it. */
      mode: root?.dataset.termLineNumbers ?? '',
      gutterDisplay: gutter ? getComputedStyle(gutter).display : '',
      gutterWidth: gutter?.getBoundingClientRect().width ?? 0,
      gutterTransform: rowsBox?.style.transform ?? '',
      screenTransform: screen?.style.transform ?? '',
      rowsVisibility: nodes[0] ? getComputedStyle(nodes[0]).visibility : '',
      termWidth: xterm?.clientWidth ?? 0,
      labels,
      rowHeight,
      scrollTop: vp?.scrollTop ?? 0,
      scrollHeight: vp?.scrollHeight ?? 0,
      clientHeight: vp?.clientHeight ?? 0,
    }
  })
}

/** Largest vertical offset between a label row and the terminal row it belongs to. */
async function alignDelta(page: Page) {
  return page.evaluate(() => {
    const labels = Array.from(document.querySelectorAll('.term-pane-term .term-ln-row'))
    const rows = Array.from(document.querySelectorAll('.term-pane-term .xterm-rows > div'))
    const n = Math.min(labels.length, rows.length)
    let maxDelta = 0
    for (let i = 0; i < n; i++) {
      const a = labels[i].getBoundingClientRect().top
      const b = rows[i].getBoundingClientRect().top
      maxDelta = Math.max(maxDelta, Math.abs(a - b))
    }
    return { maxDelta, count: n }
  })
}

/** Wheel over the middle of the pane (a real gesture — the tail room only follows those). */
async function wheel(page: Page, notches: number, deltaY: number) {
  const box = await page.locator('.term-pane-term').boundingBox()
  if (!box) throw new Error('terminal pane is not visible')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  for (let i = 0; i < notches; i++) await page.mouse.wheel(0, deltaY)
  await page.waitForTimeout(250)
}

const shiftOf = (transform: string) => {
  const m = /translateY\(-([\d.]+)px\)/.exec(transform)
  return m ? Number(m[1]) : 0
}

/** A fake `IBuffer` slice — `computeRowLabels` only touches these members. Rows are
 *  described by their text (a number is shorthand for "that many rows, each with text");
 *  `baseY` defaults to `viewportY`, i.e. "the view is at the bottom". */
function fakeBuffer(
  texts: string[] | number,
  opts: { viewportY?: number; baseY?: number; wrapped?: number[] } = {},
): Parameters<typeof computeRowLabels>[0] {
  const lines = typeof texts === 'number' ? Array.from({ length: texts }, () => 'content') : texts
  const wrapped = new Set(opts.wrapped ?? [])
  const viewportY = opts.viewportY ?? 0
  return {
    viewportY,
    baseY: opts.baseY ?? viewportY,
    getLine: (i: number) =>
      i < 0 || i >= lines.length
        ? undefined
        : { isWrapped: wrapped.has(i), translateToString: () => lines[i] },
  } as unknown as Parameters<typeof computeRowLabels>[0]
}

test.describe('line number labels (pure)', () => {
  test('numbers are absolute, 1-based and follow the viewport', () => {
    // `viewportY` is the absolute line on the top screen row (xterm's own definition),
    // so the whole page is numbered from it — `baseY` must not be added on top.
    expect(computeRowLabels(fakeBuffer(100, { viewportY: 10 }), 3)).toEqual([11, 12, 13])
    // Scrolling back into the scrollback lowers the numbers.
    expect(computeRowLabels(fakeBuffer(100, { viewportY: 2 }), 2)).toEqual([3, 4])
  })

  test('a wrapped continuation row is marked with the wrap symbol, not a number', () => {
    // Continuation rows carry the marker; rows the buffer has not grown into stay `null`
    // — the two "no number" cases are deliberately different. Called without a marker,
    // the function uses the default one (the wrap arrow).
    expect(computeRowLabels(fakeBuffer(100, { viewportY: 10, wrapped: [12, 13] }), 5)).toEqual([
      11,
      12,
      CONTINUATION_SYMBOLS.arrow,
      CONTINUATION_SYMBOLS.arrow,
      15,
    ])
    // The marker is a parameter — an empty string (what `none` resolves to) leaves the
    // row blank without making it a "buffer has not grown" row.
    expect(computeRowLabels(fakeBuffer(100, { viewportY: 10, wrapped: [11] }), 2, '')[1]).toBe('')
  })

  test('rows below the last line of output are not numbered', () => {
    // A fresh screen: the prompt sits on row 0, the rest has not been written to yet.
    expect(computeRowLabels(fakeBuffer(['root@demo:~$ ', '', '', '']), 4)).toEqual([
      1,
      null,
      null,
      null,
    ])
    // Blank rows *above* the content are real (empty) history lines — they keep numbers.
    expect(computeRowLabels(fakeBuffer(['', 'line-1', 'root@demo:~$ ']), 3)).toEqual([1, 2, 3])
    // Nothing written at all → no labels whatsoever.
    expect(computeRowLabels(fakeBuffer(['', '']), 2)).toEqual([null, null])
  })

  test('scrolled back, blank rows keep their numbers (the content is below the view)', () => {
    // Rows 0–2 are history above the viewport; the view shows rows 3–5, the last of which
    // is blank *history* (an empty line between commands), and the content continues below
    // the viewport (baseY = 5 is the bottom page) — nothing here is "unwritten".
    expect(
      computeRowLabels(
        fakeBuffer(['x', 'x', 'x', 'line-1', '', ''], { viewportY: 3, baseY: 5 }),
        3,
      ),
    ).toEqual([4, 5, 6])
  })

  test('the registry id resolves to a glyph, unknown ids fall back to the default', () => {
    expect(continuationGlyph('return')).toBe(CONTINUATION_SYMBOLS.return)
    expect(continuationGlyph('arrow')).toBe(CONTINUATION_SYMBOLS.arrow)
    expect(continuationGlyph('dash')).toBe(CONTINUATION_SYMBOLS.dash)
    expect(continuationGlyph('none')).toBe('')
    expect(continuationGlyph(undefined)).toBe(CONTINUATION_SYMBOLS.arrow)
    expect(continuationGlyph('nonsense')).toBe(CONTINUATION_SYMBOLS.arrow)
  })

  test('rows the buffer has not grown into are blank', () => {
    expect(computeRowLabels(fakeBuffer(3, { viewportY: 0 }), 5)).toEqual([1, 2, 3, null, null])
  })

  test('the width only grows with the digit count', () => {
    expect(lineNumberDigits(1)).toBe(2)
    expect(lineNumberDigits(99)).toBe(2)
    expect(lineNumberDigits(100)).toBe(3)
    expect(lineNumberDigits(5000)).toBe(4)
  })
})

test.describe('line number gutter (UI)', () => {
  test('line numbers are off by default, and the switch turns them on', async ({ page }) => {
    await openTerminal(page)

    // No global value written → the registry default (OFF) applies: no gutter, so the
    // terminal keeps the whole width.
    const sw = switchFor(page, 'terminal.lineNumbers')
    await expect(sw).toBeVisible()
    await expect(sw).toHaveAttribute('aria-pressed', 'false')
    let g = await geom(page)
    expect(g.gutterDisplay).toBe('none')
    expect(g.mode).toBe('off')
    const fullWidth = g.termWidth

    await sw.click()
    await page.waitForTimeout(250)
    g = await geom(page)
    expect(g.mode).toBe('on')
    expect(g.gutterDisplay).toBe('block')
    expect(g.gutterWidth).toBeGreaterThan(10)
    // Labels for every terminal row, and the terminal gave width up to the gutter.
    expect(g.labels.length).toBeGreaterThan(10)
    expect(g.labels.filter((l) => l !== '').length).toBe(g.labels.length)
    expect(g.termWidth).toBeLessThan(fullWidth)
    await expect(sw).toHaveAttribute('aria-pressed', 'true')
  })

  test('the labels sit exactly on the terminal rows, and count them from the bottom', async ({
    page,
  }) => {
    await openTerminal(page, { lineNumbers: true })
    const g = await geom(page)
    expect(g.labels.length).toBeGreaterThan(10)

    // Same font metrics as the terminal: every label row is within a pixel of "its" row.
    const a = await alignDelta(page)
    expect(a.count).toBe(g.labels.length)
    expect(a.maxDelta).toBeLessThanOrEqual(1)

    // Consecutive absolute numbers, and the first one is the buffer line at the top of the
    // view — which at the buffer bottom is `scrollTop / rowHeight` (xterm pins it there).
    const nums = g.labels.map(Number)
    for (let i = 1; i < nums.length; i++) expect(nums[i] - nums[i - 1]).toBe(1)
    const topLine = g.rowHeight > 0 ? g.scrollTop / g.rowHeight + 1 : 0
    expect(Math.abs(nums[0] - topLine)).toBeLessThanOrEqual(1)
  })

  test('scrolling moves the labels with the viewport', async ({ page }) => {
    await openTerminal(page, { lineNumbers: true })
    const before = await geom(page)
    await wheel(page, 8, -300)
    const after = await geom(page)
    expect(after.scrollTop).toBeLessThan(before.scrollTop)
    expect(Number(after.labels[0])).toBeLessThan(Number(before.labels[0]))
    expect((await alignDelta(page)).maxDelta).toBeLessThanOrEqual(1)
  })

  test('a wrapped line numbers its first row and marks the continuation', async ({ page }) => {
    // Nothing stored: the registry default (`terminal.continuationSymbol: 'arrow'`) applies.
    await openWrapped(page)
    const res = await wrappedRun(page)

    expect(res.run.length).toBeGreaterThan(1)
    expect(res.labels[res.run[0]]).toMatch(/^\d+$/)
    for (const row of res.run.slice(1)) expect(res.labels[row]).toBe(CONTINUATION_SYMBOLS.arrow)
  })

  test('the continuation marker follows the global setting', async ({ page }) => {
    // `wrolp-terminal-continuation-symbol` stores the registry *id*; the glyphs it maps to
    // live in `lineNumbers.ts`. Seeding the *non-default* one is what makes this prove the
    // stored value wins over the `arrow` default.
    await openWrapped(page, 'return')
    const res = await wrappedRun(page)
    for (const row of res.run.slice(1)) expect(res.labels[row]).toBe(CONTINUATION_SYMBOLS.return)
  })

  test('the marker can be turned off, and the AI bridge can change it live', async ({ page }) => {
    await openWrapped(page, 'none')
    const res = await wrappedRun(page)
    // "none" leaves the continuation rows truly empty (not `null` — the row exists).
    for (const row of res.run.slice(1)) expect(res.labels[row]).toBe('')

    // Changing it through the registry (the settings page does the same) repaints every
    // open terminal via `subscribeAppSettings`.
    await uiTool(page, 'set', { changes: { 'terminal.continuationSymbol': 'dash' } })
    await expect
      .poll(async () => (await wrappedRun(page)).labels[res.run[1]])
      .toBe(CONTINUATION_SYMBOLS.dash)
  })

  test('rows below the last line of output are not numbered', async ({ page }) => {
    // A short session: two lines of output + the prompt, the rest of the screen is
    // unwritten. Those rows are not lines of output, so they must not be numbered.
    await openTerminal(page, {
      lineNumbers: true,
      output: 'line-1\r\nline-2\r\nroot@demo:~$ ',
    })
    const g = await geom(page)
    expect(g.labels.length).toBeGreaterThan(10)

    const res = await page.evaluate(() => {
      const labels = Array.from(document.querySelectorAll('.term-pane-term .term-ln-row')).map(
        (el) => (el.textContent ?? '').trim(),
      )
      const rows = Array.from(document.querySelectorAll('.term-pane-term .xterm-rows > div')).map(
        (el) => (el.textContent ?? '').replace(/\u00a0/g, ' ').trim(),
      )
      let lastText = -1
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i]) {
          lastText = i
          break
        }
      }
      return { labels, lastText }
    })

    expect(res.lastText).toBeGreaterThan(-1)
    // 1..lastText are numbered, everything below the last written row is blank.
    expect(res.labels.slice(0, res.lastText + 1)).toEqual(
      Array.from({ length: res.lastText + 1 }, (_, i) => String(i + 1)),
    )
    expect(res.labels.slice(res.lastText + 1).every((l) => l === '')).toBe(true)
  })

  test('the alternate buffer blanks the labels without narrowing the terminal', async ({
    page,
  }) => {
    await openTerminal(page, { lineNumbers: true })
    const before = await geom(page)

    // `\x1b[?1049h` — what vim / less / top do.
    await pushOutput(page, '\x1b[?1049h')
    const alt = await geom(page)
    // The labels go blank…
    expect(alt.rowsVisibility).toBe('hidden')
    // …but the column keeps its width, so the terminal is NOT re-fit (a SIGWINCH here
    // would make the full-screen app re-lay-out on every open/close).
    expect(alt.gutterWidth).toBe(before.gutterWidth)
    expect(alt.termWidth).toBe(before.termWidth)

    await pushOutput(page, '\x1b[?1049l')
    await expect.poll(async () => (await geom(page)).rowsVisibility).toBe('visible')
  })

  test('the tail room carries the labels along when the view is parked in it', async ({ page }) => {
    await openTerminal(page, { lineNumbers: true })
    await switchFor(page, 'terminal.tailRoom').click()
    await page.waitForTimeout(200)
    await wheel(page, 40, 200) // real gesture, all the way into the room

    const g = await geom(page)
    expect(shiftOf(g.screenTransform)).toBeGreaterThan(0)
    // The labels take the same shift as the content — otherwise they would stay behind
    // while their rows move up.
    expect(g.gutterTransform).toBe(g.screenTransform)
    expect((await alignDelta(page)).maxDelta).toBeLessThanOrEqual(1)
  })

  test('the global setting seeds the switch, and the switch still overrides it', async ({
    page,
  }) => {
    await openTerminal(page, { lineNumbers: true })

    const sw = switchFor(page, 'terminal.lineNumbers')
    await expect(sw).toHaveAttribute('aria-pressed', 'true')
    expect((await geom(page)).gutterDisplay).toBe('block')

    // …and this pane can switch them off for itself.
    await sw.click()
    await page.waitForTimeout(250)
    await expect(sw).toHaveAttribute('aria-pressed', 'false')
    expect((await geom(page)).gutterDisplay).toBe('none')
  })

  test('the terminal context menu toggles the gutter as well', async ({ page }) => {
    // The menu is the only path a *floating* terminal has (no pane status bar).
    await openTerminal(page)
    const box = await page.locator('.term-pane-term').boundingBox()
    if (!box) throw new Error('terminal pane is not visible')
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' })
    await expect(page.locator('.context-menu')).toBeVisible()
    await page.locator('.context-menu-item', { hasText: 'Line numbers' }).click()
    await expect.poll(async () => (await geom(page)).gutterDisplay).toBe('block')
    expect((await geom(page)).mode).toBe('on')
  })
})

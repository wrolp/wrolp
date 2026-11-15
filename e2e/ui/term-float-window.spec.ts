import { test, expect, type Page } from './helpers/fixtures'
import { installTauriMock, invokedCalls } from './helpers/tauriMock'

// A terminal pane pops out into a real OS window. Output is *polled* per session,
// so the two windows cannot both own it: the main one hands the session over
// (serializing its screen first) and takes it back when the float window dies.
// The native window itself cannot be shown in a browser test; what is asserted
// here is that hand-over contract, the float window's own boot, and the controls it
// keeps per pane (recording / reconnect / AI).

async function bootMain(page: Page) {
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  await installTauriMock(page, {})
  await page.goto('/')
  await page.locator('.conn-item.local-term-default').click()
  await expect(page.locator('.xterm-rows')).toBeVisible()
}

const calls = async (page: Page, cmd: string) =>
  (await invokedCalls(page)).filter((c) => c.cmd === cmd)

test('floating a pane hands the session to an OS window and takes it back', async ({ page }) => {
  await bootMain(page)
  // The narrower titlebar is scoped to float windows; the main one keeps its 42px
  // (there it carries the palette and the workspace pill).
  expect((await page.locator('.titlebar').boundingBox())!.height).toBeGreaterThan(31)
  // The pane toolbar is only reachable once the pane exists.
  const floatButton = page.locator('.term-pane-float').first()
  await expect(floatButton).toBeVisible()

  await floatButton.click()

  const opened = await calls(page, 'open_float_window')
  expect(opened).toHaveLength(1)
  const args = opened[0].args as { label: string; tabId: number; title: string }
  // The label is what the backend uses for the window and what we listen for on
  // close, so it has to follow the `float-*` capability pattern.
  expect(args.label).toMatch(/^float-/)
  expect(Number.isInteger(args.tabId)).toBe(true)

  // Whatever was on screen is left for the float window, keyed by that session. A
  // blank grid serializes to an empty string, which is not handed over at all — so
  // the entry may be absent, but never mis-keyed.
  for (const entry of await calls(page, 'float_scrollback_put')) {
    expect(Number(entry.args.tabId)).toBe(args.tabId)
  }

  // The tab's context travels too: without it the float window could show the
  // terminal but not reconnect it (the connection fields live over here).
  const contextPut = await calls(page, 'float_context_put')
  expect(contextPut).toHaveLength(1)
  expect(JSON.parse(String(contextPut[0].args.data))).toMatchObject({
    tabType: 'localShell',
    isLocal: true,
  })

  // The main window stopped rendering (and polling) that session.
  await expect(page.locator('.xterm-rows')).toHaveCount(0)

  // The float window reports its destruction; the pane comes back and the screen
  // it left behind is replayed instead of a blank grid.
  await page.evaluate(
    ({ label, tabId }) =>
      (window as unknown as { __TAURI_EMIT__: (e: string, p: unknown) => void }).__TAURI_EMIT__(
        'float-window-closed',
        { label, tabId },
      ),
    { label: args.label, tabId: args.tabId },
  )

  await expect(page.locator('.xterm-rows')).toBeVisible()
  await expect.poll(async () => (await calls(page, 'float_scrollback_take')).length).toBe(1)
  expect(Number((await calls(page, 'float_scrollback_take'))[0].args.tabId)).toBe(args.tabId)
})

test('the float window boots its own terminal on the same session', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  await installTauriMock(page, {})
  await page.goto('/?float=terminal&tab=7')

  await expect(page.locator('.float-window-root')).toBeVisible()
  // The window wears the app's own titlebar (the backend opens it without OS
  // decorations), so it reads as part of Wrolp rather than a second app.
  await expect(page.locator('.titlebar')).toBeVisible()
  await expect(page.locator('.titlebar')).toHaveAttribute('data-tauri-drag-region')
  // Narrower than the main window's 42px: this bar carries no palette and no
  // workspace pill, so the height belongs to the terminal.
  const titlebarHeight = (await page.locator('.titlebar').boundingBox())!.height
  expect(titlebarHeight).toBeLessThanOrEqual(29)

  // The status/controls row lives on the bottom edge, under the terminal — the top
  // of this window belongs to the titlebar alone.
  await expect(page.locator('.float-term')).toBeVisible()
  const toolbarBox = (await page.locator('.float-toolbar').boundingBox())!
  const termBox = (await page.locator('.float-term').boundingBox())!
  const rootBox = (await page.locator('.float-window-root').boundingBox())!
  expect(toolbarBox.y).toBeGreaterThanOrEqual(termBox.y + termBox.height - 1)
  expect(
    Math.abs(toolbarBox.y + toolbarBox.height - (rootBox.y + rootBox.height)),
  ).toBeLessThanOrEqual(1)
  // A status bar, not a toolbar: one line of text, so it stays under the height the
  // buttons used to force on it.
  expect(toolbarBox.height).toBeLessThanOrEqual(21)
  // It picks up whatever the main window serialized before letting go…
  await expect
    .poll(async () => (await invokedCalls(page)).filter((c) => c.cmd === 'float_scrollback_take'))
    .toHaveLength(1)
  expect((await calls(page, 'float_scrollback_take'))[0].args.tabId).toBe(7)

  // …mounts a terminal, and polls *that* session (no reconnect: `attachOnly`).
  await expect(page.locator('.xterm-rows')).toBeVisible()
  await expect
    .poll(async () => (await calls(page, 'poll_output')).map((c) => Number(c.args.tabId)))
    .toContain(7)
  expect(await calls(page, 'connect_ssh')).toHaveLength(0)
  expect(await calls(page, 'open_local_shell')).toHaveLength(0)
})

test('the float window keeps recording, reconnect and AI available', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  // The context the main window leaves behind: without it the window still shows
  // the terminal, but could not reconnect (connection fields live over there).
  await installTauriMock(page, {
    floatContext: { title: 'local shell', tabType: 'localShell', isLocal: true },
  })
  await page.goto('/?float=terminal&tab=7')

  const toolbar = page.locator('.float-toolbar')
  await expect(toolbar).toBeVisible()
  // The session name lives in the titlebar now; the toolbar keeps the controls.
  await expect(page.locator('.float-tb-title')).toHaveText('local shell')

  // Recording reads the session's real state (the mock reports "on") and toggles it
  // off — the same command pair the pane header uses in the main window.
  const rec = toolbar.getByRole('button', { name: 'Recording' })
  await expect(rec).toBeVisible()
  await expect
    .poll(async () => (await calls(page, 'get_recording_enabled')).length)
    .toBeGreaterThan(0)
  await expect(rec).toHaveClass(/is-rec/)
  await rec.click()
  await expect
    .poll(async () => (await calls(page, 'set_recording_enabled')).at(-1)?.args)
    .toMatchObject({ tabId: 7, enabled: false })

  // Reconnect only lights up once the session is actually gone (reconnecting a live
  // session would replace the shell the user is working in).
  const reconnect = toolbar.getByRole('button', { name: 'Reconnect' })
  await expect(reconnect).toBeDisabled()
  await page.evaluate(() =>
    (window as unknown as { __TAURI_EMIT__: (e: string, p: unknown) => void }).__TAURI_EMIT__(
      'connection-closed',
      { tabId: 7 },
    ),
  )
  await expect(reconnect).toBeEnabled()
  await reconnect.click()
  // A local shell re-opens its PTY; the point is that the click reaches the backend
  // with this tab, i.e. the hand-over carried the session's kind across.
  await expect
    .poll(async () => (await calls(page, 'open_local_shell')).at(-1)?.args)
    .toMatchObject({ tabId: 7 })

  // AI opens *in this window*, bound to this window's session — not the main
  // window's inspector, whose conversation belongs to a different tab.
  await expect(page.locator('.float-ai')).toHaveCount(0)
  const aiButton = toolbar.getByRole('button', { name: 'AI' })
  await aiButton.click()
  await expect(aiButton).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.float-ai')).toHaveCount(1)
  await expect.poll(async () => (await calls(page, 'load_ai_config')).length).toBeGreaterThan(0)
  expect(await calls(page, 'focus_main_window')).toHaveLength(0)

  await aiButton.click()
  await expect(page.locator('.float-ai')).toHaveCount(0)
})

test('the AI column is resizable by dragging its seam', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  await installTauriMock(page, {
    floatContext: { title: 'local shell', tabType: 'localShell', isLocal: true },
  })
  await page.setViewportSize({ width: 1000, height: 600 })
  await page.goto('/?float=terminal&tab=7')
  await page.locator('.float-toolbar').getByRole('button', { name: 'AI' }).click()

  const panel = page.locator('.float-ai')
  const before = (await panel.boundingBox())!.width
  // The seam is the app's own divider, not a one-off strip.
  const seam = page.locator('.float-ai-resizer')
  await expect(seam).toHaveClass(/panel-divider/)
  const box = (await seam.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + 40)
  await page.mouse.down()
  // Dragging the seam left widens the column (the terminal gives up the space).
  await page.mouse.move(box.x - 120, box.y + 40, { steps: 6 })
  await page.mouse.up()

  const after = (await panel.boundingBox())!.width
  expect(after).toBeGreaterThan(before + 80)
  // The width is remembered, like the main window's columns.
  expect(Number(await page.evaluate(() => localStorage.getItem('wrolp-float-ai-width')))).toBe(
    Math.round(after),
  )

  // And it comes back at that width the next time the panel opens.
  await page.reload()
  await page.locator('.float-toolbar').getByRole('button', { name: 'AI' }).click()
  const reopened = (await page.locator('.float-ai').boundingBox())!.width
  expect(Math.abs(reopened - after)).toBeLessThanOrEqual(1)
})

test('the seam stops at a usable terminal width, and only there', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  await installTauriMock(page, {
    floatContext: { title: 'local shell', tabType: 'localShell', isLocal: true },
  })
  await page.setViewportSize({ width: 1200, height: 600 })
  await page.goto('/?float=terminal&tab=7')
  await page.locator('.float-toolbar').getByRole('button', { name: 'AI' }).click()

  const body = (await page.locator('.float-body').boundingBox())!
  const drag = async (toX: number) => {
    const seam = (await page.locator('.float-ai-resizer').boundingBox())!
    await page.mouse.move(seam.x + seam.width / 2, seam.y + 40)
    await page.mouse.down()
    await page.mouse.move(toX, seam.y + 40, { steps: 8 })
    await page.mouse.up()
  }

  // Dragged far past what used to be the limit (640px): the column keeps growing
  // until the terminal reaches its floor, not before.
  await drag(10)
  const aiWide = (await page.locator('.float-ai').boundingBox())!.width
  const termNarrow = (await page.locator('.float-term').boundingBox())!.width
  expect(aiWide).toBeGreaterThan(640)
  // The floor is 120px: a little under, once the seam's own width is counted.
  expect(termNarrow).toBeGreaterThanOrEqual(115)
  // The floor is what stops it: the AI column took everything but a usable terminal.
  expect(aiWide + termNarrow).toBeCloseTo(body.width, -1)

  // And the seam is not stuck — dragging back gives the space to the terminal again.
  await drag(body.width - 300)
  const aiBack = (await page.locator('.float-ai').boundingBox())!.width
  const termBack = (await page.locator('.float-term').boundingBox())!.width
  expect(aiBack).toBeLessThan(aiWide - 100)
  expect(termBack).toBeGreaterThan(termNarrow + 100)

  // Shrinking the window re-clamps instead of squeezing the terminal below its floor.
  await page.setViewportSize({ width: 700, height: 600 })
  await expect
    .poll(async () => (await page.locator('.float-term').boundingBox())!.width)
    .toBeGreaterThanOrEqual(115)
})

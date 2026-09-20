import { test, expect, type Page, type Locator } from '@playwright/test'
import { installTauriMock, invokedCalls, type MockConnection } from './helpers/tauriMock'

// P3-5: the inspector's two states — docked in the row (at either edge) or popped
// out as a float.
//
// The float is not `FloatingWindow` hosting the panels, and the reason is the
// subtree: the assistant's in-flight reply polls from a closure inside
// `AiChatPanel`, and the subnet scan accumulates `scan-progress` rows. Either one
// moved into a different parent would be unmounted and remounted mid-work. So the
// column is one element that changes its own positioning, and the cases below
// check both halves of that: the geometry, and that the panels survive the move.
//
// Docking *side* is the other half of the change. The column used to be a sibling
// of a `.panel-divider-v`, which put it in the row twice over; the grab zone is now
// a child of the column, so changing edge is an `order` change and nothing else.

const CONNS: MockConnection[] = [
  { id: 'c1', name: 'prod-web-01', host: '10.0.0.11', port: 22, username: 'app' },
]

async function boot(page: Page, layout?: string) {
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  await installTauriMock(page, { connections: CONNS, layout })
  await page.goto('/')
}

const inspector = (page: Page) => page.locator('.inspector')
const head = (page: Page) => page.locator('.inspector-head')
const grip = (page: Page) => page.locator('.inspector > .inspector-resize')
const floatGrips = (page: Page) => page.locator('.inspector.is-floating .floating-window-resize')
const floatBtn = (page: Page): Locator =>
  page.locator('.inspector-head .icon-btn[aria-label="Float as a separate window"]')
const dockBackBtn = (page: Page): Locator =>
  page.locator('.inspector-head .icon-btn[aria-label="Dock back into the column"]')
const sideBtn = (page: Page, label: string): Locator =>
  page.locator(`.inspector-head .icon-btn[aria-label="${label}"]`)
const netTab = (page: Page) => page.locator('.inspector-tabs .tab-btn').nth(3)

/** The geometry App computes for a fresh float at this viewport (1440x900): half
 * the window width clamped into [520, 760], and the height minus a fixed margin. */
const FLOATED = { x: 672, y: 88, width: 720, height: 750 }

test('the head offers float, edge and close, in that order', async ({ page }) => {
  await boot(page)
  await page.keyboard.press('Control+Alt+i')
  const btns = head(page).locator('.icon-btn')
  await expect(btns).toHaveCount(3)
  await expect(btns.nth(0)).toHaveAttribute('aria-label', 'Float as a separate window')
  await expect(btns.nth(1)).toHaveAttribute('aria-label', 'Dock to the left')
  await expect(btns.nth(2)).toHaveAttribute('aria-label', 'Close')
  // Docked, there is exactly one grab zone and it is the column's own edge.
  await expect(grip(page)).toHaveCount(1)
  await expect(floatGrips(page)).toHaveCount(0)
})

test('float leaves the row, and the workspace takes the column width back', async ({ page }) => {
  await boot(page)
  await page.keyboard.press('Control+Alt+i')
  const before = await page.locator('.terminal-area').boundingBox()

  await floatBtn(page).click()
  await expect(inspector(page)).toHaveClass(/is-floating/)
  await expect(inspector(page)).toHaveCSS('position', 'fixed')
  await expect(floatGrips(page)).toHaveCount(8)
  await expect(grip(page)).toHaveCount(0)

  const box = await inspector(page).boundingBox()
  expect(box).toMatchObject(FLOATED)
  // The column is gone from the row rather than merely invisible, so the workspace
  // grows by exactly what it gave up.
  const after = await page.locator('.terminal-area').boundingBox()
  expect(after!.width).toBeGreaterThan(before!.width + 200)
  expect(after!.x + after!.width).toBeCloseTo(1440, 0)
})

test('floating neither remounts the scan nor loses its results', async ({ page }) => {
  await boot(page)
  await page.keyboard.press('Control+Alt+i')
  await netTab(page).click()
  await expect(page.locator('.netscan-panel')).toBeVisible()
  await page.evaluate(() => {
    ;(document.querySelector('.netscan-panel') as HTMLElement).dataset.probe = 'mounted'
  })

  await floatBtn(page).click()
  await expect(inspector(page)).toHaveClass(/is-floating/)
  await expect(page.locator('.netscan-panel')).toHaveCount(1)
  await expect(page.locator('.netscan-panel')).toHaveJSProperty('dataset.probe', 'mounted')
  // Still the panel it was, so a scan running in it is still running.
  await expect(page.locator('.netscan-panel')).toBeVisible()

  await dockBackBtn(page).click()
  await expect(inspector(page)).toHaveCSS('position', 'relative')
  await expect(page.locator('.netscan-panel')).toHaveJSProperty('dataset.probe', 'mounted')
})

test('the head drags the float and a corner grip resizes it', async ({ page }) => {
  await boot(page)
  await page.keyboard.press('Control+Alt+i')
  await floatBtn(page).click()

  const title = await page.locator('.inspector-head .panel-title').boundingBox()
  const grab = { x: title!.x + 10, y: title!.y + 5 }
  await page.mouse.move(grab.x, grab.y)
  await page.mouse.down()
  // Up and left, so the grow below still has window to spare. The float follows
  // the pointer, not the element's corner, so the delta is measured from the grab.
  await page.mouse.move(grab.x - 220, grab.y - 80, { steps: 5 })
  await page.mouse.up()
  const moved = await inspector(page).boundingBox()
  expect(moved!.x).toBeCloseTo(FLOATED.x - 220, 0)
  expect(moved!.y).toBeCloseTo(FLOATED.y - 80, 0)
  expect(moved!.width).toBeCloseTo(FLOATED.width, 0)

  // Dragged above the row it came out of — and `boundingBox` reports a box whether
  // or not it is painted, so ask what is actually under the pointer there.
  // `.main-content` clips its overflow, and a fixed box escapes that clip only
  // because no ancestor of it transforms, filters or will-changes. If someone
  // adds one, the float starts silently losing whatever sticks out.
  const row = await page.locator('.main-content').boundingBox()
  expect(moved!.y).toBeLessThan(row!.y)
  expect(
    await page.evaluate(
      ([x, y]) => !!document.elementFromPoint(x, y)?.closest('.inspector'),
      [moved!.x + 100, row!.y - 8],
    ),
  ).toBe(true)

  const se = await page.locator('.inspector.is-floating .fw-rh-se').boundingBox()
  await page.mouse.move(se!.x + 4, se!.y + 4)
  await page.mouse.down()
  await page.mouse.move(se!.x + 60, se!.y + 40, { steps: 5 })
  await page.mouse.up()
  const grown = await inspector(page).boundingBox()
  expect(grown!.width).toBeCloseTo(FLOATED.width + 56, 0)
  expect(grown!.height).toBeCloseTo(FLOATED.height + 36, 0)
  // A corner grip moves the far edges only.
  expect(grown!.x).toBeCloseTo(moved!.x, 0)
  expect(grown!.y).toBeCloseTo(moved!.y, 0)
})

test('docking to the other edge reorders the row without an unmount', async ({ page }) => {
  await boot(page)
  await page.keyboard.press('Control+Alt+i')
  const right = await inspector(page).boundingBox()
  expect(right!.x + right!.width).toBeCloseTo(1440, 0)

  await sideBtn(page, 'Dock to the left').click()
  await expect(inspector(page)).toHaveClass(/is-left/)
  await expect(inspector(page)).toHaveCSS('position', 'relative')

  // nav | inspector | workspace. The nav column keeps its claim on the window
  // edge — the convention it has on both sides — so the column moves inside it
  // rather than in front of it.
  const nav = await page.locator('.sidebar-container').boundingBox()
  const insp = await inspector(page).boundingBox()
  const work = await page.locator('.terminal-area').boundingBox()
  expect(nav!.x).toBeCloseTo(0, 0)
  expect(insp!.x).toBeGreaterThanOrEqual(nav!.x + nav!.width - 1)
  expect(work!.x).toBeGreaterThanOrEqual(insp!.x + insp!.width - 1)
  expect(insp!.x + insp!.width).toBeLessThan(1440)

  // The seam mirrors with the column: the grab zone is now its right edge. Within
  // the 1px border, since an absolutely positioned child resolves against the
  // padding box.
  const g = await grip(page).boundingBox()
  expect(Math.abs(g!.x + g!.width - (insp!.x + insp!.width))).toBeLessThanOrEqual(2)

  await page.evaluate(() => {
    ;(document.querySelector('.netscan-panel') as HTMLElement).dataset.probe = 'mounted'
  })
  await sideBtn(page, 'Dock to the right').click()
  await expect(inspector(page)).not.toHaveClass(/is-left/)
  await expect(page.locator('.netscan-panel')).toHaveJSProperty('dataset.probe', 'mounted')
  const back = await inspector(page).boundingBox()
  expect(back!.x + back!.width).toBeCloseTo(1440, 0)
})

test('the chosen edge is persisted layout, the float is not', async ({ page }) => {
  await boot(page)
  await page.keyboard.press('Control+Alt+i')
  // `save_layout` is debounced 400ms, so let the visibility write land before
  // counting — otherwise the assertion below races it.
  await page.waitForTimeout(600)
  const before = await saveLayoutCalls(page)
  expect(before).toBeGreaterThan(0)

  // Popping out writes nothing: a restart that restored "floating" would reopen the
  // column at a default spot rather than where the user left it.
  await floatBtn(page).click()
  await page.waitForTimeout(600)
  expect(await saveLayoutCalls(page)).toBe(before)

  await sideBtn(page, 'Dock to the left').click()
  await expect
    .poll(async () => (await savedInspector(page)).side, {
      message: 'the edge reaches layout.json',
    })
    .toBe('left')
  expect((await savedInspector(page)).visible).toBe(true)
})

test('picking an edge while floated docks it to that edge', async ({ page }) => {
  await boot(page)
  await page.keyboard.press('Control+Alt+i')
  await floatBtn(page).click()
  await expect(inspector(page)).toHaveClass(/is-floating/)

  await sideBtn(page, 'Dock to the left').click()
  await expect(inspector(page)).toHaveClass(/is-left/)
  await expect(inspector(page)).not.toHaveClass(/is-floating/)
  await expect(inspector(page)).toHaveCSS('position', 'relative')
  await expect(floatGrips(page)).toHaveCount(0)
  await expect(grip(page)).toHaveCount(1)
})

test('closing clears the float, so reopening lands back in the row', async ({ page }) => {
  await boot(page)
  await page.keyboard.press('Control+Alt+i')
  await floatBtn(page).click()

  await head(page).locator('.icon-btn.x').click()
  await expect(inspector(page)).toHaveCount(0)

  await page.keyboard.press('Control+Alt+i')
  await expect(inspector(page)).toBeVisible()
  await expect(inspector(page)).toHaveCSS('position', 'relative')
  await expect(floatGrips(page)).toHaveCount(0)
})

test('Esc leaves a float where it is, as it leaves every other floatable', async ({ page }) => {
  // Deliberate. No float in this app closes on Escape — a document-level binding
  // would also steal the shell's interrupt key from the terminal. The parity the
  // phase table asks for is this: the floated column behaves like the popped-out
  // panes, which means no special Esc handling in either direction.
  await boot(page)
  await page.keyboard.press('Control+Alt+i')
  await floatBtn(page).click()
  await page.keyboard.press('Escape')
  await expect(inspector(page)).toHaveClass(/is-floating/)
  await expect(inspector(page)).toBeVisible()
})

/** How many times the app wrote the layout — debounced, so read it around a wait. */
async function saveLayoutCalls(page: Page): Promise<number> {
  return (await invokedCalls(page)).filter((c) => c.cmd === 'save_layout').length
}

/** The `inspector` object of the layout last handed to `save_layout`. */
async function savedInspector(page: Page) {
  const calls = (await invokedCalls(page)).filter((c) => c.cmd === 'save_layout')
  const raw = calls.at(-1)?.args.layout
  return raw ? JSON.parse(raw as string).inspector : {}
}

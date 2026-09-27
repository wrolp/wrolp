import { test, expect, type Page } from '@playwright/test'
import { installTauriMock, type MockConnection } from './helpers/tauriMock'

// The terminal↔inspector seam: which cursor it shows, and how wide the hover
// highlight is. Both are the two tweaks the user iterated on here, and neither is
// visible to a screenshot-based review at 5px, so they are pinned instead.
//
// On the cursor: the drag used to flip the glyph on its own, because the shared
// `body.resize-h` / `resize-col` overrides are `!important` and apply to every
// element under the pointer, so whichever one the handler picks has to be the one
// the resting rule uses. (This seam asked for `col-resize` first and was reversed
// on 2026-09-27; the drawer's divider is the only one still on the barred glyph.)

const CONNS: MockConnection[] = [
  { id: 'c1', name: 'prod-web-01', host: '10.0.0.11', port: 22, username: 'app' },
]

async function boot(page: Page) {
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  await installTauriMock(page, { connections: CONNS })
  await page.goto('/')
  await page.getByRole('button', { name: /^(Open|Close) inspector$/ }).click()
  await expect(page.locator('.inspector')).toBeVisible()
}

/** What cursor the OS would actually paint at a point, after every cascade. */
function cursorAt(page: Page, x: number, y: number) {
  return page.evaluate(
    ([px, py]) => getComputedStyle(document.elementFromPoint(px, py)!).cursor,
    [x, y],
  )
}

test('hovering the column edge gives the plain arrow cursor', async ({ page }) => {
  await boot(page)
  const grip = await page.locator('.inspector > .inspector-resize').boundingBox()
  expect(grip).not.toBeNull()

  const resting = await cursorAt(page, grip!.x + grip!.width / 2, grip!.y + 120)
  expect(resting).toBe('ew-resize')
  // The barbed column glyph is what the user rejected, so pin that it is gone rather
  // than only that the arrow is there.
  expect(resting).not.toBe('col-resize')
})

test('the cursor stays the same arrow through the whole drag', async ({ page }) => {
  await boot(page)
  const grip = await page.locator('.inspector > .inspector-resize').boundingBox()
  expect(grip).not.toBeNull()

  const y = grip!.y + 120
  await page.mouse.move(grip!.x + grip!.width / 2, y)
  await page.mouse.down()
  // Mid-drag the pointer is far from the grip, over the terminal area — the body
  // class is what keeps the cursor stable there.
  await page.mouse.move(grip!.x - 120, y, { steps: 5 })
  expect(await cursorAt(page, grip!.x - 120, y)).toBe('ew-resize')

  await page.mouse.up()
  // The override is gone once the gesture ends, so the terminal keeps its own
  // pointer instead of inheriting a resize cursor.
  expect(await cursorAt(page, grip!.x - 120, y)).not.toBe('ew-resize')
})

test('the hover highlight is half the grab strip, not the whole hit area', async ({ page }) => {
  await boot(page)
  const grip = page.locator('.inspector > .inspector-resize')

  const seam = await grip.evaluate((el) => ({
    strip: Number.parseFloat(getComputedStyle(el).width),
    line: Number.parseFloat(getComputedStyle(el, '::after').width),
    resting: getComputedStyle(el, '::after').backgroundColor,
  }))
  expect(seam.strip).toBeGreaterThan(0)
  expect(seam.line).toBe(seam.strip / 2)

  await grip.hover()
  expect(await grip.evaluate((el) => getComputedStyle(el, '::after').backgroundColor)).not.toBe(
    seam.resting,
  )
})

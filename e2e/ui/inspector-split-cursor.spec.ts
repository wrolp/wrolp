import { test, expect, type Page } from '@playwright/test'
import { installTauriMock, type MockConnection } from './helpers/tauriMock'

// The terminal↔inspector seam must read as a *column* resize — the double-bar
// cursor Windows draws for `col-resize` — both when the pointer rests on it and
// while it is being dragged. The drag used to flip to `ew-resize`, because the
// shared `body.resize-h` override (written for the sidebar's divider) is
// `!important` and applies to every element under the pointer.

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

test('hovering the column edge gives the double-bar cursor', async ({ page }) => {
  await boot(page)
  const grip = await page.locator('.inspector > .inspector-resize').boundingBox()
  expect(grip).not.toBeNull()

  expect(await cursorAt(page, grip!.x + grip!.width / 2, grip!.y + 120)).toBe('col-resize')
})

test('the cursor stays a column resize through the whole drag', async ({ page }) => {
  await boot(page)
  const grip = await page.locator('.inspector > .inspector-resize').boundingBox()
  expect(grip).not.toBeNull()

  const y = grip!.y + 120
  await page.mouse.move(grip!.x + grip!.width / 2, y)
  await page.mouse.down()
  // Mid-drag the pointer is far from the grip, over the terminal area — the body
  // class is what keeps the cursor stable there.
  await page.mouse.move(grip!.x - 120, y, { steps: 5 })
  expect(await cursorAt(page, grip!.x - 120, y)).toBe('col-resize')

  await page.mouse.up()
  // The override is gone once the gesture ends, so the terminal keeps its own
  // pointer instead of inheriting a resize cursor.
  expect(await cursorAt(page, grip!.x - 120, y)).not.toBe('col-resize')
})

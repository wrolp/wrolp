import { test, expect, type Page } from './helpers/fixtures'
import { installTauriMock } from './helpers/tauriMock'

// The popped-out ("floated") terminal window resizes from every edge and corner.
// It used to expose only a single bottom-right grip, so this guards the 8-way
// resize and the N/W edges that also move the window origin.

const DEMO_CONN = { id: 'c1', name: 'Demo', host: 'demo.local', port: 22, username: 'root' }

async function openFloat(page: Page) {
  await installTauriMock(page, {
    connections: [DEMO_CONN],
    pollOutputChunks: [['root@demo:~$ ']],
  })
  await page.goto('/')
  await page.locator('.connection-item').click()
  await expect(page.locator('.term-pane')).toHaveCount(1)
  await page.locator('.term-pane-float').click()
  await expect(page.locator('.floating-window')).toBeVisible()
}

const DELTA = 60

// Drag every grip INWARD so the window shrinks and stays on-screen. `dw`/`dh`
// are the expected size deltas (negative when shrinking).
const cases: { dir: string; dx: number; dy: number; dw: number; dh: number }[] = [
  { dir: 'n', dx: 0, dy: DELTA, dw: 0, dh: -DELTA },
  { dir: 's', dx: 0, dy: -DELTA, dw: 0, dh: -DELTA },
  { dir: 'e', dx: -DELTA, dy: 0, dw: -DELTA, dh: 0 },
  { dir: 'w', dx: DELTA, dy: 0, dw: -DELTA, dh: 0 },
  { dir: 'ne', dx: -DELTA, dy: DELTA, dw: -DELTA, dh: -DELTA },
  { dir: 'nw', dx: DELTA, dy: DELTA, dw: -DELTA, dh: -DELTA },
  { dir: 'se', dx: -DELTA, dy: -DELTA, dw: -DELTA, dh: -DELTA },
  { dir: 'sw', dx: DELTA, dy: -DELTA, dw: -DELTA, dh: -DELTA },
]

for (const c of cases) {
  test(`the ${c.dir} grip resizes the floating window`, async ({ page }) => {
    await openFloat(page)

    const grip = page.locator(`.fw-rh-${c.dir}`)
    await expect(grip).toHaveCount(1)
    const gb = (await grip.boundingBox())!
    const before = (await page.locator('.floating-window').boundingBox())!

    const cx = gb.x + gb.width / 2
    const cy = gb.y + gb.height / 2
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    await page.mouse.move(cx + c.dx, cy + c.dy, { steps: 6 })
    await page.mouse.up()

    const after = (await page.locator('.floating-window').boundingBox())!
    expect(Math.abs(after.width - before.width - c.dw)).toBeLessThanOrEqual(4)
    expect(Math.abs(after.height - before.height - c.dh)).toBeLessThanOrEqual(4)
  })
}

// Dragging the W (or N) edge must keep the OPPOSITE edge fixed — i.e. the window
// origin moves as the size changes, otherwise the whole window would slide.
test('the west grip keeps the right edge fixed', async ({ page }) => {
  await openFloat(page)
  const grip = page.locator('.fw-rh-w')
  const gb = (await grip.boundingBox())!
  const before = (await page.locator('.floating-window').boundingBox())!

  const cx = gb.x + gb.width / 2
  const cy = gb.y + gb.height / 2
  await page.mouse.move(cx, cy)
  await page.mouse.down()
  await page.mouse.move(cx + DELTA, cy, { steps: 6 })
  await page.mouse.up()

  const after = (await page.locator('.floating-window').boundingBox())!
  // Right edge unchanged; left edge moved in by the drag.
  expect(Math.abs(after.x + after.width - (before.x + before.width))).toBeLessThanOrEqual(4)
  expect(Math.abs(after.x - (before.x + DELTA))).toBeLessThanOrEqual(4)
})

// The bottom-right grip used to paint a diagonal "corner" triangle; it is now
// invisible like every other grip.
test('the resize grips paint no visible marker', async ({ page }) => {
  await openFloat(page)
  const bg = await page
    .locator('.fw-rh-se')
    .evaluate((el) => getComputedStyle(el).backgroundImage)
  expect(bg).toBe('none')
})

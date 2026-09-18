import { test, expect, type Page } from './helpers/fixtures'
import { installTauriMock } from './helpers/tauriMock'

// The floating command list supports 8-way resize. The handles used to be
// children of `.cmd-list-panel`, which has `overflow: hidden` — that clipped
// their outward halves, so only the bottom-right corner was actually grabbable
// and the panel "could only be resized from the bottom-right". The handles now
// live on the un-clipped `.cmd-list-float` wrapper, so every edge and corner
// must resize the panel.

const DEMO_CONN = { id: 'c1', name: 'Demo', host: 'demo.local', port: 22, username: 'root' }

const DEMO_SNIPPET = {
  id: 's1',
  alias: null,
  command: 'echo hi',
  description: null,
  favorite: false,
  hidden: false,
  sortOrder: 0,
  connectionId: null,
  groupName: null,
  params: [],
  options: [],
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-08-01T00:00:00Z',
}

async function openPanel(page: Page) {
  await installTauriMock(page, { connections: [DEMO_CONN], commandSnippets: [DEMO_SNIPPET] })
  await page.goto('/')
  await page.locator('.connection-item').first().click()
  await expect(page.locator('.tab-item')).toContainText('Demo')
  await page.waitForSelector('.xterm-helper-textarea', { state: 'attached' })
  await page.keyboard.press('Control+Shift+p')
  await expect(page.locator('.cmd-list-float')).toBeVisible()
}

const DELTA = 60

// Drag every handle INWARD so the panel shrinks and always stays on-screen.
// `dw`/`dh` are the expected size deltas (both negative when shrinking).
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
  test(`the ${c.dir} handle resizes the panel`, async ({ page }) => {
    await openPanel(page)

    const handle = page.locator(`.cmd-list-rh-${c.dir}`)
    await expect(handle).toHaveCount(1)
    const hb = (await handle.boundingBox())!
    const before = (await page.locator('.cmd-list-panel').boundingBox())!

    const cx = hb.x + hb.width / 2
    const cy = hb.y + hb.height / 2
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    await page.mouse.move(cx + c.dx, cy + c.dy, { steps: 6 })
    await page.mouse.up()

    const after = (await page.locator('.cmd-list-panel').boundingBox())!
    expect(Math.abs(after.width - before.width - c.dw)).toBeLessThanOrEqual(4)
    expect(Math.abs(after.height - before.height - c.dh)).toBeLessThanOrEqual(4)
  })
}

// The handles straddle the panel border, so they must also be grabbable just
// OUTSIDE it — precisely the area `overflow: hidden` used to clip away.
test('an edge handle is grabbable just outside the panel border', async ({ page }) => {
  await openPanel(page)
  const before = (await page.locator('.cmd-list-panel').boundingBox())!

  // 1px above the top border (outside the panel box), where the `n` handle's
  // outward half lives.
  const x = before.x + before.width / 2
  const y = before.y - 1
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x, y + DELTA, { steps: 6 })
  await page.mouse.up()

  const after = (await page.locator('.cmd-list-panel').boundingBox())!
  expect(Math.abs(after.height - before.height + DELTA)).toBeLessThanOrEqual(4)
})

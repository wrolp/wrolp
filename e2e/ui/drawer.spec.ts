import { test, expect, type Page } from '@playwright/test'
import { installTauriMock, type MockConnection } from './helpers/tauriMock'

// P3-1: the bottom panel is now a drawer. What changed is *how* it changes size:
// the open/close is animated on the axis its dock puts it on, the collapsed strip
// shares the tab bar's height token, and the drag handles opt out of the
// animation (a smoothed drag is a lagging drag).

const CONNS: MockConnection[] = [
  { id: 'c1', name: 'prod-web-01', host: '10.0.0.11', port: 22, username: 'app' },
]

const drawer = (page: Page) => page.locator('.bottom-panel')

async function boot(page: Page, layout?: string) {
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  await installTauriMock(page, { connections: CONNS, layout })
  await page.goto('/')
}

/** The drawer's own height divider — the nav column has `.panel-divider-h` too,
 * but those live inside `.sidebar-container`. */
const heightDivider = (page: Page) => page.locator('.terminal-area > .panel-divider-h')

const styleOf = (page: Page, selector: string, prop: string) =>
  page.$eval(selector, (el, p) => getComputedStyle(el).getPropertyValue(p), prop)

test('opening the drawer animates its height, and reduced motion drops the animation', async ({
  page,
}) => {
  await boot(page)
  await page.keyboard.press('Control+j')
  await expect(drawer(page)).toHaveClass(/expanded/)

  expect(await styleOf(page, '.bottom-panel', 'transition-property')).toContain('height')
  expect(await styleOf(page, '.bottom-panel', 'transition-duration')).toContain('0.24s')

  await page.emulateMedia({ reducedMotion: 'reduce' })
  expect(await styleOf(page, '.bottom-panel', 'transition-duration')).not.toContain('0.24s')
})

test('dragging the drawer divider is not smoothed away from the pointer', async ({ page }) => {
  await boot(page, JSON.stringify({ bottomPanel: { visible: true, pos: 'bottom', size: 200 } }))
  // The drawer opens animated, so the divider is *moving* for the first few
  // hundred milliseconds. Grabbing its box before it settles makes the pointer
  // land where it used to be, which is a miss, not a drag.
  await expect(drawer(page)).toHaveCSS('height', '200px')
  const box = await heightDivider(page).boundingBox()
  expect(box).not.toBeNull()

  await page.mouse.move(box!.x + box!.width / 2, box!.y + 1)
  await page.mouse.down()
  expect(await styleOf(page, '.bottom-panel', 'transition-duration')).toBe('0s')

  await page.mouse.move(box!.x + box!.width / 2, box!.y - 60, { steps: 4 })
  const grown = await drawer(page).boundingBox()
  expect(grown!.height).toBeGreaterThan(200)

  await page.mouse.up()
  expect(await styleOf(page, '.bottom-panel', 'transition-duration')).toContain('0.24s')
})

test('the collapsed drawer is one band tall, on whichever side it is docked', async ({ page }) => {
  await boot(page, JSON.stringify({ bottomPanel: { visible: false, pos: 'bottom', size: 200 } }))
  const band = await styleOf(page, '.tab-bar', 'height')
  expect(await styleOf(page, '.bottom-panel', 'height')).toBe(band)

  // Re-dock to the right while collapsed: the strip must turn into a narrow
  // column. It used to stay 28px tall, which boxed it into a square.
  await page.keyboard.press('Control+Alt+j')
  const collapsed = await drawer(page).boundingBox()
  expect(collapsed!.width).toBeCloseTo(parseFloat(band), 0)
  expect(collapsed!.height).toBeGreaterThan(300)
})

test('the disclosure control is a button that reports its state', async ({ page }) => {
  await boot(page, JSON.stringify({ bottomPanel: { visible: false, pos: 'bottom', size: 200 } }))
  // Located by class, not by name: its accessible name is the action it offers
  // now, so it changes on every click.
  const toggle = page.locator('.drawer-toggle')
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')

  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(toggle).toHaveAccessibleName('Collapse')
  await expect(drawer(page)).toHaveClass(/expanded/)
})

import { test, expect } from './helpers/fixtures'
import { installTauriMock } from './helpers/tauriMock'

/**
 * A right-click menu must paint over the tooltip of the row it was opened on.
 *
 * The tooltip is the last surface in the app (10000) and lives in a portal on
 * <body>; a menu renders inline, inside the panel that owns the row — the sidebar
 * makes its own stacking context (z-index 60), so no `z-index` the menu carries
 * can climb out of it. Both halves of that are checked here: the menu takes the
 * rung above the tooltip, and the provider drops the tooltip as soon as a menu
 * exists, which is what actually wins inside a nested panel.
 */
const CONNS = [
  {
    id: 'c1',
    name: 'Web Server',
    host: '192.168.1.10',
    port: 22,
    username: 'root',
    description: 'Production web front end',
  },
]

test('the sidebar menu is not covered by the row tooltip', async ({ page }) => {
  await installTauriMock(page, { connections: CONNS })
  await page.goto('/')

  const row = page.locator('.connection-item').first()
  await row.hover()
  const tip = page.locator('.wl-tooltip')
  await expect(tip, 'the row title must become a tooltip first').toHaveAttribute(
    'data-visible',
    'true',
  )

  await row.click({ button: 'right' })
  const menu = page.locator('.context-menu')
  await expect(menu).toBeVisible()
  // The label describing the row gives way instead of sitting on top of the menu.
  await expect(tip).toHaveAttribute('data-visible', 'false')
  // The browser's own tooltip outranks every HTML layer, so the row's `title` must
  // stay off for as long as the menu lives — hiding the custom bubble is not enough.
  await expect(row, 'the row title must be suppressed while the menu is open').not.toHaveAttribute(
    'title',
  )

  // And the menu really is the top surface where the two could overlap.
  const z = await menu.evaluate((el) => Number(getComputedStyle(el).zIndex))
  expect(z, 'a menu outranks the tooltip (10000)').toBeGreaterThan(10000)
  const box = await menu.boundingBox()
  expect(box).not.toBeNull()
  const onTop = await page.evaluate(
    ({ x, y }) => document.elementFromPoint(x, y)?.closest('.context-menu') != null,
    { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 },
  )
  expect(onTop, 'the menu is what the pointer hits, not the tooltip').toBe(true)

  // Dismissing it puts the row's label back, so the suppression is not permanent.
  await page.mouse.click(120, 660)
  await page.mouse.move(140, 680)
  await expect(row).toHaveAttribute('title', 'Production web front end')
})

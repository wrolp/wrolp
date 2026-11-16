/**
 * Minimal mode's escape hatch: the exit button sits in the horizontal centre of
 * the top strip, not tucked into the left corner. The strip only reveals on
 * hover, so a centred button is what makes it findable by position.
 */
import { test, expect } from './helpers/fixtures'
import { installTauriMock } from './helpers/tauriMock'

test('the exit button is centred in the minimal-mode bar', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  await installTauriMock(page)
  await page.goto('/')

  await page.getByRole('button', { name: 'Minimal mode' }).click()
  const exit = page.locator('.minimal-exit')
  await expect(exit).toHaveCount(1)

  const box = await exit.boundingBox()
  expect(box).not.toBeNull()
  const viewport = await page.evaluate(() => window.innerWidth)
  // Centre within a pixel: absolute `left: 50%` + translate(-50%).
  expect(Math.abs(box!.x + box!.width / 2 - viewport / 2)).toBeLessThan(2)

  // The window controls keep the right edge; centring the exit button must not
  // drag them along.
  const controls = await page.locator('.minimal-window-controls').boundingBox()
  expect(controls).not.toBeNull()
  expect(viewport - (controls!.x + controls!.width)).toBeLessThan(4)
})

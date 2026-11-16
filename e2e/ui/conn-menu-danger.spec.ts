/**
 * Destructive context-menu items read red.
 *
 * `ctx-danger` is the menu's danger modifier (red label, red-tinted hover). The
 * connection and group menus carried their Delete actions as plain items, so a
 * slip on "Delete Group" looked exactly like "Rename Group".
 */
import { test, expect, type Page } from './helpers/fixtures'
import { selectRailMode } from './helpers/sections'
import { installTauriMock } from './helpers/tauriMock'

const DEMO_CONN = {
  id: 'c1',
  name: 'Demo',
  host: 'demo.local',
  port: 22,
  username: 'root',
  group: 'Network',
}

async function boot(page: Page) {
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  await installTauriMock(page, { connections: [DEMO_CONN] })
  await page.goto('/')
  await selectRailMode(page, 'hosts')
}

/** True for a colour whose red channel clearly dominates (the danger cue). */
function isReddish(colour: string): boolean {
  const nums = (colour.match(/[\d.]+/g) ?? []).map(Number)
  return nums.length >= 3 && nums[0] > nums[1] + 40 && nums[0] > nums[2] + 40
}

const itemColour = (page: Page, label: string) =>
  page
    .locator('.context-menu-item', { hasText: label })
    .evaluate((el) => getComputedStyle(el).color)

test('the group menu paints Delete Group red, unlike Rename Group', async ({ page }) => {
  await boot(page)
  await page.locator('.conn-group-header', { hasText: 'Network' }).click({ button: 'right' })
  await expect(page.locator('.context-menu')).toBeVisible()

  const del = await itemColour(page, 'Delete Group')
  const rename = await itemColour(page, 'Rename Group')
  expect(del).not.toBe(rename)
  expect(isReddish(del)).toBe(true)
  expect(isReddish(rename)).toBe(false)
})

test('the connection menu paints Delete red too', async ({ page }) => {
  await boot(page)
  await page.locator('.connection-item', { hasText: 'Demo' }).click({ button: 'right' })
  await expect(page.locator('.context-menu')).toBeVisible()

  const del = await itemColour(page, 'Delete')
  const duplicate = await itemColour(page, 'Duplicate Connection')
  expect(del).not.toBe(duplicate)
  expect(isReddish(del)).toBe(true)
  expect(isReddish(duplicate)).toBe(false)
})

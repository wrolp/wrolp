import { test, expect, type Page } from './helpers/fixtures'
import { installTauriMock } from './helpers/tauriMock'

// The New / Edit Connection dialog is a draggable floating window: no scrim,
// portaled to <body>, and above the floating command list.

const DEMO_CONN = {
  id: 'c1',
  name: 'Demo',
  host: 'demo.local',
  port: 22,
  username: 'root',
  group: 'Network',
}

async function boot(page: Page) {
  await installTauriMock(page, { connections: [DEMO_CONN], commandSnippets: [] })
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  await page.goto('/')
}

/** `fromWelcome` opens the hosts rail first; after connecting it is already up. */
async function openEditor(page: Page, fromWelcome = false) {
  if (fromWelcome) await page.getByRole('button', { name: 'New SSH connection' }).click()
  await page.locator('.conn-group-header', { hasText: 'Network' }).hover()
  await page.locator('.conn-group-add[title="Add connection to Network"]').click()
  await expect(page.locator('.conn-editor-modal')).toBeVisible()
}

test('the connection editor floats above the command list with no scrim', async ({ page }) => {
  await boot(page)
  // The command list needs a focused terminal to open.
  await page.locator('.connection-item').first().click()
  await page.waitForSelector('.xterm-helper-textarea', { state: 'attached' })
  await page.keyboard.press('Control+Shift+p')
  await expect(page.locator('.cmd-list-float')).toBeVisible()
  await openEditor(page)

  const layers = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement)
    const overlay = document.querySelector('.conn-editor-overlay') as HTMLElement
    const cs = getComputedStyle(overlay)
    return {
      float: Number(root.getPropertyValue('--z-float')),
      overlay: Number(cs.zIndex),
      background: cs.backgroundColor,
      pointerEvents: cs.pointerEvents,
      modalPointerEvents: getComputedStyle(overlay.querySelector('.modal')!).pointerEvents,
      portal: overlay.parentElement === document.body,
    }
  })
  expect(layers.portal).toBe(true)
  expect(layers.overlay).toBeGreaterThan(layers.float)
  // No mask: fully transparent, and the full-screen layer does not swallow
  // clicks meant for the app underneath.
  expect(layers.background).toBe('rgba(0, 0, 0, 0)')
  expect(layers.pointerEvents).toBe('none')
  expect(layers.modalPointerEvents).toBe('auto')
})

test('the connection editor can be dragged by its header', async ({ page }) => {
  await boot(page)
  await openEditor(page, true)

  const modal = page.locator('.conn-editor-modal')
  const header = modal.locator('.modal-header')
  const before = await modal.boundingBox()
  const hb = await header.boundingBox()
  if (!before || !hb) throw new Error('editor header is not measurable')

  await page.mouse.move(hb.x + 80, hb.y + hb.height / 2)
  await page.mouse.down()
  await page.mouse.move(hb.x + 170, hb.y + hb.height / 2 + 70, { steps: 8 })
  await page.mouse.up()

  const after = await modal.boundingBox()
  expect(after?.x).toBeGreaterThan(before.x + 60)
  expect(after?.y).toBeGreaterThan(before.y + 50)
})

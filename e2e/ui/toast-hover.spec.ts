import { test, expect, type Page } from './helpers/fixtures'
import { installTauriMock, pasteIntoTerminal } from './helpers/tauriMock'

// The toast at the top centre disappears on a timer, which is exactly wrong for
// an error long enough to still be under the cursor when it goes. Hovering now
// holds it; the window starts again once the pointer leaves.

const SERIAL_CONN = {
  id: 's1',
  name: 'Console',
  host: 'COM3',
  port: 0,
  username: '',
  kind: 'serial',
  portName: 'COM3',
  baudRate: 115200,
}

async function raiseError(page: Page) {
  await installTauriMock(page, { connections: [SERIAL_CONN] })
  await page.goto('/')
  await page.locator('.connection-item').click()
  await page.waitForSelector('.xterm-helper-textarea', { state: 'attached' })
  // A serial session has no line editor, so a multi-line paste is refused with a
  // notice — a real error string, long enough to need reading.
  await pasteIntoTerminal(page, 'line one\nline two')
  await expect(page.locator('.toast')).toContainText('Serial sessions do not support')
}

test('the message stays while the pointer is on it, then goes', async ({ page }) => {
  await raiseError(page)
  const toast = page.locator('.toast')
  await toast.hover()

  // Past the 3s window it would have had unheld.
  await page.waitForTimeout(3800)
  await expect(toast).toBeVisible()

  const box = await toast.boundingBox()
  await page.mouse.move(box!.x + box!.width / 2, box!.y + 200)
  await expect(toast).toBeHidden({ timeout: 6000 })
})

test('a message that arrives while the old one is held still times out', async ({ page }) => {
  // The hold is keyed to the message, not to a flag: otherwise a held toast would
  // hand its "never dismiss" state to whatever came next.
  await raiseError(page)
  const toast = page.locator('.toast')
  await toast.hover()
  await page.waitForTimeout(3800)
  await expect(toast).toBeVisible()

  await pasteIntoTerminal(page, 'another\nmulti-line')
  await expect(toast).toContainText('Serial sessions do not support')
  const box = await toast.boundingBox()
  await page.mouse.move(box!.x + box!.width / 2, box!.y + 200)
  await expect(toast).toBeHidden({ timeout: 6000 })
})

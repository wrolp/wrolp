import { test, expect } from './helpers/fixtures'
import { installTauriMock, invokedCalls } from './helpers/tauriMock'

// The pane header's record control used to be a bare 8px dot, which read as a
// status pip (the same shape the container list uses for "running"). It is now a
// ring-plus-hub record glyph, red while recording.

const DEMO_CONN = { id: 'c1', name: 'Demo', host: 'demo.local', port: 22, username: 'root' }

async function connect(page: import('@playwright/test').Page) {
  await installTauriMock(page, {
    connections: [DEMO_CONN],
    pollOutputChunks: [['root@demo:~$ ']],
  })
  await page.goto('/')
  await page.locator('.connection-item').first().click()
  await expect(page.locator('.terminal-split-root')).toBeVisible()
  return page.locator('.term-pane-record').first()
}

test('the record control is a button glyph, not a status pip', async ({ page }) => {
  const record = await connect(page)
  await expect(record).toBeVisible()

  // The old dot span is gone; the glyph is a ring plus its hub.
  await expect(page.locator('.term-pane-record-dot')).toHaveCount(0)
  await expect(record.locator('svg')).toHaveCount(1)
  await expect(record.locator('svg circle')).toHaveCount(2)
})

test('clicking it toggles recording and the active state', async ({ page }) => {
  const record = await connect(page)
  // The mock reports recording as on, so the control starts active.
  await expect(record).toHaveClass(/active/)

  await record.click()
  await expect(record).not.toHaveClass(/active/)
  await record.click()
  await expect(record).toHaveClass(/active/)

  const calls = (await invokedCalls(page))
    .filter((c) => c.cmd === 'set_recording_enabled')
    .map((c) => c.args.enabled)
  expect(calls).toEqual([false, true])
})

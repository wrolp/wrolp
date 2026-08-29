import { test, expect } from '@playwright/test'
import { installTauriMock, emitTauriEvent, invokedCommands } from './helpers/tauriMock'

// Terminal connect flow with a stubbed backend: clicking a connection opens a
// workspace tab whose Terminal component drives `connect` then polls
// `poll_output`. Output rendering is canvas-based (xterm.js), so we assert the
// backend interaction (invoke recording) rather than terminal text.

const DEMO_CONN = { id: 'c1', name: 'Demo', host: 'demo.local', port: 22, username: 'root' }

test('clicking a connection opens a tab and starts the SSH connect flow', async ({ page }) => {
  await installTauriMock(page, {
    connections: [DEMO_CONN],
    pollOutputChunks: [['root@demo:~$ '], ['ls\r\n']],
  })
  await page.goto('/')

  await page.locator('.connection-item').click()

  // Tab + pane header show the connection name.
  await expect(page.locator('.tab-item')).toContainText('Demo')
  await expect(page.locator('.term-pane-title')).toContainText('Demo')

  // The backend connect command must have been invoked.
  await expect
    .poll(async () => (await invokedCommands(page)).filter((c) => c === 'connect').length)
    .toBeGreaterThanOrEqual(1)

  // After connect succeeds the terminal polls output.
  await expect
    .poll(async () => (await invokedCommands(page)).filter((c) => c === 'poll_output').length)
    .toBeGreaterThanOrEqual(1)
})

test('connection-closed event stops the output polling loop', async ({ page }) => {
  await installTauriMock(page, { connections: [DEMO_CONN] })
  await page.goto('/')

  await page.locator('.connection-item').click()

  const pollCount = async () =>
    (await invokedCommands(page)).filter((c) => c === 'poll_output').length

  // Wait until the poll loop is actively running.
  await expect.poll(pollCount).toBeGreaterThan(3)

  // The first opened tab always gets tabId 1 (nextTabId starts at 1).
  await emitTauriEvent(page, 'connection-closed', { tabId: 1 })

  // Give any in-flight interval tick a chance to fire, then verify the loop
  // has stopped (count is stable across another interval).
  await page.waitForTimeout(250)
  const after = await pollCount()
  await page.waitForTimeout(250)
  expect(await pollCount()).toBe(after)
})

import { test, expect, type Page } from './helpers/fixtures'
import {
  installTauriMock,
  emitTauriEvent,
  invokedCalls,
  invokedCommands,
  type MockConnection,
} from './helpers/tauriMock'

// Connection-lifecycle feedback that the mocked backend can drive end-to-end:
// a failed serial open has to be visible, a saved tunnel has to flip between
// started/stopped, and `connection-closed` has to roll the tab back to a state
// the Reconnect button recovers from.

const SERIAL_CONN: MockConnection = {
  id: 's1',
  name: 'Console',
  host: 'COM9',
  port: 0,
  username: '',
  kind: 'serial',
  portName: 'COM9',
  baudRate: 115200,
}

const SSH_CONN: MockConnection = {
  id: 'c1',
  name: 'Web Server',
  host: '192.168.1.10',
  port: 22,
  username: 'root',
}

const TUNNEL_CONN: MockConnection = {
  ...SSH_CONN,
  id: 'c2',
  name: 'Bastion',
  tunnels: [
    {
      id: 't1',
      name: 'db',
      localAddr: '127.0.0.1',
      localPort: 5432,
      remoteHost: '10.0.0.9',
      remotePort: 5432,
    },
  ],
}

async function countInvoked(page: Page, cmd: string): Promise<number> {
  return (await invokedCommands(page)).filter((c) => c === cmd).length
}

test('a failed serial open reports the backend error instead of going green', async ({ page }) => {
  await installTauriMock(page, {
    connections: [SERIAL_CONN],
    // The port is busy: the real backend rejects `connect_serial` with this text.
    failCommands: { connect_serial: 'Access is denied (COM9 is in use)' },
  })
  await page.goto('/')

  await page.locator('.connection-item').click()
  await expect.poll(() => countInvoked(page, 'connect_serial')).toBeGreaterThan(0)

  // The tab is marked `error`, and the overlay carries the backend's reason —
  // the exact failure the previous silent path used to swallow.
  const placeholder = page.locator('.terminal-placeholder')
  await expect(placeholder).toBeVisible()
  await expect(placeholder).toContainText('Access is denied (COM9 is in use)')
})

test('a saved tunnel starts and stops from the sidebar tree', async ({ page }) => {
  await installTauriMock(page, { connections: [TUNNEL_CONN] })
  await page.goto('/')

  const row = page.locator('.conn-tunnel').filter({ hasText: '5432' })
  await expect(row).toBeVisible()
  await expect(row).not.toHaveClass(/active/)

  // No connected carrier tab yet, so this opens the SSH tab first and starts the
  // tunnel once that tab reports `connected` (the pending-start queue).
  await row.click()
  await expect.poll(() => countInvoked(page, 'start_tunnel')).toBeGreaterThan(0)
  await expect(row).toHaveClass(/active/)

  await row.locator('.conn-tunnel-toggle').click()
  await expect.poll(() => countInvoked(page, 'stop_tunnel')).toBeGreaterThan(0)
  await expect(row).not.toHaveClass(/active/)
})

test('connection-closed rolls the tab back and Reconnect starts a fresh session', async ({ page }) => {
  await installTauriMock(page, { connections: [SSH_CONN] })
  await page.goto('/')

  await page.locator('.connection-item').click()
  await expect.poll(() => countInvoked(page, 'connect')).toBeGreaterThan(0)

  const tabId = (await invokedCalls(page)).filter((c) => c.cmd === 'connect').at(-1)?.args
    .tabId as number
  expect(typeof tabId).toBe('number')

  // The backend reports the drop (with its reason) instead of the promise
  // rejecting — the path that used to leave the dot green.
  await emitTauriEvent(page, 'connection-closed', {
    tabId,
    reason: 'ssh: connection reset by peer',
  })
  const placeholder = page.locator('.terminal-placeholder')
  await expect(placeholder).toBeVisible()
  await expect(placeholder).toContainText('Connection lost')
  // The reason survives even though the backend clears the output queue before
  // emitting the event, because App renders it on the disconnected overlay.
  await expect(placeholder).toContainText('ssh: connection reset by peer')

  const before = await countInvoked(page, 'connect')
  await page.locator('.term-pane-reconnect').click()
  // The status flips to `connecting`, so the lost overlay goes away at once...
  await expect(placeholder).toHaveCount(0)
  // ...and a new session is opened (the reconnect trigger bumped).
  await expect.poll(() => countInvoked(page, 'connect')).toBeGreaterThan(before)
})

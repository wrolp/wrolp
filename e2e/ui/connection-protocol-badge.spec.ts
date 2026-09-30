import { test, expect } from './helpers/fixtures'
import { installTauriMock } from './helpers/tauriMock'

// The hosts rail used to draw the same link glyph on every connection, so an SSH
// server, a switch console and a serial bench were indistinguishable without
// reading the name. Each tile now carries its protocol abbreviation.

const CONNS = [
  { id: 'c1', name: 'prod-web-02', host: '10.0.12.32', port: 22, username: 'root' },
  { id: 'c2', name: 'gw-telnet', host: '192.168.8.1', port: 23, username: 'admin', kind: 'telnet' },
  {
    id: 'c3',
    name: 'serial bench',
    host: 'COM3',
    port: 0,
    username: '',
    kind: 'serial',
    portName: 'COM3',
    baudRate: 115200,
  },
]

test('each connection tile says which protocol it is', async ({ page }) => {
  await installTauriMock(page, { connections: CONNS })
  await page.goto('/')

  const badge = (name: string) =>
    page.locator('.connection-item', { hasText: name }).locator('.conn-icon')
  await expect(badge('prod-web-02')).toHaveText('SSH')
  await expect(badge('gw-telnet')).toHaveText('TEL')
  await expect(badge('serial bench')).toHaveText('COM')
  // The hue still separates them for anyone reading the column by colour.
  const hue = (name: string) => badge(name).evaluate((el) => getComputedStyle(el).color)
  expect(await hue('prod-web-02')).not.toBe(await hue('gw-telnet'))
  expect(await hue('gw-telnet')).not.toBe(await hue('serial bench'))
})

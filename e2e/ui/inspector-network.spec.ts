import { test, expect, type Page } from './helpers/fixtures'
import {
  installTauriMock,
  resolvePendingScan,
  invokedCalls,
  type TauriMockOptions,
} from './helpers/tauriMock'

// P3-3: the subnet scan as the inspector's fourth tab.
//
// It used to be a modal mounted by the nav column, which meant the one thing you
// do with a scan — watch the host you just found in the shell next to it — was
// impossible while it ran: `scan_network` streams `scan-progress` for as long as
// the CIDR does, and the overlay covered the terminal for all of it.
//
// So these cases are mostly about the overlay *not* being there, and about the
// panel keeping its accumulated rows when it is hidden rather than unmounted.

const CONNS = [
  { id: 'c1', name: 'prod-web-01', host: '10.0.0.11', port: 22, username: 'app', group: 'prod' },
]

const SSH_ROW = {
  ip: '10.0.0.21',
  port: 22,
  open: true,
  service: 'ssh',
  banner: 'SSH-2.0-OpenSSH_9.6',
  latencyMs: 12,
}
const TELNET_ROW = { ip: '10.0.0.22', port: 23, open: true, service: 'telnet', latencyMs: 40 }
// Closed probes must never reach the list — the modal showed them in a table with
// an empty "Open" cell, which read like a rendering bug.
const CLOSED_ROW = { ip: '10.0.0.23', port: 22, open: false, service: 'unknown' }

async function boot(page: Page, extra: TauriMockOptions = {}) {
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  await installTauriMock(page, {
    connections: CONNS,
    pollOutputChunks: [['app@prod-web-01:~$ ']],
    ...extra,
  })
  await page.goto('/')
  await page.locator('.connection-item').click()
  await expect(page.locator('.tab-item')).toHaveCount(1)
}

const tabBtns = (page: Page) => page.locator('.inspector-tabs .tab-btn')
const networkTab = (page: Page) => tabBtns(page).nth(3)
const panel = (page: Page) => page.locator('.netscan-panel')

test('the nav column opens the scan as a column tab and leaves the terminal alone', async ({
  page,
}) => {
  await boot(page)
  await expect(page.locator('.inspector')).toHaveCount(0)

  await page.getByRole('button', { name: 'Scan Network' }).click()

  await expect(networkTab(page)).toHaveAttribute('aria-selected', 'true')
  await expect(panel(page)).toBeVisible()
  // The whole point of the change: no overlay between you and the shell.
  await expect(page.locator('.modal-overlay')).toHaveCount(0)
  await expect(page.locator('.scan-dialog')).toHaveCount(0)
  await expect(page.locator('.terminal-split-root')).toBeVisible()
})

test('rows come from the scan-progress events and closed probes are dropped', async ({ page }) => {
  await boot(page, { scanResults: [SSH_ROW, TELNET_ROW, CLOSED_ROW], scanHold: true })
  await page.getByRole('button', { name: 'Scan Network' }).click()
  await panel(page).locator('#netscan-target').fill('10.0.0.0/24')
  await panel(page).getByRole('button', { name: 'Start Scan' }).click()

  // Still in flight — the promise is held — and the read-out says so.
  await expect(panel(page).getByRole('button', { name: 'Scanning…' })).toBeVisible()
  await expect(page.locator('.scan-progress')).toBeVisible()
  // The progress counter is *probes*, so it counts the closed host too; only the
  // result list filters. Mixing the two up would report a scan that missed a host.
  await expect(page.locator('.scan-progress')).toContainText('3/3 probed')

  await expect(page.locator('.scan-item')).toHaveCount(2)
  await expect(page.locator('.scan-item-addr')).toHaveText(['10.0.0.21:22', '10.0.0.22:23'])
  await expect(page.locator('.scan-results-count')).toHaveText('2')
  // The banner is the one field that needs the column's full width, so it gets a
  // line to itself rather than a seventh table cell.
  await expect(page.locator('.scan-banner')).toHaveText(['SSH-2.0-OpenSSH_9.6'])

  await resolvePendingScan(page)
  await expect(page.locator('.scan-progress')).toHaveCount(0)
  await expect(panel(page).getByRole('button', { name: 'Start Scan' })).toBeEnabled()
})

test('switching inspector tabs keeps the scan and its results mounted', async ({ page }) => {
  await boot(page, { scanResults: [SSH_ROW] })
  await page.getByRole('button', { name: 'Scan Network' }).click()
  await panel(page).locator('#netscan-target').fill('10.0.0.21')
  await panel(page).getByRole('button', { name: 'Start Scan' }).click()
  await expect(page.locator('.scan-item')).toHaveCount(1)

  // Hiding is not closing: a scan that found something is worth coming back to,
  // and an unmount would throw the accumulated rows away.
  await page.evaluate(() => {
    ;(document.querySelector('.netscan-panel') as HTMLElement).dataset.probe = 'mounted'
  })
  await tabBtns(page).nth(0).click()
  await expect(panel(page)).toBeHidden()
  await expect(page.locator('.host-analysis-panel')).toBeVisible()
  await expect(page.locator('.netscan-panel')).toHaveCount(1)

  await tabBtns(page).nth(3).click()
  await expect(panel(page)).toBeVisible()
  await expect(panel(page)).toHaveJSProperty('dataset.probe', 'mounted')
  await expect(page.locator('.scan-item')).toHaveCount(1)
})

test('adding a result saves a connection that matches the probe', async ({ page }) => {
  await boot(page, { scanResults: [SSH_ROW, TELNET_ROW] })
  await page.getByRole('button', { name: 'Scan Network' }).click()
  await panel(page).locator('#netscan-target').fill('10.0.0.0/24')
  await panel(page).locator('#netscan-group').selectOption('prod')
  await panel(page).getByRole('button', { name: 'Start Scan' }).click()

  await page.locator('.scan-item').first().getByRole('button', { name: 'Add' }).click()
  await expect(page.locator('.scan-added')).toHaveCount(1)

  const saved = (await invokedCalls(page)).filter((c) => c.cmd === 'save_connection')
  expect(saved).toHaveLength(1)
  expect(saved[0].args.config).toMatchObject({
    host: '10.0.0.21',
    port: 22,
    username: 'root',
    kind: 'ssh',
    group: 'prod',
  })

  // Telnet probes come back with no user to guess for them.
  await page.locator('.scan-item').nth(1).getByRole('button', { name: 'Add' }).click()
  const telnet = (await invokedCalls(page))
    .filter((c) => c.cmd === 'save_connection')
    .map((c) => c.args.config as Record<string, unknown>)
    .at(-1)
  expect(telnet).toMatchObject({ host: '10.0.0.22', port: 23, username: '', kind: 'telnet' })
})

test('Add All is dead until the scan found something', async ({ page }) => {
  await boot(page, { scanResults: [] })
  await page.getByRole('button', { name: 'Scan Network' }).click()
  const addAll = panel(page).getByRole('button', { name: 'Add All' })
  await expect(addAll).toBeDisabled()
  await expect(page.locator('.scan-empty')).toBeVisible()

  await panel(page).getByRole('button', { name: 'Start Scan' }).click()
  await expect(panel(page).locator('#netscan-target')).toHaveValue('')
  await expect(page.locator('.scan-error')).toHaveText('Please enter a target to scan')
})

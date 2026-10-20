import { test, expect, type Page } from './helpers/fixtures'
import { installTauriMock, invokedCalls, type MockConnection } from './helpers/tauriMock'

// The welcome page's host card. It used to render `connections.slice(0, 4)` — the
// first four *saved* connections in sidebar drag order — so it was a slightly worse
// copy of the sidebar rather than a way back into the hosts you actually use.

const BASE: MockConnection[] = [
  { id: 'c1', name: 'Web', host: '192.168.1.10', port: 22, username: 'root' },
  { id: 'c2', name: 'DB', host: '10.0.0.5', port: 22, username: 'admin' },
  { id: 'c3', name: 'Gw', host: '192.168.8.1', port: 23, username: 'admin', kind: 'telnet' },
  {
    id: 'c4',
    name: 'Bench',
    host: 'COM3',
    port: 0,
    username: '',
    kind: 'serial',
    portName: 'COM3',
    baudRate: 115200,
  },
]

/** A saved local-terminal entry, as the sidebar's 本地 section stores it. */
const LT = { id: 'lt-1', name: 'Bash', cwd: '/var/www', shell: 'bash' }

/** The two recency cards, and the row lists inside them. Local and remote are
 *  separate lists now, each with its own configured cap. */
const remoteCard = (page: Page) => page.locator('[data-testid="welcome-recent-remote"]')
const localCard = (page: Page) => page.locator('[data-testid="welcome-recent-local"]')
const remoteRows = (page: Page) => remoteCard(page).locator('.welcome-list li')
const localRows = (page: Page) => localCard(page).locator('.welcome-list li')
const times = (page: Page) => remoteCard(page).locator('.wl-when')

/** English throughout: the relative-time strings are asserted literally, and the
 *  app otherwise falls back to the browser locale. */
async function boot(page: Page, opts: Parameters<typeof installTauriMock>[1]) {
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  await installTauriMock(page, opts)
  await page.goto('/')
}

test('orders the card by when each host was last connected to', async ({ page }) => {
  const now = Date.now()
  await boot(page, {
    connections: BASE,
    // Deliberately the reverse of the saved order, and skipping c2 entirely, so a
    // pass can only come from reading the timestamps.
    recentConnections: [
      { connectionId: 'c3', usedAtMs: now - 60_000 },
      { connectionId: 'c1', usedAtMs: now - 7_200_000 },
    ],
  })

  await expect(remoteRows(page)).toHaveCount(2)
  await expect(remoteCard(page).locator('.wl-name')).toHaveText(['Gw', 'Web'])
})

test('falls back to the first saved hosts when there is no history yet', async ({ page }) => {
  await boot(page, { connections: BASE })

  await expect(remoteRows(page)).toHaveCount(4)
  await expect(remoteCard(page).locator('.wl-name')).toHaveText(['Web', 'DB', 'Gw', 'Bench'])
  // Fallback rows carry no usage record, so they show no timestamp.
  await expect(times(page)).toHaveCount(0)
})

test('caps each list instead of scrolling it', async ({ page }) => {
  const many: MockConnection[] = Array.from({ length: 12 }, (_, i) => ({
    id: `c${i}`,
    name: `Host ${i}`,
    host: `10.0.0.${i + 1}`,
    port: 22,
    username: 'root',
  }))
  await boot(page, { connections: many })

  // The default cap is ten rows per list; the twelfth host is simply not shown.
  await expect(remoteRows(page)).toHaveCount(10)
  // The cap is a cap: nothing in the card scrolls.
  await expect(remoteCard(page).locator('.welcome-list')).toHaveCSS('overflow-y', 'visible')
})

test('drops a recency row whose connection no longer exists', async ({ page }) => {
  const now = Date.now()
  await boot(page, {
    connections: BASE,
    recentConnections: [
      { connectionId: 'deleted-host', usedAtMs: now - 1000 },
      { connectionId: 'c2', usedAtMs: now - 2000 },
    ],
  })

  await expect(remoteRows(page)).toHaveCount(1)
  await expect(remoteCard(page).locator('.wl-name')).toHaveText(['DB'])
  await expect(remoteCard(page).locator('.welcome-list')).not.toContainText('deleted-host')
})

test('each row says which protocol it is and when it was used', async ({ page }) => {
  // Freeze the clock so "just now" cannot drift into "1 min ago" mid-assert.
  const now = Date.now()
  await page.addInitScript((t) => {
    Date.now = () => t
  }, now)
  await boot(page, {
    connections: BASE,
    recentConnections: [
      { connectionId: 'c1', usedAtMs: now - 30_000 },
      { connectionId: 'c3', usedAtMs: now - 3 * 3_600_000 },
      // Past a week the helper switches to an absolute date, whose exact text is
      // the browser's to choose — so only the shape is asserted.
      { connectionId: 'c4', usedAtMs: now - 20 * 86_400_000 },
    ],
  })

  const row = (name: string) => remoteCard(page).locator('.welcome-list li', { hasText: name })
  await expect(row('Web').locator('.wl-proto')).toHaveText('SSH')
  await expect(row('Gw').locator('.wl-proto')).toHaveText('TEL')
  await expect(row('Bench').locator('.wl-proto')).toHaveText('COM')

  // The hue still separates them for anyone reading the column by colour.
  const hue = (name: string) =>
    row(name)
      .locator('.wl-proto')
      .evaluate((el) => getComputedStyle(el).color)
  expect(await hue('Web')).not.toBe(await hue('Gw'))

  await expect(times(page)).toHaveText(['just now', '3 h ago', /^\d{2}\/\d{2}$/])
  // A serial connection reads as a port and a baud rate, not `COM3:0`.
  await expect(row('Bench').locator('.wl-sub')).toHaveText('COM3 @ 115200')
})

test('clicking a row opens that connection', async ({ page }) => {
  await boot(page, {
    connections: BASE,
    recentConnections: [{ connectionId: 'c3', usedAtMs: Date.now() - 1000 }],
  })

  await remoteCard(page).locator('.welcome-list li', { hasText: 'Gw' }).locator('button').click()

  // A Telnet connection reaches the backend as `connect_telnet` (not `connect`),
  // dispatched once the terminal pane mounts rather than on the click. That the
  // right command fired at all is the assertion: an SSH tab would feed the
  // hostname to russh instead.
  await expect
    .poll(async () => (await invokedCalls(page)).filter((c) => c.cmd === 'connect_telnet').length)
    .toBeGreaterThanOrEqual(1)
  const call = (await invokedCalls(page)).find((c) => c.cmd === 'connect_telnet')!
  expect(JSON.stringify(call.args)).toContain('"id":"c3"')
})

test('connecting to a host records its use', async ({ page }) => {
  await boot(page, { connections: BASE, pollOutputChunks: [['root@web:~$ ']] })

  await page.locator('.connection-item', { hasText: 'Web' }).click()

  // The write is what puts this host at the top of the card next time.
  await expect
    .poll(async () => (await invokedCalls(page)).filter((c) => c.cmd === 'record_connection_used'))
    .toEqual([{ cmd: 'record_connection_used', args: { connectionId: 'c1' } }])
})

test('a local shell is recorded as a local terminal, not as a connection', async ({ page }) => {
  await boot(page, { connections: BASE, localTerminals: [LT] })

  // The built-in "open local shell" row: a tab with no `connectionId`, so the
  // connection write must stay untouched rather than fire against "".
  await page.locator('.conn-item.local-term-item').first().click()

  await expect
    .poll(async () => (await invokedCalls(page)).filter((c) => c.cmd === 'record_connection_used'))
    .toEqual([])
  await expect
    .poll(async () =>
      (await invokedCalls(page)).filter((c) => c.cmd === 'record_local_terminal_used'),
    )
    .toEqual([{ cmd: 'record_local_terminal_used', args: { entryId: '__default__' } }])
})

test('a saved local terminal is recorded under its own entry', async ({ page }) => {
  await boot(page, { connections: BASE, localTerminals: [LT] })

  await page.locator('.conn-item.local-term-item').filter({ hasText: LT.name }).click()

  await expect
    .poll(async () =>
      (await invokedCalls(page)).filter((c) => c.cmd === 'record_local_terminal_used'),
    )
    .toEqual([{ cmd: 'record_local_terminal_used', args: { entryId: LT.id } }])
})

test('recent local terminals are listed on the card and reopen their entry', async ({ page }) => {
  const now = Date.now()
  await boot(page, {
    connections: BASE,
    localTerminals: [LT],
    recentConnections: [
      // Newest first, and a host below it, so a local row has to be resolved
      // against the local-terminal list rather than the connections.
      { connectionId: `local:${LT.id}`, usedAtMs: now - 60_000, kind: 'localTerminal' },
      { connectionId: 'local:__default__', usedAtMs: now - 120_000, kind: 'localTerminal' },
      { connectionId: 'c1', usedAtMs: now - 7_200_000 },
    ],
  })

  // The two lists are independent: the local rows stay on their own card, the
  // host stays on the remote one, and each card keeps its own ordering.
  await expect(localRows(page)).toHaveCount(2)
  await expect(remoteRows(page)).toHaveCount(1)
  await expect(localCard(page).locator('.wl-name')).toHaveText([LT.name, 'Open Local Terminal'])
  await expect(remoteCard(page).locator('.wl-name')).toHaveText(['Web'])
  await expect(localRows(page).first().locator('.wl-proto')).toHaveText('LOC')

  // Clicking the saved entry reopens THAT shell — its directory and shell reach
  // the backend, which the built-in default (no cwd, no shell) never would.
  await localRows(page).first().locator('button').click()
  const call = (await invokedCalls(page)).find((c) => c.cmd === 'open_local_shell')!
  expect(JSON.stringify(call.args)).toContain(LT.cwd)
})

test('a local terminal deleted since drops out of the card', async ({ page }) => {
  await boot(page, {
    connections: BASE,
    localTerminals: [],
    recentConnections: [
      { connectionId: `local:${LT.id}`, usedAtMs: Date.now(), kind: 'localTerminal' },
      { connectionId: 'c1', usedAtMs: Date.now() - 1000 },
    ],
  })

  // The backend filters the orphaned row; the join here would drop it anyway.
  await expect(localRows(page)).toHaveCount(0)
  await expect(localCard(page)).toContainText('No saved local terminals yet')
  await expect(remoteCard(page).locator('.wl-name')).toHaveText(['Web'])
})

test('each list keeps its own configured number of rows', async ({ page }) => {
  const many: MockConnection[] = Array.from({ length: 8 }, (_, i) => ({
    id: `c${i}`,
    name: `Host ${i}`,
    host: `10.0.0.${i + 1}`,
    port: 22,
    username: 'root',
  }))
  const locals = [LT, { id: 'lt-2', name: 'Zsh', cwd: '/srv', shell: 'zsh' }]
  await page.addInitScript(() => {
    localStorage.setItem('wrolp-recent-remote-count', '3')
    localStorage.setItem('wrolp-recent-local-count', '1')
  })
  await boot(page, { connections: many, localTerminals: locals })

  await expect(remoteRows(page)).toHaveCount(3)
  await expect(localRows(page)).toHaveCount(1)
})

test('the Settings → Appearance counts resize the Home lists', async ({ page }) => {
  await boot(page, { connections: BASE })
  await page.locator('.settings-btn').click()

  await page.locator('#home-recent-remote').fill('2')
  await page.locator('#home-recent-remote').blur()
  await page.locator('#home-recent-local').fill('4')
  await page.locator('#home-recent-local').blur()
  expect(await page.evaluate(() => localStorage.getItem('wrolp-recent-remote-count'))).toBe('2')
  expect(await page.evaluate(() => localStorage.getItem('wrolp-recent-local-count'))).toBe('4')

  // Closing the Settings tab brings the Home page back whether it is a pinned tab
  // or what stands behind an empty stage.
  await page.locator('.tab-item.active .tab-close').click()
  // Remote fell back to the saved hosts and is capped at two; local has no saved
  // entries, so it stays empty regardless of its own count.
  await expect(remoteRows(page)).toHaveCount(2)
  await expect(localRows(page)).toHaveCount(0)
})

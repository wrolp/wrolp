import { test, expect, type Page } from './helpers/fixtures'
import { installTauriMock, emitTauriEvent, invokedCalls } from './helpers/tauriMock'

// The device command index, from the user's side (SSH-COMMAND-INDEX-COMPLETION-PLAN
// §2.B, P1): what the settings card says about the machine behind the tab, and what
// pressing its button costs.
//
// The collection itself runs on the far side of an exec, which no mocked IPC can
// exercise — see `host_commands::tests` in the Rust for the script and the parser,
// and the plan's P1 self-check items for the real-machine half.

const DEMO_CONN = { id: 'c1', name: 'Demo', host: 'demo.local', port: 22, username: 'root' }
const FP = 'SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG'

const INDEX_ROWS = [
  { command: 'git', sources: 'path' },
  { command: 'github', sources: 'path' },
  { command: 'jobs', sources: 'builtin' },
]

async function boot(page: Page, hostCommands: unknown[] = []) {
  await installTauriMock(page, {
    connections: [DEMO_CONN],
    pollOutputChunks: [[`root@demo:~$ `]],
    hostCommands: hostCommands as never,
  })
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  await page.goto('/')
}

/** Open a terminal for the demo connection and identify its device. */
async function openAndIdentify(page: Page) {
  await boot(page, INDEX_ROWS)
  await page.locator('.connection-item').click()
  const tabId = Number((await invokedCalls(page)).find((c) => c.cmd === 'connect')!.args.tabId)
  await emitTauriEvent(page, 'host-identified', {
    tabId,
    fingerprint: FP,
    kind: 'ssh',
    host: 'demo.local',
    port: 22,
    username: 'root',
    isNew: false,
    changed: false,
    previousFingerprint: null,
  })
  await expect(
    page.locator('.status-bar-left .status-item', { hasText: 'SHA256:abcd…' }),
  ).toBeVisible()
  return tabId
}

async function openTerminalSettings(page: Page) {
  await page.locator('.settings-btn').click()
  await page.locator('.settings-nav-item', { hasText: 'Terminal' }).click()
}

const card = (page: Page) => page.locator('.settings-card', { hasText: 'Device command index' })

test('the card reports how many commands the device index holds', async ({ page }) => {
  await openAndIdentify(page)
  await openTerminalSettings(page)

  await expect(card(page)).toContainText('3 commands indexed')
})

test('a device nobody has collected yet says so instead of showing a zero', async ({ page }) => {
  await boot(page)
  await page.locator('.connection-item').click()
  const tabId = Number((await invokedCalls(page)).find((c) => c.cmd === 'connect')!.args.tabId)
  await emitTauriEvent(page, 'host-identified', {
    tabId,
    fingerprint: FP,
    kind: 'ssh',
    host: 'demo.local',
    port: 22,
    username: 'root',
    isNew: true,
    changed: false,
    previousFingerprint: null,
  })
  await openTerminalSettings(page)

  await expect(card(page)).toContainText('Not collected yet')
  // The button stays live: collecting now is exactly how this state ends.
  await expect(card(page).getByRole('button', { name: 'Refresh now' })).toBeEnabled()
})

test('a tab that never identified a device cannot be refreshed', async ({ page }) => {
  await boot(page)
  await page.locator('.connection-item').click()
  await openTerminalSettings(page)

  await expect(card(page)).toContainText('has not identified its device')
  await expect(card(page).getByRole('button', { name: 'Refresh now' })).toBeDisabled()
})

test('refreshing collects for the device behind this very tab', async ({ page }) => {
  const tabId = await openAndIdentify(page)
  await openTerminalSettings(page)

  await card(page).getByRole('button', { name: 'Refresh now' }).click()
  await expect
    .poll(
      async () =>
        (await invokedCalls(page)).filter((c) => c.cmd === 'collect_host_commands').length,
    )
    .toBe(1)
  const call = (await invokedCalls(page)).find((c) => c.cmd === 'collect_host_commands')!
  expect(call.args).toMatchObject({ tabId, fingerprint: FP, kind: 'ssh' })
  // No distro on an SSH tab: `wsl.exe -d …` is how a local tab is enumerated, and
  // sending it for a remote one would index the wrong machine entirely.
  expect(call.args.distro).toBeNull()
  // The count the toast reports is the backend's, not the length of whatever the
  // frontend happened to have cached before the collection.
  await expect(page.locator('.toast')).toContainText('Indexed 3 commands on this device.')
})

test('a collection finishing in the background re-reads the list', async ({ page }) => {
  await openAndIdentify(page)
  const before = (await invokedCalls(page)).filter((c) => c.cmd === 'list_host_commands').length

  // The backend auto-collects after a first connect and announces it; the open
  // terminal must pick the result up without the user touching anything.
  await emitTauriEvent(page, 'host-commands-updated', { fingerprint: FP, count: 120 })
  await expect
    .poll(
      async () => (await invokedCalls(page)).filter((c) => c.cmd === 'list_host_commands').length,
    )
    .toBeGreaterThan(before)

  await openTerminalSettings(page)
  // The count is the list length, so this also proves the re-read replaced the
  // cache rather than appending to it.
  await expect(card(page)).toContainText('3 commands indexed')
})

test('clearing forgets the device and takes the button away with it', async ({ page }) => {
  await openAndIdentify(page)
  await openTerminalSettings(page)

  // Only worth offering when there is something to forget.
  await expect(card(page).getByRole('button', { name: 'Forget this device' })).toBeVisible()
  await card(page).getByRole('button', { name: 'Forget this device' }).click()

  await expect
    .poll(
      async () => (await invokedCalls(page)).filter((c) => c.cmd === 'clear_host_commands').length,
    )
    .toBe(1)
  expect((await invokedCalls(page)).find((c) => c.cmd === 'clear_host_commands')!.args).toEqual({
    fingerprint: FP,
  })
  await expect(page.locator('.toast')).toContainText('Removed 3 indexed commands')

  // The re-read must show the truth: an empty index, and no clear button left to
  // click. A card that kept counting 3 would mean the cache survived the clear.
  await expect(card(page)).toContainText('Not collected yet')
  await expect(card(page).getByRole('button', { name: 'Forget this device' })).toHaveCount(0)
  // Refreshing is still there — that is the way back, and the way auto-collection
  // resumes.
  await expect(card(page).getByRole('button', { name: 'Refresh now' })).toBeEnabled()
})

test('the database pane sizes the index separately from the file', async ({ page }) => {
  await openAndIdentify(page)
  await page.locator('.settings-btn').click()
  await page.locator('.settings-nav-item', { hasText: 'Data' }).click()

  // 3 rows × 128 bytes in the mock's figures.
  await expect(page.locator('.settings-card', { hasText: 'Database' })).toContainText(
    'Device command index: 3 commands over 1 device',
  )
})

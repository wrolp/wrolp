import { test, expect, type Page } from './helpers/fixtures'
import { selectRailMode } from './helpers/sections'
import { emitTauriEvent, installTauriMock, invokedCalls } from './helpers/tauriMock'

// A jump host's 「Enter Shell」 does not get a PTY of its own: it splits the focused
// session's pane and types `docker exec -it …` into that new SSH shell once it reports
// connected (App.tsx `openInSplit` → `postConnectCmd`). Everything this feature can
// break lives in that handoff, so the specs watch `send_input`.

const DEMO_CONN = { id: 'c1', name: 'Demo', host: 'demo.local', port: 22, username: 'root' }
const PROMPT = 'root@demo:~# '
const REMOTE = {
  id: '9f2c1a4b8e0d',
  name: 'wrolp-remote-api',
  image: 'wrolp/api:1.4',
  state: 'running',
  status: 'Up 5 hours',
}

const sentInput = async (page: Page) =>
  (await invokedCalls(page)).filter((c) => c.cmd === 'send_input').map((c) => String(c.args.data))

/** Whether the exec line reached a session. */
const sentExec = async (page: Page) =>
  (await sentInput(page)).some((d) => d.includes(`docker exec -it ${REMOTE.name}`))

const row = (page: Page, name: string) => page.locator('.docker-item').filter({ hasText: name })

async function boot(page: Page) {
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  await installTauriMock(page, {
    connections: [DEMO_CONN],
    dockerContainers: [REMOTE],
    pollOutputChunks: [[PROMPT]],
  })
  await page.goto('/')
  await page.locator('.connection-item').first().click()
  await expect(page.locator('.tab-item')).toContainText('Demo')
}

async function enterShell(page: Page) {
  await selectRailMode(page, 'containers')
  await row(page, REMOTE.name).click({ button: 'right' })
  await page.locator('.context-menu-item', { hasText: 'Enter Shell' }).click()
}

test('entering a jump host container’s shell types the exec into the new pane', async ({
  page,
}) => {
  await boot(page)
  await enterShell(page)

  // A second pane opens on the same host, and the exec line has to reach it — a bare
  // host prompt is the bug this pins (the line never gets typed).
  await expect.poll(() => sentExec(page), { timeout: 5_000 }).toBe(true)
})

// The backend announces the machine it just met with `host-identified` a few hundred ms
// after the connect invoke resolves — inside the window the exec waits in. The listener
// writes the identity onto the tab record, so the tabs array changes; an effect that
// owns the pending command through its cleanup drops it there, and its edge trigger
// (`prev !== 'connected'`) can never fire again for that connect. The pane then sits at
// the host prompt with nothing queued and nothing retried.
test('the exec survives the device announcement landing mid-settle', async ({ page }) => {
  await boot(page)
  await enterShell(page)

  // The pane's own session is the second `connect` the app makes.
  await expect
    .poll(async () => (await invokedCalls(page)).filter((c) => c.cmd === 'connect').length)
    .toBeGreaterThanOrEqual(2)
  const paneTabId = Number(
    (await invokedCalls(page)).filter((c) => c.cmd === 'connect').at(1)!.args.tabId,
  )

  await emitTauriEvent(page, 'host-identified', {
    tabId: paneTabId,
    fingerprint: 'SHA256:Zm9vYmFy',
    kind: 'ssh',
    host: DEMO_CONN.host,
    port: DEMO_CONN.port,
    username: DEMO_CONN.username,
    isNew: false,
    changed: false,
    previousFingerprint: null,
  })

  await expect
    .poll(() => sentExec(page), { message: 'the pending exec was cancelled', timeout: 5_000 })
    .toBe(true)
})

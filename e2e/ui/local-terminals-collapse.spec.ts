import { test, expect, type Page } from './helpers/fixtures'
import { installTauriMock, invokedCalls } from './helpers/tauriMock'

// The local-terminals section collapses like a connection group, so its state
// has to be remembered the same way (`window.json.collapsedGroups`) instead of
// starting expanded on every launch.

const LOCAL_ENTRY = {
  id: 'lt-1',
  name: 'WSL shell',
  cwd: '',
  shell: 'wsl',
  distro: 'Ubuntu',
}

const SENTINEL = '\u0000local-terminals'

async function boot(page: Page, windowConfig: Record<string, unknown> = {}) {
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  await installTauriMock(page, {
    connections: [
      { id: 'c1', name: 'Demo', host: 'demo.local', port: 22, username: 'root', group: '' },
    ],
    localTerminals: [LOCAL_ENTRY],
    windowConfig,
  })
  await page.goto('/')
  await expect(page.locator('.local-terminals-group')).toBeVisible()
}

const header = (page: Page) => page.locator('.local-terminals-group .conn-group-header')
const items = (page: Page) => page.locator('.local-terminals-group .local-term-item')

test('collapsing the local terminals section is persisted', async ({ page }) => {
  await boot(page)
  await expect(items(page).first()).toBeVisible()

  await header(page).click()
  await expect(items(page)).toHaveCount(0)
  await expect(header(page).locator('.collapse-chevron')).not.toHaveClass(/expanded/)

  // Debounced write into the window config that survives a restart.
  await expect
    .poll(async () =>
      (await invokedCalls(page))
        .filter((c) => c.cmd === 'save_window_config')
        .map((c) => (c.args.config as { collapsedGroups?: string[] } | undefined)?.collapsedGroups),
    )
    .toContainEqual([SENTINEL])

  // Expanding removes the key again, so a later launch starts open.
  await header(page).click()
  await expect(items(page).first()).toBeVisible()
  await expect
    .poll(async () =>
      (await invokedCalls(page))
        .filter((c) => c.cmd === 'save_window_config')
        .map((c) => (c.args.config as { collapsedGroups?: string[] } | undefined)?.collapsedGroups),
    )
    .toContainEqual([])
})

test('a saved collapse starts the section closed on the next launch', async ({ page }) => {
  await boot(page, { collapsedGroups: [SENTINEL] })
  await expect(items(page)).toHaveCount(0)
  await expect(header(page).locator('.collapse-chevron')).not.toHaveClass(/expanded/)

  await header(page).click()
  await expect(items(page).first()).toBeVisible()
})

import { test, expect } from './helpers/fixtures'
import { installTauriMock, type MockConnection } from './helpers/tauriMock'

// P2-3a: the nav column's single filter box.
//
// The connection list had *no* text search at all before this — the 🔍 in its
// header opens the network-scan dialog — so these cases are pinning a capability
// that did not exist, not a restyling of one.

const CONNS: MockConnection[] = [
  { id: 'a1', name: 'web-01', host: '10.0.1.11', port: 22, username: 'deploy', group: 'prod' },
  { id: 'a2', name: 'web-02', host: '10.0.1.12', port: 22, username: 'deploy', group: 'prod' },
  { id: 'b1', name: 'build', host: '192.168.0.7', port: 22, username: 'ci', group: 'dev' },
]

async function boot(page: import('@playwright/test').Page) {
  await installTauriMock(page, { connections: CONNS })
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  await page.goto('/')
  // `.connection-item` is an SSH row, `.conn-item` is a local-terminal row. Two
  // class names this close is worth naming once, here.
  await expect(page.locator('.connection-item')).toHaveCount(3)
}

const search = (page: import('@playwright/test').Page) => page.locator('.nav-search input')

test('the box filters by name, by host and by the user you log in as', async ({ page }) => {
  await boot(page)

  await search(page).fill('web-02')
  await expect(page.locator('.connection-item')).toHaveCount(1)
  await expect(page.locator('.connection-item')).toContainText('web-02')

  // A host is how you actually find a machine you have never named.
  await search(page).fill('192.168')
  await expect(page.locator('.connection-item')).toHaveCount(1)
  await expect(page.locator('.connection-item')).toContainText('build')

  await search(page).fill('deploy')
  await expect(page.locator('.connection-item')).toHaveCount(2)
})

test('matching is case-insensitive but the query is echoed back as typed', async ({ page }) => {
  await boot(page)
  await search(page).fill('WEB-01')
  await expect(page.locator('.connection-item')).toHaveCount(1)

  await search(page).fill('Nope')
  const empty = page.locator('.empty-state')
  await expect(empty).toContainText('No match for “Nope”')
  // Lower-casing the echo would tell the user they typed something they did not.
  await expect(empty).not.toContainText('nope')
})

test('typing a group name narrows to that group', async ({ page }) => {
  await boot(page)
  await search(page).fill('dev')
  await expect(page.locator('.conn-group-name')).toHaveText(['dev'])
  await expect(page.locator('.connection-item')).toHaveCount(1)
})

test('a collapsed group opens for the duration of the search, then goes back', async ({ page }) => {
  await boot(page)
  // Collapse `prod` the way a user would, then search inside it.
  await page.locator('.conn-group-header', { hasText: 'prod' }).click()
  await expect(page.locator('.connection-item', { hasText: 'web-01' })).toBeHidden()

  await search(page).fill('web-01')
  await expect(page.locator('.connection-item', { hasText: 'web-01' })).toBeVisible()

  // Clearing restores the user's own collapse choice rather than leaving
  // everything expanded as if the search had edited it.
  await search(page).fill('')
  await expect(page.locator('.connection-item', { hasText: 'web-01' })).toBeHidden()
})

test('the clear control only exists while there is something to clear', async ({ page }) => {
  await boot(page)
  await expect(page.locator('.nav-search-clear')).toHaveCount(0)
  await search(page).fill('x')
  const clear = page.locator('.nav-search-clear')
  await expect(clear).toHaveCount(1)
  await clear.click()
  await expect(search(page)).toHaveValue('')
  await expect(page.locator('.connection-item')).toHaveCount(3)
})

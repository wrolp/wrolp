import { test, expect } from './helpers/fixtures'
import { installTauriMock } from './helpers/tauriMock'
import { selectRailMode, sectionHead } from './helpers/sections'

// B49 originally: clicking 「All」 in the Docker head collapsed the whole panel, because the
// head *was* the collapse switch (`onClick={onToggleExpanded}`) and the label never held its
// own click. The head is no longer clickable at all, so the bug has no gesture left to
// happen in; what stays worth pinning is that the filter still drives the list.

const DEMO_CONN = { id: 'c1', name: 'Demo', host: 'demo.local', port: 22, username: 'root' }
const PROMPT = 'root@demo:~# '
const API = {
  id: '9f2c1a4b8e0d',
  name: 'wrolp-api',
  image: 'wrolp/api:1.4',
  state: 'running',
  status: 'Up 3 hours',
}
const WORKER = {
  id: '112233445566',
  name: 'wrolp-worker-old',
  image: 'wrolp/worker:1.2',
  state: 'exited',
  status: 'Exited (0) 2 hours ago',
}

const dockerRow = (page: import('@playwright/test').Page, name: string) =>
  page.locator('.docker-item').filter({ hasText: name })

test('「All」 filters the list and leaves it on screen (B49)', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  await installTauriMock(page, {
    connections: [DEMO_CONN],
    pollOutputChunks: [[PROMPT]],
    dockerContainers: [API, WORKER],
  })
  await page.goto('/')
  await page.locator('.connection-item').first().click()
  await selectRailMode(page, 'containers')

  const head = sectionHead(page, 'Docker')
  // Stopped containers are hidden until 「All」 says otherwise.
  await expect(dockerRow(page, API.name)).toBeVisible()
  await expect(dockerRow(page, WORKER.name)).toHaveCount(0)

  // Click the label — the exact gesture that used to fold the section away.
  await head.locator('.docker-filter-toggle').click()
  await expect(head.locator('.docker-filter-toggle input')).toBeChecked()
  await expect(dockerRow(page, WORKER.name)).toBeVisible()
  await expect(dockerRow(page, API.name)).toBeVisible()

  // And the box itself, which is the smaller target a user aims at.
  await head.locator('.docker-filter-toggle input').click()
  await expect(head.locator('.docker-filter-toggle input')).not.toBeChecked()
  await expect(dockerRow(page, WORKER.name)).toHaveCount(0)
  await expect(dockerRow(page, API.name)).toBeVisible()
})

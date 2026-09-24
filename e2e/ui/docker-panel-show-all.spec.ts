import { test, expect } from './helpers/fixtures'
import { installTauriMock } from './helpers/tauriMock'
import { expandSection } from './helpers/sections'

// B49: clicking 「All」 in the Docker head collapsed the whole panel, so the filter could
// never actually be used. The head *is* the collapse switch (`onClick={onToggleExpanded}`),
// the label sits inside it, and unlike the refresh button next to it the label never held
// its own click — so ticking the box bubbled up and folded the section away. The
// checkbox's `onChange` was never involved.

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

test('「All」 filters the list without collapsing the panel (B49)', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  await installTauriMock(page, {
    connections: [DEMO_CONN],
    pollOutputChunks: [[PROMPT]],
    dockerContainers: [API, WORKER],
  })
  await page.goto('/')
  await page.locator('.connection-item').first().click()
  await expandSection(page, 'Docker')

  const head = page
    .locator('.panel-head.sec')
    .filter({ has: page.locator('.panel-title', { hasText: /^Docker$/ }) })
  const toggle = head.locator('.panel-head-toggle')
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  // Stopped containers are hidden until 「All」 says otherwise.
  await expect(dockerRow(page, API.name)).toBeVisible()
  await expect(dockerRow(page, WORKER.name)).toHaveCount(0)

  // Click the label — the exact gesture that used to fold the section away.
  await head.locator('.docker-filter-toggle').click()
  await expect(toggle, 'the panel must stay open').toHaveAttribute('aria-expanded', 'true')
  await expect(head.locator('.docker-filter-toggle input')).toBeChecked()
  await expect(dockerRow(page, WORKER.name)).toBeVisible()

  // And the box itself, which is the smaller target a user aims at.
  await head.locator('.docker-filter-toggle input').click()
  await expect(toggle, 'the panel must stay open').toHaveAttribute('aria-expanded', 'true')
  await expect(head.locator('.docker-filter-toggle input')).not.toBeChecked()
  await expect(dockerRow(page, WORKER.name)).toHaveCount(0)

  // The head is still a collapse switch for the click that means it.
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
})

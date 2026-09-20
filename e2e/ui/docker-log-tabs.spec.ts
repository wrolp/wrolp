import { test, expect } from './helpers/fixtures'
import { installTauriMock } from './helpers/tauriMock'
import { expandSection } from './helpers/sections'

// Regression for BUGS.md B35 — "打开docker日志, 已经打开一个再打开一个, 显示的还是之前
// 打开的docker实例日志的内容".
//
// The docker-log view replaces its pane's terminal surface, so opening a second
// container's log switches the pane's `shellView` from `dockerlog:<A>` to
// `dockerlog:<B>`: the same tree position, same component, only props change.
// Without a React `key`, the `DockerLogViewer` instance was reused — and since
// its initial load lives in a mount-only effect (`useEffect(…, [])`), the
// header showed B while the body still held A's logs (and A's live stream kept
// appending when Follow was on). Both render sites now pass `key={dl.tabId}`.

const DEMO_CONN = { id: 'c1', name: 'Demo', host: 'demo.local', port: 22, username: 'root' }
const PROMPT = 'root@demo:~# '

const API = {
  id: '9f2c1a4b8e0d',
  name: 'wrolp-api',
  image: 'wrolp/api:1.4',
  state: 'running',
  status: 'Up 3 hours',
}
const DB = {
  id: '5a1b2c3d4e6f',
  name: 'wrolp-db',
  image: 'postgres:16',
  state: 'running',
  status: 'Up 5 hours',
}

const API_LOG = 'api-only-marker: listening on :8080'
const DB_LOG = 'db-only-marker: database system is ready'

const CONTAINER_ITEM = (page: import('@playwright/test').Page, name: string) =>
  page.locator('.docker-item').filter({ hasText: name })

/** Right-click a container in the sidebar and pick "View Logs". */
async function viewLogs(page: import('@playwright/test').Page, name: string) {
  // The Docker section ships collapsed, so open it before reaching for a row.
  await expandSection(page, 'Docker')
  const item = CONTAINER_ITEM(page, name)
  await expect(item).toBeVisible()
  await item.click({ button: 'right' })
  await page.locator('.context-menu-item', { hasText: 'View Logs' }).click()
}

test('a second container log tab shows its own container, not the first one (B35)', async ({
  page,
}) => {
  // Pin the language for the context-menu label, and turn Follow off so the
  // viewer does a single one-shot fetch instead of streaming.
  await page.addInitScript(() => {
    localStorage.setItem('wrolp-lang', 'en')
    localStorage.setItem('wrolp-docker-follow', '0')
  })
  await installTauriMock(page, {
    connections: [DEMO_CONN],
    pollOutputChunks: [[PROMPT]],
    dockerContainers: [API, DB],
    dockerLogsByContainer: { [API.name]: API_LOG, [DB.name]: DB_LOG },
  })
  await page.goto('/')
  await page.locator('.connection-item').first().click()

  // First container: its own logs.
  await viewLogs(page, API.name)
  const viewer = page.locator('.docker-log-viewer')
  await expect(viewer.locator('.dlv-container-name')).toHaveText(API.name)
  await expect(viewer.locator('.dlv-output')).toContainText(API_LOG)

  // Second container, opened into the SAME pane: header AND body must switch.
  await viewLogs(page, DB.name)
  await expect(viewer.locator('.dlv-container-name')).toHaveText(DB.name)
  await expect(viewer.locator('.dlv-output')).toContainText(DB_LOG)
  await expect(viewer.locator('.dlv-output')).not.toContainText(API_LOG)
})

test('two log tabs are independent — the first one keeps its own logs (B35)', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('wrolp-lang', 'en')
    localStorage.setItem('wrolp-docker-follow', '0')
  })
  await installTauriMock(page, {
    connections: [DEMO_CONN],
    pollOutputChunks: [[PROMPT]],
    dockerContainers: [API, DB],
    dockerLogsByContainer: { [API.name]: API_LOG, [DB.name]: DB_LOG },
  })
  await page.goto('/')
  await page.locator('.connection-item').first().click()

  await viewLogs(page, API.name)
  await viewLogs(page, DB.name)

  // Both docker-log tabs stay in the pane header; switching back to the first
  // must show the API log again (a fresh mount, not the stale DB buffer).
  await page.locator('.term-pane-file-tab', { hasText: 'wrolp-api' }).click()
  const viewer = page.locator('.docker-log-viewer')
  await expect(viewer.locator('.dlv-container-name')).toHaveText(API.name)
  await expect(viewer.locator('.dlv-output')).toContainText(API_LOG)
  await expect(viewer.locator('.dlv-output')).not.toContainText(DB_LOG)
})

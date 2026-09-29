import { test, expect } from './helpers/fixtures'
import { installTauriMock, type MockConnection } from './helpers/tauriMock'
import { expandSection, selectRailMode } from './helpers/sections'

// P2-3b: the nav sections on one header primitive.
//
// `.panel-head.sec` is `chevron + title + metadata + whatever controls fit`, and
// the mode column is 264px by default. That combination has one failure mode worth
// pinning: the title is the item that gives up first, so a long host label silently
// ate "DOCKER" whole. These cases assert the title is *measurable*, not just
// present — `toBeVisible` passes on a zero-width element.
//
// v8 gave the column to the activity rail: one section at a time now, so a case
// that measures a section first has to put it there.

const CONNS: MockConnection[] = [
  {
    id: 'a1',
    name: 'build-agent-07',
    host: '10.254.18.31',
    port: 22,
    username: 'ci',
  },
]
const CONTAINERS = [
  {
    id: '9f2c1a4b8e0d',
    name: 'wrolp-api',
    image: 'wrolp/api:1.4',
    state: 'running',
    status: 'Up 3 hours',
  },
]

async function boot(page: import('@playwright/test').Page) {
  await installTauriMock(page, { connections: CONNS, dockerContainers: CONTAINERS })
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  await page.goto('/')
  await page.locator('.connection-item').first().click()
}

/** Elements whose text is cut off by `text-overflow: ellipsis`. */
const truncated = (page: import('@playwright/test').Page, selector: string) =>
  page.$$eval(selector, (els) =>
    els
      .filter((el) => el.scrollWidth > Math.floor(el.clientWidth) + 1)
      .map((el) => el.textContent ?? ''),
  )

/**
 * A section by its title. `hasText` is not enough: the Files header carries a
 * "Docker" mode button, so filtering the bars by that word matched two of them.
 */
const section = (page: import('@playwright/test').Page, title: string) =>
  page
    .locator('.panel-head.sec')
    .filter({ has: page.locator('.panel-title', { hasText: new RegExp(`^${title}$`) }) })

test('every section keeps its title at the default column width', async ({ page }) => {
  await boot(page)

  // "build-agent-07 (10.254.18.31)" is the stress case: two sections show it as
  // metadata in the same row as their title. One mode at a time, so each is
  // measured while it owns the whole column.
  await selectRailMode(page, 'hosts')
  await expect(page.locator('.panel-head.sec .panel-title')).toHaveText(['Connections'])
  expect(await truncated(page, '.panel-head.sec .panel-title')).toEqual([])

  await selectRailMode(page, 'files')
  await expect(page.locator('.panel-head.sec .panel-title')).toHaveText(['Files'])
  expect(await truncated(page, '.panel-head.sec .panel-title')).toEqual([])

  await selectRailMode(page, 'containers')
  await expandSection(page, 'Docker')
  await expect(page.locator('.panel-head.sec .panel-title')).toHaveText(['Docker'])
  expect(await truncated(page, '.panel-head.sec .panel-title')).toEqual([])

  // The metadata *is* allowed to ellipsis — that is the item that gives way.
  expect(await truncated(page, '.panel-head.sec .cnt')).not.toEqual([])
})

test('the mode switch never truncates a mode name', async ({ page }) => {
  await boot(page)
  await selectRailMode(page, 'files')

  // Three words that used to clip to "SSH / Jump / Do" once the verbs shared the
  // row. It sits in the header now, and the verbs are on their own.
  await expect(page.locator('.file-mode-switch button')).toHaveText(['SSH', 'Jump', 'Docker'])
  expect(await truncated(page, '.file-mode-switch button')).toEqual([])
  await expect(page.locator('.file-panel .toolbar .file-toolbar button')).toHaveCount(6)
})

test('the bar itself collapses the section, not just the chevron', async ({ page }) => {
  await boot(page)
  // Docker ships collapsed (it renders for local shells too, where it is always
  // empty), so a spec that measures its rows has to open it.
  await selectRailMode(page, 'containers')
  await expandSection(page, 'Docker')

  const docker = section(page, 'Docker')
  const toggle = docker.locator('.panel-head-toggle')
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')

  // A click anywhere on the bar — here, the metadata — is the affordance the
  // chevron shows. The toggle button is what keyboard readers reach.
  await docker.locator('.cnt').click({ position: { x: 2, y: 2 } })
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(page.locator('.docker-item')).toHaveCount(0)

  await docker.locator('.cnt').click({ position: { x: 2, y: 2 } })
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(page.locator('.docker-item')).toHaveCount(1)
})

test('a control inside a header does not also toggle it', async ({ page }) => {
  await boot(page)
  await selectRailMode(page, 'files')

  const files = section(page, 'Files')
  const toggle = files.locator('.panel-head-toggle')
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')

  // Switching to the container filesystem is a selection, not a collapse.
  await files.locator('.file-mode-switch button').nth(2).click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
})

import { test, expect, type Page } from '@playwright/test'
import { installTauriMock, type MockConnection } from './helpers/tauriMock'

// P2-4: the inspector — the third region, holding read-outs about the *focused*
// tab (host analysis, container analysis). It took those two tabs out of the
// bottom drawer, which keeps only what lists things across every target.
// P3-2 added the AI tab, which replaced the full-screen AI Chat tab; its layout
// cases live in `ai-chat-layout.spec.ts`. P3-3 added the Network tab, which
// replaced the subnet-scan modal; its cases live in `inspector-network.spec.ts`.
// P3-5 gave the column its two states — floated out, or docked at either edge —
// and those live in `inspector-float.spec.ts`.
//
// The two regions share a row of the window, so the cases below are mostly about
// geometry: the column must be flush with the edge it docks to, must not overlap a
// drawer docked to the same side, and must be resizable without the resizer
// stealing width from its neighbour.

const CONNS: MockConnection[] = [
  { id: 'c1', name: 'prod-web-01', host: '10.0.0.11', port: 22, username: 'app' },
]

async function boot(page: Page, layout?: string) {
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  await installTauriMock(page, { connections: CONNS, layout })
  await page.goto('/')
}

const toggle = (page: Page) => page.getByRole('button', { name: /^(Open|Close) inspector$/ })

/** The column's own grab zone. It is a child of the column rather than a sibling
 * divider in the row, so the column stays one flex item and can change edge with
 * `order` alone — see `inspector-float.spec.ts`. */
const inspectorGrip = (page: Page) => page.locator('.inspector > .inspector-resize')

test('the column ships closed and the tab bar opens it', async ({ page }) => {
  await boot(page)
  await expect(page.locator('.inspector')).toHaveCount(0)

  await toggle(page).click()
  await expect(page.locator('.inspector')).toBeVisible()
  await expect(toggle(page)).toHaveAttribute('aria-label', 'Close inspector')
  await expect(page.locator('.inspector-tabs .tab-btn')).toHaveText([
    'Analysis',
    'Docker',
    'AI',
    'Network',
  ])
  // Exactly one control carries the region name; the column's own ✕ says plain
  // "Close", so the two are not interchangeable in the accessibility tree.
  await expect(page.getByRole('button', { name: 'Close inspector', exact: true })).toHaveCount(1)
})

test('Ctrl+Alt+I toggles it and the header close button hides it', async ({ page }) => {
  await boot(page)
  await page.keyboard.press('Control+Alt+i')
  await expect(page.locator('.inspector')).toBeVisible()

  // `.icon-btn` alone would now match all three header buttons.
  await page.locator('.inspector-head .icon-btn.x').click()
  await expect(page.locator('.inspector')).toHaveCount(0)

  await page.keyboard.press('Control+Alt+i')
  await expect(page.locator('.inspector')).toBeVisible()
})

test('each tab renders its own panel', async ({ page }) => {
  await boot(page)
  await toggle(page).click()
  await expect(page.locator('.host-analysis-panel')).toBeVisible()

  await page.locator('.inspector-tabs .tab-btn').nth(1).click()
  await expect(page.locator('.docker-analysis-panel')).toBeVisible()
  await expect(page.locator('.host-analysis-panel')).toHaveCount(0)
})

test('the AI tab explains itself when no session is focused', async ({ page }) => {
  // The assistant is bound to the focused pane, so with nothing open the tab must
  // say so rather than render an empty box with no explanation.
  await boot(page)
  await toggle(page).click()
  await page.locator('.inspector-tabs .tab-btn').nth(2).click()
  await expect(page.locator('.inspector-empty')).toHaveText(
    'Open a terminal to talk to the assistant.',
  )
  await expect(page.locator('.ai-chat-panel')).toHaveCount(0)
})

test('a right-docked drawer and the inspector split the row without overlapping', async ({
  page,
}) => {
  // Both columns want the right side, so their order in `.main-content` decides:
  // the drawer stays inside the terminal area and the inspector stays flush with
  // the window edge.
  await boot(page, JSON.stringify({ bottomPanel: { visible: true, pos: 'right', size: 260 } }))
  await toggle(page).click()

  const drawer = await page.locator('.bottom-panel.right').boundingBox()
  const insp = await page.locator('.inspector').boundingBox()
  expect(drawer).not.toBeNull()
  expect(insp).not.toBeNull()
  expect(drawer!.x + drawer!.width).toBeLessThanOrEqual(insp!.x + 1)
  expect(insp!.x + insp!.width).toBeCloseTo(1440, 0)
})

test('dragging the column edge changes only the inspector width', async ({ page }) => {
  await boot(page)
  await toggle(page).click()
  const box = await inspectorGrip(page).boundingBox()
  expect(box).not.toBeNull()

  const target = 1440 - 420
  await page.mouse.move(box!.x + 2, box!.y + 60)
  await page.mouse.down()
  await page.mouse.move(target, box!.y + 60, { steps: 5 })
  await page.mouse.up()

  const after = await page.locator('.inspector').boundingBox()
  expect(after!.width).toBeGreaterThanOrEqual(418)
  expect(after!.width).toBeLessThanOrEqual(422)
  // Still flush with the right edge after the drag.
  expect(after!.x + after!.width).toBeCloseTo(1440, 0)
})

test('the drawer no longer offers the tabs the inspector took', async ({ page }) => {
  await boot(page, JSON.stringify({ bottomPanel: { visible: true, pos: 'bottom', size: 200 } }))
  await expect(page.locator('.bottom-panel-tabs .tab-btn')).toHaveText(['Sessions', 'Command Sets'])
})

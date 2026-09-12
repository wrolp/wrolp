import { test, expect } from '@playwright/test'
import { installTauriMock, emitTauriEvent, invokedCommands } from './helpers/tauriMock'

// Terminal connect flow with a stubbed backend: clicking a connection opens a
// workspace tab whose Terminal component drives `connect` then polls
// `poll_output`. Output rendering is canvas-based (xterm.js), so we assert the
// backend interaction (invoke recording) rather than terminal text.

const DEMO_CONN = { id: 'c1', name: 'Demo', host: 'demo.local', port: 22, username: 'root' }

test('clicking a connection opens a tab and starts the SSH connect flow', async ({ page }) => {
  await installTauriMock(page, {
    connections: [DEMO_CONN],
    pollOutputChunks: [['root@demo:~$ '], ['ls\r\n']],
  })
  await page.goto('/')

  await page.locator('.connection-item').click()

  // Tab + pane header show the connection name.
  await expect(page.locator('.tab-item')).toContainText('Demo')
  await expect(page.locator('.term-pane-title')).toContainText('Demo')

  // The backend connect command must have been invoked.
  await expect
    .poll(async () => (await invokedCommands(page)).filter((c) => c === 'connect').length)
    .toBeGreaterThanOrEqual(1)

  // After connect succeeds the terminal polls output.
  await expect
    .poll(async () => (await invokedCommands(page)).filter((c) => c === 'poll_output').length)
    .toBeGreaterThanOrEqual(1)
})

// Splitting must leave a real pixel gap between panes (the divider is an
// invisible overlay sitting inside that gap) — the panes must NOT be flush.
test('split panes are separated by a real gap', async ({ page }) => {
  await installTauriMock(page, {
    connections: [DEMO_CONN],
    pollOutputChunks: [['root@demo:~$ ']],
  })
  await page.goto('/')
  await page.locator('.connection-item').click()
  await expect(page.locator('.term-pane')).toHaveCount(1)

  // Ctrl+\ splits the active session into a second pane (row).
  await page.locator('.tab-split-btn').click()
  await expect(page.locator('.term-pane')).toHaveCount(2)
  await expect(page.locator('.term-split-divider.divider-row')).toHaveCount(1)

  const boxes = await page.locator('.term-pane').evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect()
      return { x: r.x, width: r.width }
    }),
  )
  boxes.sort((a, b) => a.x - b.x)
  const gap = boxes[1].x - (boxes[0].x + boxes[0].width)
  // SPLIT_GAP is 4px; allow a small rounding tolerance.
  expect(gap).toBeGreaterThanOrEqual(2)
  expect(gap).toBeLessThanOrEqual(6)

  // Hover highlight is a crisp 1px accent line with a blurred halo — not a
  // translucent band filling the whole track.
  const divider = page.locator('.term-split-divider.divider-row')
  await divider.hover()
  // The highlight fades in (0.12s transition), so poll instead of reading the
  // animated value immediately (which would still be 0 at opacity 0).
  await expect
    .poll(() => divider.evaluate((el) => getComputedStyle(el, '::after').opacity))
    .toBe('1')
  const line = await divider.evaluate((el) => {
    const s = getComputedStyle(el, '::after')
    return { width: s.width, shadow: s.boxShadow }
  })
  expect(line.width).toBe('1px')
  expect(line.shadow).not.toBe('none')
})

// The docked AI pane must be separated from the terminal by a real gap AND a
// border on the terminal-facing edge (previously the shared edge was flush and
// had its border suppressed → the two looked joined).
test('the docked AI pane has a gap and a border against the terminal', async ({ page }) => {
  const aiConfig = {
    profiles: [
      {
        id: 'p1',
        name: 'Mock',
        endpoint: 'https://api.openai.com/v1',
        apiKeyEnc: '',
        model: 'gpt-4o',
        toolCallFormat: 'nested',
        systemPrompt: '',
      },
    ],
    activeId: 'p1',
    defaultMode: 'command',
    runInTerminal: false,
  }
  await installTauriMock(page, {
    connections: [DEMO_CONN],
    pollOutputChunks: [['root@demo:~$ ']],
    aiConfig,
  })
  await page.goto('/')
  await page.locator('.connection-item').click()
  await expect(page.locator('.term-pane')).toHaveCount(1)

  await page.locator('.term-pane-ai-toggle').click()
  const dock = page.locator('.ai-dock-pane')
  await expect(dock).toBeVisible()

  // Default dock side is 'right', so the terminal-facing edge is the dock's LEFT.
  const gap = await page.evaluate(() => {
    const t = document.querySelector('.term-pane-term')!.getBoundingClientRect()
    const d = document.querySelector('.ai-dock-pane')!.getBoundingClientRect()
    return d.left - t.right
  })
  expect(gap).toBeGreaterThanOrEqual(2)
  expect(gap).toBeLessThanOrEqual(6)

  // …and the shared edge carries a visible border.
  expect(await dock.evaluate((el) => getComputedStyle(el).borderLeftWidth)).toBe('1px')
})

test('connection-closed event stops the output polling loop', async ({ page }) => {
  await installTauriMock(page, { connections: [DEMO_CONN] })
  await page.goto('/')

  await page.locator('.connection-item').click()

  const pollCount = async () =>
    (await invokedCommands(page)).filter((c) => c === 'poll_output').length

  // Wait until the poll loop is actively running.
  await expect.poll(pollCount).toBeGreaterThan(3)

  // The first opened tab always gets tabId 1 (nextTabId starts at 1).
  await emitTauriEvent(page, 'connection-closed', { tabId: 1 })

  // Give any in-flight interval tick a chance to fire, then verify the loop
  // has stopped (count is stable across another interval).
  await page.waitForTimeout(250)
  const after = await pollCount()
  await page.waitForTimeout(250)
  expect(await pollCount()).toBe(after)
})

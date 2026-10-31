import { test, expect, type Page } from './helpers/fixtures'
import { installTauriMock } from './helpers/tauriMock'

// The Conversations list is portaled to <body>. It opens hanging under its own
// header button, can be dragged by its header, and keeps its per-row action
// strip out of the flow until the row is hovered — so the title and meta get
// the full width, and only truncate once the buttons take space.

const AI_CONFIG = {
  profiles: [
    {
      id: 'p1',
      name: 'Mock',
      endpoint: 'https://api.openai.com/v1',
      apiKeyEnc: 'enc-mock',
      model: 'gpt-4o',
      toolCallFormat: 'nested',
      systemPrompt: '',
    },
  ],
  activeId: 'p1',
  defaultMode: 'command',
  runInTerminal: false,
}

const SESSIONS = [
  {
    id: 's1',
    title: 'Show system information, cpu and memory details',
    connectionName: '192.168.0.75',
    messageCount: 4,
    pinned: false,
    toolCallFormat: 'nested',
    createdAt: '2026-10-01T10:00:00Z',
    updatedAt: '2026-10-01T10:00:00Z',
  },
]

async function openPanel(page: Page) {
  await installTauriMock(page, { connections: [], aiConfig: AI_CONFIG, aiSessions: SESSIONS })
  await page.goto('/')
  await page.locator('.titlebar-btn.ai-chat-btn').click()
  await page.locator('.ai-chat-panel .ai-chat-clear-btn[aria-label="Conversations"]').click()
  const panel = page.locator('.ai-session-menu-panel')
  await expect(panel).toBeVisible()
  return panel
}

test('the conversations panel opens under its button and moves with its header', async ({
  page,
}) => {
  const panel = await openPanel(page)
  await expect(panel).toContainText('Show system information')

  const before = await panel.boundingBox()
  if (!before) throw new Error('no bounding box')

  // It opens hanging off the button, not pinned to the window's corner.
  const openBtn = page.locator('.ai-chat-panel .ai-chat-clear-btn[aria-label="Conversations"]')
  const btnBox = await openBtn.boundingBox()
  if (!btnBox) throw new Error('no button box')
  expect(Math.round(before.y - (btnBox.y + btnBox.height + 6))).toBeCloseTo(0, -1)
  expect(Math.round(before.x + before.width - (btnBox.x + btnBox.width))).toBeCloseTo(0, -1)

  // Grab the title area, well clear of the close button on the right.
  const startX = before.x + 40
  const startY = before.y + 20
  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.mouse.move(startX - 200, startY + 120, { steps: 8 })
  await page.mouse.up()

  const after = await panel.boundingBox()
  if (!after) throw new Error('no bounding box')
  expect(Math.round(after.x - before.x)).toBeCloseTo(-200, -1)
  expect(Math.round(after.y - before.y)).toBeCloseTo(120, -1)

  // The panel stays mounted: a drag is not an outside click.
  await expect(panel).toBeVisible()
})

test('the row actions claim space only while the row is hovered', async ({ page }) => {
  const panel = await openPanel(page)
  const row = panel.locator('.ai-session-item').first()
  const actions = row.locator('.ai-session-item-actions')
  const title = row.locator('.ai-session-item-title')

  // Nothing is hovered yet: the buttons are out of the flow, so the long title
  // fits instead of showing an ellipsis.
  await page.mouse.move(5, 5)
  await expect(actions).toBeHidden()
  expect(await title.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)

  await row.hover()
  await expect(actions).toBeVisible()
  // Now they take room and the title truncates.
  expect(await title.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true)
})

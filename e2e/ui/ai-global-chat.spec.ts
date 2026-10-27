import { test, expect } from './helpers/fixtures'
import { installTauriMock, invokedCalls } from './helpers/tauriMock'

// The inspector column's AI chat is the app-level one: it belongs to no terminal.
//
// It used to be the focused pane's conversation shown in a second place, which
// made the entry point dead whenever no session was open ("open a terminal
// first") and silently swapped the transcript when you clicked another pane.
// These specs pin the three things that follow from the decoupling: it renders
// with nothing open, it reaches the backend with no bound tab (so the backend
// keeps every shell tool away from the run), and it is a different conversation
// from a terminal's own docked pane.

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

const DEMO_CONN = { id: 'c1', name: 'Demo', host: 'demo.local', port: 22, username: 'root' }

const globalPanel = (page) => page.locator('.inspector .ai-chat-panel')

test('the assistant opens with no terminal anywhere', async ({ page }) => {
  await installTauriMock(page, { connections: [], aiConfig: AI_CONFIG })
  await page.goto('/')
  await expect(page.locator('.tab-item.tab-home')).toBeVisible()

  await page.locator('.titlebar-btn.ai-chat-btn').click()

  await expect(globalPanel(page)).toBeVisible()
  // The old dead-end placeholder must be gone, not merely hidden.
  await expect(page.locator('.inspector .inspector-empty')).toHaveCount(0)
  // And it must not promise shell work it cannot do.
  await expect(page.locator('.inspector .ai-chat-empty-text')).toContainText(
    'not attached to a terminal',
  )
  await expect(page.locator('.inspector .ai-chat-input-hint')).toContainText('no commands are run')
})

test('sending from the global chat asks the backend for a run with no bound tab', async ({
  page,
}) => {
  await installTauriMock(page, { connections: [], aiConfig: AI_CONFIG })
  await page.goto('/')
  await page.locator('.titlebar-btn.ai-chat-btn').click()
  await expect(globalPanel(page)).toBeVisible()

  await page.locator('.inspector .ai-chat-input').fill('what does this app do?')
  await page.locator('.inspector .ai-chat-input').press('Enter')

  // `tabId: null` is what makes the backend refuse shell tools for this run.
  await expect
    .poll(async () => {
      const call = (await invokedCalls(page)).find((c) => c.cmd === 'start_ai_agent')
      return call ? JSON.stringify(call.args.tabId) : null
    })
    .toBe('null')
})

test('closing every terminal keeps the global conversation', async ({ page }) => {
  await installTauriMock(page, { connections: [DEMO_CONN], aiConfig: AI_CONFIG })
  await page.goto('/')
  await page.locator('.connection-item').click()
  await expect(page.locator('.terminal-split-root')).toBeVisible()

  await page.locator('.titlebar-btn.ai-chat-btn').click()
  await globalPanel(page).locator('.ai-chat-input').fill('a draft in the global chat')

  await page.locator('.tab-item:not(.tab-home) .tab-close').click()
  await expect(page.locator('.tab-item:not(.tab-home)')).toHaveCount(0)

  await expect(globalPanel(page).locator('.ai-chat-input')).toHaveValue(
    'a draft in the global chat',
  )
})

test('the global chat and a pane dock are two conversations', async ({ page }) => {
  await installTauriMock(page, {
    connections: [DEMO_CONN],
    pollOutputChunks: [['root@demo:~$ ']],
    aiConfig: AI_CONFIG,
  })
  await page.goto('/')
  await page.locator('.connection-item').click()
  await expect(page.locator('.terminal-split-root')).toBeVisible()

  await page.locator('.titlebar-btn.ai-chat-btn').click()
  await globalPanel(page).locator('.ai-chat-input').fill('only in the global chat')

  // Open the pane's own docked AI. Before the split it read the very same
  // conversation, so it would have shown the draft above.
  await page.locator('.term-pane-ai-toggle').click()
  const dock = page.locator('.ai-dock-pane .ai-chat-panel')
  await expect(dock).toBeVisible()
  await expect(dock.locator('.ai-chat-input')).toHaveValue('')
  await expect(globalPanel(page).locator('.ai-chat-input')).toHaveValue('only in the global chat')
})

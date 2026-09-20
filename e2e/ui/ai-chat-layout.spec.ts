import { test, expect, type Page } from './helpers/fixtures'
import { installTauriMock } from './helpers/tauriMock'

// Layout of the AI panel as the inspector hosts it.
//
// Regression: the right side of the dialog was clipped. Root cause — the panel's
// wrapper is a flex item (`flex: 1`) without `min-width: 0`, so its *automatic
// minimum size* was the min-content width of the transcript, i.e. the width of
// the widest unbreakable run in it (a JSON blob the AI echoed, or the
// `changes={...}` tool-call summary, which is `white-space: nowrap`). The panel
// then grew to ~4400px instead of its container's width and everything past the
// right edge was cut off.
//
// The standalone full-screen AI tab is gone — "Ask AI" now opens the inspector
// column's AI tab, so the container is 308px of column instead of the window.
// The same defect would now squeeze the terminal beside it, which makes the
// "must not grow past its container" assertion the one that matters.

const AI_CONFIG = {
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

const DEMO_CONN = { id: 'c1', name: 'Demo', host: 'demo.local', port: 22, username: 'root' }

// Open a session, then ask the assistant. Returns with the inspector on its AI
// tab and the panel mounted.
const openAiChat = async (page: Page) => {
  await installTauriMock(page, {
    connections: [DEMO_CONN],
    pollOutputChunks: [['root@demo:~$ ']],
    aiConfig: AI_CONFIG,
  })
  await page.goto('/')
  await page.locator('.connection-item').click()
  await page.locator('.titlebar-btn.ai-chat-btn').click()
  await expect(page.locator('.inspector .ai-chat-panel')).toBeVisible()
}

// Append a transcript item shaped like the real render output. Injection is used
// because the AI transport is a streaming Tauri command the mock doesn't
// implement — the layout only depends on the resulting DOM.
const addMessage = (page: Page, inner: string) =>
  page.evaluate((html) => {
    const msgs = document.querySelector('.ai-chat-messages')!
    const msg = document.createElement('div')
    msg.className = 'ai-chat-msg ai-chat-msg-assistant'
    msg.innerHTML =
      '<div class="ai-chat-msg-head"><span class="ai-chat-msg-role">AI</span></div>' +
      `<div class="ai-chat-msg-body">${html}</div>`
    msgs.appendChild(msg)
  }, inner)

const wideTranscript = async (page: Page) => {
  // A long code line, a long unbreakable paragraph (the `changes={...}` JSON the
  // AI echoes back) and a collapsed tool-call card whose summary is nowrap.
  await addMessage(
    page,
    '<div class="ai-chat-msg-content"><pre class="ai-chat-code-block"><code>' +
      'x'.repeat(800) +
      '</code></pre></div>',
  )
  await addMessage(page, `<div class="ai-chat-msg-content"><p>${'y'.repeat(800)}</p></div>`)
  await addMessage(
    page,
    '<div class="ai-tool-card ai-tool-done"><div class="ai-tool-head">' +
      '<span class="ai-tool-icon"></span>' +
      `<span class="ai-tool-name">Change appearance settings: changes=${'{"terminal.palette":"dark"},'.repeat(30)}</span>` +
      '<span class="ai-tool-status">done</span></div></div>',
  )
}

const measure = (page: Page) =>
  page.evaluate(() => {
    const box = (s: string) => {
      const el = document.querySelector(s) as HTMLElement
      const r = el.getBoundingClientRect()
      return {
        left: Math.round(r.left),
        right: Math.round(r.right),
        clientW: el.clientWidth,
        scrollW: el.scrollWidth,
      }
    }
    return {
      win: window.innerWidth,
      insp: box('.inspector'),
      panel: box('.ai-chat-panel'),
      header: box('.ai-chat-header'),
      messages: box('.ai-chat-messages'),
    }
  })

for (const vp of [
  { width: 1080, height: 600 },
  { width: 1440, height: 900 },
  { width: 760, height: 600 },
]) {
  test(`the inspector's AI panel is not widened by its transcript at ${vp.width}x${vp.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(vp)
    await openAiChat(page)

    const before = await measure(page)
    await wideTranscript(page)
    const after = await measure(page)
    console.log(`[${vp.width}]`, JSON.stringify(after))

    // The panel fills the column and nothing overflows it.
    expect(before.panel.clientW).toBe(before.insp.clientW)
    expect(after.panel.clientW).toBe(before.panel.clientW)
    expect(after.panel.right).toBeLessThanOrEqual(after.insp.right + 1)
    expect(after.header.clientW).toBe(after.panel.clientW)

    // Wide content wraps / is ellipsized instead of overflowing.
    expect(after.panel.scrollW).toBeLessThanOrEqual(after.panel.clientW + 1)
    expect(after.header.scrollW).toBeLessThanOrEqual(after.header.clientW + 1)
    expect(after.messages.scrollW).toBeLessThanOrEqual(after.messages.clientW + 1)

    // The column never eats the window: the terminal is still on screen beside
    // it, which is the whole point of moving AI out of a full-screen tab.
    expect(after.insp.right).toBeLessThanOrEqual(after.win)
    await expect(page.locator('.terminal-split-root')).toBeVisible()
  })
}

// The same panel is also docked inside a terminal pane (`.ai-dock-pane`), which
// is a flex item of `.term-pane-body` — it must not be widened by the transcript
// either, or it would squeeze the terminal next to it.
test('the docked AI pane keeps its width with wide content', async ({ page }) => {
  await page.setViewportSize({ width: 1080, height: 600 })
  await installTauriMock(page, {
    connections: [DEMO_CONN],
    pollOutputChunks: [['root@demo:~$ ']],
    aiConfig: AI_CONFIG,
  })
  await page.goto('/')
  await page.locator('.connection-item').click()
  await page.locator('.term-pane-ai-toggle').click()
  const dock = page.locator('.ai-dock-pane')
  await expect(dock).toBeVisible()

  const widths = () =>
    page.evaluate(() => {
      const d = document.querySelector('.ai-dock-pane') as HTMLElement
      const p = d.querySelector('.ai-chat-panel') as HTMLElement
      return { dock: d.clientWidth, panelClientW: p.clientWidth, panelScrollW: p.scrollWidth }
    })
  const before = await widths()

  await wideTranscript(page)

  const after = await widths()
  console.log('[dock]', JSON.stringify(after))

  expect(after.dock).toBe(before.dock)
  expect(after.panelClientW).toBe(before.panelClientW)
  expect(after.panelScrollW).toBeLessThanOrEqual(after.panelClientW + 1)
})

test('asking the assistant opens the inspector, not a workspace tab', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await installTauriMock(page, {
    connections: [DEMO_CONN],
    pollOutputChunks: [['root@demo:~$ ']],
    aiConfig: AI_CONFIG,
  })
  await page.goto('/')
  await page.locator('.connection-item').click()
  await expect(page.locator('.tab-item')).toHaveCount(1)
  await expect(page.locator('.inspector')).toHaveCount(0)

  await page.locator('.titlebar-btn.ai-chat-btn').click()

  // The old behaviour added a second tab whose pane covered the terminal. The
  // assistant is a view of the session you are already looking at, so the tab
  // count must not move and the terminal must stay on screen.
  await expect(page.locator('.tab-item')).toHaveCount(1)
  await expect(page.locator('.inspector-tabs .tab-btn')).toHaveText([
    'Analysis',
    'Docker',
    'AI',
    'Network',
  ])
  await expect(page.locator('.inspector-tabs .tab-btn').nth(2)).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(page.locator('.inspector .ai-chat-panel')).toBeVisible()
  await expect(page.locator('.terminal-split-root')).toBeVisible()
})

test('switching inspector tabs keeps the AI panel mounted', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await openAiChat(page)
  const panel = page.locator('.inspector .ai-chat-panel')

  // A run polls the backend from a closure inside the panel and the unmount
  // cleanup cancels that chain, so an unmount mid-reply would strand it. Tag the
  // node: if the panel were unmounted and rebuilt, the tag would be gone.
  await page.evaluate(() => {
    ;(document.querySelector('.ai-chat-panel') as HTMLElement).dataset.probe = 'mounted'
  })
  const draft = 'keep this draft alive'
  await panel.locator('textarea').fill(draft)

  await page.locator('.inspector-tabs .tab-btn').nth(0).click()
  await expect(panel).toBeHidden()
  await expect(page.locator('.host-analysis-panel')).toBeVisible()
  await expect(page.locator('.ai-chat-panel')).toHaveCount(1)

  await page.locator('.inspector-tabs .tab-btn').nth(2).click()
  await expect(panel).toBeVisible()
  await expect(panel).toHaveJSProperty('dataset.probe', 'mounted')
  await expect(panel.locator('textarea')).toHaveValue(draft)
})

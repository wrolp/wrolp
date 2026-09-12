import { test, expect, type Page } from '@playwright/test'
import { installTauriMock } from './helpers/tauriMock'

// Layout of the standalone AI Chat tab (opened from the titlebar AI button).
//
// Regression: the right side of the dialog was clipped. Root cause — the tab
// wrapper is a flex item (`flex: 1`) without `min-width: 0`, so its *automatic
// minimum size* was the min-content width of the chat panel, i.e. the width of
// the widest unbreakable run in the transcript (a JSON blob the AI echoed, or
// the `changes={...}` tool-call summary, which is `white-space: nowrap`). The
// panel then grew to ~4400px instead of the window width and everything past
// the right edge was cut off by `.shell-pane-body { overflow: hidden }`.

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

const openAiChat = async (page: Page) => {
  await installTauriMock(page, { aiConfig: AI_CONFIG })
  await page.goto('/')
  await page.locator('.titlebar-btn.ai-chat-btn').click()
  await expect(page.locator('.ai-chat-panel')).toBeVisible()
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
  test(`the AI chat dialog is not clipped on the right at ${vp.width}x${vp.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(vp)
    await openAiChat(page)

    const before = await measure(page)

    // A wide transcript: a long code line, a long unbreakable paragraph (the
    // `changes={...}` JSON the AI echoes back) and a collapsed tool-call card
    // whose summary line is `white-space: nowrap`.
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

    const after = await measure(page)
    console.log(`[${vp.width}]`, JSON.stringify(after))

    // The dialog still fills the window exactly — it must not have grown.
    expect(after.panel.right).toBeLessThanOrEqual(after.win + 1)
    expect(after.panel.right).toBeGreaterThanOrEqual(after.win - 2)
    expect(after.panel.clientW).toBe(before.panel.clientW)
    expect(after.header.clientW).toBe(before.panel.clientW)

    // Wide content wraps / is ellipsized instead of overflowing the panel.
    expect(after.panel.scrollW).toBeLessThanOrEqual(after.panel.clientW + 1)
    expect(after.header.scrollW).toBeLessThanOrEqual(after.header.clientW + 1)
    expect(after.messages.scrollW).toBeLessThanOrEqual(after.messages.clientW + 1)
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

  await addMessage(page, `<div class="ai-chat-msg-content"><p>${'y'.repeat(800)}</p></div>`)
  await addMessage(
    page,
    '<div class="ai-tool-card ai-tool-done"><div class="ai-tool-head">' +
      '<span class="ai-tool-icon"></span>' +
      `<span class="ai-tool-name">Change appearance settings: changes=${'{"terminal.palette":"dark"},'.repeat(30)}</span>` +
      '<span class="ai-tool-status">done</span></div></div>',
  )

  const after = await widths()
  console.log('[dock]', JSON.stringify(after))

  expect(after.dock).toBe(before.dock)
  expect(after.panelClientW).toBe(before.panelClientW)
  expect(after.panelScrollW).toBeLessThanOrEqual(after.panelClientW + 1)
})

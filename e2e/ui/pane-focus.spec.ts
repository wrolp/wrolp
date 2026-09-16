import { test, expect, type Page } from './helpers/fixtures'
import { installTauriMock, invokedCalls } from './helpers/tauriMock'

// Pane chrome must not steal the keyboard from the shell.
//
// The status-bar switches ("Tail room" / "Line numbers") and the pane-header "AI 对话"
// toggle are side trips *inside* a session: after clicking one, the user wants to keep
// typing. A `<button>` takes focus on mousedown, so the next keystroke went nowhere until
// the terminal was clicked again. All three now cancel that default action
// (`preventDefault` on mousedown) — and because keyboard activation has no mousedown,
// Tab/Enter still reach the buttons themselves.

const DEMO_CONN = { id: 'c1', name: 'Demo', host: 'demo.local', port: 22, username: 'root' }
const FIRST_OUTPUT =
  Array.from({ length: 40 }, (_, i) => `line-${i}\r\n`).join('') + 'root@demo:~$ '

// One saved profile: without it the app shows no AI at all (`load_ai_config` → `{}`) and
// the pane's AI toggle cannot open its dock.
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

async function openTerminal(page: Page) {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('wrolp-lang', 'en')
    } catch {
      /* ignore */
    }
  })
  await installTauriMock(page, {
    connections: [DEMO_CONN],
    pollOutputChunks: [FIRST_OUTPUT],
    aiConfig: AI_CONFIG,
  })
  await page.goto('/')
  await page.locator('.connection-item').click()
  await expect(page.locator('.xterm-helper-textarea')).toBeAttached()
  await page.waitForTimeout(300)
}

/** Class list of whatever holds keyboard focus right now. */
const focusedClass = (page: Page) => page.evaluate(() => document.activeElement?.className ?? '')

/** Put the keyboard in the shell the way a user does — by clicking it. */
async function clickTerminal(page: Page) {
  await page.locator('.term-pane-term .xterm-screen').click()
  expect(await focusedClass(page)).toContain('xterm-helper-textarea')
}

/** Type one character and require it to reach the session — the end the user cares about
 *  (xterm forwards keystrokes through `send_input`; a lone keypress with no focus goes
 *  nowhere and this poll times out). */
async function expectTypingReachesSession(page: Page) {
  const before = (await invokedCalls(page)).filter((c) => c.cmd === 'send_input').length
  await page.keyboard.type('q')
  await expect
    .poll(async () => (await invokedCalls(page)).filter((c) => c.cmd === 'send_input').length)
    .toBeGreaterThan(before)
}

/** Whether the keyboard sits inside the Monaco editor (its hidden textarea). Asserting on
 *  the *container* rather than on a textarea class name keeps this independent of Monaco's
 *  internal markup. */
const focusInEditor = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null
    return !!el && !!el.closest('.monaco-editor')
  })

const FILE_NAME = 'focus.txt'
const FILE_CONTENT = ['first', 'second', 'third'].join('\n')

/** Opens a file in the editor of the (single) shell pane, like `editor-word-wrap.spec.ts`. */
async function openEditorFile(page: Page) {
  await installTauriMock(page, {
    connections: [DEMO_CONN],
    pollOutputChunks: [FIRST_OUTPUT],
    fileEntries: [
      {
        name: FILE_NAME,
        path: `/home/root/${FILE_NAME}`,
        isDir: false,
        size: FILE_CONTENT.length,
        mode: '-rw-r--r--',
        modified: '',
      },
    ],
    fileContent: {
      path: `/home/root/${FILE_NAME}`,
      content: FILE_CONTENT,
      size: FILE_CONTENT.length,
      mode: '-rw-r--r--',
      isBinary: false,
      isTooLarge: false,
      encoding: 'utf-8',
      needsEncoding: false,
    },
  })
  await page.goto('/')
  await page.locator('.connection-item').click()
  await expect(page.locator('.term-pane')).toHaveCount(1)
  const file = page.locator('.tree-row.file', { hasText: FILE_NAME })
  await expect(file).toBeVisible()
  await file.click()
  await expect(page.locator('.monaco-editor .view-line').first()).toBeVisible()
  await page.locator('.monaco-editor').click()
  expect(await focusInEditor(page)).toBe(true)
}

test('the status-bar switches keep keyboard focus in the terminal', async ({ page }) => {
  await openTerminal(page)
  await clickTerminal(page)

  for (const key of ['terminal.tailRoom', 'terminal.lineNumbers']) {
    const sw = page.locator(`.tsb-toggle[data-setting="${key}"]`)
    await expect(sw).toBeVisible()
    const before = (await sw.getAttribute('aria-pressed')) === 'true'
    await sw.click()
    // The click still flips the switch…
    await expect(sw).toHaveAttribute('aria-pressed', before ? 'false' : 'true')
    // …and the keyboard is still in the shell.
    expect(await focusedClass(page), `${key} must not steal focus`).toContain(
      'xterm-helper-textarea',
    )
    await expectTypingReachesSession(page)
  }
})

test('the pane’s AI-chat toggle keeps keyboard focus in the terminal', async ({ page }) => {
  await openTerminal(page)
  await clickTerminal(page)

  await page.locator('.term-pane-ai-toggle').click()
  // The click still opens the docked panel…
  await expect(page.locator('.ai-dock-pane')).toBeVisible()
  // …without taking the keyboard away from the shell.
  expect(await focusedClass(page)).toContain('xterm-helper-textarea')
  await expectTypingReachesSession(page)
})

test('the editor toolbar keeps keyboard focus in the editor', async ({ page }) => {
  await openEditorFile(page)

  // The three display switches of the toolbar…
  for (const cls of ['wrap-toggle', 'sticky-toggle', 'tail-toggle']) {
    const btn = page.locator(`.editor-btn.${cls}`)
    await expect(btn).toBeVisible()
    const before = (await btn.getAttribute('aria-pressed')) === 'true'
    await btn.click()
    await expect(btn).toHaveAttribute('aria-pressed', before ? 'false' : 'true')
    expect(await focusInEditor(page), `${cls} must not steal focus`).toBe(true)
  }

  // …and a button that carries no class of its own: the rule is one handler on the
  // toolbar, not a per-button option.
  const map = page.locator('.editor-btn', { hasText: 'Map' })
  await map.click()
  await expect(map).toContainText('◫')
  expect(await focusInEditor(page)).toBe(true)

  // Save is the awkward one: the button turns `disabled` as soon as the file is clean
  // again, and a disabled button cannot hold focus — without the rule the keyboard would
  // end up on `<body>`. Typing in between is also the end-to-end proof that the focus
  // really is in the document.
  const save = page.locator('.editor-btn.primary')
  await expect(save).toBeDisabled()
  await page.keyboard.type('x')
  await expect(save).toBeEnabled()
  expect(await focusInEditor(page)).toBe(true)

  await save.click()
  await expect(save).toBeDisabled()
  expect(await focusInEditor(page)).toBe(true)
})

import { test, expect, type Page } from './helpers/fixtures'
import { installTauriMock } from './helpers/tauriMock'

// The editor toolbar's sticky toggle must pin the enclosing scope (function /
// class / block) to the top of the viewport while its body is scrolled through,
// and stay off until asked (the preference lives in lib/editorPrefs, default off
// = Monaco's own default, so the editor keeps behaving as before).
// See task/todo.md → 「文件树浏览 + 代码编辑器增强（P5）」.

const DEMO_CONN = { id: 'c1', name: 'Demo', host: 'demo.local', port: 22, username: 'root' }

const FILE_NAME = 'scopes.js'
const FILE_PATH = `/home/root/${FILE_NAME}`
// One long function: scrolling into its body pushes the `function …` line off the
// top of the viewport, which is exactly when a sticky header is useful.
const CONTENT = [
  'const config = { debug: false }',
  '',
  'function stickyTarget() {',
  ...Array.from({ length: 140 }, (_, i) => `  const v${i} = ${i}`),
  '  const STICKY_BODY_END = true',
  '  return config',
  '}',
].join('\n')

const FILE_ENTRY = {
  name: FILE_NAME,
  path: FILE_PATH,
  isDir: false,
  size: CONTENT.length,
  mode: '-rw-r--r--',
  modified: '',
}

/** Monaco renders the pinned scope as `.sticky-line-content` rows. */
function stickyLineCount(page: Page): Promise<number> {
  return page.locator('.monaco-editor .sticky-line-content').count()
}

/**
 * Wheel-scroll the editor down by `ticks` gestures — one gesture only advances a
 * small step (Chromium and Monaco both clamp it, so `deltaY` barely matters).
 * Deliberately NOT scrolled to the very bottom: with the tail room (default) the
 * last lines sit above an empty viewport, where nothing encloses the top line and
 * the pinned header correctly disappears.
 */
async function scrollDown(page: Page, ticks = 30) {
  const box = (await page.locator('.editor-host').boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  for (let i = 0; i < ticks; i++) {
    await page.mouse.wheel(0, 200)
  }
  // Monaco needs a beat to move the lines (and the sticky widget re-renders on
  // the scroll event).
  await page.waitForTimeout(500)
}

async function openScopesFile(page: Page, seedSticky = false) {
  if (seedSticky) {
    // The preference is read at mount, so seed it before the app boots.
    await page.addInitScript(() => {
      localStorage.setItem('wrolp-editor-sticky-scroll', '1')
    })
  }

  await installTauriMock(page, {
    connections: [DEMO_CONN],
    pollOutputChunks: [['root@demo:~$ ']],
    fileEntries: [FILE_ENTRY],
    fileContent: {
      path: FILE_PATH,
      content: CONTENT,
      size: CONTENT.length,
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
}

test('the sticky toggle pins the enclosing scope while scrolling (off by default)', async ({
  page,
}) => {
  await openScopesFile(page)

  const toggle = page.locator('.editor-btn.sticky-toggle')
  await expect(toggle).toHaveAttribute('aria-pressed', 'false') // off by default

  // Deep inside the function body — the header is off screen, nothing pinned.
  await scrollDown(page)
  const viewLine = page.locator('.monaco-editor .view-line').first()
  await expect(viewLine).toContainText('v')

  // On → the enclosing `function stickyTarget()` line is pinned at the top. The
  // outline model the widget is built from arrives from the TS worker async, so
  // give it a moment.
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => stickyLineCount(page), { timeout: 15_000 }).toBeGreaterThan(0)
  await expect(page.locator('.monaco-editor .sticky-line-content').first()).toContainText(
    'stickyTarget',
  )

  // Off again → the pinned header goes away.
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expect.poll(() => stickyLineCount(page), { timeout: 15_000 }).toBe(0)
})

test('the sticky preference is restored from localStorage', async ({ page }) => {
  await openScopesFile(page, true)

  await expect(page.locator('.editor-btn.sticky-toggle')).toHaveAttribute('aria-pressed', 'true')

  await scrollDown(page)
  await expect.poll(() => stickyLineCount(page), { timeout: 15_000 }).toBeGreaterThan(0)
  await expect(page.locator('.monaco-editor .sticky-line-content').first()).toContainText(
    'stickyTarget',
  )
})

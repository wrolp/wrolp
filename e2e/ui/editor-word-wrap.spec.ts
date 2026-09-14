import { test, expect, type Page } from './helpers/fixtures'
import { installTauriMock } from './helpers/tauriMock'

// The editor toolbar's wrap toggle must soft-wrap long lines on demand, and stay
// off until asked (long code/config lines are easier to read unwrapped by
// default; the preference lives in lib/editorPrefs).
// See task/todo.md → 「编辑器：末尾留白 / 自动换行可选」.

const DEMO_CONN = { id: 'c1', name: 'Demo', host: 'demo.local', port: 22, username: 'root' }

const FILE_NAME = 'long.txt'
const LONG_LINE = `LONG_LINE_START ${'x'.repeat(1200)} LONG_LINE_END`
const CONTENT = ['first', LONG_LINE, 'last'].join('\n')

/** Monaco renders one `.view-line` per VISUAL line, so wrapping a long line adds
 *  more of them than the file has logical lines. */
function viewLineCount(page: Page): Promise<number> {
  return page.locator('.monaco-editor .view-line').count()
}

test('the wrap toggle soft-wraps a long line (off by default)', async ({ page }) => {
  await installTauriMock(page, {
    connections: [DEMO_CONN],
    pollOutputChunks: [['root@demo:~$ ']],
    fileEntries: [
      {
        name: FILE_NAME,
        path: `/home/root/${FILE_NAME}`,
        isDir: false,
        size: CONTENT.length,
        mode: '-rw-r--r--',
        modified: '',
      },
    ],
    fileContent: {
      path: `/home/root/${FILE_NAME}`,
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

  const toggle = page.locator('.editor-btn.wrap-toggle')
  await expect(toggle).toHaveAttribute('aria-pressed', 'false') // off by default

  // 3 logical lines, one of them far wider than the pane — none of it wraps yet.
  expect(await viewLineCount(page)).toBe(3)

  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  // The wide line becomes several visual lines (3 logical + its continuations).
  await expect.poll(() => viewLineCount(page), { timeout: 10_000 }).toBeGreaterThan(3)

  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expect.poll(() => viewLineCount(page), { timeout: 10_000 }).toBe(3)
})

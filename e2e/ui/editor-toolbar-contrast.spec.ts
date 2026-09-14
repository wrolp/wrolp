import { test, expect, type Page } from './helpers/fixtures'
import { installTauriMock } from './helpers/tauriMock'
import { contrastRatio, type Rgb } from '../../src/components/terminal/sgrContrast'

// The editor toolbar's buttons were hard to read: the "on"/primary states were
// `color: $accent` on a 15% accent wash — blue on blue-grey, 2.0:1 in the dark
// theme and 4.3:1 in the light one — and the off state used `$text-muted`, only
// 2.8:1 on its own `$bg-input` in the dark theme.
// They are now a solid accent fill with on-accent text, plus `$text-secondary`
// labels, and must stay above WCAG AA (4.5:1) in BOTH themes.
// See task/todo.md → 「编辑器工具栏按钮看不清（Tail room / Wrap / Save）」.

const FILE_NAME = 'notes.txt'
const CONTENT = 'first\nsecond\n'

/** `rgb(r, g, b)` / `rgba(r, g, b, a)` → RGB. */
function parseRgb(value: string): Rgb {
  const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(value)
  if (!m) throw new Error(`Unparsable computed colour: ${value}`)
  return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) }
}

/** The button palette is JS-free CSS, but the THEME is a `<html>` attribute, so
 *  seed it before the app boots (same trick as the terminal-contrast specs). */
async function openEditor(page: Page, theme: 'dark' | 'light') {
  await page.addInitScript((mode) => {
    localStorage.setItem('wrolp-theme', mode)
  }, theme)

  await installTauriMock(page, {
    connections: [{ id: 'c1', name: 'Demo', host: 'demo.local', port: 22, username: 'root' }],
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
}

async function buttonColours(page: Page, selector: string) {
  return await page.evaluate((sel) => {
    const el = document.querySelector<HTMLElement>(sel)
    if (!el) throw new Error(`missing ${sel}`)
    const cs = getComputedStyle(el)
    return { color: cs.color, background: cs.backgroundColor }
  }, selector)
}

for (const theme of ['dark', 'light'] as const) {
  test(`the editor toolbar buttons are legible in the ${theme} theme`, async ({ page }) => {
    await openEditor(page, theme)

    // Save only carries the primary palette while it is actionable.
    await page.locator('.monaco-editor').click()
    await page.keyboard.type('x')
    await expect(page.locator('.editor-btn.primary')).toBeEnabled()

    const states: Array<[string, string]> = [
      ['toggle off', '.editor-btn.wrap-toggle'],
      ['toggle on', '.editor-btn.tail-toggle'],
      ['primary action', '.editor-btn.primary'],
    ]
    for (const [label, selector] of states) {
      const { color, background } = await buttonColours(page, selector)
      const ratio = contrastRatio(parseRgb(color), parseRgb(background))
      expect(ratio, `${label}: ${color} on ${background}`).toBeGreaterThanOrEqual(4.5)
    }
  })
}

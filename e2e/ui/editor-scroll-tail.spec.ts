import { test, expect, type Page } from './helpers/fixtures'
import { installTauriMock } from './helpers/tauriMock'

// The tail of a file must be scrollable up to the TOP of the viewport, in both the
// Monaco editor (`scrollBeyondLastLine`) and the hex dump viewer (tail room), so
// the last lines can be read with the room after them in view. Without that room
// the last line is pinned to the BOTTOM edge of the viewport and the view stops
// there.
//
// The room is a PREFERENCE (`wrolp-editor-scroll-beyond-last-line`), enabled by
// default and toggled by the editor toolbar's `.tail-toggle`; the hex viewer
// follows the same switch.
// See task/todo.md → 「编辑器 / Hex 查看器：末尾几行可滚到视口顶部」.

const DEMO_CONN = { id: 'c1', name: 'Demo', host: 'demo.local', port: 22, username: 'root' }

const FILE_ARGS = {
  path: '/home/root/stub',
  mode: '-rw-r--r--',
  isBinary: false,
  isTooLarge: false,
  encoding: 'utf-8',
  needsEncoding: false,
}

const TEXT_PATH = '/home/root/big.txt'
const LAST_LINE = 'LAST_LINE_MARKER'
// Enough lines to overflow any reasonable pane height (~200 * 19px ≈ 3.8k px).
const TEXT_CONTENT = [...Array.from({ length: 199 }, (_, i) => `line ${i + 1}`), LAST_LINE].join(
  '\n',
)

const BIN_PATH = '/home/root/data.bin'
const BIN_BYTES = 4096
const BIN_B64 = Buffer.from(Array.from({ length: BIN_BYTES }, (_, i) => i % 256)).toString('base64')

/** Open the demo connection and click the mock file into the pane's editor. */
async function openFile(page: Page, name: string, fileContent: Record<string, unknown>) {
  await installTauriMock(page, {
    connections: [DEMO_CONN],
    pollOutputChunks: [['root@demo:~$ ']],
    fileEntries: [
      {
        name,
        path: `/home/root/${name}`,
        isDir: false,
        size: 4096,
        mode: '-rw-r--r--',
        modified: '',
      },
    ],
    fileContent,
  })
  await page.goto('/')
  await page.locator('.connection-item').click()
  await expect(page.locator('.term-pane')).toHaveCount(1)

  const file = page.locator('.tree-row.file', { hasText: name })
  await expect(file).toBeVisible()
  await file.click()
  await expect(page.locator('.tab-item', { hasText: name })).toHaveCount(1)
}

/** Vertical scroll position of the Monaco view (px), read off its line container. */
async function scrollPosition(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const content = document.querySelector<HTMLElement>('.monaco-editor .lines-content')
    return content ? -parseFloat(getComputedStyle(content).top || '0') : Number.NaN
  })
}

/**
 * Wheel-scroll the editor to its very bottom. A single wheel gesture only advances
 * one small tick (Chromium and Monaco both clamp it), so tick in rounds until the
 * position stops changing — that is the maximum scroll position.
 */
async function wheelToBottom(page: Page) {
  const box = (await page.locator('.editor-host').boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  for (let round = 0; round < 10; round++) {
    const before = await scrollPosition(page)
    for (let i = 0; i < 40; i++) {
      await page.mouse.wheel(0, 200)
    }
    await page.waitForTimeout(100)
    if ((await scrollPosition(page)) === before) return
  }
}

/**
 * How many rendered line heights separate the top of the editor viewport from the
 * line holding `text` — 0 means that line sits at the very top. `Infinity` while
 * the line is not rendered (not scrolled far enough).
 */
async function offsetInLines(page: Page, text: string): Promise<number> {
  return await page.evaluate((needle) => {
    const host = document.querySelector('.editor-host')
    if (!host) return Number.POSITIVE_INFINITY
    const lines = Array.from(document.querySelectorAll<HTMLElement>('.monaco-editor .view-line'))
    const target = lines.find((l) => (l.textContent ?? '').includes(needle))
    if (!target) return Number.POSITIVE_INFINITY
    const lineH = lines[0].getBoundingClientRect().height || 1
    const hostTop = host.getBoundingClientRect().top
    return (target.getBoundingClientRect().top - hostTop) / lineH
  }, text)
}

/** Scroll the hex dump to its very bottom (the browser clamps to the maximum). */
async function scrollHexToBottom(page: Page) {
  await page.evaluate(() => {
    const body = document.querySelector<HTMLElement>('.hex-body')!
    body.scrollTop = body.scrollHeight
  })
}

/** Distance from the top of the hex viewport to its last row, in px. */
async function lastHexRowOffset(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const body = document.querySelector<HTMLElement>('.hex-body')!
    const all = body.querySelectorAll<HTMLElement>('.hex-row')
    const last = all[all.length - 1]
    return last.getBoundingClientRect().top - body.getBoundingClientRect().top
  })
}

test('the editor can scroll the last line up to the top of the viewport', async ({ page }) => {
  await openFile(page, 'big.txt', {
    ...FILE_ARGS,
    path: TEXT_PATH,
    content: TEXT_CONTENT,
    size: TEXT_CONTENT.length,
  })

  await expect(page.locator('.monaco-editor .view-line').first()).toBeVisible()
  await wheelToBottom(page)

  // `< 1` line: the marker is the topmost line on screen, roughly flush with the
  // viewport top instead of parked against its bottom edge.
  await expect.poll(() => offsetInLines(page, LAST_LINE), { timeout: 15_000 }).toBeLessThan(1)
})

test('the tail-room toggle is on by default and can turn the room off again', async ({ page }) => {
  await openFile(page, 'big.txt', {
    ...FILE_ARGS,
    path: TEXT_PATH,
    content: TEXT_CONTENT,
    size: TEXT_CONTENT.length,
  })

  await expect(page.locator('.monaco-editor .view-line').first()).toBeVisible()
  const toggle = page.locator('.editor-btn.tail-toggle')
  await expect(toggle).toHaveAttribute('aria-pressed', 'true') // default: enabled

  // Off → the last line is back to being pinned to the bottom edge.
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await wheelToBottom(page)
  await expect.poll(() => offsetInLines(page, LAST_LINE), { timeout: 15_000 }).toBeGreaterThan(5)

  // On again → the tail room is back.
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await wheelToBottom(page)
  await expect.poll(() => offsetInLines(page, LAST_LINE), { timeout: 15_000 }).toBeLessThan(1)
})

test('the hex dump can scroll its last row up to the top of the viewport', async ({ page }) => {
  await openFile(page, 'data.bin', {
    ...FILE_ARGS,
    path: BIN_PATH,
    size: BIN_BYTES,
    isBinary: true,
    content: '',
    hexBase64: BIN_B64,
  })

  const rows = page.locator('.hex-body .hex-row')
  await expect(rows).toHaveCount(BIN_BYTES / 16)

  // The dump must actually overflow, otherwise the assertion below is vacuous.
  const overflow = await page.evaluate(() => {
    const body = document.querySelector<HTMLElement>('.hex-body')!
    return body.scrollHeight - body.clientHeight
  })
  expect(overflow).toBeGreaterThan(200)

  await scrollHexToBottom(page)

  // One line height (18px) at worst, instead of the whole viewport height without
  // the tail room.
  expect(await lastHexRowOffset(page)).toBeLessThan(20)
})

test('the hex dump drops its tail room when the preference is turned off', async ({ page }) => {
  // The preference is read at mount (default = on), so seed it before the app boots.
  await page.addInitScript(() => {
    localStorage.setItem('wrolp-editor-scroll-beyond-last-line', '0')
  })

  await openFile(page, 'data.bin', {
    ...FILE_ARGS,
    path: BIN_PATH,
    size: BIN_BYTES,
    isBinary: true,
    content: '',
    hexBase64: BIN_B64,
  })

  await expect(page.locator('.hex-body .hex-row')).toHaveCount(BIN_BYTES / 16)
  await expect(page.locator('.hex-tail')).toHaveCount(0)

  await scrollHexToBottom(page)

  // Without the tail the last row stops at the bottom edge — a whole viewport away
  // from the top.
  expect(await lastHexRowOffset(page)).toBeGreaterThan(200)
})

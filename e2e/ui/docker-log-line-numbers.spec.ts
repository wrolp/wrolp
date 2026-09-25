import { test, expect, type Page, type Locator } from './helpers/fixtures'
import { installTauriMock } from './helpers/tauriMock'
import { expandSection } from './helpers/sections'

// Line numbers in the Docker log tab. The tab renders coloured HTML into one <pre>, so a
// number column cannot be a separate scroll-synced list: with Wrap on, a long line covers
// several visual rows and an outside gutter drifts. Each *logical* line therefore becomes
// a row of its own, with the number as a sticky first cell — which raises the two things
// these tests pin down: the number must sit on the line's first row, and it must not end
// up in the copied text.

declare global {
  interface Window {
    __copied: string[]
  }
}

const DEMO_CONN = { id: 'c1', name: 'Demo', host: 'demo.local', port: 22, username: 'root' }
const PROMPT = 'root@demo:~# '
const CONTAINER = {
  id: '9f2c1a4b8e0d',
  name: 'wrolp-api',
  image: 'wrolp/api:1.4',
  state: 'running',
  status: 'Up 3 hours',
}

const LINES = [
  '2026-09-25T08:00:01Z INFO request 1 handled',
  '',
  '2026-09-25T08:00:03Z WARN ' + 'x'.repeat(400),
  '2026-09-25T08:00:04Z ERROR db connection refused',
]
const LOG = LINES.join('\n')

async function openLogViewer(page: Page, log = LOG): Promise<Locator> {
  await page.addInitScript(() => {
    localStorage.setItem('wrolp-lang', 'en')
    // Follow off → one fetch, so nothing re-renders under the test.
    localStorage.setItem('wrolp-docker-follow', '0')
  })
  await installTauriMock(page, {
    connections: [DEMO_CONN],
    pollOutputChunks: [[PROMPT]],
    dockerContainers: [CONTAINER],
    dockerLogsByContainer: { [CONTAINER.name]: log },
  })
  await page.goto('/')
  await page.locator('.connection-item').first().click()
  await expandSection(page, 'Docker')
  const item = page.locator('.docker-item').first()
  await expect(item).toBeVisible()
  await item.click({ button: 'right' })
  await page.locator('.context-menu-item', { hasText: 'View Logs' }).click()
  const output = page.locator('.dlv-output')
  await expect(output).toContainText(log.split('\n').pop()!.slice(0, 24))
  return output
}

const numbersToggle = (page: Page) => page.locator('.dlv-checkbox', { hasText: 'Line numbers' })

test('one number per log line, including the blank ones', async ({ page }) => {
  const output = await openLogViewer(page)
  // Off by default: the log is the whole width, exactly as before.
  await expect(output.locator('.dlv-ln')).toHaveCount(0)

  await numbersToggle(page).click()
  await expect(output.locator('.dlv-ln')).toHaveCount(LINES.length)
  expect(await output.locator('.dlv-ln').allTextContents()).toEqual(
    LINES.map((_, i) => String(i + 1)),
  )
  const bodies = output.locator('.dlv-line-body')
  for (const [i, line] of LINES.entries()) {
    await expect(bodies.nth(i)).toHaveText(line)
  }

  // The blank line still owns a row — otherwise its number would stack onto the next.
  const blank = await bodies.nth(1).boundingBox()
  const first = await bodies.nth(0).boundingBox()
  expect(blank!.height).toBeGreaterThan(0)
  expect(Math.round(blank!.height)).toBe(Math.round(first!.height))
})

test('the number column is the same width on every row', async ({ page }) => {
  // 12 lines straddles the 1→2 digit boundary; a buffer capped at 10 000+ lines straddles
  // others. A `min-width` column would be uniform here but not there, and slack-wide both.
  const many = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n')
  const output = await openLogViewer(page, many)
  await numbersToggle(page).click()

  const geom = await output.evaluate((pre) => {
    const gutters = Array.from(pre.querySelectorAll<HTMLElement>('.dlv-ln'))
    const widest = gutters[gutters.length - 1]
    const range = document.createRange()
    range.selectNodeContents(widest.firstChild!)
    const pad = getComputedStyle(widest)
    return {
      gutterWidths: [
        ...new Set(gutters.map((el) => Math.round(el.getBoundingClientRect().width * 10) / 10)),
      ],
      bodyStarts: [
        ...new Set(
          Array.from(pre.querySelectorAll<HTMLElement>('.dlv-line-body')).map((el) =>
            Math.round(el.getBoundingClientRect().x),
          ),
        ),
      ],
      widestText: range.getBoundingClientRect().width,
      padding:
        parseFloat(pad.paddingLeft) + parseFloat(pad.paddingRight) + parseFloat(pad.borderLeft),
    }
  })

  expect(geom.gutterWidths).toHaveLength(1)
  expect(geom.bodyStarts).toHaveLength(1)
  // …and the column is only as wide as the largest number needs, not a fixed reserve.
  expect(geom.gutterWidths[0]).toBeCloseTo(geom.widestText + geom.padding, 0)
})

test('a wrapped line keeps its number on its first row', async ({ page }) => {
  const output = await openLogViewer(page)
  await numbersToggle(page).click()
  const lines = output.locator('.dlv-line')
  const shortRow = await lines.nth(0).boundingBox()
  const wrapped = await lines.nth(2).boundingBox()
  // Wrap is on by default, so the 400-column line must span several rows…
  expect(wrapped!.height).toBeGreaterThan(shortRow!.height * 2)
  // …and the number has to stay at the top of it, not drift to a continuation row.
  const gutter = await output.locator('.dlv-ln').nth(2).boundingBox()
  expect(gutter!.y).toBeCloseTo(wrapped!.y, 0)
})

test('the numbers stay out of the copied text', async ({ page }) => {
  // Before the navigation: `addInitScript` only reaches pages that have not loaded yet.
  await page.addInitScript(() => {
    window.__copied = []
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: (text: string) => {
          window.__copied.push(text)
          return Promise.resolve()
        },
      },
      configurable: true,
    })
  })
  const output = await openLogViewer(page)
  await numbersToggle(page).click()

  const selected = await page.evaluate(() => {
    const pre = document.querySelector('.dlv-output')!
    const bodies = pre.querySelectorAll<HTMLElement>('.dlv-line-body')
    const last = bodies[bodies.length - 1]
    const range = document.createRange()
    range.setStart(bodies[0], 0)
    range.setEnd(last, last.childNodes.length)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)
    return sel.toString()
  })
  // The whole selection, newlines and the blank line included — and no digits from the
  // gutter, which is `user-select: none` for exactly this reason.
  expect(selected).toBe(LOG)

  await output.dispatchEvent('mousedown', { button: 2 })
  await output.dispatchEvent('contextmenu', { clientX: 300, clientY: 200 })
  await page.locator('.context-menu-item', { hasText: 'Copy selected text' }).click()
  expect(await page.evaluate(() => window.__copied)).toEqual([LOG])
})

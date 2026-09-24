import { test, expect, type Page, type Locator } from './helpers/fixtures'
import { installTauriMock } from './helpers/tauriMock'
import { expandSection } from './helpers/sections'

// The docker log tab's right-click menu had one item — "Ask AI" — and no copy. Three
// things had to change:
//   * the menu reads the *document* selection, so a highlight left in another pane was
//     sent along with the logs, and a drag could run out of the log body into the header
//     and the tab bar — everything the menu touches (and everything the user drags) is
//     now scoped to the log;
//   * opening the menu re-renders the viewer, and the fresh `{ __html }` prop made React
//     re-apply the <pre>'s innerHTML, detaching the very text nodes the user had selected
//     — which is why the highlight vanished on every right-click;
//   * the selection is now snapshotted on the press and put back if something eats it, so
//     "Copy selected text" has text to copy even when the range could not survive.

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

const LOG = Array.from(
  { length: 40 },
  (_, i) => `2026-09-24T08:00:${String(i).padStart(2, '0')}Z INFO request ${i} handled`,
).join('\n')

async function openLogViewer(page: Page): Promise<Locator> {
  await page.goto('/')
  await page.locator('.connection-item').first().click()
  await expandSection(page, 'Docker')
  const item = page.locator('.docker-item').first()
  await expect(item).toBeVisible()
  await item.click({ button: 'right' })
  await page.locator('.context-menu-item', { hasText: 'View Logs' }).click()
  const output = page.locator('.dlv-output')
  await expect(output).toContainText('request 39 handled')
  return output
}

/**
 * Highlight log text in the page. A real drag is not reproducible here — Playwright's
 * synthetic mouse drag leaves the DOM selection collapsed in this environment — so the
 * selection is set through the same Range API the browser uses, which is what both the
 * menu and the clamp read.
 */
async function selectLog(page: Page, from: string, to: string): Promise<string> {
  return page.evaluate(
    ([from, to]) => {
      const pre = document.querySelector('.dlv-output')!
      const find = (needle: string) => {
        const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT)
        for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
          if (n.textContent!.includes(needle)) return n
        }
        throw new Error(`no log text node contains ${needle}`)
      }
      const range = document.createRange()
      range.setStart(find(from as string), 0)
      const end = find(to as string)
      range.setEnd(end, end.length)
      const sel = window.getSelection()!
      sel.removeAllRanges()
      sel.addRange(range)
      return sel.toString()
    },
    [from, to] as [string, string],
  )
}

/**
 * Right-click the log body, then take the selection away twice — as the press is handled
 * and again after the menu is up. Whatever the engine does with the highlight there, the
 * menu has to act on what was selected before the press, and show it again.
 */
async function rightClickLog(page: Page, output: Locator) {
  await output.dispatchEvent('mousedown', { button: 2 })
  await page.evaluate(() => window.getSelection()?.removeAllRanges())
  await output.dispatchEvent('contextmenu', { clientX: 300, clientY: 200 })
  await output.dispatchEvent('mouseup', { button: 2 })
  await page.evaluate(() => window.getSelection()?.removeAllRanges())
}

const selectionState = (page: Page) =>
  page.evaluate(() => {
    const sel = window.getSelection()!
    const pre = document.querySelector('.dlv-output')!
    const range = sel.rangeCount ? sel.getRangeAt(0) : null
    return {
      text: sel.toString(),
      inLog: !!range && pre.contains(range.startContainer) && pre.contains(range.endContainer),
    }
  })

test.describe('docker log right-click', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('wrolp-lang', 'en')
      // Follow off → one fetch, so no poll re-renders while the test selects.
      localStorage.setItem('wrolp-docker-follow', '0')
      // Record what the app copies instead of touching the OS clipboard.
      Object.defineProperty(navigator, 'clipboard', {
        value: {
          writeText: (text: string) => {
            window.__copied.push(text)
            return Promise.resolve()
          },
        },
        configurable: true,
      })
      window.__copied = []
    })
    await installTauriMock(page, {
      connections: [DEMO_CONN],
      pollOutputChunks: [[PROMPT]],
      dockerContainers: [CONTAINER],
      dockerLogsByContainer: { [CONTAINER.name]: LOG },
    })
  })

  test('copies the selected log text', async ({ page }) => {
    const output = await openLogViewer(page)
    const selected = await selectLog(page, 'request 5 handled', 'request 8 handled')
    expect(selected).toContain('request 5 handled')
    expect(selected).toContain('request 8 handled')
    expect(selected).not.toContain('request 9 handled')

    await rightClickLog(page, output)
    // Right-clicking is not allowed to eat the highlight: it comes back while the menu
    // is up, so the user can still see what they are about to copy.
    await expect
      .poll(() => selectionState(page), { message: 'the highlight should be restored' })
      .toEqual({ text: selected, inLog: true })

    const item = page.locator('.context-menu-item', { hasText: 'Copy selected text' })
    await expect(item).toBeVisible()
    await item.click()
    expect(await page.evaluate(() => window.__copied)).toEqual([selected])
  })

  test('a re-render keeps the selection the user just made', async ({ page }) => {
    await openLogViewer(page)
    const selected = await selectLog(page, 'request 5 handled', 'request 8 handled')
    // This is the bug the whole menu had: opening the menu re-renders the viewer, and a
    // fresh `{ __html }` prop made React re-apply the <pre>'s innerHTML — detaching every
    // text node the selection pointed at. Toggling Wrap is the same re-render.
    await page.locator('.dlv-checkbox', { hasText: 'Wrap' }).click()
    await expect
      .poll(() => selectionState(page), { message: 'the selection must survive the render' })
      .toEqual({ text: selected, inLog: true })
    expect(await page.evaluate(() => document.querySelector('.dlv-output')?.textContent)).toContain(
      'request 5 handled',
    )
  })

  test('a selection from outside the log is not copied with it', async ({ page }) => {
    const output = await openLogViewer(page)
    // Highlight the container name in the header, then right-click the log body:
    // the menu used to treat that as "selected log text".
    await page.evaluate(() => {
      const name = document.querySelector('.dlv-container-name')!
      const range = document.createRange()
      range.selectNodeContents(name)
      const sel = window.getSelection()!
      sel.removeAllRanges()
      sel.addRange(range)
    })
    await rightClickLog(page, output)
    const item = page.locator('.context-menu-item', { hasText: 'Copy all logs' })
    await expect(item).toBeVisible()
    await item.click()
    expect(await page.evaluate(() => window.__copied)).toEqual([LOG])
  })

  test('a selection dragged past the log edge is pulled back inside', async ({ page }) => {
    const output = await openLogViewer(page)
    // A neighbour with selectable text, standing in for whatever pane sits beside the
    // log: the app's own header is `user-select: none`, so the browser stops there and
    // only a genuinely selectable neighbour exercises the clamp.
    await page.evaluate(() => {
      const stray = document.createElement('div')
      stray.className = 'stray-selectable'
      stray.style.userSelect = 'text'
      stray.textContent = 'stray-text-outside-the-log'
      document.querySelector('.dlv-body')!.appendChild(stray)
    })

    // The drag begins in the log…
    await output.dispatchEvent('mousedown', { button: 0 })
    const straddling = await page.evaluate(() => {
      const pre = document.querySelector('.dlv-output')!
      const stray = document.querySelector('.stray-selectable')!.firstChild as Text
      const inLog = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT).nextNode() as Text
      const range = document.createRange()
      range.setStart(inLog, 0)
      range.setEnd(stray, stray.length)
      const sel = window.getSelection()!
      sel.removeAllRanges()
      sel.addRange(range)
      return sel.toString()
    })
    expect(straddling).toContain('stray-text-outside-the-log')

    await expect
      .poll(() => selectionState(page), { message: 'the clamp should own the selection' })
      .toEqual({
        inLog: true,
        text: expect.not.stringContaining('stray-text-outside-the-log'),
      })

    await output.dispatchEvent('mouseup', { button: 0 })
    const state = await selectionState(page)
    expect(state.inLog).toBe(true)
    expect(state.text.trim()).not.toBe('')
    expect(LOG).toContain(state.text.trim())

    // …and the menu copies exactly that, nothing from outside.
    await rightClickLog(page, output)
    await page.locator('.context-menu-item', { hasText: 'Copy selected text' }).click()
    expect(await page.evaluate(() => window.__copied)).toEqual([state.text])
  })
})

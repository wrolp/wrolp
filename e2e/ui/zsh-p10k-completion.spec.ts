/**
 * p10k's live prompt carries a RIGHT prompt — the status/clock segments — to the
 * right of the caret (`helpers/p10kCapture.ts`, captured from the test server).
 * Both the ghost completion and the `cd` dropdown read the input row and used to
 * reject any row with content right of the caret as "the caret is mid-line", so
 * neither feature ever appeared on this prompt.
 *
 * Replaying the exact captured bytes keeps the regression honest: the assertions
 * below only pass if the readers accept the right prompt and still hang the
 * suggestion off the real caret.
 */
import { test, expect, type Page } from './helpers/fixtures'
import { installTauriMock } from './helpers/tauriMock'
import { p10kChunks } from './helpers/p10kCapture'

const DEMO_CONN = { id: 'c1', name: 'Demo', host: 'demo.local', port: 22, username: 'root' }

const SNIPPETS = [
  {
    id: 's1',
    command: 'git status -sb',
    alias: 'short status',
    hidden: false,
    connectionId: null,
    description: null,
  },
]

const listEntry = (parent: string, name: string, isDir: boolean) => ({
  name,
  path: `${parent}${parent.endsWith('/') ? '' : '/'}${name}`,
  isDir,
  size: isDir ? 0 : 12,
  mode: isDir ? 'drwxr-xr-x' : '-rw-r--r--',
  modified: '',
})

const ghost = (page: Page) => page.locator('.term-ghost')
const cdPanel = (page: Page) => page.locator('.term-cd-suggest')
const cdRows = (page: Page) =>
  cdPanel(page).locator('.term-cd-suggest-row .term-cd-suggest-name').allTextContents()

/**
 * Echo printable input back through `poll_output`, the way a PTY would. The typed
 * characters overwrite the blanks between the caret and the right prompt, which is
 * exactly the row state the real server shows.
 */
async function installEcho(page: Page) {
  await page.evaluate(() => {
    const internals = (
      window as unknown as {
        __TAURI_INTERNALS__: {
          invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
        }
      }
    ).__TAURI_INTERNALS__
    const orig = internals.invoke.bind(internals)
    const pending: string[] = []
    internals.invoke = async (cmd: string, args: Record<string, unknown> = {}) => {
      if (cmd === 'send_input') {
        const data = String(args.data ?? '')
        if (/^[\x20-\x7e]+$/.test(data)) pending.push(data)
      }
      const res = await orig(cmd, args)
      if (cmd === 'poll_output') return [...((res as string[]) ?? []), ...pending.splice(0)]
      return res
    }
  })
}

async function openZsh(page: Page) {
  // The capture came from a 120x30 PTY. A narrower pane wraps the status line,
  // which would hide the very layout this spec is about.
  await page.setViewportSize({ width: 1900, height: 900 })
  await installTauriMock(page, {
    connections: [DEMO_CONN],
    pollOutputChunks: [[p10kChunks[0]]],
    commandSnippets: SNIPPETS,
    filesByDir: {
      '/': [
        listEntry('/', 'etc', true),
        listEntry('/', 'opt', true),
        listEntry('/', 'readme.txt', false),
      ],
    },
  })
  await page.goto('/')
  await page.locator('.connection-item').first().click()
  // The prompt is on screen with its right prompt.
  await expect(page.locator('.xterm-rows')).toContainText('with root@user')
  await page.locator('.xterm-screen').click()
  await installEcho(page)
}

test('the ghost tail appears on a prompt with a right prompt', async ({ page }) => {
  await openZsh(page)

  await page.keyboard.type('g', { delay: 60 })
  await expect(ghost(page)).toBeVisible()
  await expect(ghost(page)).toHaveText('it status -sb')
})

test('the cd dropdown opens on a prompt with a right prompt', async ({ page }) => {
  await openZsh(page)

  await page.keyboard.type('cd /o', { delay: 60 })
  await expect(cdPanel(page)).toBeVisible()
  // Real children of `/`, directories only — the right prompt no longer hides
  // the line from the reader.
  await expect.poll(() => cdRows(page)).toEqual(['opt'])
})

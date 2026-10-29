import { test, expect, type Page } from './helpers/fixtures'
import { installTauriMock, invokedCalls } from './helpers/tauriMock'

// B22 residual: after `mv note.txt ../` the on-screen listing is still the old
// one and the cwd has not moved. The click used to resolve against the stale
// source directory; the terminal now records where the move went and follows it.

const DEMO_CONN = {
  id: 'c1',
  name: 'Demo',
  host: 'demo.local',
  port: 22,
  username: 'root',
  startupDir: '/srv/a',
}
const PROMPT = '[root@srv a]# '

const file = (name: string, path: string) => ({
  name,
  path,
  isDir: false,
  size: 12,
  mode: '-rw-r--r--',
  modified: '',
})

async function installShell(page: Page) {
  await page.evaluate(
    ({ prompt }) => {
      const internals = (
        window as unknown as {
          __TAURI_INTERNALS__: {
            invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
          }
        }
      ).__TAURI_INTERNALS__
      const orig = internals.invoke.bind(internals)
      const pending: string[] = []
      let line = ''
      internals.invoke = async (cmd: string, args: Record<string, unknown> = {}) => {
        if (cmd === 'send_input') {
          const data = String(args.data ?? '')
          const clean = data.replace(/\x1b\[20[01]~/g, '').replace(/\x16/g, '')
          if (/[\r\n]/.test(clean)) {
            const submitted = line.trim()
            line = ''
            pending.push('\r\n')
            if (submitted === 'ls') pending.push('note.txt\r\n')
            pending.push(prompt)
          } else {
            line += clean
            if (clean) pending.push(clean)
          }
        }
        const res = await orig(cmd, args)
        if (cmd === 'poll_output') return [...(res as string[]), ...pending.splice(0)]
        return res
      }
    },
    { prompt: PROMPT },
  )
}

test('a click on a listing made before `mv` opens the file at its new path', async ({ page }) => {
  await installTauriMock(page, {
    connections: [DEMO_CONN],
    pollOutputChunks: [[PROMPT]],
    filesByDir: {
      '/srv/a': [file('note.txt', '/srv/a/note.txt')],
      // The type lookup after the click lists the destination directory.
      '/srv': [file('note.txt', '/srv/note.txt')],
    },
    fileContent: { path: '/srv/note.txt', content: 'moved', language: 'plaintext' },
  })
  await page.goto('/')
  await installShell(page)
  await page.locator('.connection-item').first().click()
  await expect(page.locator('.xterm-rows')).toContainText(PROMPT)

  // Only the moved-to location exists; the source path is gone.
  await page.evaluate(() => {
    const internals = (
      window as unknown as {
        __TAURI_INTERNALS__: {
          invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
        }
      }
    ).__TAURI_INTERNALS__
    const orig = internals.invoke.bind(internals)
    internals.invoke = async (cmd: string, args: Record<string, unknown> = {}) => {
      if (cmd === 'file_exists') return String(args.path) === '/srv/note.txt'
      return orig(cmd, args)
    }
  })

  await page.locator('.xterm-screen').click()
  await page.keyboard.type('ls')
  await page.keyboard.press('Enter')
  await expect(page.locator('.xterm-rows')).toContainText('note.txt')

  await page.keyboard.type('mv note.txt ../')
  await page.keyboard.press('Enter')

  const row = page.locator('.xterm-rows > div').filter({ hasText: 'note.txt' }).first()
  const box = await row.boundingBox()
  expect(box).not.toBeNull()
  await page.mouse.move(box!.x + 6, box!.y + box!.height / 2)
  const card = page.locator('.term-link-tooltip')
  await expect(card).toContainText('Open file', { timeout: 5_000 })
  await card.click()

  await expect
    .poll(async () => {
      const call = (await invokedCalls(page)).find((c) => c.cmd === 'read_file_content')
      return call ? String(call.args.path) : null
    })
    .toBe('/srv/note.txt')
})

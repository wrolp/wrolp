import { test, expect, type Page } from './helpers/fixtures'
import { installTauriMock, invokedCalls } from './helpers/tauriMock'

// `cd ~` then `ls`: the listing must describe the HOME directory.
//
// The `ls` links resolve against the cwd the terminal tracks. `cd ~` (like
// `cd -` or a bare `cd`) has a target that cannot be derived from the command
// line, and the Enter handler used to `return` and leave the PREVIOUS absolute
// directory in place — so the next `ls` listed and resolved the old directory:
// home's names matched nothing in its map (every entry lost its directory type,
// so the hover card offered "Open file" for `bin` too) and a click opened the
// same-named entry under the old path.

const DEMO_CONN = {
  id: 'c1',
  name: 'Demo',
  host: 'demo.local',
  port: 22,
  username: 'root',
  // Authoritative at connect: the backend cds into it, and the terminal seeds
  // its tracked cwd from it (Terminal.tsx `seedInitialRemoteCwd`).
  startupDir: '/var/log',
}

const OLD_PROMPT = '[root@sip /var/log]# '
const NEW_PROMPT = '[root@sip ~]# '

const file = (name: string, path: string) => ({
  name,
  path,
  isDir: false,
  size: 414,
  mode: '-rw-r--r--',
  modified: '',
})
const dir = (name: string, path: string) => ({
  name,
  path,
  isDir: true,
  size: 0,
  mode: 'drwxr-xr-x',
  modified: '',
})

/**
 * Echo what the user types, and answer each submitted line from `replies`.
 * A line carrying `$(pwd)` is the app's own hidden cwd query — it gets the
 * marker-wrapped answer parsed straight out of the query text, the way a real
 * shell would echo it.
 */
async function installShell(page: Page, replies: Record<string, string[]>) {
  await page.evaluate((table) => {
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
        const pwd = /\$\(pwd\)/.test(data)
          ? {
              beg: /__WROLP_CWD_BEG_\w+__/.exec(data)?.[0] ?? '',
              end: /__WROLP_CWD_END_\w+__/.exec(data)?.[0] ?? '',
            }
          : null
        if (pwd) {
          pending.push(`\r\n${pwd.beg}/root${pwd.end}\r\n`)
        } else if (/[\r\n]/.test(data)) {
          const frame = table[line.trim()]
          line = ''
          if (frame) pending.push('\r\n', ...frame)
        } else {
          const visible = data.replace(/\x1b\[20[01]~/g, '').replace(/[\x00-\x1f\x7f]/g, '')
          line += visible
          if (visible) pending.push(visible)
        }
      }
      const res = await orig(cmd, args)
      if (cmd === 'poll_output') return [...(res as string[]), ...pending.splice(0)]
      return res
    }
  }, replies)
}

const listFilesPaths = async (page: Page) =>
  (await invokedCalls(page))
    .filter((c) => c.cmd === 'list_files' || c.cmd === 'target_list_files')
    .map((c) => String(c.args.path))

test('the listing after `cd ~` is taken from home, not from the previous directory', async ({
  page,
}) => {
  await installTauriMock(page, {
    connections: [DEMO_CONN],
    pollOutputChunks: [[OLD_PROMPT]],
    filesByDir: {
      '/var/log': [file('journal', '/var/log/journal'), dir('private', '/var/log/private')],
      '/root': [
        dir('bin', '/root/bin'),
        dir('projects', '/root/projects'),
        file('notes.txt', '/root/notes.txt'),
      ],
    },
  })
  await page.goto('/')
  await page.locator('.connection-item').first().click()
  await expect(page.locator('.xterm-rows')).toContainText(OLD_PROMPT)

  await installShell(page, {
    'cd ~': [NEW_PROMPT],
    ls: ['bin   notes.txt  projects', NEW_PROMPT],
  })

  await page.locator('.xterm-screen').click()
  await page.keyboard.type('cd ~')
  await page.keyboard.press('Enter')
  await expect(page.locator('.xterm-rows')).toContainText(NEW_PROMPT)

  await page.keyboard.type('ls')
  await page.keyboard.press('Enter')
  await expect
    .poll(() => page.locator('.xterm-rows').innerText(), { timeout: 10_000 })
    .toContain('notes.txt')

  // The directory the listing was resolved against. `/var/log` is the stale
  // seed the bug left behind; home's own path is the only right answer.
  const paths = await listFilesPaths(page)
  expect(paths.at(-1)).toBe('/root')
  expect(paths).not.toContain('/var/log')

  // …and the consequence the user reported: hovering a home directory offers to
  // enter it. The card shows 800 ms after the pointer rests on the link, and an
  // entry whose type could not be resolved reads "Open file" — which is exactly
  // what every home entry did while the stale `/var/log` map was in use.
  const row = page.locator('.xterm-rows > div').filter({ hasText: 'bin' }).first()
  const box = await row.boundingBox()
  expect(box).not.toBeNull()
  await page.mouse.move(box!.x + 6, box!.y + box!.height / 2)
  await expect(page.locator('.term-link-tooltip')).toContainText('Enter folder', {
    timeout: 5_000,
  })
})

import { test, expect, type Page } from './helpers/fixtures'
import { installTauriMock, invokedCalls } from './helpers/tauriMock'

// A prompt whose terminator is not one of `splitPromptCommand`'s markers —
// oh-my-zsh's robbyrussell `➜`, or the Nerd Font chevron many themes use in
// place of `❯` (U+F054) — used to leave the glyph glued to the command
// (`\uf054  ls`). Consequences, all fixed by splitting the glyph off:
//   * `detectLsCommand` read the glyph as the program and bailed, so listings
//     were never captured and nothing was clickable;
//   * `highlightCurrentCommandLine` bails without a prompt, so the typed line
//     was never colored;
//   * the `cd` handler never saw `cd`, so the tracked cwd went stale and later
//     listings resolved against the previous directory.

const DEMO_CONN = {
  id: 'c1',
  name: 'Demo',
  host: 'demo.local',
  port: 22,
  username: 'root',
  startupDir: '/var/log',
}

const listEntry = (name: string, path: string) => ({
  name,
  path,
  isDir: true,
  size: 0,
  mode: 'drwxr-xr-x',
  modified: '',
})

/** Echo typed input like a PTY and answer each submitted line from `table`. */
async function installShell(page: Page, table: Record<string, string[]>) {
  await page.evaluate((replies) => {
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
        if (/[\r\n]/.test(data)) {
          const frame = replies[line.trim()]
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
  }, table)
}

/** The directories the listing was resolved against (base dir for `ls` links). */
const listFilesPaths = async (page: Page) =>
  (await invokedCalls(page))
    .filter((c) => c.cmd === 'list_files' || c.cmd === 'target_list_files')
    .map((c) => String(c.args.path))

/** Wait until the shell has painted the prompt again, i.e. the command finished. */
async function waitForPrompt(page: Page, glyph: string) {
  await expect
    .poll(() =>
      page.evaluate((g) => {
        const text = document.querySelector('.xterm-rows')?.textContent ?? ''
        return text.split(g).length - 1
      }, glyph.trim()),
    )
    .toBeGreaterThanOrEqual(2)
}

async function openShell(page: Page, prompt: string) {
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  await installTauriMock(page, {
    connections: [DEMO_CONN],
    pollOutputChunks: [[prompt]],
    filesByDir: {
      '/var/log': [listEntry('journal', '/var/log/journal')],
      '/opt': [listEntry('wrolp', '/opt/wrolp'), listEntry('wrolp-editor', '/opt/wrolp-editor')],
    },
  })
  await page.goto('/')
  await page.locator('.connection-item').first().click()
  await expect(page.locator('.xterm-rows')).toContainText(prompt.trim())
  await page.locator('.xterm-screen').click()
}

async function expectClickable(page: Page, prompt: string) {
  // GNU `ls --color=auto` on a two-entry directory: SGR around each name, two
  // spaces of padding between them.
  const listing = '\x1b[0m\x1b[01;34mwrolp\x1b[0m  \x1b[01;34mwrolp-editor\x1b[0m'
  await openShell(page, prompt)
  await installShell(page, { 'cd /opt': [prompt], ls: [listing, '\r\n', prompt] })
  await page.keyboard.type('cd /opt')
  await page.keyboard.press('Enter')
  await waitForPrompt(page, prompt)
  await page.keyboard.type('ls')
  await page.keyboard.press('Enter')
  await expect.poll(() => page.locator('.xterm-rows').innerText()).toContain('wrolp-editor')
  const row = page.locator('.xterm-rows > div').filter({ hasText: 'wrolp-editor' }).last()
  const box = await row.boundingBox()
  expect(box).not.toBeNull()
  await page.mouse.move(box!.x + 6, box!.y + box!.height / 2)
  await expect(page.locator('.term-link-tooltip')).toContainText('Enter folder', {
    timeout: 5_000,
  })
}

test.describe('ls links under zsh prompts', () => {
  test('a Nerd Font chevron prompt is not part of the command', async ({ page }) => {
    await expectClickable(page, '\uf054  ')
  })

  test('oh-my-zsh robbyrussell `➜` is not part of the command', async ({ page }) => {
    await expectClickable(page, '➜  ')
  })

  test('`cd` under a glyph prompt updates the base of the next listing', async ({ page }) => {
    const prompt = '\uf054  '
    await openShell(page, prompt)
    await installShell(page, { 'cd /opt': [prompt], ls: ['wrolp  wrolp-editor', '\r\n', prompt] })
    await page.keyboard.type('cd /opt')
    await page.keyboard.press('Enter')
    await waitForPrompt(page, prompt)
    await page.keyboard.type('ls')
    await page.keyboard.press('Enter')
    await expect.poll(() => page.locator('.xterm-rows').innerText()).toContain('wrolp-editor')
    // The tracked cwd is what a click resolves against. `/var/log` is the seed
    // the bug left behind (the `cd` was never recognised).
    const paths = await listFilesPaths(page)
    expect(paths.at(-1)).toBe('/opt')
    expect(paths).not.toContain('/var/log')
  })
})

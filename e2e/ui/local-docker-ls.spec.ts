/**
 * A LOCAL container's shell (`docker exec` PTY) with starship's two-line prompt.
 *
 * The prompt's second row is `⬢ [Docker] ❯ ` — the cwd (the first row's
 * `root in /`) is not on the input row, and the local shell never learns the
 * container's directory on its own. So `ls` had no base directory: no listing →
 * no colours, every entry's kind stayed `unknown` → the hover card offered
 * "Open file" on a directory.
 *
 * The fix asks the container shell for its cwd once, right after it opens, and
 * prefetches that directory's map before the user can type. This spec answers
 * the hidden `pwd` query the way bash does (the bytes below mirror a real
 * ConPTY capture) and then runs `ls`.
 */
import { test, expect, type Page } from './helpers/fixtures'
import { selectRailMode } from './helpers/sections'
import { installTauriMock, invokedCalls } from './helpers/tauriMock'

const LOCAL = {
  id: 'aaa1111bbb2',
  name: 'debian-env',
  image: 'debian',
  state: 'running',
  status: 'Up 1 hour',
}
const RUNNING = { installed: true, serverRunning: true, bin: 'docker', serverVersion: '27.1.1' }

/** What the container prints: two rows, colour included. */
const PROMPT =
  '\x1b[1;31mroot\x1b[0m in \x1b[1;36m/\x1b[0m \r\n' +
  '\x1b[1;2;31m\u2b22 [Docker]\x1b[0m \x1b[1;32m\u276f\x1b[0m '

const dirEntry = (name: string) => ({
  name,
  path: `/${name}`,
  isDir: true,
  size: 0,
  mode: 'drwxr-xr-x',
  modified: '',
})

async function installShell(page: Page) {
  await page.evaluate((prompt) => {
    const internals = (
      window as unknown as {
        __TAURI_INTERNALS__: {
          invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
        }
      }
    ).__TAURI_INTERNALS__
    const orig = internals.invoke.bind(internals)
    const pending: string[] = []
    let typed = ''
    internals.invoke = async (cmd: string, args: Record<string, unknown> = {}) => {
      if (cmd === 'local_send_input') {
        const data = String(args.data ?? '')
        const beg = /__WROLP_CWD_BEG_[a-z0-9]+__/.exec(data)?.[0]
        const end = /__WROLP_CWD_END_[a-z0-9]+__/.exec(data)?.[0]
        if (beg && end) {
          // Exactly what bash on the real container writes: the echoed command,
          // then the marker-wrapped path, then a fresh prompt. BEG and END carry
          // independent random ids — echo them back verbatim.
          pending.push(`${data.replace(/\r$/, '')}\r\n`, `\r${beg}/${end}\r\n\r\n`, prompt)
        } else if (data.includes('\r')) {
          // One command per Enter, like bash: only an `ls` prints the listing.
          pending.push('\r\n')
          if (/(?:^|\s)ls$/.test(typed.trim())) pending.push('bin  etc  home\r\n\r\n')
          pending.push(prompt)
          typed = ''
        } else {
          const visible = data
            .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
            .replace(/[\x00-\x1f\x7f]/g, '')
          typed += visible
          if (visible) pending.push(visible)
        }
      }
      const res = await orig(cmd, args)
      if (cmd === 'poll_output') return [...((res as string[]) ?? []), ...pending.splice(0)]
      return res
    }
  }, PROMPT)
}

/** The theme's directory hue, in the `rgb(…)` form xterm's DOM renderer writes. */
async function dirHue(page: Page) {
  return page.evaluate(() => {
    const token = getComputedStyle(document.documentElement).getPropertyValue('--link').trim()
    const probe = document.createElement('span')
    probe.style.color = token
    document.body.appendChild(probe)
    const value = getComputedStyle(probe).color
    probe.remove()
    return value
  })
}

async function enterLocalContainerShell(page: Page) {
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  await installTauriMock(page, {
    localDockerProbe: RUNNING,
    localDockerContainers: [LOCAL],
    pollOutputChunks: [[PROMPT]],
    filesByDir: { '/': [dirEntry('bin'), dirEntry('etc'), dirEntry('home')] },
  })
  await page.goto('/')
  await selectRailMode(page, 'containers')
  await installShell(page)
  await page.locator('.docker-item').filter({ hasText: LOCAL.name }).click({ button: 'right' })
  await page.locator('.context-menu-item', { hasText: 'Enter Shell' }).click()

  await expect(page.locator('.tab-item.active .tab-label')).toHaveText(LOCAL.name)
  await expect(page.locator('.xterm-rows')).toContainText('root in /')
  await page.locator('.xterm-screen').click()
}

test('a local container listing is read from the container, coloured and typed', async ({
  page,
}) => {
  await enterLocalContainerShell(page)

  // The shell's cwd is learned through the hidden query and the directory map is
  // prefetched — through the CONTAINER target, not this machine's local FS.
  await expect
    .poll(
      async () =>
        (await invokedCalls(page))
          .filter((c) => c.cmd === 'target_list_files' && c.args.path === '/')
          .map((c) => (c.args.target as { kind?: string; container?: string }) ?? null)
          .filter((t) => t?.kind === 'dockerLocal' && t.container === LOCAL.name).length,
      { timeout: 10_000 },
    )
    .toBeGreaterThanOrEqual(1)

  await page.keyboard.type('ls', { delay: 60 })
  await page.keyboard.press('Enter')
  await expect(page.locator('.xterm-rows')).toContainText('bin')

  // Names painted by kind: `etc` is a directory in the container's `/`.
  const hue = await dirHue(page)
  const listingRow = page.locator('.xterm-rows > div').filter({ hasText: 'etc' }).first()
  expect(await listingRow.innerHTML()).toContain(hue)

  // …and the hover card knows it is a directory, not a file to open.
  const box = await listingRow.boundingBox()
  expect(box).not.toBeNull()
  await page.mouse.move(box!.x + 6, box!.y + box!.height / 2)
  await expect(page.locator('.term-link-tooltip')).toContainText('Enter folder', {
    timeout: 6_000,
  })
})

test('a failed cd does not move the tracked directory', async ({ page }) => {
  await enterLocalContainerShell(page)

  // The connect-time seed has established `/` as the tracked directory.
  await expect
    .poll(
      async () =>
        (await invokedCalls(page)).filter(
          (c) => c.cmd === 'target_list_files' && c.args.path === '/',
        ).length,
      { timeout: 10_000 },
    )
    .toBeGreaterThanOrEqual(1)

  // The shell answers `cd /nope` with an error and stays in `/`; the app must ask
  // the container whether the path exists instead of trusting the typed target.
  await page.keyboard.type('cd /nope', { delay: 60 })
  await page.keyboard.press('Enter')
  await expect
    .poll(
      async () =>
        (await invokedCalls(page)).filter(
          (c) => c.cmd === 'target_file_exists' && c.args.path === '/nope',
        ).length,
      { timeout: 10_000 },
    )
    .toBeGreaterThanOrEqual(1)

  await page.keyboard.type('ls', { delay: 60 })
  await page.keyboard.press('Enter')
  await expect(page.locator('.xterm-rows')).toContainText('bin')

  // Nothing was ever listed for the bogus directory, and the entry is still typed
  // from the real one — the base never left `/`.
  const listedPaths = (await invokedCalls(page))
    .filter((c) => c.cmd === 'target_list_files')
    .map((c) => String(c.args.path))
  expect(listedPaths).not.toContain('/nope')

  const listingRow = page.locator('.xterm-rows > div').filter({ hasText: 'etc' }).first()
  const box = await listingRow.boundingBox()
  expect(box).not.toBeNull()
  await page.mouse.move(box!.x + 6, box!.y + box!.height / 2)
  await expect(page.locator('.term-link-tooltip')).toContainText('Enter folder', {
    timeout: 6_000,
  })
})

import { test, expect, type Page } from './helpers/fixtures'
import { installTauriMock, invokedCalls } from './helpers/tauriMock'

// A burst of `cd`s typed faster than the tracked cwd can follow it.
//
// Every `cd` adopts its target only after an SFTP existence check, and a
// relative target is resolved against the tracked cwd. Run in parallel, each
// check read the same stale cwd and the last one to finish won, so the tracked
// directory could stall several levels behind the shell; the next `ls` then
// bound its listing to that stale base and a click resolved against it — on a
// real box clicking `org` inside
// `/opt/k3s/prod-k3s/build/app-ws` produced `cd -- '/opt/org'`.
// Tracking now runs through one ordered chain, and an `ls` capture joins it
// before computing its base, which is what this spec pins down.

const HOST = 'demo-node-01'
const BUILD = '/opt/k3s/prod-k3s/build'
const WS = `${BUILD}/app-ws`

const CONN = {
  id: 'c1',
  name: 'demo-node-01',
  host: 'demo-node-01',
  port: 22,
  username: 'root',
  startupDir: '/opt',
}

const dir = (parent: string, name: string) => ({
  name,
  path: `${parent}/${name}`,
  isDir: true,
  size: 0,
  mode: 'drwxr-xr-x',
  modified: '',
})

const FILES: Record<string, unknown[]> = {
  '/opt': [dir('/opt', 'k3s')],
  '/opt/k3s': [dir('/opt/k3s', 'prod-k3s')],
  '/opt/k3s/prod-k3s': [dir('/opt/k3s/prod-k3s', 'build')],
  [BUILD]: [dir(BUILD, 'app-ws')],
  [WS]: [dir(WS, 'org')],
}

/**
 * A one-directory-at-a-time shell: `cd` moves, `ls` names what is there, and each
 * submission is echoed with a prompt that carries only the basename (the way
 * the real `[root@host dir]#` prompt does).
 */
async function installShell(page: Page, startDir: string) {
  await page.evaluate(
    ({ start, host }) => {
      const internals = (
        window as unknown as {
          __TAURI_INTERNALS__: {
            invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
          }
        }
      ).__TAURI_INTERNALS__
      const orig = internals.invoke.bind(internals)
      let shellCwd = start
      const pending: string[] = []
      let line = ''
      const prompt = () => {
        const base = shellCwd.split('/').filter(Boolean).pop() ?? '/'
        return `[root@${host} ${base}]# `
      }
      internals.invoke = async (cmd: string, args: Record<string, unknown> = {}) => {
        if (cmd === 'send_input') {
          const data = String(args.data ?? '')
          if (/[\r\n]/.test(data)) {
            const submitted = line.trim()
            line = ''
            pending.push('\r\n')
            const cd = /^cd\s+(?:--\s+)?'?([^']+)'?$/.exec(submitted)
            if (cd) {
              const target = cd[1]
              shellCwd = target.startsWith('/')
                ? target
                : `${shellCwd}/${target}`.replace(/\/\.\//g, '/')
            } else if (submitted === 'ls') {
              pending.push('org\r\n')
            }
            pending.push(prompt())
          } else {
            line += data
            if (data) pending.push(data)
          }
        }
        const res = await orig(cmd, args)
        if (cmd === 'poll_output') return [...(res as string[]), ...pending.splice(0)]
        return res
      }
    },
    { start: startDir, host: HOST },
  )
}

test('a click on a listing made after a burst of `cd`s uses the real directory', async ({
  page,
}) => {
  await installTauriMock(page, {
    connections: [CONN],
    pollOutputChunks: [[`[root@${HOST} opt]# `]],
    filesByDir: FILES,
    // Every directory check is slow, so the burst below is still in flight when
    // the `ls` is submitted — the state that used to stall the tracking.
    delayCommands: { file_exists: 700 },
  })
  // The `cd` dropdown would swallow these Enters (it completes instead of
  // submitting); this spec is about cwd tracking, so keep it out of the way.
  await page.addInitScript(() => localStorage.setItem('wrolp-terminal-cd-suggest', '0'))
  await page.goto('/')
  await installShell(page, '/opt')
  await page.locator('.connection-item').first().click()
  await expect(page.locator('.xterm-rows')).toContainText(`[root@${HOST} opt]#`)

  await page.locator('.xterm-screen').click()
  // The mock echoes through `poll_output` (100 ms), so the Enter handler parses
  // the BUFFER: wait for each line to be painted before submitting it, or the
  // tracked `cd` would be cut short (`cd` alone, …) and this spec would be
  // measuring the mock, not the tracker.
  const submit = async (cmd: string) => {
    await page.keyboard.type(cmd)
    await expect(page.locator('.xterm-rows')).toContainText(cmd)
    await page.keyboard.press('Enter')
  }
  for (const cmd of ['cd /opt/k3s', 'cd prod-k3s', 'cd build', 'cd app-ws']) {
    await submit(cmd)
  }
  await submit('ls')
  await expect(page.locator('.xterm-rows')).toContainText('org')

  // The listing is only clickable once its base resolved, i.e. once every `cd`
  // of the burst has been verified, and xterm caches a row's links — a hover
  // before that would leave the row permanently link-less. Wait for the four
  // existence checks, then one tick for the binding, and only then hover.
  await expect
    .poll(
      async () =>
        (await invokedCalls(page)).filter(
          (c) => c.cmd === 'file_exists' && String(c.args.path).startsWith('/opt'),
        ).length,
      { timeout: 20_000 },
    )
    .toBeGreaterThanOrEqual(4)
  await page.waitForTimeout(1_500)

  const row = page.locator('.xterm-rows > div').filter({ hasText: 'org' }).first()
  const box = await row.boundingBox()
  expect(box).not.toBeNull()
  await page.mouse.move(box!.x + 6, box!.y + box!.height / 2)
  const card = page.locator('.term-link-tooltip')
  await expect(card).toContainText('Enter folder', { timeout: 5_000 })
  await card.click()

  // …and the `cd` it sends must name the directory the listing came from, not
  // a level or three behind it (`/opt/org`, `/opt/k3s/org`, …).
  await expect
    .poll(
      async () => {
        const calls = (await invokedCalls(page)).filter((c) => c.cmd === 'send_input')
        const hit = calls.find((c) => String(c.args.data).startsWith('cd -- '))
        return hit ? String(hit.args.data).trim() : null
      },
      { timeout: 15_000 },
    )
    .toBe(`cd -- '${WS}/org'`)
})

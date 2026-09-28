import { test, expect, type Page } from './helpers/fixtures'
import { installTauriMock, invokedCalls } from './helpers/tauriMock'

// The Warp-style `cd` directory dropdown (plan: task/plans/cd-directory-dropdown-plan.md).
//
// No shell beats behind the mock, so NOTHING these tests type ever echoes back —
// which is precisely what makes the panel interesting: it is driven by the
// projected input line (what the buffer shows + the keystrokes already sent but
// not echoed + the current one), never by the buffer alone. Without that
// projection every case below would have nothing to show.

const BASH_ENTRY = { id: 'lt-bash', name: 'Bash', cwd: '/var/www', shell: 'bash' }

const dirEntry = (parent: string, name: string) => ({
  name,
  path: `${parent}/${name}`,
  isDir: true,
  size: 0,
  mode: 'drwxr-xr-x',
  modified: 0,
})
const fileEntry = (parent: string, name: string) => ({
  name,
  path: `${parent}/${name}`,
  isDir: false,
  size: 12,
  mode: '-rw-r--r--',
  modified: 0,
})

const FILES: Record<string, unknown[]> = {
  '/var/www': [
    dirEntry('/var/www', 'local'),
    dirEntry('/var/www', 'log'),
    dirEntry('/var/www', 'nginx'),
    dirEntry('/var/www', '.cache'), // hidden — listed only once the prefix starts with a dot
    fileEntry('/var/www', 'index.html'), // files are never offered
  ],
  '/var/www/local': [dirEntry('/var/www/local', 'bin'), dirEntry('/var/www/local', 'lib')],
}

/** Bytes the app pushed into the PTY, in order. */
const localSent = async (page: Page) =>
  (await invokedCalls(page))
    .filter((c) => c.cmd === 'local_send_input')
    .map((c) => String(c.args.data))

/** How many times the dropdown listed `dir` (it may have been listed for other
 *  reasons — the file panel queries the same backend command). */
const listed = async (page: Page, dir: string) =>
  (await invokedCalls(page)).filter(
    (c) => (c.cmd === 'list_files' || c.cmd === 'target_list_files') && c.args.path === dir,
  ).length

/** Open a local POSIX terminal sitting at a bare prompt in /var/www. */
async function connect(page: Page) {
  await installTauriMock(page, {
    localTerminals: [BASH_ENTRY],
    pollOutputChunks: [['user@host:~$ ']],
    filesByDir: FILES,
  })
  await page.goto('/')
  await page.locator('.conn-item.local-term-item').filter({ hasText: BASH_ENTRY.name }).click()
  await page.waitForSelector('.xterm-helper-textarea', { state: 'attached' })
  await expect
    .poll(async () => (await invokedCalls(page)).filter((c) => c.cmd === 'open_local_shell').length)
    .toBeGreaterThanOrEqual(1)
  await page.waitForTimeout(400)
  await page.locator('.xterm-screen').click()
}

/** Type into the terminal. Nothing comes back — every character is `lag`. */
const type = (page: Page, text: string) => page.keyboard.type(text, { delay: 60 })

const panel = (page: Page) => page.locator('.term-cd-suggest')
const rowNames = (page: Page) =>
  panel(page).locator('.term-cd-suggest-row .term-cd-suggest-name').allTextContents()

test('`cd ` opens the dropdown on the space itself — directories only', async ({ page }) => {
  await connect(page)

  await type(page, 'cd ')

  await expect(panel(page)).toBeVisible()
  // Real subdirectories of the shell's working directory: alphabetical, hidden
  // directories and files excluded, `..` as the synthetic parent row.
  await expect.poll(() => rowNames(page)).toEqual(['..', 'local', 'log', 'nginx'])
  await expect.poll(() => listed(page, '/var/www')).toBeGreaterThanOrEqual(1)
})

test('keeping to type narrows the list without relisting the directory', async ({ page }) => {
  await connect(page)

  await type(page, 'cd ')
  await expect.poll(() => rowNames(page)).toEqual(['..', 'local', 'log', 'nginx'])
  const before = await listed(page, '/var/www')

  await type(page, 'l')
  await expect.poll(() => rowNames(page)).toEqual(['local', 'log'])
  // The 15s cache absorbs the filtering — no second round trip.
  expect(await listed(page, '/var/www')).toBe(before)
})

test('Enter completes the highlighted name into the line and does NOT submit', async ({ page }) => {
  await connect(page)

  await type(page, 'cd l')
  await expect.poll(() => rowNames(page)).toEqual(['local', 'log'])

  await page.keyboard.press('Enter')

  // Only the missing tail is sent (`cd l` + `local` ⇒ `ocal`): nothing is deleted,
  // so the shell's own line editor keeps every byte it had echoed.
  await expect.poll(() => localSent(page)).toContain('ocal')
  // Decision ② — completing is not executing. No CR reached the shell, and the
  // panel closed. The user's own Enter still runs `cd` through the usual path.
  expect(await localSent(page)).not.toContain('\r')
  await expect(panel(page)).toHaveCount(0)
})

test('Tab completes and drills one level deeper', async ({ page }) => {
  await connect(page)

  await type(page, 'cd ')
  // The panel is visible while it is still LISTING (items empty) — wait for the
  // real rows before walking the highlight, the same way a user would.
  await expect.poll(() => rowNames(page)).toEqual(['..', 'local', 'log', 'nginx'])
  // Row 0 is the synthetic `..`; walk down to `local`.
  await page.keyboard.press('ArrowDown')

  await page.keyboard.press('Tab')

  await expect.poll(() => localSent(page)).toContain('local/')
  // Drilling bypasses the cache (a `cd` is not the only thing that can change a
  // directory's contents) and lists where we just moved to.
  await expect.poll(() => listed(page, '/var/www/local')).toBeGreaterThanOrEqual(1)
  await expect.poll(() => rowNames(page)).toEqual(['..', 'bin', 'lib'])
})

test('Esc closes the dropdown and never reaches the shell', async ({ page }) => {
  await connect(page)

  await type(page, 'cd ')
  await expect(panel(page)).toBeVisible()

  await page.keyboard.press('Escape')

  await expect(panel(page)).toHaveCount(0)
  // A bare Esc is readline's META prefix — it must be swallowed, not forwarded.
  expect(await localSent(page)).not.toContain('\u001b')
})

test('nothing opens for a command line that is not a `cd`', async ({ page }) => {
  await connect(page)
  // Opening the tab already lists the cwd on its own (the file panel does); what
  // matters is that TYPING a non-`cd` line adds no further listing.
  const baseline = await listed(page, '/var/www')

  await type(page, 'ls ')
  await page.waitForTimeout(600)

  await expect(panel(page)).toHaveCount(0)
  expect(await listed(page, '/var/www')).toBe(baseline)
})

test('the right-click switch turns it off', async ({ page }) => {
  await connect(page)
  const baseline = await listed(page, '/var/www')

  await page.locator('.xterm-screen').click({ button: 'right' })
  const item = page.locator('.context-menu .context-menu-item').filter({ hasText: 'cd' })
  await expect(item).toBeVisible()
  await item.click()

  await page.locator('.xterm-screen').click()
  await type(page, 'cd ')
  await page.waitForTimeout(600)

  await expect(panel(page)).toHaveCount(0)
  expect(await listed(page, '/var/www')).toBe(baseline)
})

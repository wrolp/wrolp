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
/** Name of the highlighted row, or '' while nothing is highlighted. */
const activeName = async (page: Page) =>
  (
    await panel(page)
      .locator('.term-cd-suggest-row.is-active .term-cd-suggest-name')
      .allTextContents()
  )[0] ?? ''

test('`cd ` opens the dropdown on the space itself — directories only', async ({ page }) => {
  await connect(page)

  await type(page, 'cd ')

  await expect(panel(page)).toBeVisible()
  // Real subdirectories of the shell's working directory: alphabetical, hidden
  // directories and files excluded, `..` as the synthetic parent row.
  await expect.poll(() => rowNames(page)).toEqual(['..', 'local', 'log', 'nginx'])
  await expect.poll(() => listed(page, '/var/www')).toBeGreaterThanOrEqual(1)
  // The list is an offer, not a decision: it opens with NOTHING highlighted, so
  // a reflexive Enter runs the typed `cd` instead of taking row 0.
  expect(await activeName(page)).toBe('')
  // The panel must actually GROW to fit its rows — regression guard for the
  // maxHeight-stuck-at-the-loading-floor bug (user screenshot 2026-09-29: the
  // list never expanded past ~1.5 rows).
  await expect.poll(async () => (await panel(page).boundingBox())?.height ?? 0).toBeGreaterThan(80)
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

test('Enter without navigating runs the typed line, not the highlighted name', async ({ page }) => {
  await connect(page)

  await type(page, 'cd l')
  await expect.poll(() => rowNames(page)).toEqual(['local', 'log'])
  expect(await activeName(page)).toBe('')

  await page.keyboard.press('Enter')

  // The user never steered the highlight, so Enter runs what was typed. The first
  // row's `local` is NOT appended into the line.
  expect(await localSent(page)).not.toContain('ocal')
  // The user's own Enter reaches the shell — `cd l` is executed, not completed.
  await expect.poll(() => localSent(page)).toContain('\r')
  await expect(panel(page)).toHaveCount(0)
})

test('Enter after picking a row completes that name instead of submitting', async ({ page }) => {
  await connect(page)

  await type(page, 'cd ')
  await expect.poll(() => rowNames(page)).toEqual(['..', 'local', 'log', 'nginx'])
  // Nothing is highlighted up front; ↓ twice walks onto `local` (row 0 is `..`).
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await expect.poll(() => activeName(page)).toBe('local')

  await page.keyboard.press('Enter')

  // The picked name is completed into the line and the key is consumed — the
  // command still needs the user's own Enter to actually run.
  await expect.poll(() => localSent(page)).toContain('local')
  expect(await localSent(page)).not.toContain('\r')
  await expect(panel(page)).toHaveCount(0)
})

test('→ completes and drills one level deeper, Enter only completes', async ({ page }) => {
  await connect(page)

  await type(page, 'cd ')
  // The panel is visible while it is still LISTING (items empty) — wait for the
  // real rows before walking the highlight, the same way a user would.
  await expect.poll(() => rowNames(page)).toEqual(['..', 'local', 'log', 'nginx'])
  // Nothing is highlighted yet; row 0 is the synthetic `..`, so ↓ twice reaches
  // `local`.
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await expect.poll(() => activeName(page)).toBe('local')

  // `→` holds the drill that `Tab` used to do — Tab went back to the shell for good.
  await page.keyboard.press('ArrowRight')

  await expect.poll(() => localSent(page)).toContain('local/')
  // Drilling bypasses the cache (a `cd` is not the only thing that can change a
  // directory's contents) and lists where we just moved to.
  await expect.poll(() => listed(page, '/var/www/local')).toBeGreaterThanOrEqual(1)
  await expect.poll(() => rowNames(page)).toEqual(['..', 'bin', 'lib'])

  // `Enter` never drills: it completes and leaves the line for the user's own
  // Enter. The fresh listing opens unhighlighted again, so ↓ twice lands on `bin`.
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await expect.poll(() => activeName(page)).toBe('bin')
  await page.keyboard.press('Enter')
  expect(await localSent(page)).not.toContain('\r')
})

test('Tab reaches the shell even with the dropdown open and a row highlighted', async ({
  page,
}) => {
  await connect(page)

  await type(page, 'cd ')
  await expect.poll(() => rowNames(page)).toEqual(['..', 'local', 'log', 'nginx'])
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await expect.poll(() => activeName(page)).toBe('local')

  // The panel is up and the highlight is on `local`, and `Tab` still goes straight
  // through: readline completes paths from the real filesystem, and a key pressed
  // reflexively must not change meaning because of what an overlay is showing.
  await page.keyboard.press('Tab')
  await expect.poll(() => localSent(page)).toContain('\t')
  expect(await localSent(page)).not.toContain('local/')
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

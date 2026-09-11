import { test, expect, type Page } from '@playwright/test'
import { installTauriMock, invokedCalls, pasteIntoTerminal } from './helpers/tauriMock'

// B20 — multi-line paste guard. Pastes are driven through the same DOM `paste`
// event a real Ctrl+V produces; assertions look at the stub backend calls
// because xterm's rendering is canvas-based. UI language is English by default
// (navigator.language in the test browser).

const DEMO_CONN = { id: 'c1', name: 'Demo', host: 'demo.local', port: 22, username: 'root' }
const SERIAL_CONN = {
  id: 's1',
  name: 'Console',
  host: '',
  port: 0,
  kind: 'serial',
  portName: 'COM3',
  baudRate: 115200,
}

const DIALOG = '.paste-confirm-dialog'

async function openTerminal(page: Page, pollOutputChunks: string[][]) {
  await installTauriMock(page, { connections: [DEMO_CONN], pollOutputChunks })
  await page.goto('/')
  await page.locator('.connection-item').click()
  await expect(page.locator('.tab-item')).toContainText('Demo')
  // `attached` (not `visible`): the guard listens on the container in the
  // capture phase, which works regardless of the pane's visibility state.
  await page.waitForSelector('.xterm-helper-textarea', { state: 'attached' })
}

const sentInput = async (page: Page) =>
  (await invokedCalls(page)).filter((c) => c.cmd === 'send_input').map((c) => String(c.args.data))

test('multi-line paste opens the guard and sends nothing until a choice is made', async ({
  page,
}) => {
  await openTerminal(page, [['root@demo:~$ ']])

  await pasteIntoTerminal(page, 'echo one\necho two')

  const dialog = page.locator(DIALOG)
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('.paste-preview')).toContainText('echo one')

  // Nothing may reach the shell before the user chooses.
  expect(await sentInput(page)).toEqual([])
})

test('a single-line paste stays untouched (no dialog)', async ({ page }) => {
  await openTerminal(page, [['root@demo:~$ ']])

  await pasteIntoTerminal(page, 'ls -la')

  await expect(page.locator(DIALOG)).toHaveCount(0)
  // A trailing `\x05` (Ctrl-E) parks the cursor at the end of the line.
  await expect.poll(async () => await sentInput(page)).toEqual(['ls -la', '\u0005'])
})

test('"execute line by line" sends the raw text (CR separated)', async ({ page }) => {
  await openTerminal(page, [['root@demo:~$ ']])

  await pasteIntoTerminal(page, 'echo one\necho two')
  const dialog = page.locator(DIALOG)
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: /execute line by line/i }).click()

  await expect(dialog).toHaveCount(0)
  // xterm normalises `\r?\n` to `\r` on the paste path.
  await expect.poll(async () => await sentInput(page)).toEqual(['echo one\recho two'])
})

test('"insert without executing" adds a line continuation and uses quoted-insert', async ({
  page,
}) => {
  await openTerminal(page, [['root@demo:~$ ']])

  await pasteIntoTerminal(page, 'echo one\necho two')
  const dialog = page.locator(DIALOG)
  await expect(dialog).toBeVisible()
  // The dialog tells the user about the continuation it is going to add.
  await expect(dialog.locator('.paste-continuation-note')).toBeVisible()
  await dialog.getByRole('button', { name: /insert without executing/i }).click()

  await expect(dialog).toHaveCount(0)
  // Non-final lines get a trailing `\` so the block is ONE command after Enter;
  // `\x16` (Ctrl-V) + LF makes readline insert the newline literally instead of
  // submitting the line. The LF must NOT be normalised to \r. A trailing `\x05`
  // (Ctrl-E) parks the cursor at the end of the inserted block.
  await expect.poll(async () => await sentInput(page)).toEqual(['echo one \\\u0016\necho two', '\u0005'])
})

test('a backslash followed by a stray space is repaired when inserting', async ({ page }) => {
  await openTerminal(page, [['root@demo:~$ ']])

  // `cd \ ` — the backslash is not the last character, so the shell would read
  // `\ ` as an escaped space and run `cd ' '` on its own.
  await pasteIntoTerminal(page, 'cd \\ \n/')
  const dialog = page.locator(DIALOG)
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: /insert without executing/i }).click()

  await expect.poll(async () => await sentInput(page)).toEqual(['cd \\\u0016\n/', '\u0005'])
})

test('an existing continuation is not doubled when inserting', async ({ page }) => {
  await openTerminal(page, [['root@demo:~$ ']])

  await pasteIntoTerminal(page, 'docker run -d \\\nnginx:latest')
  const dialog = page.locator(DIALOG)
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: /insert without executing/i }).click()

  await expect
    .poll(async () => await sentInput(page))
    .toEqual(['docker run -d \\\u0016\nnginx:latest', '\u0005'])
})

test('Esc cancels the guard and an overlay click does not close it', async ({ page }) => {
  await openTerminal(page, [['root@demo:~$ ']])

  await pasteIntoTerminal(page, 'a\nb')
  const dialog = page.locator(DIALOG)
  await expect(dialog).toBeVisible()

  // Project convention: modals are never dismissed by clicking the overlay.
  await page.locator('.modal-overlay').click({ position: { x: 5, y: 5 } })
  await expect(dialog).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  expect(await sentInput(page)).toEqual([])
})

test('bracketed paste into a POSIX shell adds continuations (no dialog)', async ({ page }) => {
  // The shell enables bracketed paste (`CSI ? 2004 h`) — the WSL/bash default,
  // so xterm wraps the paste itself and nothing executes before Enter. The
  // non-final lines still get a `\`, otherwise the buffered newline would split
  // the block into two commands at Enter.
  await openTerminal(page, [['\u001b[?2004hroot@demo:~$ ']])
  // Let the poll loop deliver and xterm parse the mode sequence.
  await page.waitForTimeout(600)

  await pasteIntoTerminal(page, 'echo one\necho two')

  await expect(page.locator(DIALOG)).toHaveCount(0)
  await expect
    .poll(async () => await sentInput(page))
    .toEqual(['\u001b[200~echo one \\\recho two\u001b[201~', '\u0005'])
})

test('a multi-line paste into a serial session is dropped with a toast', async ({ page }) => {
  await installTauriMock(page, { connections: [SERIAL_CONN] })
  await page.goto('/')
  await page.locator('.connection-item').click()
  await expect(page.locator('.tab-item')).toContainText('Console')
  await page.waitForSelector('.xterm-helper-textarea', { state: 'attached' })

  await pasteIntoTerminal(page, 'line one\nline two')

  // Decision 3: serial sessions get no dialog and no send — just a notice.
  await expect(page.locator(DIALOG)).toHaveCount(0)
  await expect(page.locator('.toast')).toContainText(
    'Serial sessions do not support multi-line paste',
  )
  await page.waitForTimeout(200)
  expect(await sentInput(page)).toEqual([])
})

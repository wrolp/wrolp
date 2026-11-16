/**
 * Ctrl+/ toggles line comments in the editor.
 *
 * Monaco's `editor.action.commentLine` needs the language to declare its line
 * comment; the custom languages (nginx / properties / sshconfig), the Makefile
 * id and Monaco's built-in Dockerfile conf had none, so the key silently did
 * nothing in exactly the files that read as "config".
 */
import { test, expect, type Page } from './helpers/fixtures'
import { selectRailMode } from './helpers/sections'
import { installTauriMock } from './helpers/tauriMock'

const DEMO_CONN = { id: 'c1', name: 'Demo', host: 'demo.local', port: 22, username: 'root' }

async function openEditor(page: Page, name: string, content: string) {
  const path = `/etc/${name}`
  await installTauriMock(page, {
    connections: [DEMO_CONN],
    pollOutputChunks: [['root@demo:~$ ']],
    fileEntries: [
      { name, path, isDir: false, size: content.length, mode: '-rw-r--r--', modified: '' },
    ],
    fileContent: {
      path,
      content,
      size: content.length,
      mode: '-rw-r--r--',
      isBinary: false,
      isTooLarge: false,
      encoding: 'utf-8',
      needsEncoding: false,
    },
  })
  await page.goto('/')
  await page.locator('.connection-item').click()
  await selectRailMode(page, 'files')
  await page.locator('.tree-row.file', { hasText: name }).click()
  await expect(page.locator('.monaco-editor')).toBeVisible()
  // Put the caret on the first line: click the text itself. (Ctrl+Home is not
  // used — in the browser it scrolls the page and the editor loses the caret.)
  await page.locator('.view-line').first().locator('span').first().click()
}

/** Non-empty rendered lines, in order (Monaco renders spaces as NBSP). */
const lines = async (page: Page) =>
  (await page.locator('.view-line').allInnerTexts())
    .map((t) => t.replace(/\u00a0/g, ' '))
    .filter((t) => t.trim() !== '')

const toggle = (page: Page) => page.keyboard.press('Control+/')

test('Ctrl+/ toggles # comments in an sshd_config', async ({ page }) => {
  await openEditor(page, 'sshd_config', 'Port 2222\n')
  await toggle(page)
  expect(await lines(page)).toEqual(['# Port 2222'])
  await toggle(page)
  expect(await lines(page)).toEqual(['Port 2222'])
})

test('a built-in language keeps working with its own marker', async ({ page }) => {
  await openEditor(page, 'app.js', 'const x = 1\n')
  await toggle(page)
  expect(await lines(page)).toEqual(['// const x = 1'])
})

test('Ctrl+/ toggles # comments in an nginx config', async ({ page }) => {
  await openEditor(page, 'nginx.conf', 'server {}\n')
  await toggle(page)
  expect(await lines(page)).toEqual(['# server {}'])
})

test('Ctrl+/ toggles # comments in a Dockerfile', async ({ page }) => {
  await openEditor(page, 'Dockerfile', 'FROM debian\n')
  await toggle(page)
  expect(await lines(page)).toEqual(['# FROM debian'])
})

test('Ctrl+/ toggles # comments in a Makefile', async ({ page }) => {
  await openEditor(page, 'Makefile', 'all:\n')
  await toggle(page)
  expect(await lines(page)).toEqual(['# all:'])
})

test('a selected block is commented and uncommented together', async ({ page }) => {
  await openEditor(page, 'sshd_config', 'Port 2222\nPermitRootLogin no\n')
  await page.keyboard.press('Shift+ArrowDown')
  await toggle(page)
  expect(await lines(page)).toEqual(['# Port 2222', '# PermitRootLogin no'])
  await toggle(page)
  expect(await lines(page)).toEqual(['Port 2222', 'PermitRootLogin no'])
})

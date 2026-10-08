import { test, expect, type Page } from './helpers/fixtures'
import { installTauriMock, invokedCalls } from './helpers/tauriMock'

// The Files panel's "up" button (`上级`). It used to be dimmed whenever the panel
// showed its own root, which is the state it OPENS in — a session panel starts at
// $HOME and a local panel at "" (also $HOME) — so the button read as broken rather
// than as a boundary. It now walks up to the filesystem root and stops only there.

const DEMO_CONN = { id: 'c1', name: 'Demo', host: 'demo.local', port: 22, username: 'root' }

const dir = (parent: string, name: string) => ({
  name,
  path: `${parent}${name}`,
  isDir: true,
  size: 0,
  mode: 'drwxr-xr-x',
  modified: '',
})
const file = (parent: string, name: string) => ({
  name,
  path: `${parent}${name}`,
  isDir: false,
  size: 3,
  mode: '-rw-r--r--',
  modified: '',
})

/** What $HOME and its ancestors hold. The panel opens at "." (and a local panel
 *  at ""), and every entry it gets back is absolute — that is how the panel knows
 *  where "up" leads from a path it cannot resolve itself. */
const HOME = [file('/home/root/', 'app.log'), dir('/home/root/', 'src')]
const FILES: Record<string, unknown[]> = {
  '.': HOME,
  '': HOME,
  '/home/root/': HOME,
  '/home/': [dir('/home/', 'root')],
  '/': [dir('/', 'home')],
}

const listed = async (page: Page) =>
  (await invokedCalls(page))
    .filter((c) => c.cmd === 'list_files' || c.cmd === 'target_list_files')
    .map((c) => String(c.args.path))

async function openFilesPanel(page: Page) {
  await installTauriMock(page, {
    connections: [DEMO_CONN],
    pollOutputChunks: [['root@demo:~$ ']],
    filesByDir: FILES,
  })
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  await page.goto('/')
  await page.locator('.connection-item').click()
  await expect(page.locator('.titlebar')).toBeVisible()
  // The Files section of the activity rail: it only appears for a connected tab.
  await page.locator('.rail-item[data-mode="files"]').click()
  await expect(page.locator('.file-panel')).toBeVisible()
}

const up = (page: Page) => page.locator('.file-panel .file-path-up')

test('up is live on the $HOME listing the panel opens in', async ({ page }) => {
  await openFilesPanel(page)

  await expect(page.locator('.file-panel .tree-row').first()).toBeVisible()
  expect(await up(page).getAttribute('class')).not.toContain('disabled')
})

test('up walks towards the filesystem root and stops there', async ({ page }) => {
  await openFilesPanel(page)

  // $HOME → /home → /. Two clicks, then the button is honestly disabled.
  await up(page).click()
  await expect.poll(() => listed(page)).toContain('/home')
  expect(await up(page).getAttribute('class')).not.toContain('disabled')

  await up(page).click()
  await expect.poll(() => listed(page)).toContain('/')
  await expect(up(page)).toHaveClass(/disabled/)
})

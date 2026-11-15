import { test, expect, type Page } from './helpers/fixtures'
import { installTauriMock, invokedCalls } from './helpers/tauriMock'
import { selectRailMode } from './helpers/sections'
import { defaultCloneDest, projectNameFromUrl } from '../../src/lib/gitClone'

// A clone lands in a folder named after the repository, the way `git clone <url>`
// on its own does. The picker used to prefill the folder the user was browsing,
// so the clone either nested one level too deep or failed because that folder
// already existed.

/** The folder being browsed when the clone form opens. */
const PARENT = 'D:\\repos'

test('the project name comes from every URL shape git accepts', () => {
  const cases: Array<[string, string | null]> = [
    ['https://github.com/acme/demo.git', 'demo'],
    ['https://github.com/acme/demo', 'demo'],
    ['https://github.com/acme/demo/', 'demo'],
    ['https://github.com/acme/demo.git?ref=main', 'demo'],
    ['git@github.com:acme/demo.git', 'demo'],
    ['git@github.com:demo.git', 'demo'],
    ['ssh://git@host:2222/group/demo.git', 'demo'],
    ['/srv/repos/demo.git', 'demo'],
    ['D:\\repos\\demo.git', 'demo'],
    ['https://github.com/acme/demo.git#main', 'demo'],
  ]
  for (const [url, name] of cases) expect(projectNameFromUrl(url), url).toBe(name)

  // Nothing to derive a name from: a host with no repository path, or empties.
  for (const url of ['', '   ', 'https://github.com/', 'https://github.com']) {
    expect(projectNameFromUrl(url), url).toBeNull()
  }
  // A trailing separator on a plain path is still a directory name (`git clone`
  // would create `repos`), so it must not be treated as unknown.
  expect(projectNameFromUrl('/srv/repos/')).toBe('repos')
})

test('the destination joins the browsed folder with the project name', () => {
  expect(defaultCloneDest('D:\\repos', 'https://github.com/acme/demo.git')).toBe('D:\\repos\\demo')
  expect(defaultCloneDest('/opt/', 'git@host:group/demo.git')).toBe('/opt/demo')
  expect(defaultCloneDest('/', 'https://github.com/acme/demo.git')).toBe('/demo')
  expect(defaultCloneDest('D:\\', 'https://github.com/acme/demo.git')).toBe('D:\\demo')
  // Without a URL it is just the folder, and without a folder just the name.
  expect(defaultCloneDest('/opt', '')).toBe('/opt')
  expect(defaultCloneDest('', 'https://github.com/acme/demo.git')).toBe('demo')
})

async function boot(page: Page) {
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  await installTauriMock(page, {})
  await page.goto('/')
  await selectRailMode(page, 'hosts')
  await page.locator('.conn-item.local-term-default').click()
  await selectRailMode(page, 'git')
  await page.locator('.git-path-row input').fill(PARENT)
  await page.getByRole('button', { name: 'Clone a repository…' }).click()
}

const urlInput = (page: Page) => page.locator('.git-clone-row input').first()
const destInput = (page: Page) => page.locator('.git-clone-row input').nth(1)

test('typing a URL fills the destination with the project name', async ({ page }) => {
  await boot(page)
  // Before a URL there is nothing to name the folder after.
  await expect(destInput(page)).toHaveValue(PARENT)

  await urlInput(page).fill('https://github.com/acme/demo.git')
  await expect(destInput(page)).toHaveValue('D:\\repos\\demo')

  // Still following: a different repository means a different folder.
  await urlInput(page).fill('git@host:group/other.git')
  await expect(destInput(page)).toHaveValue('D:\\repos\\other')
})

test('an edited destination is not overwritten by later URL edits', async ({ page }) => {
  await boot(page)
  await urlInput(page).fill('https://github.com/acme/demo.git')
  await destInput(page).fill('D:\\work\\custom')
  await urlInput(page).fill('https://github.com/acme/another.git')

  await expect(destInput(page)).toHaveValue('D:\\work\\custom')

  await page.locator('.git-clone-row button[type="submit"]').click()
  await expect
    .poll(async () => (await invokedCalls(page)).filter((c) => c.cmd === 'git_clone').at(-1)?.args)
    .toMatchObject({
      url: 'https://github.com/acme/another.git',
      dest: 'D:\\work\\custom',
    })
})

import { test, expect, type Page } from './helpers/fixtures'
import { installTauriMock } from './helpers/tauriMock'
import { selectRailMode } from './helpers/sections'

// The picker's fields are drawn by `_git.scss`, not by a dialog's `.form-group`,
// so they have to be styled explicitly. Without that the clone form fell back to
// the UA's grey boxes: a different control from the Open row above it, and taller
// than the button beside it. These assertions are relational — the clone fields
// must look like the picker's own path field — so a token change moves all of
// them together instead of breaking the test.

const REPO = 'D:\\repos\\demo'

async function boot(page: Page) {
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  await installTauriMock(page, {})
  await page.goto('/')
  await selectRailMode(page, 'hosts')
  await page.locator('.conn-item.local-term-default').click()
  await selectRailMode(page, 'git')
}

async function styleOf(locator: ReturnType<Page['locator']>, props: string[]) {
  return await locator.evaluate((el, keys) => {
    const cs = getComputedStyle(el as Element)
    const out: Record<string, string> = {}
    for (const k of keys) out[k] = cs.getPropertyValue(k)
    return out
  }, props)
}

test('the clone fields look like the picker path field, not UA defaults', async ({ page }) => {
  await boot(page)

  const pathInput = page.locator('.git-path-row input')
  await pathInput.fill(REPO)
  const reference = await styleOf(pathInput, [
    'background-color',
    'border-top-width',
    'border-top-style',
    'border-radius',
    'font-size',
    'font-family',
  ])

  await page.getByRole('button', { name: 'Clone a repository…' }).click()
  const urlInput = page.locator('.git-clone-row input').first()
  await expect(urlInput).toBeVisible()

  for (const locator of [urlInput, page.locator('.git-clone-row input').nth(1)]) {
    const clone = await styleOf(locator, Object.keys(reference))
    expect(clone).toEqual(reference)
  }

  // Placeholder text is dimmed like the rest of the app instead of the UA grey.
  await expect(urlInput).toHaveAttribute('placeholder', 'Repository URL')
})

test('clone fields and the Clone button sit on the same baseline', async ({ page }) => {
  await boot(page)
  await page.locator('.git-path-row input').fill(REPO)
  await page.getByRole('button', { name: 'Clone a repository…' }).click()

  const button = page.locator('.git-clone-row button[type="submit"]')
  const [dest, buttonBox] = await Promise.all([
    page.locator('.git-clone-row input').nth(1).boundingBox(),
    button.boundingBox(),
  ])
  expect(dest).not.toBeNull()
  expect(buttonBox).not.toBeNull()
  // `.btn` is 24px tall; the input must match it rather than tower over it.
  expect(Math.abs(dest!.height - buttonBox!.height)).toBeLessThanOrEqual(1)

  // The URL owns its own line — side by side, two paths in a 264px rail are
  // unreadable.
  const form = await page.locator('.git-clone-row').boundingBox()
  const url = await page.locator('.git-clone-row input').first().boundingBox()
  expect(url!.width).toBeGreaterThan(form!.width - 4)
  expect(url!.y).toBeLessThan(dest!.y)
})

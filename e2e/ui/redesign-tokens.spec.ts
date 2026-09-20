import { test, expect } from './helpers/fixtures'
import { installTauriMock } from './helpers/tauriMock'

// P0 of the redesign: the token layer and the runtime accent.
//
// The store reads localStorage at module init, so each case seeds the preference
// before the app boots rather than reaching for a setter.

const read = (page: import('@playwright/test').Page, prop: string) =>
  page.evaluate((p) => getComputedStyle(document.documentElement).getPropertyValue(p).trim(), prop)

async function bootWith(page: import('@playwright/test').Page, prefs: Record<string, string>) {
  await installTauriMock(page, {})
  await page.addInitScript((items) => {
    for (const [key, value] of Object.entries(items)) localStorage.setItem(key, value)
  }, prefs)
  await page.goto('/')
}

test('emits the structural tokens the component layer is built on', async ({ page }) => {
  await bootWith(page, {})
  for (const prop of ['--sp-3', '--r-2', '--fs-ui', '--d-2', '--e-out', '--z-toast']) {
    expect(await read(page, prop), prop).not.toBe('')
  }
  // Regression guard: `--font-mono` was read by App.tsx for ages without ever
  // being defined, so those two call sites silently fell back to Consolas.
  expect(await read(page, '--font-mono')).toContain('"Cascadia Code"')
})

test('the default accent keeps the theme table values untouched', async ({ page }) => {
  await bootWith(page, {})
  const theme = await read(page, '--accent')
  expect(['#0e639c', '#0066b8']).toContain(theme)
  // No inline override is written for 'default', so the derived shades stay the
  // build-time Sass ones rather than a runtime approximation.
  expect(
    await page.evaluate(() => document.documentElement.style.getPropertyValue('--accent')),
  ).toBe('')
})

test('a chosen accent overrides the family and derives its shades', async ({ page }) => {
  await bootWith(page, { 'wrolp-accent': '#e0714f' })
  expect(await read(page, '--accent')).toBe('#e0714f')
  for (const prop of ['--accent-hover', '--accent-l8', '--accent-l12', '--accent-l14']) {
    const value = await read(page, prop)
    expect(value, prop).toMatch(/^#[0-9a-f]{6}$/)
    expect(value, `${prop} must move away from the base, not copy it`).not.toBe('#e0714f')
  }
})

test('a light accent switches the text on it instead of staying white', async ({ page }) => {
  await bootWith(page, { 'wrolp-accent': '#e0a13c' })
  expect(await read(page, '--text-on-accent')).toBe('#171717')
})

test('a dark accent keeps white text', async ({ page }) => {
  await bootWith(page, { 'wrolp-accent': '#25476a' })
  expect(await read(page, '--text-on-accent')).toBe('#ffffff')
})

test('density is recorded on <html> for the layout to read', async ({ page }) => {
  await bootWith(page, { 'wrolp-density': 'compact' })
  await expect(page.locator('html')).toHaveAttribute('data-density', 'compact')
})

test('a stored accent that is not a colour is ignored', async ({ page }) => {
  await bootWith(page, { 'wrolp-accent': 'hot-pink' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', /.*/)
  expect(
    await page.evaluate(() => document.documentElement.style.getPropertyValue('--accent')),
  ).toBe('')
})

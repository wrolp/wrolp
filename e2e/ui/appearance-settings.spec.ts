import { test, expect } from './helpers/fixtures'
import { installTauriMock, invokedCalls } from './helpers/tauriMock'
import { ACCENT_PRESETS } from '../../src/lib/accentPresets'
import { contrastRatio, LIGHT_TEXT_BG } from '../../src/lib/themeColors'
import en from '../../src/i18n/en'

// P4 of the redesign: the appearance card.
//
// Every preference here is a localStorage value the store applies to `<html>`
// before the first render, so most cases seed the key and boot rather than drive
// a setter — that is also what proves the out-of-box value still belongs to the
// stylesheet rather than to something the JS restated.

const DEMO_CONN = { id: 'c1', name: 'Demo', host: 'demo.local', port: 22, username: 'root' }

async function boot(
  page: import('@playwright/test').Page,
  prefs: Record<string, string> = {},
  layout?: string,
) {
  await installTauriMock(page, {
    connections: [DEMO_CONN],
    pollOutputChunks: [['root@demo:~$ ']],
    ...(layout ? { layout } : {}),
  })
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  await page.addInitScript((items) => {
    for (const [key, value] of Object.entries(items)) localStorage.setItem(key, value)
  }, prefs)
  await page.goto('/')
}

/** Open the settings tab and wait for the appearance card in the General pane. */
async function openAppearance(page: import('@playwright/test').Page) {
  await page.locator('.settings-btn').click()
  await expect(page.locator('.swatches')).toBeVisible()
}

const inline = (page: import('@playwright/test').Page, prop: string) =>
  page.evaluate((p) => document.documentElement.style.getPropertyValue(p), prop)

const fontSizeOf = (page: import('@playwright/test').Page, selector: string) =>
  page.evaluate((sel) => getComputedStyle(document.querySelector(sel)!).fontSize, selector)

/** Seconds, so `0.001ms` and `100ms` compare without string games. */
const transitionSeconds = (page: import('@playwright/test').Page, selector: string) =>
  page.evaluate((sel) => {
    const raw = getComputedStyle(document.querySelector(sel)!).transitionDuration
    return Number.parseFloat(raw) * (raw.endsWith('ms') ? 0.001 : 1)
  }, selector)

/**
 * The `save_layout` payload the app last wrote — the two columns live there, not in
 * CSS. `null` until the first write lands, and writes are debounced 400ms, so every
 * caller polls the value rather than reading it once.
 */
async function lastLayout(page: import('@playwright/test').Page) {
  const calls = (await invokedCalls(page)).filter((c) => c.cmd === 'save_layout')
  if (!calls.length) return null
  return JSON.parse(String(calls[calls.length - 1].args.layout)) as {
    sidebar: { width: number }
    inspector: { width: number }
  }
}

test('the appearance preferences leave <html> and the type scale at their defaults', async ({
  page,
}) => {
  await boot(page)
  const html = page.locator('html')
  await expect(html).toHaveAttribute('data-motion', 'system')
  await expect(html).toHaveAttribute('data-focus-ring', 'on')
  await expect(html).toHaveAttribute('data-status-shapes', 'on')
  // Like the 'default' accent, an untouched size is removed rather than restated,
  // so `:root` stays the thing that owns the out-of-box value.
  expect(await inline(page, '--fs-ui')).toBe('')
})

test('a seeded interface size moves the whole scale it feeds', async ({ page }) => {
  await boot(page, { 'wrolp-ui-font-size': '14' })
  expect(await inline(page, '--fs-ui')).toBe('14px')
  await openAppearance(page)
  // `.settings-label` is `--fs-md` (= `--fs-ui`) and `.settings-nav-item` is
  // `--fs-lg` (= `--fs-ui` + 1px): the scale, not one hard-coded rule.
  expect(await fontSizeOf(page, '.settings-label')).toBe('14px')
  expect(await fontSizeOf(page, '.settings-nav-item')).toBe('15px')
})

test('the slider commits through the registry, so the pick survives a reload', async ({ page }) => {
  await boot(page)
  await openAppearance(page)
  await page.locator('#ui-font-size').fill('14')
  await page.locator('#ui-font-size').blur()
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('wrolp-ui-font-size')))
    .toBe('14')
  expect(await inline(page, '--fs-ui')).toBe('14px')
})

test('“Off” kills motion without the OS asking for it', async ({ page }) => {
  await boot(page, { 'wrolp-motion': 'off' })
  await openAppearance(page)
  expect(await transitionSeconds(page, '.settings-nav-item')).toBeLessThan(0.01)
})

test('“On” keeps motion even against a system reduced-motion request', async ({ page }) => {
  await boot(page, { 'wrolp-motion': 'on' })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await openAppearance(page)
  expect(await transitionSeconds(page, '.settings-nav-item')).toBeGreaterThan(0.01)
})

/**
 * Programmatic focus alone does not make a button match `:focus-visible`; a real
 * keystroke after it does, which is what the ring is for.
 */
async function outlineOfKeyboardFocus(page: import('@playwright/test').Page) {
  await page.locator('.settings-nav-item').first().focus()
  await page.keyboard.press('Tab')
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement
    const s = getComputedStyle(el)
    return { style: s.outlineStyle, width: s.outlineWidth }
  })
}

test('the focus-ring switch is the only thing that hides the ring', async ({ page }) => {
  await boot(page)
  await openAppearance(page)
  expect(await outlineOfKeyboardFocus(page)).toEqual({ style: 'solid', width: '2px' })

  await boot(page, { 'wrolp-focus-ring': 'off' })
  await openAppearance(page)
  expect((await outlineOfKeyboardFocus(page)).style).toBe('none')
})

// Reaching a real `.err` dot needs a failed connection, and what is being pinned
// here is the stylesheet, not the session lifecycle — so the dot is a probe.
const dotShapes = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const make = (cls: string) => {
      const el = document.createElement('span')
      el.className = `dot ${cls}`
      document.body.append(el)
      const s = getComputedStyle(el)
      const out = { radius: s.borderTopLeftRadius, clip: s.clipPath }
      el.remove()
      return out
    }
    return { err: make('err'), warn: make('warn') }
  })

test('status shapes are redundant by default and retractable on request', async ({ page }) => {
  await boot(page)
  const on = await dotShapes(page)
  expect(on.err.radius).toBe('0px')
  expect(on.warn.clip).toContain('polygon')

  await boot(page, { 'wrolp-status-shapes': 'off' })
  const off = await dotShapes(page)
  expect(off.err.radius).toBe('50%')
  expect(off.warn.clip).toBe('none')
})

test('a swatch sets the accent and “Reset” hands it back to the theme table', async ({ page }) => {
  await boot(page)
  await openAppearance(page)
  await page.getByRole('button', { name: 'Clay', exact: true }).click()
  expect(await inline(page, '--accent')).toBe('#e0714f')
  expect(await page.evaluate(() => localStorage.getItem('wrolp-accent'))).toBe('#e0714f')
  await expect(page.locator('.swatch[aria-pressed="true"]')).toHaveCount(1)

  await page.locator('.swatches').getByRole('button', { name: 'Reset' }).click()
  expect(await inline(page, '--accent')).toBe('')
  expect(await page.evaluate(() => localStorage.getItem('wrolp-accent'))).toBe('default')
})

// The contrast gate parses SCSS, so it cannot see a runtime accent at all — this
// is the only automated check on the shade the picker actually paints.
test('every preset keeps its derived light-theme text shade above AA', async ({ page }) => {
  await boot(page, { 'wrolp-theme': 'light' })
  await openAppearance(page)
  for (const preset of ACCENT_PRESETS) {
    await page.getByRole('button', { name: en[preset.labelKey], exact: true }).click()
    const shade = await inline(page, '--accent-soft-40')
    expect(
      contrastRatio(shade, LIGHT_TEXT_BG),
      `${preset.hex} derives "${shade}" — too dark to read on the light theme's own surface`,
    ).toBeGreaterThanOrEqual(4.5)
  }
})

test('density is written to <html> and to storage from the segment', async ({ page }) => {
  await boot(page)
  await openAppearance(page)
  await page.getByRole('button', { name: 'Comfy' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-density', 'comfy')
  expect(await page.evaluate(() => localStorage.getItem('wrolp-density'))).toBe('comfy')
})

test('density moves the columns a user never dragged…', async ({ page }) => {
  await boot(page)
  await openAppearance(page)
  await page.getByRole('button', { name: 'Comfy' }).click()
  await expect.poll(async () => (await lastLayout(page))?.inspector.width).toBe(344)
  expect((await lastLayout(page))?.sidebar.width).toBe(276)
})

test('…and leaves the one they did alone', async ({ page }) => {
  await boot(page, {}, JSON.stringify({ sidebar: { width: 400 }, inspector: { width: 308 } }))
  await openAppearance(page)
  await page.getByRole('button', { name: 'Comfy' }).click()
  await expect.poll(async () => (await lastLayout(page))?.inspector.width).toBe(344)
  expect((await lastLayout(page))?.sidebar.width).toBe(400)
})

import { test, expect, type Page } from './helpers/fixtures'
import { installTauriMock } from './helpers/tauriMock'

// Native <select>: the OS arrow sits flush against the border and the popup's
// hover highlight is an OS grey that flashes white on the dark panel. Both are
// UA-drawn and unreachable from CSS, so SelectOverlay replaces the arrow with an
// inline SVG and opens a themed, in-DOM listbox instead of the native popup.

const DEMO_CONN = {
  id: 'c1',
  name: 'Demo',
  host: 'demo.local',
  port: 22,
  username: 'root',
  group: 'Network',
}

const WORKSPACES = {
  workspaces: [{ id: 'default', name: 'Default', createdAt: '2026-01-01T00:00:00Z' }],
  activeWorkspaceId: 'default',
}

async function openConnectionEditor(page: Page, connections: unknown[] = [DEMO_CONN]) {
  await installTauriMock(page, {
    connections,
    workspaces: WORKSPACES,
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'New SSH connection' }).click()
  // The group header's "+" only materialises on hover; it opens the editor with
  // the group preselected.
  await page.locator('.conn-group-header', { hasText: 'Network' }).hover()
  await page.locator('.conn-group-add[title="Add connection to Network"]').click()
  await expect(page.locator('.modal')).toBeVisible()
}

const selectStyle = (page: Page) =>
  page.locator('.modal .form-group select').first().evaluate((el) => {
    const cs = getComputedStyle(el)
    return {
      appearance: cs.appearance,
      backgroundImage: cs.backgroundImage,
      paddingRight: parseFloat(cs.paddingRight),
      colorScheme: cs.colorScheme,
      borderRadius: parseFloat(cs.borderRadius),
      borderWidth: parseFloat(cs.borderTopWidth),
    }
  })

/** The scheme the UA paints its own widgets (the popup) in — set on `:root`. */
const rootScheme = (page: Page) =>
  page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)

test('a select draws its own chevron with room on the right', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('wrolp-lang', 'en')
    // Pin the theme: Playwright's default color-scheme emulation is light.
    localStorage.setItem('wrolp-theme', 'dark')
  })
  await openConnectionEditor(page)

  const style = await selectStyle(page)
  // The native arrow is gone, replaced by an inline SVG…
  expect(style.appearance).toBe('none')
  expect(style.backgroundImage).toContain('svg')
  // …which sits 26px in from the right edge, so the value never prints under it.
  expect(style.paddingRight).toBeGreaterThanOrEqual(22)
  // A real border with the panel radius, not the UA's square box.
  expect(style.borderWidth).toBeGreaterThanOrEqual(1)
  expect(style.borderRadius).toBeGreaterThanOrEqual(6)
  // The OS-drawn list follows the (dark) theme instead of flashing white — the
  // scheme has to be on `:root`, because the popup is a separate surface.
  expect(style.colorScheme).toContain('dark')
  expect(await rootScheme(page)).toContain('dark')
})

test('clicking a select opens a themed listbox, not the OS popup', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('wrolp-lang', 'en')
    localStorage.setItem('wrolp-theme', 'dark')
  })
  await openConnectionEditor(page)

  const select = page.locator('.modal .form-group select').first()
  await select.click()

  const menu = page.locator('.wl-select-menu')
  await expect(menu).toBeVisible()
  await expect(menu.locator('.wl-select-option').first()).toHaveText('(No Group)')

  // The hover highlight is a dark wash, never the OS's light grey. Hover a row
  // that is NOT the current value so we measure the plain `active` colour.
  const option = menu.locator('.wl-select-option').first()
  await option.hover()
  await expect(option).toHaveClass(/active/)
  const bg = await option.evaluate((el) => getComputedStyle(el).backgroundColor)
  // Chromium resolves `color-mix()` tokens to `color(srgb r g b / a)` with 0..1
  // channels; plain rgb() stays 0..255.
  const nums = (bg.match(/[\d.]+/g) ?? []).map(Number)
  const scale = nums.slice(0, 3).every((n) => n <= 1) ? 255 : 1
  expect(((nums[0] + nums[1] + nums[2]) / 3) * scale).toBeLessThan(100)

  // Picking a row writes through the native setter + `change`, so React's
  // onChange still runs (this one opens the "new group" input).
  await menu.locator('.wl-select-option', { hasText: '+ New Group…' }).click()
  await expect(menu).toHaveCount(0)
  await expect(page.getByPlaceholder('New group name')).toHaveValue('')

  await select.click()
  await expect(menu).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)

  // A focused select must not fall back to the OS popup on Enter either.
  await select.focus()
  await page.keyboard.press('Enter')
  await expect(menu).toBeVisible()
  await page.keyboard.press('Escape')
})

test('selectOption still works with the custom popup in place', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  await openConnectionEditor(page)

  const select = page.locator('.modal .form-group select').first()
  await select.selectOption('__new__')
  // No OS popup was involved; the React handler reacted to the change event.
  await expect(page.getByPlaceholder('New group name')).toBeVisible()
  await expect(page.locator('.wl-select-menu')).toHaveCount(0)
})

// Enough saved groups to make the list far taller than any viewport.
const MANY_GROUPS = [
  DEMO_CONN,
  ...Array.from({ length: 40 }, (_, i) => ({
    id: `c${i + 2}`,
    name: `Host ${i}`,
    host: `10.0.0.${i + 2}`,
    port: 22,
    username: 'root',
    group: `Group ${String(i).padStart(2, '0')}`,
  })),
]

test('a long group list scrolls inside the viewport instead of running off it', async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  await openConnectionEditor(page, MANY_GROUPS)

  const select = page.locator('.modal .form-group select').first()
  await select.click()

  const menu = page.locator('.wl-select-menu')
  await expect(menu).toBeVisible()

  const metrics = await menu.evaluate((el) => {
    const r = el.getBoundingClientRect()
    return {
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
      overflowY: getComputedStyle(el).overflowY,
      top: r.top,
      bottom: r.bottom,
      viewport: window.innerHeight,
    }
  })
  // There IS a scrollbar, and the menu itself stays fully on screen.
  expect(metrics.overflowY).toBe('auto')
  expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight)
  expect(metrics.top).toBeGreaterThanOrEqual(0)
  expect(metrics.bottom).toBeLessThanOrEqual(metrics.viewport)

  // Scrolling the menu must not dismiss it (only page scrolling closes it).
  await menu.evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })
  await expect(menu).toBeVisible()

  // The tail of the list is still reachable and clickable.
  await menu.locator('.wl-select-option', { hasText: '+ New Group…' }).click()
  await expect(page.getByPlaceholder('New group name')).toBeVisible()
})

test('the light theme gets its own chevron and a light-scheme list', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('wrolp-lang', 'en')
    localStorage.setItem('wrolp-theme', 'light')
  })
  await openConnectionEditor(page)

  const style = await selectStyle(page)
  expect(style.colorScheme).toContain('light')
  expect(await rootScheme(page)).toContain('light')
  // The chevron is theme-coloured, not the dark theme's grey.
  expect(style.backgroundImage).toContain('57606a')
})

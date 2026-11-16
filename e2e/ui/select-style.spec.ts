import { test, expect, type Page } from './helpers/fixtures'
import { installTauriMock } from './helpers/tauriMock'
import { selectRailMode } from './helpers/sections'

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
  page
    .locator('.modal .form-group select')
    .first()
    .evaluate((el) => {
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
  const list = menu.locator('.wl-select-list')
  await expect(menu).toBeVisible()

  const metrics = await list.evaluate((el) => ({
    clientHeight: el.clientHeight,
    scrollHeight: el.scrollHeight,
    overflowY: getComputedStyle(el).overflowY,
  }))
  const frame = await menu.evaluate((el) => {
    const r = el.getBoundingClientRect()
    return { top: r.top, bottom: r.bottom, viewport: window.innerHeight }
  })
  // The list is the scrollport, and the menu frame itself stays on screen.
  expect(metrics.overflowY).toBe('auto')
  expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight)
  expect(frame.top).toBeGreaterThanOrEqual(0)
  expect(frame.bottom).toBeLessThanOrEqual(frame.viewport)

  // Scrolling the menu must not dismiss it (only page scrolling closes it).
  await list.evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })
  await expect(menu).toBeVisible()

  // The tail of the list is still reachable and clickable.
  await menu.locator('.wl-select-option', { hasText: '+ New Group…' }).click()
  await expect(page.getByPlaceholder('New group name')).toBeVisible()
})

test('a tall language list opens below the toolbar instead of parking above', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  const name = 'app.ini'
  const path = `/srv/${name}`
  const content = 'key=value\n'
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

  // The editor toolbar sits near the top, so the language list has far more
  // room BELOW it — yet ~29 rows do not fit on one screen. The old check
  // measured the unconstrained height, decided "doesn't fit below" and opened
  // above (at the viewport top); a later hover re-ran the layout and flipped it
  // down — the user's "hover 后才翻转下来".
  const select = page.locator('.editor-select select').first()
  await select.click()
  const menu = page.locator('.wl-select-menu')
  await expect(menu).toBeVisible()

  const sel = await select.boundingBox()
  const box = await menu.boundingBox()
  expect(sel).not.toBeNull()
  expect(box).not.toBeNull()
  expect(box!.y).toBeGreaterThanOrEqual(sel!.y + sel!.height)
  const vh = await page.evaluate(() => window.innerHeight)
  expect(box!.y + box!.height).toBeLessThanOrEqual(vh)
  // Capped, not pushed up: the tail is reached by scrolling this list.
  expect(
    await menu.locator('.wl-select-list').evaluate((el) => el.scrollHeight > el.clientHeight),
  ).toBe(true)
})

test('the list shows its own scrollbar and keeps its place while rows hover', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  await openConnectionEditor(page, MANY_GROUPS)

  const select = page.locator('.modal .form-group select').first()
  // Pin the chosen value to the FIRST row, so a reveal-the-selection bug would
  // yank a bottom-scrolled list all the way back to the top.
  await select.selectOption({ label: '(No Group)' })
  await select.click()

  const menu = page.locator('.wl-select-menu')
  const list = menu.locator('.wl-select-list')
  await expect(menu).toBeVisible()
  expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)

  // The shared overlay thumb is this list's scrollbar: it exists once the list
  // overflows and shows while the pointer is over it.
  const thumb = menu.locator('.sidebar-scrollbar-thumb')
  await menu.hover()
  await expect(menu.locator('.sidebar-scrollbar')).toHaveClass(/show/)
  await expect(thumb).toHaveCount(1)

  // Scroll to the tail; the thumb follows.
  const before = await list.evaluate((el) => {
    el.scrollTop = el.scrollHeight
    return el.scrollTop
  })
  expect(before).toBeGreaterThan(0)
  await expect
    .poll(async () =>
      parseFloat((await thumb.getAttribute('style'))?.match(/top:\s*([\d.]+)px/)?.[1] ?? '0'),
    )
    .toBeGreaterThan(0)

  // Move the POINTER over a row (hover changes the active row). The list must
  // stay where the wheel left it instead of snapping back to the selection.
  const box = await list.boundingBox()
  expect(box).not.toBeNull()
  await page.mouse.move(box!.x + 24, box!.y + box!.height - 16)
  await page.waitForTimeout(150)
  const after = await list.evaluate((el) => el.scrollTop)
  expect(after).toBeGreaterThan(before - 40)
  await expect(menu).toBeVisible()
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

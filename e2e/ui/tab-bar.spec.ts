import { test, expect } from './helpers/fixtures'
import { installTauriMock } from './helpers/tauriMock'

// P2-2 of the redesign: the tab strip stopped being a row of text with emoji
// pasted in front of it.
//
// Two things are really being pinned. The label is now *only* the label, because
// the same string also feeds window titles and the pane header, where `🖥 pwsh`
// is noise. And the kind of a tab is an SVG that inherits the text colour, so it
// stays quiet next to the name and follows the theme, which a colour picture
// pasted into a `<span>` never did.

const DEMO_CONN = { id: 'c1', name: 'Demo', host: 'demo.local', port: 22, username: 'root' }

async function bootEnglish(page: import('@playwright/test').Page) {
  await installTauriMock(page, {
    connections: [DEMO_CONN],
    pollOutputChunks: [['root@demo:~$ ']],
  })
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  await page.goto('/')
}

test('a tab pairs a kind icon with a label that carries no glyph of its own', async ({ page }) => {
  await bootEnglish(page)
  await page.locator('.connection-item').click()

  const tab = page.locator('.tab-item')
  await expect(tab.locator('svg.tab-icon')).toHaveCount(1)
  await expect(tab.locator('.tab-label')).toHaveText('Demo')

  // The emoji prefixes used to live inside the label string itself, so this is
  // the regression guard for the whole change: the tab's text, close button
  // aside, must be exactly the name.
  expect((await tab.textContent())?.trim()).toBe('Demo')
})

test('the icon is quieter than the name it sits next to', async ({ page }) => {
  await bootEnglish(page)
  await page.locator('.connection-item').click()

  const { icon, label } = await page.evaluate(() => {
    const colour = (sel: string) => getComputedStyle(document.querySelector(sel)!).color
    return {
      icon: colour('.tab-item.active .tab-icon'),
      label: colour('.tab-item.active .tab-label'),
    }
  })
  // An active tab inherits the header's primary text for both, which is the
  // point: the icon must not fight the name for attention.
  expect(icon).toBe(label)
})

test('closing a tab is a button with a real hit area, not a × character', async ({ page }) => {
  await bootEnglish(page)
  await page.locator('.connection-item').click()

  const close = page.getByRole('button', { name: 'Close tab' })
  await expect(close).toHaveCount(1)
  const box = await close.boundingBox()
  // 18px is the target the approved draft asks for; the glyph it replaces was
  // 11px of ink on an undefined box.
  expect(box?.width).toBeGreaterThanOrEqual(18)
  expect(box?.height).toBeGreaterThanOrEqual(18)
})

test('the strip brackets itself with two labelled icon buttons', async ({ page }) => {
  await bootEnglish(page)

  // Both used to be bespoke classes with hand-drawn SVG / an U+229E glyph.
  await expect(page.getByRole('button', { name: 'Hide sidebar' })).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Split Terminal' })).toHaveCount(1)
  // The tab bar only appears once a tab exists, so assert the toggle survives
  // the transition from the boot state to a session state.
  await page.getByRole('button', { name: 'Hide sidebar' }).click()
  await expect(page.locator('.sidebar')).toBeHidden()
  await expect(page.getByRole('button', { name: 'Show sidebar' })).toHaveCount(1)
})

test('non-terminal tabs read their kind from the icon, not from the name', async ({ page }) => {
  await bootEnglish(page)
  await page.locator('.settings-btn').click()

  const active = page.locator('.tab-item.active')
  await expect(active.locator('.tab-label')).toHaveText('Settings')
  await expect(active.locator('svg.tab-icon')).toHaveCount(1)
})

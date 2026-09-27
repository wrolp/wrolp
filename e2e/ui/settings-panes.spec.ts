import { test, expect, type Page } from './helpers/fixtures'
import { installTauriMock } from './helpers/tauriMock'

// General used to be one scroll holding every card — a 370-line card mixed window
// opacity with the data root and the updater. It is now one pane per theme, so these
// pin the two things the split is for: a control lives in exactly ONE pane, and the
// pane header says the same name the sidebar button does.

async function openSettings(page: Page) {
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  await page.setViewportSize({ width: 1100, height: 760 })
  await installTauriMock(page, {})
  await page.goto('/')
  await page.locator('.titlebar-btn.settings-btn').click()
  await expect(page.locator('.settings-content')).toBeVisible()
}

const nav = (page: Page) => page.locator('.settings-nav-item')
const header = (page: Page) => page.locator('.settings-pane-header h3')

/** `#id` is only in the DOM while its own pane is showing. */
const field = (page: Page, id: string) => page.locator(`#${id}`)

// About sits last, and it absorbed the updater.
const PANES = ['Appearance', 'Terminal', 'Data', 'Docker', 'AI Assistant', 'About']

test('the sidebar lists one entry per pane, in order', async ({ page }) => {
  await openSettings(page)
  await expect(nav(page)).toHaveText(PANES)
  // The first entry is the one showing on a fresh open, and the header agrees with it.
  await expect(nav(page).first()).toHaveClass(/active/)
  await expect(header(page)).toHaveText('Appearance')
})

test('picking an entry moves the header with it', async ({ page }) => {
  await openSettings(page)
  for (const name of PANES) {
    await nav(page).filter({ hasText: name }).click()
    await expect(header(page), `header for ${name}`).toHaveText(name)
  }
})

test('each control shows in exactly one pane', async ({ page }) => {
  await openSettings(page)
  // One field per pane, chosen for the theme it belongs to rather than for convenience:
  // opacity is appearance, keepalive is the terminal, the file-open limit is data.
  const home: Record<string, string> = {
    'ui-theme': 'Appearance',
    'ui-language': 'Appearance',
    maxScrollback: 'Terminal',
    keepaliveInterval: 'Terminal',
    maxFileOpenSize: 'Data',
    'docker-maxlines': 'Docker',
  }
  for (const [id, pane] of Object.entries(home)) {
    for (const name of PANES) {
      await nav(page).filter({ hasText: name }).click()
      const count = name === pane ? 1 : 0
      await expect(field(page, id), `#${id} under ${name}`).toHaveCount(count)
    }
  }
})

test('about is its own pane, last, and holds the updater', async ({ page }) => {
  await openSettings(page)
  await expect(page.locator('.app-version-info')).toHaveCount(0)
  const check = page.locator('.settings-card button', { hasText: 'Check for updates' })
  await expect(check).toHaveCount(0)

  await nav(page).filter({ hasText: 'About' }).click()
  await expect(page.locator('.app-version-info')).toBeVisible()
  // The updater merged into this pane rather than keeping a nav entry of its own.
  await expect(check).toBeVisible()
})

test('the assistant’s own look moved out of General', async ({ page }) => {
  await openSettings(page)
  const card = page.locator('.settings-card', { hasText: 'AI appearance & settings' })
  await expect(card).toHaveCount(0)
  await nav(page).filter({ hasText: 'AI Assistant' }).click()
  await expect(card).toBeVisible()
})

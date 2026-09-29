import { expect, type Page } from './fixtures'

/**
 * The activity rail owns the mode column, so a spec that wants the file tree or
 * the container list has to put it there first — the panel is not mounted until
 * its mode is picked. Saying so in the spec is the point: it makes "which panel
 * is showing" a precondition rather than an accident of the default.
 *
 * Idempotent: the rail toggles, so clicking the mode that is already active
 * would fold the column away — skip the click when that mode's panel is
 * already showing.
 */
export async function selectRailMode(
  page: Page,
  mode: 'hosts' | 'files' | 'containers' | 'sessions' | 'nettools',
) {
  const item = page.locator(`.rail-item[data-mode="${mode}"]`)
  await expect(item).toBeVisible()
  const panel = page.locator('.sidebar-container.mode-panel')
  if ((await item.getAttribute('class'))?.includes('active') && (await panel.count()) > 0) {
    return
  }
  await item.click()
  await expect(item).toHaveClass(/active/)
}

/**
 * The head of the panel currently owning the mode column. Every section used to
 * fold itself and had to be opened before a spec could reach its rows; the rail
 * mounts one panel at a time and nothing inside it folds any more, so this is
 * what is left of that: locating the bar by its title.
 */
export function sectionHead(page: Page, title: string) {
  return page
    .locator('.panel-head.sec')
    .filter({ has: page.locator('.panel-title', { hasText: new RegExp(`^${title}$`) }) })
}

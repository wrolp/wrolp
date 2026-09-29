import { expect, type Page } from './fixtures'

/**
 * The nav column's sections start in the state `defaultLayout` gives them —
 * Docker closed, because it also renders for local shells that have no daemon
 * to query. A spec that needs the container list has to open it first, and
 * saying so is the point: the precondition stops being an accident of the
 * default. Idempotent, so it is safe to call from a shared boot helper.
 */
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

export async function expandSection(page: Page, title: string) {
  const toggle = page
    .locator('.panel-head.sec')
    .filter({ has: page.locator('.panel-title', { hasText: new RegExp(`^${title}$`) }) })
    .locator('.panel-head-toggle')
  await expect(toggle).toHaveAttribute('aria-expanded', /.*/)
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
    await toggle.click()
  }
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
}

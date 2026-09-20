import { expect, type Page } from './fixtures'

/**
 * The nav column's sections start in the state `defaultLayout` gives them —
 * Docker closed, because it also renders for local shells that have no daemon
 * to query. A spec that needs the container list has to open it first, and
 * saying so is the point: the precondition stops being an accident of the
 * default. Idempotent, so it is safe to call from a shared boot helper.
 */
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

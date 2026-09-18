import { expect, type Page } from './fixtures'

/**
 * The floating command list opens with every group COLLAPSED (the list's
 * default), so a spec that needs the rows must expand the headers first.
 * Headers that are already expanded (their chevron lacks `.collapsed`) are left
 * alone, which makes this safe to call right after opening the panel.
 */
export async function expandAllGroups(page: Page) {
  const headers = page.locator('.cmd-list-section-header')
  const count = await headers.count()
  for (let i = 0; i < count; i++) {
    const header = headers.nth(i)
    if ((await header.locator('.cmd-list-section-chevron.collapsed').count()) > 0) {
      await header.click()
    }
  }
  await expect(page.locator('.cmd-list-section-chevron.collapsed')).toHaveCount(0)
}

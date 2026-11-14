import { test, expect } from './helpers/fixtures'
import { installTauriMock } from './helpers/tauriMock'

// Picking "+ New Group…" in the connection editor must start with an EMPTY box.
// It used to keep the currently selected group name, so "new group" silently
// saved back into the group the user was trying to leave.

const CONN_A = {
  id: 'c1',
  name: 'Web',
  host: '10.0.0.1',
  port: 22,
  username: 'root',
  group: 'Network',
}
const CONN_B = {
  id: 'c2',
  name: 'DB',
  host: '10.0.0.2',
  port: 22,
  username: 'root',
  group: 'Network',
}

test('choosing "+ New Group…" starts with an empty name box', async ({ page }) => {
  await installTauriMock(page, { connections: [CONN_A, CONN_B] })
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  await page.goto('/')

  await page.getByRole('button', { name: 'New SSH connection' }).click()
  // The group header's "+" only materialises on hover; it seeds the editor with
  // that group.
  await page.locator('.conn-group-header', { hasText: 'Network' }).hover()
  await page.locator('.conn-group-add[title="Add connection to Network"]').click()

  const modal = page.locator('.modal')
  await expect(modal).toBeVisible()

  const groupSelect = modal.locator('select').filter({ has: page.locator('option[value="__new__"]') })
  await expect(groupSelect).toHaveValue('Network')

  await groupSelect.selectOption('__new__')
  await expect(modal.getByPlaceholder('New group name')).toHaveValue('')
})

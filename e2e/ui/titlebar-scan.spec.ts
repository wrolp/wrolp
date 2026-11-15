import { test, expect } from './helpers/fixtures'
import { installTauriMock } from './helpers/tauriMock'

// The titlebar's top-right shortcut used to open the built-in network *file*
// tools (FTP/HTTP/TFTP), which are already a rail mode. It now opens the subnet
// scan instead — and carries its own glyph, because the two shared `network`.

test('the titlebar opens the subnet scan, not the file tools', async ({ page }) => {
  await installTauriMock(page, {})
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  await page.goto('/')

  const scan = page.locator('.titlebar .scan-btn')
  await expect(scan).toBeVisible()
  await expect(scan).toHaveAttribute('aria-label', 'Scan Network')
  // The file-tools button is gone from the titlebar (it lives on the rail now).
  await expect(page.locator('.titlebar .net-tools-btn')).toHaveCount(0)

  await scan.click()

  await expect(page.locator('.inspector')).toBeVisible()
  await expect(page.locator('.inspector').getByRole('tab', { selected: true })).toHaveText(
    'Network',
  )
})

import { test, expect } from './helpers/fixtures'
import { installTauriMock } from './helpers/tauriMock'

// Local terminals are workspace-scoped like connections: switching workspaces
// must re-read the list instead of leaving the previous workspace's entries on
// screen (and must never let a save here wipe the other workspace's rows).

const WORKSPACES = {
  workspaces: [
    { id: 'default', name: 'Default', createdAt: '2026-01-01T00:00:00Z' },
    { id: 'w2', name: 'Work', createdAt: '2026-01-01T00:00:00Z' },
  ],
  activeWorkspaceId: 'default',
}

const LOCAL_DEFAULT = { id: 'lt1', name: 'Bash (home)', cwd: '/srv/app', shell: 'bash' }
const LOCAL_WORK = { id: 'lt2', name: 'Pwsh (work)', cwd: 'C:\\work', shell: 'powershell' }

test('the local terminal list follows the workspace switch', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  await installTauriMock(page, {
    connections: [{ id: 'c1', name: 'Demo', host: 'demo.local', port: 22, username: 'root' }],
    workspaces: WORKSPACES,
    localTerminalsByWorkspace: { default: [LOCAL_DEFAULT], w2: [LOCAL_WORK] },
  })
  await page.goto('/')

  const entries = page.locator(
    '.local-terminals-group .local-term-item:not(.local-term-default)',
  )
  await expect(entries).toHaveCount(1)
  await expect(entries).toContainText('Bash (home)')

  await page.locator('.workspace-selector-trigger').click()
  await page.locator('.workspace-item-label', { hasText: 'Work' }).click()

  await expect(entries).toHaveCount(1)
  await expect(entries).toContainText('Pwsh (work)')
})

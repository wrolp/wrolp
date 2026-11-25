import type { Page } from '@playwright/test'
import { test, expect } from './helpers/fixtures'
import {
  installTauriMock,
  emitTauriEvent,
  invokedCalls,
  invokedCommands,
} from './helpers/tauriMock'

// The tray and its menu are native, so a browser test cannot open them. What it
// can pin is the contract behind the menu: the frontend pushes the open
// sessions and the recent items after every change, and a click event coming
// back from the backend switches to that session / reopens that recent item.

const CONN = { id: 'c1', name: 'Demo', host: 'demo.local', port: 22, username: 'root' }

interface TrayPayload {
  tabs: Array<{ tabId: number; label: string; active: boolean }>
  recents: Array<{ id: string; label: string }>
  labels: Record<string, string>
}

async function boot(page: Page) {
  await installTauriMock(page, {
    connections: [CONN],
    recentConnections: [{ connectionId: 'c1', usedAtMs: Date.now(), kind: 'connection' }],
  })
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  await page.goto('/')
}

async function lastTraySync(page: Page): Promise<TrayPayload | undefined> {
  const calls = (await invokedCalls(page)).filter((call) => call.cmd === 'sync_tray_menu')
  return calls.at(-1)?.args as unknown as TrayPayload | undefined
}

test('the tray menu mirrors the open sessions and recent items', async ({ page }) => {
  await boot(page)
  await expect.poll(async () => (await lastTraySync(page))?.tabs.length).toBe(0)

  await page.locator('.connection-item').click()
  await page.locator('.connection-item').click()

  await expect.poll(async () => (await lastTraySync(page))?.tabs.length).toBe(2)
  const payload = await lastTraySync(page)
  expect(payload?.tabs.map((tab) => tab.label)).toEqual(['Demo (1)', 'Demo (2)'])
  expect(payload?.tabs.map((tab) => tab.active)).toEqual([false, true])
  expect(payload?.recents).toEqual([{ id: 'c1', label: 'Demo' }])
  expect(payload?.labels.sessions).toBe('Sessions')
  expect(payload?.labels.noRecent).toBe('No recent items')
})

test('a tray click switches to the chosen session', async ({ page }) => {
  await boot(page)
  await page.locator('.connection-item').click()
  await page.locator('.connection-item').click()
  await expect.poll(async () => (await lastTraySync(page))?.tabs.length).toBe(2)

  const firstTabId = (await lastTraySync(page))!.tabs[0].tabId
  await emitTauriEvent(page, 'tray-action', { kind: 'tab', tabId: firstTabId })

  await expect(page.locator('.tab-item.active .tab-label')).toHaveText('Demo (1)')
  await expect
    .poll(async () => (await lastTraySync(page))?.tabs.map((tab) => tab.active))
    .toEqual([true, false])
})

test('a tray recent row reopens that connection as a new session', async ({ page }) => {
  await boot(page)
  await page.locator('.connection-item').click()
  await expect.poll(async () => (await lastTraySync(page))?.tabs.length).toBe(1)

  await emitTauriEvent(page, 'tray-action', { kind: 'recent', id: 'c1' })

  await expect(page.locator('.tab-item:not(.tab-home)')).toHaveCount(2)
  await expect(page.locator('.tab-item.active .tab-label')).toHaveText('Demo (2)')
})

test('the tray quit asks first, and only the confirmation exits', async ({ page }) => {
  await boot(page)
  await emitTauriEvent(page, 'tray-action', { kind: 'quit' })

  const dialog = page.locator('.confirm-dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('Quit Wrolp Terminal?')

  // Cancel leaves the app (and its sessions) alone.
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toBeHidden()
  expect(await invokedCommands(page)).not.toContain('quit_app')

  // Confirming runs the only command that ends the process.
  await emitTauriEvent(page, 'tray-action', { kind: 'quit' })
  await page.getByRole('button', { name: 'Quit' }).click()
  await expect.poll(async () => (await invokedCommands(page)).includes('quit_app')).toBe(true)
})

// Rust owns the CloseRequested handler and cannot read localStorage, so the
// frontend must push the setting. These two tests pin that contract: the
// shipped default (hide → closeToTray=true) and an explicit quit choice.
test('the close-to-tray setting is pushed on boot as hide by default', async ({ page }) => {
  await boot(page)
  await expect
    .poll(async () => (await invokedCalls(page)).some((c) => c.cmd === 'set_close_to_tray'))
    .toBe(true)
  const call = (await invokedCalls(page)).find((c) => c.cmd === 'set_close_to_tray')
  expect(call?.args).toEqual({ closeToTray: true })
})

// The icon is frontend-configurable as well: `ui.showTray` (default on) is
// pushed the same way. The tray menu's "hide tray icon" item asks first (the
// frontend shows a confirmation naming the Settings switch as the way back)
// and only a confirmed choice is written, so the Settings switch and the menu
// can never disagree.
test('the tray icon is pushed as visible by default', async ({ page }) => {
  await boot(page)
  await expect
    .poll(async () => (await invokedCalls(page)).some((c) => c.cmd === 'set_tray_visible'))
    .toBe(true)
  const call = (await invokedCalls(page)).find((c) => c.cmd === 'set_tray_visible')
  expect(call?.args).toEqual({ visible: true })
})

test('hiding the tray from its menu asks first and only the confirmation hides it', async ({
  page,
}) => {
  await boot(page)
  await emitTauriEvent(page, 'tray-action', { kind: 'hide-tray' })

  const dialog = page.locator('.confirm-dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('Hide the tray icon?')
  // The dialog has to say where the icon can be turned back on.
  await expect(dialog).toContainText('Settings → Appearance → Show tray icon')

  // Cancel leaves both the icon and the stored setting alone.
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toBeHidden()
  expect(
    (await invokedCalls(page)).some(
      (c) => c.cmd === 'set_tray_visible' && c.args.visible === false,
    ),
  ).toBe(false)
  expect(await page.evaluate(() => localStorage.getItem('wrolp-show-tray'))).not.toBe('0')

  // Confirming persists the setting; that push is what hides the icon.
  await emitTauriEvent(page, 'tray-action', { kind: 'hide-tray' })
  await page.getByRole('button', { name: 'Hide icon' }).click()
  await expect
    .poll(async () =>
      (await invokedCalls(page)).some(
        (c) => c.cmd === 'set_tray_visible' && c.args.visible === false,
      ),
    )
    .toBe(true)
  expect(await page.evaluate(() => localStorage.getItem('wrolp-show-tray'))).toBe('0')
})

test('a quit close-action setting is pushed as closeToTray=false', async ({ page }) => {
  await installTauriMock(page, { connections: [CONN] })
  await page.addInitScript(() => {
    localStorage.setItem('wrolp-lang', 'en')
    localStorage.setItem('wrolp-window-close-action', 'quit')
  })
  await page.goto('/')
  await expect
    .poll(async () =>
      (await invokedCalls(page)).some(
        (c) => c.cmd === 'set_close_to_tray' && c.args.closeToTray === false,
      ),
    )
    .toBe(true)
})

import { test, expect, type Page } from './helpers/fixtures'
import { installTauriMock, emitTauriEvent, invokedCalls } from './helpers/tauriMock'
import { shortFingerprint } from '../../src/lib/deviceId'

// Device identity (SSH-COMMAND-INDEX-COMPLETION-PLAN §2.A, P0).
//
// The backend reports which machine a tab reached as soon as the handshake
// finishes; the frontend keeps it on the tab and shows a short form of it in the
// status bar. What the UI can do is thin here — the interesting half is that the
// fingerprint reaches the DB and that a key change is the one case that speaks up.

const DEMO_CONN = { id: 'c1', name: 'Demo', host: 'demo.local', port: 22, username: 'root' }

/** A real-length OpenSSH digest, so truncation is doing actual work. */
const FP = 'SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG'

async function boot(page: Page, prefs: Record<string, string> = {}) {
  await installTauriMock(page, {
    connections: [DEMO_CONN],
    pollOutputChunks: [['root@demo:~$ ']],
  })
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  await page.addInitScript((items) => {
    for (const [key, value] of Object.entries(items)) localStorage.setItem(key, value)
  }, prefs)
  await page.goto('/')
}

/** Open a terminal for the demo connection and return the tabId the app used. */
async function openConnection(page: Page) {
  await page.locator('.connection-item').click()
  await expect
    .poll(async () => (await invokedCalls(page)).filter((c) => c.cmd === 'connect').length)
    .toBeGreaterThanOrEqual(1)
  const call = (await invokedCalls(page)).find((c) => c.cmd === 'connect')!
  return Number(call.args.tabId)
}

const deviceEvent = (tabId: number, over: Record<string, unknown> = {}) => ({
  tabId,
  fingerprint: FP,
  kind: 'ssh',
  host: 'demo.local',
  port: 22,
  username: 'root',
  isNew: false,
  changed: false,
  previousFingerprint: null,
  ...over,
})

/**
 * Start recording every toast the app mounts, so "it stayed silent" can be
 * asserted without racing the 3s dismiss timer. Waiting for the element to be
 * *absent* proves nothing on its own — a heavy app can show and drop a toast
 * between two assertions, and the check would call that silence.
 */
async function watchToasts(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __toasts: string[] }
    w.__toasts = []
    const text = (node: Node): string | null => {
      const el = node as Element
      if (el?.classList?.contains('toast')) return el.textContent
      return el?.querySelector?.('.toast-text')?.textContent ?? null
    }
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of Array.from(record.addedNodes)) {
          const found = text(node)
          if (found) w.__toasts.push(found)
        }
      }
    }).observe(document.body, { childList: true, subtree: true })
  })
}

const toastTexts = (page: Page) =>
  page.evaluate(() => (window as unknown as { __toasts: string[] }).__toasts ?? [])

test('shortFingerprint keeps the algorithm prefix and collapses the digest', () => {
  expect(shortFingerprint(FP)).toBe('SHA256:abcd…')
  // A fallback id is not a digest and has no prefix to keep: it is short already,
  // and cutting `local:ubuntu-24.04` to `local:ubun…` would only lose information.
  expect(shortFingerprint('local:devbox')).toBe('local:devbox')
  expect(shortFingerprint('wsl:Ubuntu-24.04')).toBe('wsl:Ubuntu-24.04')
  // SHA512 digests collapse the same way — the prefix is what tells them apart.
  expect(shortFingerprint('SHA512:zzzzYYYYwwww')).toBe('SHA512:zzzz…')
})

test('the status bar shows the device the handshake identified', async ({ page }) => {
  await boot(page)
  const tabId = await openConnection(page)
  await emitTauriEvent(page, 'host-identified', deviceEvent(tabId))

  const chip = page.locator('.status-bar-left .status-item', { hasText: 'SHA256:abcd…' })
  await expect(chip).toBeVisible()
  // The whole point of showing a short form is that the long one stays available;
  // a user verifying a host key needs the full digest, not four characters.
  await expect(chip).toHaveAttribute('title', new RegExp(FP))
})

test('a fallback identity renders whole rather than truncated', async ({ page }) => {
  await boot(page)
  const tabId = await openConnection(page)
  await emitTauriEvent(
    page,
    'host-identified',
    deviceEvent(tabId, { kind: 'local', fingerprint: 'local:devbox', host: 'devbox' }),
  )

  await expect(
    page.locator('.status-bar-left .status-item', { hasText: 'local:devbox' }),
  ).toBeVisible()
})

test('a changed host key is reported with both sides of the comparison', async ({ page }) => {
  await boot(page)
  const tabId = await openConnection(page)
  const previous = 'SHA256:OLDoldOLDold0123456789abcdefghijklmn'
  await emitTauriEvent(
    page,
    'host-identified',
    deviceEvent(tabId, { changed: true, isNew: false, previousFingerprint: previous }),
  )

  const toast = page.locator('.toast')
  await expect(toast).toContainText('Host key for demo.local')
  await expect(toast).toContainText(previous)
  await expect(toast).toContainText(FP)
})

test('an unchanged key says nothing', async ({ page }) => {
  await boot(page)
  const tabId = await openConnection(page)
  await watchToasts(page)
  await emitTauriEvent(page, 'host-identified', deviceEvent(tabId))

  // First prove the event reached the tab and re-rendered, so the silence below is
  // a decision the app made rather than a render that had not happened yet.
  await expect(
    page.locator('.status-bar-left .status-item', { hasText: 'SHA256:abcd…' }),
  ).toBeVisible()
  // Silence is the design: a fingerprint that matches is not news, and a notice on
  // every connect would train the user to dismiss the one that matters.
  expect(await toastTexts(page)).toEqual([])
})

test('connect carries the strict host key policy, off unless switched on', async ({ page }) => {
  await boot(page)
  await openConnection(page)
  const call = (await invokedCalls(page)).find((c) => c.cmd === 'connect')!
  // Absent would bind to `None` in Rust and mean off, but sending the value keeps
  // one reading of the truth: the frontend decides, the backend obeys.
  expect(call.args.strictHostKey).toBe(false)

  await page.reload()
  await page.evaluate(() => localStorage.setItem('wrolp-strict-host-key', '1'))
  await page.goto('/')
  await page.locator('.connection-item').click()
  await expect
    .poll(async () => (await invokedCalls(page)).filter((c) => c.cmd === 'connect').length)
    .toBeGreaterThanOrEqual(1)
  const again = (await invokedCalls(page)).filter((c) => c.cmd === 'connect').pop()!
  // `'1'`, not `'true'` — the registry decodes booleans as `raw === '1'`.
  expect(again.args.strictHostKey).toBe(true)
})

test('the Security pane holds the toggle and writes the registry key', async ({ page }) => {
  await boot(page)
  await page.locator('.settings-btn').click()
  await page.locator('.settings-nav-item', { hasText: 'Security' }).click()

  const toggle = page.locator('.settings-pane input[type="checkbox"]')
  await expect(toggle).toHaveCount(1)
  await expect(toggle).not.toBeChecked()
  await toggle.click()
  await expect(toggle).toBeChecked()
  expect(await page.evaluate(() => localStorage.getItem('wrolp-strict-host-key'))).toBe('1')
})

test('the AI cannot switch strict host key checking off, or on', async ({ page }) => {
  // `security` is a setting group but not a writable one, and the sanitizer drops
  // any stored value for it. An assistant that could relax this could open a
  // connection it was told to refuse — the one switch that decides whether a
  // server identity change stops you.
  await boot(page)
  const id = 4001
  await emitTauriEvent(page, 'ai-ui-tool-request', {
    id,
    op: 'set',
    args: { changes: { 'security.strictHostKey': true } },
  })
  await expect
    .poll(
      async () =>
        (await invokedCalls(page)).filter((c) => c.cmd === 'ai_ui_tool_result' && c.args.id === id)
          .length,
    )
    .toBe(1)
  const result = (await invokedCalls(page)).find(
    (c) => c.cmd === 'ai_ui_tool_result' && c.args.id === id,
  )!
  const parsed = JSON.parse(String(result.args.result)) as { error?: string }
  expect(parsed.error).toContain('security')
  expect(await page.evaluate(() => localStorage.getItem('wrolp-strict-host-key'))).toBeNull()
})

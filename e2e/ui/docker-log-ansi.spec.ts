import { test, expect } from '@playwright/test'
import { installTauriMock } from './helpers/tauriMock'
import { parseAnsiToHtml, stripInvisible } from '../../src/ansi'

// B30: the "Analyze Container" report rendered its log payload as a plain text
// node (`<pre>{logs}</pre>`), so every byte that `docker logs` had captured —
// colour codes, screen clears, window titles — showed up verbatim as `[36m`,
// `[2J`, … instead of being converted. `ansi.ts` now strips *all* non-SGR escape
// sequences and stray control bytes, and the panel renders the resulting HTML.
//
// A `docker logs` payload is the worst case for this: it is a recorded tty
// stream, so it contains cursor/erase sequences and OSC titles on top of the
// application's own colours.

const LOGS =
  '\x1b[2J\x1b[H' + // the app cleared the screen on start-up
  '\x1b[36m2026-09-13T10:02:11Z\x1b[0m \x1b[32mINFO\x1b[0m app listening on :8080\r\n' +
  '\x1b[33m2026-09-13T10:02:12Z\x1b[0m \x1b[1;31mERROR\x1b[0m db connection refused\n' +
  '\x1b]0;wrolp-api\x07\x1b[?25hworker ready\n'

test.describe('invisible characters in log payloads (B30)', () => {
  test('SGR codes become coloured spans', () => {
    expect(parseAnsiToHtml('\x1b[36mINFO\x1b[0m')).toBe('<span style="color:#56b6c2">INFO</span>')
    // Bold + 3-bit red, and the reset drops back to plain text.
    expect(parseAnsiToHtml('\x1b[1;31mERROR\x1b[0m done')).toBe(
      '<span style="font-weight:bold;color:#e06c75">ERROR</span> done',
    )
  })

  test('non-SGR escapes and control bytes are removed', () => {
    // Screen clear, cursor home, mode set/reset, OSC title, bell, backspace.
    expect(stripInvisible('\x1b[2J\x1b[H\x1b[?25l\x1b]0;title\x07ab\x08c\x00d')).toBe('abcd')
    // Parametrised (colon) forms are escapes too, not text.
    expect(stripInvisible('\x1b[4:3munderlined')).toBe('underlined')
    // TAB / LF / CR survive — they are layout, not noise.
    expect(stripInvisible('a\tb\nc\r\n')).toBe('a\tb\nc\r\n')
  })

  test('the converted payload keeps the text and loses every escape', () => {
    const html = parseAnsiToHtml(LOGS)
    expect(html).not.toContain('\x1b')
    expect(html).not.toContain('[2J')
    expect(html).not.toContain('[?25h')
    expect(html).not.toContain(']0;')
    expect(html).toContain('app listening on :8080')
    expect(html).toContain('db connection refused')
    expect(html).toContain('worker ready')
    // Colours survived the conversion.
    expect(html).toContain('color:#56b6c2')
    expect(html).toContain('color:#e06c75')
  })

  test('markup in the log is escaped, not executed', () => {
    const html = parseAnsiToHtml('2 < 3 & <script>alert(1)</script> > 1')
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>')
  })

  test('the produced HTML renders without raw control characters', async ({ page }) => {
    await page.setContent(`<pre id="out">${parseAnsiToHtml(LOGS)}</pre>`)
    const out = page.locator('#out')
    await expect(out).toContainText('worker ready')
    const text = (await out.textContent()) ?? ''
    // eslint-disable-next-line no-control-regex
    expect(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)).toBe(false)
    await expect(page.locator('#out span[style*="color:#56b6c2"]')).toHaveCount(1)
  })
})

const DEMO_CONN = { id: 'c1', name: 'Demo', host: 'demo.local', port: 22, username: 'root' }
const PROMPT = 'root@demo:~# '
const CONTAINER = {
  id: '9f2c1a4b8e0d',
  name: 'wrolp-api',
  image: 'wrolp/api:1.4',
  state: 'running',
  status: 'Up 3 hours',
}

/** Minimal but complete `DockerAnalysis` — the panel reads every field. */
const ANALYSIS = {
  tabId: 1,
  containerName: 'wrolp-api',
  containerId: '9f2c1a4b8e0d',
  image: 'wrolp/api',
  imageTag: '1.4',
  state: 'running',
  createdAt: '2026-09-13 09:00:00 +0800 CST',
  os: 'Debian GNU/Linux 12 (bookworm)',
  kernel: '6.1.0-23-amd64',
  arch: 'x86_64',
  hostname: '9f2c1a4b8e0d',
  packageManager: 'apt',
  packages: [],
  tools: [],
  ports: [],
  mounts: [],
  envKeys: [],
  processes: [],
  resource: null,
  orchestration: { isCompose: false },
  analyzedAt: 1757740000000,
}

test('Analyze Container converts the log escapes instead of printing them', async ({ page }) => {
  // Pin the language: the context-menu label is looked up by text below.
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  await installTauriMock(page, {
    connections: [DEMO_CONN],
    pollOutputChunks: [[PROMPT]],
    dockerContainers: [CONTAINER],
    dockerAnalysis: ANALYSIS,
    dockerLogs: LOGS,
  })
  await page.goto('/')
  await page.locator('.connection-item').first().click()

  // The sidebar Docker section lists the container; its context menu is how the
  // analysis report is opened.
  const item = page.locator('.docker-item').first()
  await expect(item).toBeVisible()
  await item.click({ button: 'right' })
  await page.locator('.context-menu-item', { hasText: 'Analyze Container' }).click()

  const out = page.locator('.danalysis-logs-output')
  await expect(out).toBeVisible()
  await expect(out).toContainText('app listening on :8080')

  const text = (await out.textContent()) ?? ''
  expect(text).not.toContain('\x1b')
  expect(text).not.toContain('[2J')
  expect(text).not.toContain('[?25h')
  expect(text).not.toContain(']0;')

  // The escapes were converted into colours, not merely deleted.
  const html = await out.innerHTML()
  expect(html).toContain('<span style="color:#56b6c2">')
})

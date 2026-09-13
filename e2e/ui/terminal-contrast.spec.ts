import { test, expect, type Page } from '@playwright/test'
import { installTauriMock } from './helpers/tauriMock'
import { ansiThemeColors, xtermTheme } from '../../src/lib/theme'
import {
  MIN_CONTRAST_RATIO,
  bestLegibleForeground,
  contrastRatio,
  fixLowContrastSgr,
  rgbOf,
  xterm256Color,
} from '../../src/components/terminal/sgrContrast'

// B29: GNU `ls --color` marks world-writable directories with a *background*
// colour (dircolors `OTHER_WRITABLE 34;42` = blue on green). That pair assumes a
// plain white-on-black terminal, so on our dark palette it is 1.1:1 — a real
// session showed `storage` / `Tracker2` (`drwxrwxrwx`) effectively invisible.
// `sgrContrast` keeps the background (it is the signal) and swaps in a legible
// foreground; everything else must stay byte-for-byte identical.

const DARK = ansiThemeColors(xtermTheme('dark'))
const LIGHT = ansiThemeColors(xtermTheme('light'))

test.describe('dircolors colour legibility (B29)', () => {
  test('dark palette: blue on green is rewritten, background kept', () => {
    // #5b7fb5 on #3a8558 is 1.1:1 — black reads best on that green (4.67:1).
    expect(fixLowContrastSgr('\x1b[34;42mstorage\x1b[0m', DARK)).toBe(
      '\x1b[42;38;2;0;0;0mstorage\x1b[0m',
    )
  })

  test('light palette: the same pair is already legible and is left alone', () => {
    // #0451a5 on #00bc00 is 4.0:1 — low for VS Code's palette but readable, and
    // above our 3:1 floor, so the shell's own choice is respected.
    expect(fixLowContrastSgr('\x1b[34;42mstorage\x1b[0m', LIGHT)).toBe('\x1b[34;42mstorage\x1b[0m')
  })

  test('the guard has a floor: it never leaves a pair below the ratio', () => {
    const fixed = fixLowContrastSgr('\x1b[30;43msuid-ish\x1b[0m', DARK)
    const fg = fixed.includes('38;2;0;0;0') ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 }
    expect(contrastRatio(fg, rgbOf('#dcdcaa')!)).toBeGreaterThanOrEqual(MIN_CONTRAST_RATIO)
    expect(bestLegibleForeground(rgbOf('#dcdcaa')!)).toEqual({ r: 0, g: 0, b: 0 })
  })

  test('a foreground with no background is never touched', () => {
    // `ls` colours plain directories `01;34` — no background, no clash.
    expect(fixLowContrastSgr('\x1b[1;34mnetwork-manager\x1b[0m', DARK)).toBe(
      '\x1b[1;34mnetwork-manager\x1b[0m',
    )
  })

  test('a background whose foreground is decided elsewhere is left alone', () => {
    // The effective foreground comes from the earlier sequence, so rewriting
    // would be a guess: `97m` then a bare `42m` is white-on-green (4.5:1) and
    // fine as-is.
    expect(fixLowContrastSgr('\x1b[97m\x1b[42mstorage\x1b[0m', DARK)).toBe(
      '\x1b[97m\x1b[42mstorage\x1b[0m',
    )
  })

  test('other attributes and the reset survive a rewrite', () => {
    // Bold is kept, `0` (reset) stays in front, only the colour changes.
    expect(fixLowContrastSgr('\x1b[0;1;34;42mtw\x1b[0m', DARK)).toBe(
      '\x1b[0;1;42;38;2;0;0;0mtw\x1b[0m',
    )
  })

  test('256-colour and truecolour backgrounds are understood', () => {
    // `48;5;28` = #008700, a green cube colour; the pair must be re-emitted with
    // its background intact.
    const fixed = fixLowContrastSgr('\x1b[38;2;91;127;181;48;5;28mstorage\x1b[0m', DARK)
    expect(fixed).toContain('48;5;28')
    expect(fixed).not.toContain('38;2;91;127;181')
    expect(fixed).toBe('\x1b[48;5;28;38;2;255;255;255mstorage\x1b[0m')
    expect(xterm256Color(28)).toEqual({ r: 0, g: 135, b: 0 })
  })

  test('non-SGR escapes and plain text pass through', () => {
    expect(fixLowContrastSgr('plain text\r\n', DARK)).toBe('plain text\r\n')
    const mixed = fixLowContrastSgr('\x1b[?25l\x1b[34;42mstorage\x1b[0m\x1b[?25h', DARK)
    expect(mixed).toContain('\x1b[?25l')
    expect(mixed).toContain('\x1b[?25h')
    expect(mixed).not.toContain('\x1b[34;42m')
  })
})

const DEMO_CONN = { id: 'c1', name: 'Demo', host: 'demo.local', port: 22, username: 'root' }
const PROMPT = 'root@demo:~# '
// A real `ls -l` slice: a normal directory, then the two dircolors-flagged ones.
const LS_OUTPUT =
  'drwxr-xr-x  2 root root     6  9月  1 10:02 \x1b[1;34mnetwork-manager\x1b[0m\r\n' +
  'drwxrwxrwx  5 root root    42  3月  3  2026 \x1b[34;42mstorage\x1b[0m\r\n'

/** Computed colour/background of the first cell of `needle` in the screen. */
async function cellAt(page: Page, needle: string): Promise<{ color: string; bg: string } | null> {
  return page.evaluate((needle) => {
    for (const row of Array.from(document.querySelectorAll('.xterm-rows > div'))) {
      const spans = Array.from(row.querySelectorAll('span')) as HTMLElement[]
      let text = ''
      const styles: Array<{ color: string; bg: string }> = []
      for (const span of spans) {
        const cs = getComputedStyle(span)
        const chunk = span.textContent ?? ''
        for (let i = 0; i < chunk.length; i++)
          styles.push({ color: cs.color, bg: cs.backgroundColor })
        text += chunk
      }
      const idx = text.indexOf(needle)
      if (idx >= 0) return styles[idx]
    }
    return null
  }, needle)
}

const parseRgb = (css: string): { r: number; g: number; b: number } => {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(css)
  if (!m) throw new Error(`unexpected colour: ${css}`)
  return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) }
}

test('world-writable dirs stay readable in the live terminal', async ({ page }) => {
  // Force the dark palette: the pair is 1.1:1 there (the reported case) and 4:1
  // on the light one, and Playwright defaults to `prefers-color-scheme: light`.
  await page.addInitScript(() => {
    localStorage.setItem('wrolp-theme', 'dark')
    localStorage.setItem('wrolp-terminal-palette', 'dark')
  })
  await installTauriMock(page, {
    connections: [DEMO_CONN],
    pollOutputChunks: [[PROMPT], [LS_OUTPUT]],
  })
  await page.goto('/')
  await page.locator('.connection-item').first().click()
  await expect(page.locator('.xterm-rows')).toContainText('storage', { timeout: 10_000 })

  const flagged = await cellAt(page, 'storage')
  expect(flagged).not.toBeNull()
  // The dircolors background is what says "world-writable" — it must survive.
  expect(flagged!.bg).toBe('rgb(58, 133, 88)')
  expect(flagged!.color).toBe('rgb(0, 0, 0)')
  expect(contrastRatio(parseRgb(flagged!.color), parseRgb(flagged!.bg))).toBeGreaterThanOrEqual(
    MIN_CONTRAST_RATIO,
  )

  // …and a plain directory keeps the palette colour it was given.
  const plain = await cellAt(page, 'network-manager')
  expect(plain).not.toBeNull()
  expect(plain!.color).toBe('rgb(91, 127, 181)')
})

// Regression tests for issue #26.
//
// The streaming highlighter holds back the trailing token of every chunk so a
// token split by a chunk boundary (an IPv6 address, say) is still colorized as a
// single unit. `flush()` used to keep holding that fragment as well — which is
// wrong: it only ever runs after HL_FLUSH_DELAY_MS of silence, i.e. when no
// further bytes are coming. The consequence in the terminal was a trailing number
// that stayed invisible until the next output arrived: sending a snippet into a
// non-empty input line writes ` && <cmd>` (no trailing newline), the shell echoes
// it, and the echo's final token (`… on 50`) was swallowed — it only appeared
// after pressing a key (e.g. the right arrow) produced more output.
import { test, expect } from '@playwright/test'
import { installTauriMock } from './helpers/tauriMock'
import { AnsiHighlighter } from '../../src/components/terminal/highlightStream'
import { cloneDefaultConfig } from '../../src/lib/highlightRules'

const DEMO_CONN = { id: 'c1', name: 'Demo', host: 'demo.local', port: 22, username: 'root' }

/** Colors are inserted as SGR codes; the visible text must round-trip. */
const stripSgr = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')

test('push() + flush() round-trip an echoed command ending in a number', () => {
  const hl = new AnsiHighlighter(cloneDefaultConfig())
  const echo =
    '[root@sip ~]# ./fs_light_sound.sh ./560.mp3 252 on 50 && ./fs_light_sound.sh ./560.mp3 252 on 50'

  const pushed = hl.push(echo)
  const flushed = hl.flush()

  // The tail must not be withheld: whatever `push` holds back, `flush` releases.
  expect(stripSgr(pushed + flushed)).toBe(echo)
  expect(pushed + flushed).toContain('on 50')
  expect(hl.hasPending()).toBe(false)
  // The final `50` is not silently dropped from the pushed half.
  expect(stripSgr(pushed)).toContain('50')
})

test('flush() emits a held fragment instead of holding it forever', () => {
  const hl = new AnsiHighlighter(cloneDefaultConfig())

  const out = hl.push('build finished in 42') + hl.flush()

  expect(stripSgr(out)).toBe('build finished in 42')
  expect(hl.hasPending()).toBe(false)
})

test('a chunk ending in a number becomes visible once output goes quiet', async ({ page }) => {
  await installTauriMock(page, {
    connections: [DEMO_CONN],
    // Two poll batches: the prompt, then a line WITHOUT a trailing newline whose
    // last token is a bare number (the shape that used to get held forever).
    pollOutputChunks: [['root@demo:~$ '], ['echo 42']],
  })
  await page.goto('/')
  await page.locator('.connection-item').click()
  await expect(page.locator('.tab-item')).toContainText('Demo')
  await expect(page.locator('.xterm-helper-textarea')).toBeAttached()

  // Past the silent-gap flush (HL_FLUSH_DELAY_MS = 300ms) the whole line is shown.
  await expect.poll(() => page.locator('.xterm-rows').innerText()).toContain('echo 42')
})

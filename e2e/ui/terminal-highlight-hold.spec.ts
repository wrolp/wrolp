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
import { test, expect } from './helpers/fixtures'
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

/**
 * A truecolor escape split across a chunk boundary (`\x1b[38;2;` | `72;71;67m`)
 * must survive the idle-flush timer. The old `flush()` emitted the held partial
 * escape AND cleared `pending`, so the next chunk's leading bytes — the escape's
 * tail — arrived with no `ESC` in scope, hit the fast path, and were colourised as
 * plain text, leaking `72;71;67m` onto the screen (BUGS.md B46 ④). The timer now
 * keeps a partial escape so the next `push()` reassembles it.
 */
test('the idle flush keeps a split escape so its tail is not leaked as text', () => {
  const hl = new AnsiHighlighter(cloneDefaultConfig())

  const a = hl.push('gray \x1b[38;2')
  expect(hl.hasPending()).toBe(true)
  // keepPartialEscape = true (the timer): release nothing, keep the bytes held.
  expect(hl.flush(true)).toBe('')
  expect(hl.hasPending()).toBe(true)
  const b = hl.push(';72;71;67m done')

  const visible = stripSgr(a + b)
  expect(visible).toBe('gray  done')
  expect(visible).not.toContain('72;71;67m')
})

/** The old drain-and-clear path is what leaked — pinned here so the fix is scoped. */
test('draining a partial escape (keepPartialEscape=false) leaks its tail as text', () => {
  const hl = new AnsiHighlighter(cloneDefaultConfig())

  const a = hl.push('gray \x1b[38;2')
  const f = hl.flush(false) // explicit drain (bypass / reset) still emits the bytes
  const b = hl.push(';72;71;67m done')

  // Without the reassembly the orphaned params survive as visible text.
  expect(stripSgr(a + f + b)).toContain('72;71;67m')
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

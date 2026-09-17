import { test, expect, type Page } from './helpers/fixtures'
import { installTauriMock, invokedCalls } from './helpers/tauriMock'
import { createCwdQueryStripper } from '../../src/components/terminal/cwdQuery'

// The hidden `pwd` query is injected into the interactive shell and its output
// stripped before it reaches the screen. Both the echo and the result can be split
// across output chunks at *any* character — the reported case was the shell's line
// editor wrapping the echoed command with a hard CRLF at the terminal's right
// margin, which dumped the whole command into the user's terminal:
//
//   root@host:/tmp# echo "__WROLP_CWD_BEG_bfao5wru__$(pwd)__WROLP_CWD_END
//   _y923n77y__"
//
// The strip is a state machine over the character stream (see cwdQuery.ts) so it
// holds for every split point; these cases pin that.

const PROMPT = 'root@demo:/tmp# '
const AT_PROMPT = 'root@demo:/tmp # '
const BEG = '__WROLP_CWD_BEG_bfao5wru__'
const END = '__WROLP_CWD_END_y923n77y__'
const ECHO = `echo "${BEG}$(pwd)${END}"`
const RESULT = `${BEG}/tmp/ffmpeg-src${END}`

/** Feed `chunks` through a fresh stripper: what the terminal would show, and
 *  every cwd captured along the way. `armed` (the default) is the state these cases
 *  happen in: the query is in flight, so a split echo/result may span chunks. */
function feed(
  chunks: string[],
  { armed = true }: { armed?: boolean } = {},
): {
  out: string
  paths: string[]
} {
  const stripper = createCwdQueryStripper(BEG, END)
  if (armed) stripper.arm()
  let out = ''
  const paths: string[] = []
  for (const chunk of chunks) {
    const res = stripper.strip(chunk)
    out += res.text
    if (res.path !== null) paths.push(res.path)
  }
  return { out, paths }
}

test.describe('hidden pwd query strip', () => {
  test('keeps the prompt, drops the echo + result, captures the cwd', () => {
    const { out, paths } = feed([PROMPT, `${ECHO}\r\n${RESULT}\r\n${AT_PROMPT}`])
    // Nothing of the query is left, and no blank row is gained for it.
    expect(out).toBe(PROMPT + AT_PROMPT)
    expect(paths).toEqual(['/tmp/ffmpeg-src'])
  })

  test('the echoed command never leaks, whatever split point the shell uses', () => {
    for (let cut = 1; cut < ECHO.length; cut++) {
      const { out, paths } = feed([
        PROMPT,
        ECHO.slice(0, cut),
        ECHO.slice(cut) + '\r\n',
        `${RESULT}\r\n`,
      ])
      expect(out, `split at ${cut}`).toBe(PROMPT)
      expect(paths, `split at ${cut}`).toEqual(['/tmp/ffmpeg-src'])
    }
  })

  test('a line-editor wrap with a hard CRLF inside the echo is swallowed', () => {
    // The reported shape: the break lands mid-command at the terminal's margin.
    const { out, paths } = feed([
      PROMPT,
      ECHO.slice(0, 54) + '\r\n',
      ECHO.slice(54) + '\r\n',
      `${RESULT}\r\n`,
      AT_PROMPT,
    ])
    expect(out).toBe(PROMPT + AT_PROMPT)
    expect(paths).toEqual(['/tmp/ffmpeg-src'])
  })

  test('a character-by-character echo (slow link, line editor redraw) leaks nothing', () => {
    const { out, paths } = feed([
      PROMPT,
      ...ECHO.split(''),
      '\r\n',
      ...RESULT.split(''),
      '\r\n',
      AT_PROMPT,
    ])
    expect(out).toBe(PROMPT + AT_PROMPT)
    expect(paths).toEqual(['/tmp/ffmpeg-src'])
  })

  test('the result is captured even when its marker and path are split', () => {
    const { out, paths } = feed([RESULT.slice(0, 30), `${RESULT.slice(30)}\r\n`])
    expect(out).toBe('')
    expect(paths).toEqual(['/tmp/ffmpeg-src'])
  })

  test('a redrawn echo (readline repaint) is dropped as well', () => {
    const { out } = feed([PROMPT, `${ECHO}\r`, `${ECHO}\r\n`, `${RESULT}\r\n`])
    expect(out).toBe(PROMPT)
  })

  test('ordinary output is untouched', () => {
    const lines = [
      'total 0\r\n',
      'echo hello_世界\r\n',
      'drwxr-xr-x 2 root root 40 __pycache__\r\n',
      'error: echo " is a directory\r\n',
    ]
    const { out, paths } = feed(lines)
    expect(out).toBe(lines.join(''))
    expect(paths).toEqual([])
  })

  test('a lone trailing `e` is only delayed until the next chunk, never dropped', () => {
    // A single `e` could be the start of the echoed command, so while the query is in
    // flight it is held back — and replayed ahead of whatever the next chunk brings,
    // in order.
    const stripper = createCwdQueryStripper(BEG, END)
    stripper.arm()
    expect(stripper.strip('a_$ _e').text).toBe('a_$ _')
    expect(stripper.strip('bar\r\n').text).toBe('ebar\r\n')
  })

  test('while idle a typed `_` is never held back (it is the marker`s first char)', () => {
    // Reported: typing `_` in the shell showed nothing until the next keystroke — the
    // `_` looked like the beginning of `beg` and was carried over to a chunk that only
    // arrives when the user types again (three typed, two shown). Idle is the normal
    // state (no query in flight), and there an ambiguous prefix must pass straight
    // through. Same for a typed `e`, which starts `echo "…`.
    const stripper = createCwdQueryStripper(BEG, END)
    for (const chunk of ['_', '__', 'e', 'ec', 'echo hi', 'my_file']) {
      expect(stripper.strip(chunk).text, chunk).toBe(chunk)
    }
  })

  test('while idle a complete hidden line is still stripped (stale output)', () => {
    // The query's own output is dropped whether or not a query is currently in flight:
    // a result line that completes inside one chunk is unambiguous.
    const { out, paths } = feed([PROMPT, `${ECHO}\r\n${RESULT}\r\n${AT_PROMPT}`], { armed: false })
    expect(out).toBe(PROMPT + AT_PROMPT)
    expect(paths).toEqual(['/tmp/ffmpeg-src'])
  })

  test('while armed a held prefix comes back on release(), without disarming', () => {
    const stripper = createCwdQueryStripper(BEG, END)
    stripper.arm()
    expect(stripper.strip('x_').text).toBe('x') // the `_` waits for the next chunk
    // Output went quiet — the caller hands it back instead of leaving it invisible.
    expect(stripper.release()).toBe('_')
    // …and it is not repeated later on (the state was cleared, not just reported).
    expect(stripper.strip('yz').text).toBe('yz')
    expect(stripper.release()).toBe('')
  })

  test('disarm() ends the window: nothing stays held and prefixes pass through', () => {
    const stripper = createCwdQueryStripper(BEG, END)
    stripper.arm()
    expect(stripper.strip('_').text).toBe('')
    expect(stripper.disarm()).toBe('_')
    expect(stripper.strip('_').text).toBe('_')
  })

  test('a stray begin marker cannot swallow the stream', () => {
    const junk = `${BEG}${'x'.repeat(4096)}`
    const { out } = feed([junk])
    // Not a result line (no end marker) — the text comes back, nothing is stuck.
    expect(out).toBe(junk)
  })

  test('a result line whose payload is not a path is dropped but not captured', () => {
    // A syntax-highlighting prompt can split the echo so the marker pair is seen
    // on its own, leaving the un-expanded `$(pwd)` between the markers.
    const { out, paths } = feed([`${BEG}$(pwd)${END}\r\n`])
    expect(out).toBe('')
    expect(paths).toEqual([])
  })

  test('`~` and Windows drive paths are captured', () => {
    expect(feed([`${BEG}~/docs${END}\r\n`]).paths).toEqual(['~/docs'])
    expect(feed([`${BEG}C:\\Users\\me${END}\r\n`]).paths).toEqual(['C:\\Users\\me'])
  })

  test('a marker containing the echo`s first letter still wins over the echo attempt', () => {
    // `Math.random().toString(36)` yields lowercase letters, so a marker's random
    // part can contain `e` — mid-marker matching must take priority over starting
    // a fresh echo attempt on that character.
    const beg = '__WROLP_CWD_BEG_e1e2e3e4__'
    const end = '__WROLP_CWD_END_e5e6e7e8__'
    const stripper = createCwdQueryStripper(beg, end)
    stripper.arm() // one character per chunk: only while the query is in flight
    let out = ''
    let path: string | null = null
    for (const ch of `${PROMPT}${stripper.command}\r\n${beg}/srv/app${end}\r\n${AT_PROMPT}`) {
      const res = stripper.strip(ch)
      out += res.text
      path = res.path ?? path
    }
    expect(out).toBe(PROMPT + AT_PROMPT)
    expect(path).toBe('/srv/app')
  })
})

// --- End to end: the user types `_` while the query is in flight --------------

const DEMO_CONN = { id: 'c1', name: 'Demo', host: 'demo.local', port: 22, username: 'root' }
const UI_PROMPT = 'root@demo:~$ '

/** Echo `send_input` payloads back through `poll_output` like a real PTY. There is no
 *  shell behind it, so the hidden `pwd` query is echoed as typed text (which the stripper
 *  removes) but its result line never arrives — the query stays in flight. */
async function installEchoingShell(page: Page) {
  await page.evaluate(() => {
    const internals = (
      window as unknown as {
        __TAURI_INTERNALS__: {
          invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
        }
      }
    ).__TAURI_INTERNALS__
    const orig = internals.invoke.bind(internals)
    const pending: string[] = []
    internals.invoke = async (cmd: string, args: Record<string, unknown> = {}) => {
      if (cmd === 'send_input') {
        const raw = String(args.data ?? '')
        const visible = raw
          .replace(/\x1b\[20[01]~/g, '')
          .replace(/\x16/g, '')
          .replace(/[\r\n]/g, '')
        if (visible) pending.push(visible)
        if (/[\r\n]/.test(raw)) pending.push('\r\nroot@demo:~$ ')
      }
      const res = await orig(cmd, args)
      if (cmd === 'poll_output') return [...(res as string[]), ...pending.splice(0)]
      return res
    }
  })
}

test('a `_` typed while the hidden query is in flight still shows up', async ({ page }) => {
  await installTauriMock(page, { connections: [DEMO_CONN], pollOutputChunks: [[UI_PROMPT]] })
  await page.goto('/')
  await installEchoingShell(page)
  await page.locator('.connection-item').first().click()
  await expect(page.locator('.xterm-rows')).toContainText('root@demo')
  await page.locator('.xterm-screen').click()

  // `ls` with no tracked cwd asks the shell for its real directory: the hidden
  // `echo "…$(pwd)…"` goes out and the stripper is armed for its echo and result.
  await page.keyboard.type('ls')
  await page.keyboard.press('Enter')
  await expect
    .poll(async () =>
      (await invokedCalls(page)).some((c) =>
        String(c.args.data ?? '').includes('__WROLP_CWD_BEG_'),
      ),
    )
    .toBe(true)

  // Typing underscores must not be mistaken for the start of the marker — all three
  // have to end up on the input line (reported: three typed, two shown).
  await page.keyboard.type('_', { delay: 80 })
  await page.keyboard.type('_', { delay: 80 })
  await page.keyboard.type('_', { delay: 80 })
  await expect(page.locator('.term-pane-term .xterm-rows')).toContainText('___')
})

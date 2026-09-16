import { test, expect } from './helpers/fixtures'
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
 *  every cwd captured along the way. */
function feed(chunks: string[]): { out: string; paths: string[] } {
  const stripper = createCwdQueryStripper(BEG, END)
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
    // A single `e` could be the start of the echoed command, so it is held back —
    // and replayed ahead of whatever the next chunk brings, in order.
    const stripper = createCwdQueryStripper(BEG, END)
    expect(stripper.strip('a_$ _e').text).toBe('a_$ _')
    expect(stripper.strip('bar\r\n').text).toBe('ebar\r\n')
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

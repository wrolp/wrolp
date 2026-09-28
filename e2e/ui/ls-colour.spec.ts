import { test, expect, type Page } from './helpers/fixtures'
import { installTauriMock } from './helpers/tauriMock'

// `ls` / `dir` listings are painted by kind: directory blue, symlink cyan,
// executable green, everything else left exactly as the shell printed it.
//
// The three hues are the theme's own tokens (`--link` / `--cyan` / `--success`),
// so the expected values are read back off the page rather than restated here —
// the light table's are much darker than the dark table's, and pinning one set
// would make the other theme's run fail.

const DEMO_CONN = { id: 'c1', name: 'Demo', host: 'demo.local', port: 22, username: 'root' }
const PROMPT = '[root@sip /srv]# '
// The default category scheme's date tone (#98c379). Not a theme token, so it
// reads the same in dark and light.
const DATE_RGB = 'rgb(152, 195, 121)'

const entry = (name: string, isDir: boolean) => ({
  name,
  path: `/srv/${name}`,
  isDir,
  size: isDir ? 0 : 414,
  mode: isDir ? 'drwxr-xr-x' : '-rw-r--r--',
  modified: '',
})

/** The theme's listing hues, in the `rgb(…)` form the DOM renderer writes inline. */
async function themeHues(page: Page) {
  return page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement)
    const asRgb = (token: string): string => {
      const probe = document.createElement('span')
      probe.style.color = cs.getPropertyValue(token).trim()
      document.body.appendChild(probe)
      const value = getComputedStyle(probe).color
      probe.remove()
      return value
    }
    return {
      dir: asRgb('--link'),
      link: asRgb('--cyan'),
      exec: asRgb('--success'),
      file: asRgb('--purple'),
    }
  })
}

/** Feed `reply` through `poll_output` after the Enter, echoing typed input like a PTY. */
async function installShell(page: Page, reply: string | string[]) {
  await page.evaluate((frame) => {
    const internals = (
      window as unknown as {
        __TAURI_INTERNALS__: {
          invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
        }
      }
    ).__TAURI_INTERNALS__
    const orig = internals.invoke.bind(internals)
    const pending: string[] = []
    // The app fires a hidden `pwd` query for a remote cwd, which arrives as
    // another Enter. One listing per test is enough, so the frame is spent once.
    let answered = false
    internals.invoke = async (cmd: string, args: Record<string, unknown> = {}) => {
      if (cmd === 'send_input') {
        const data = String(args.data ?? '')
        if (/[\r\n]/.test(data)) {
          const body = Array.isArray(frame) ? frame : [frame]
          pending.push('\r\n', ...(answered ? [] : body))
          answered = true
        } else {
          const visible = data.replace(/\x1b\[20[01]~/g, '').replace(/[\x00-\x1f\x7f]/g, '')
          if (visible) pending.push(visible)
        }
      }
      const res = await orig(cmd, args)
      if (cmd === 'poll_output') return [...(res as string[]), ...pending.splice(0)]
      return res
    }
  }, reply)
}

async function openShell(
  page: Page,
  command: string,
  reply: string | string[],
  needle = 'note.txt',
) {
  await page.goto('/')
  await page.locator('.connection-item').first().click()
  await expect(page.locator('.xterm-rows')).toContainText(PROMPT)
  await page.locator('.xterm-screen').click()
  await installShell(page, reply)
  await page.keyboard.type(command)
  await page.keyboard.press('Enter')
  await expect
    .poll(() => page.locator('.xterm-rows').innerText(), { timeout: 10_000 })
    .toContain(needle)
  return themeHues(page)
}

const rowHtml = (page: Page, needle: string) =>
  page.locator('.xterm-rows > div').filter({ hasText: needle }).first().innerHTML()

/** The runs painted inside one row — both names share a row here, and the
 *  command-line colorizer paints the prompt with a truecolor run of its own. */
const colouredRunsInRow = (page: Page, needle: string) =>
  page
    .locator('.xterm-rows > div')
    .filter({ hasText: needle })
    .first()
    .evaluate((row) =>
      Array.from(row.querySelectorAll('span[style*="color:"]')).map((s) => s.textContent),
    )

test('cmd `dir`: every column keeps its own highlighting', async ({ page }) => {
  await installTauriMock(page, { connections: [DEMO_CONN], pollOutputChunks: [[PROMPT]] })
  const hues = await openShell(
    page,
    'dir',
    [
      ' Volume in drive D has no label.',
      '',
      ' Directory of D:\\srv',
      '',
      '2026-09-28  08:11    <DIR>          .',
      '2026-09-28  08:11    <DIR>          ..',
      '2026-09-16  10:23    <DIR>          backups',
      '2026-09-19  14:14               414 note.txt',
      '2026-09-19  14:14            12,288 setup.exe',
      '               2 File(s)     12,702 bytes',
      '',
      PROMPT,
    ].join('\r\n'),
  )

  expect(await rowHtml(page, 'backups')).toContain(hues.dir)
  expect(await rowHtml(page, 'setup.exe')).toContain(hues.exec)
  expect(await rowHtml(page, 'note.txt')).toContain(hues.file)
  // The listing capture owns these bytes, so the ordinary output highlighter has
  // to be run over everything that is not a name — otherwise the date, time and
  // size columns lose the highlighting every other terminal line gets.
  const row = await colouredRunsInRow(page, 'backups')
  expect(row).toEqual(['2026-09-16', '10:23', 'backups'])
  expect(await rowHtml(page, 'backups')).toContain(DATE_RGB)
})

test('a ConPTY listing that arrives a row at a time is still colored', async ({ page }) => {
  await installTauriMock(page, { connections: [DEMO_CONN], pollOutputChunks: [[PROMPT]] })
  // Chunk-for-chunk what a real local cmd emits through ConPTY (read off a live
  // PTY): every row its own chunk, an entry even split from its own CRLF, and an
  // OSC title in between. Line by line the echoed command is long gone, so a
  // paint that assumes "line 0 is the echo" colors precisely nothing — which is
  // exactly how this looked on the real machine while the links still worked.
  const hues = await openShell(page, 'dir', [
    '\r\n',
    '\x1b]0;C:\\WINDOWS\\system32\\cmd.exe - dir\x1b\\',
    '\r\n',
    ' 驱动器 D 中的卷是 本地磁盘\r\n',
    '\r\n',
    ' D:\\wrolp\\wrolp-win 的目录\r\n',
    '\r\n',
    '2026-09-28  09:12    <DIR>          .',
    '\r\n',
    '2026-09-16  10:23    <DIR>          backups',
    '\r\n',
    '2026-09-19  14:14               414 note.txt',
    '\r\n',
    '2026-09-19  14:14            12,288 setup.exe',
    '\r\n',
    '              15 个文件        250,202 字节\r\n',
    '\r\n',
    PROMPT,
  ])

  expect(await rowHtml(page, 'backups')).toContain(hues.dir)
  expect(await rowHtml(page, 'setup.exe')).toContain(hues.exec)
  expect(await rowHtml(page, 'note.txt')).toContain(hues.file)
})

test('the window title cmd sets mid-listing never reaches the screen', async ({ page }) => {
  await installTauriMock(page, {
    connections: [DEMO_CONN],
    pollOutputChunks: [[PROMPT]],
    fileEntries: [entry('AppData', true), entry('Cert_Info.bin', false)],
  })
  // cmd re-titles the window around every command, and the sequence lands with no
  // newline of its own — it is prepended to the first listing row. Tokenized, it
  // yields a "name" ending in `.exe`, and wrapping that splices an ESC into the
  // OSC, which aborts it and dumps `C:\WINDOWS\system32\cmd.exe - ls` on screen.
  const hues = await openShell(
    page,
    'ls',
    [
      '\r\n',
      '\x1b]0;C:\\WINDOWS\\system32\\cmd.exe - ls\x1b\\AppData',
      '\r\n',
      'Cert_Info.bin',
      '\r\n',
      PROMPT,
    ],
    'Cert_Info.bin',
  )

  expect(await page.locator('.xterm-rows').innerText()).not.toContain('system32')
  expect(await rowHtml(page, 'AppData')).toContain(hues.dir)
  expect(await rowHtml(page, 'Cert_Info.bin')).toContain(hues.exec)
})

test('a `dir` row the window title is glued onto is still colored', async ({ page }) => {
  await installTauriMock(page, { connections: [DEMO_CONN], pollOutputChunks: [[PROMPT]] })
  // The case the title sequence really breaks: it has no newline of its own, so
  // it lands in front of an entry row. `dir` rows are matched from column 0, so
  // anything sitting before the date used to cost that row its coloring — the
  // "前面有些没着色" report.
  const hues = await openShell(
    page,
    'dir',
    [
      '\x1b]0;C:\\WINDOWS\\system32\\cmd.exe - dir\x1b\\2026-09-16  10:23    <DIR>          backups',
      '\r\n',
      '2026-09-19  14:14               414 note.txt',
      '\r\n',
      PROMPT,
    ],
    'backups',
  )

  const html = await rowHtml(page, 'backups')
  expect(html).toContain(hues.dir)
  expect(html).toContain(DATE_RGB)
  expect(html).not.toContain('system32')
  expect(await rowHtml(page, 'note.txt')).toContain(hues.file)
})

test('`ls -l`: directory, symlink and executable each take their own hue', async ({ page }) => {
  await installTauriMock(page, { connections: [DEMO_CONN], pollOutputChunks: [[PROMPT]] })
  const hues = await openShell(
    page,
    'ls -l',
    [
      'total 12',
      'drwxr-xr-x  2 root root 4096 Sep 28 08:11 backups',
      'lrwxrwxrwx  1 root root    9 Sep 28 08:11 current -> releases',
      '-rwxr-xr-x  1 root root 1200 Sep 28 08:11 run.sh',
      '-rw-r--r--  1 root root  414 Sep 28 08:11 note.txt',
      '',
      PROMPT,
    ].join('\r\n'),
  )

  expect(await rowHtml(page, 'backups')).toContain(hues.dir)
  expect(await rowHtml(page, 'current')).toContain(hues.link)
  expect(await rowHtml(page, 'run.sh')).toContain(hues.exec)
  // The permission bits say note.txt is not runnable, so it takes the file hue
  // rather than the executable one `run.sh` gets.
  expect(await rowHtml(page, 'note.txt')).toContain(hues.file)
})

test('a bare `ls` colors directories from the listing it fetches anyway', async ({ page }) => {
  await installTauriMock(page, {
    connections: [DEMO_CONN],
    pollOutputChunks: [[PROMPT]],
    fileEntries: [entry('backups', true), entry('note.txt', false)],
  })
  const hues = await openShell(page, 'ls', ['backups   note.txt', '', PROMPT].join('\r\n'))

  expect(await rowHtml(page, 'backups')).toContain(hues.dir)
  // `note.txt` shares the row with it, so pin the whole painted set instead.
  expect(await colouredRunsInRow(page, 'backups')).toEqual(['backups', 'note.txt'])
})

test('the gate reads "already colored" as colour SGR, not any escape', async () => {
  // Imported directly: this decides whether a listing is painted at all, and the
  // DOM cannot show it — wrapping the shell's own SGR in ours leaves *its* hue
  // rendering, because the inner sequence is applied last.
  const { outputHasColor } = await import('../../src/lib/termHighlight')
  expect(outputHasColor('\x1b[01;34mbackups\x1b[0m')).toBe(true)
  expect(outputHasColor('\x1b[38;2;13;160;25;mbin\x1b[0m')).toBe(true)
  expect(outputHasColor('\x1b[1mdrwxr-xr-x\x1b[0m')).toBe(false) // bold only
  expect(outputHasColor('\x1b[7mname\x1b[27m')).toBe(false) // inverse only
  expect(outputHasColor('\x1b[2K\x1b[1;1H')).toBe(false) // erase / cursor, not SGR
  expect(outputHasColor('drwxr-xr-x 2 root root 4096 Sep 28 08:11 backups')).toBe(false)
})

test("a colored `ls -l` keeps rendering the shell's own hues", async ({ page }) => {
  await installTauriMock(page, { connections: [DEMO_CONN], pollOutputChunks: [[PROMPT]] })
  // GNU `ls -l --color` prints the mode column plain and wraps only the name in
  // its own SGR (SGR `01;34` renders as the DOM renderer's bright blue, fg-12).
  const hues = await openShell(
    page,
    'ls -l --color=auto',
    [
      'total 12',
      'drwxr-xr-x  2 root root 4096 Sep 28 08:11 \x1b[01;34mbackups\x1b[0m',
      '-rw-r--r--  1 root root  414 Sep 28 08:11 note.txt',
      '',
      PROMPT,
    ].join('\r\n'),
  )

  const html = await rowHtml(page, 'backups')
  expect(html).toContain('xterm-fg-12')
  expect(html).not.toContain(hues.dir)
  expect(html).not.toContain(hues.exec)
  expect(html).not.toContain(hues.file)
  // The gate passes the bytes through, so the columns keep whatever the shell
  // painted rather than getting our category highlighting.
  expect(html).not.toContain(DATE_RGB)
})

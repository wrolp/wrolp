import { test, expect, type Page } from './helpers/fixtures'
import { selectRailMode } from './helpers/sections'
import { installTauriMock } from './helpers/tauriMock'

// The editor must survive a shell line whose quoted text contains `)` and `'`.
// Monaco's built-in shell grammar ended the command substitution at that `)` and
// then treated the stray quote as an open string, so every following line came
// back as one uniform `string` run (task/BUGS.md B57). src/editor/shellLanguage.ts
// replaces that grammar; this spec proves the editor actually uses the replacement.

const DEMO_CONN = { id: 'c1', name: 'Demo', host: 'demo.local', port: 22, username: 'root' }

const FILE_NAME = 'install.sh'
const CONTENT = [
  `#!/bin/sh`,
  `valid_chars=$(printf '%s' "\${SYSTEM_NAME}" | sed -e 's/[][!#$%&()*;<=>?\\_\`{|}/[:space:]]/^/g;' )`,
  `if [ "\${SYSTEM_NAME}" != "\${valid_chars}" ]; then`,
  `  echo matched # inline comment`,
  `# a whole-line comment`,
  `fi`,
].join('\n')

type Segment = { text: string; color: string }

/**
 * Leaf spans of each rendered line with their computed colour. Monaco paints a
 * line as a single default-coloured span and swaps in the token spans a frame
 * later, and it merges adjacent tokens that share a class — so callers must wait
 * for the tokenised render (see `waitForTokens`) and match lines by full text.
 */
function segmentsByLine(page: Page): Promise<Segment[][]> {
  return page.evaluate(() => {
    const nbsp = String.fromCharCode(160)
    return Array.from(document.querySelectorAll('.view-lines .view-line')).map((line) =>
      Array.from(line.querySelectorAll('span'))
        .filter((s) => !s.querySelector('span') && s.textContent)
        .map((s) => ({
          text: (s.textContent as string).split(nbsp).join(' '),
          color: getComputedStyle(s).color,
        })),
    )
  })
}

const fullText = (segs: Segment[]) => segs.map((s) => s.text).join('')
const lineStartingWith = (lines: Segment[][], prefix: string) =>
  lines.find((segs) => fullText(segs).startsWith(prefix))
const colorOf = (segs: Segment[] | undefined, needle: string) =>
  segs?.find((s) => s.text.includes(needle))?.color

/** Wait until Monaco has finished colouring the `if` line, then return it. */
async function settledIfLine(page: Page): Promise<Segment[]> {
  const settled = () =>
    (async () => {
      const line = lineStartingWith(await segmentsByLine(page), 'if [')
      return !!line && colorOf(line, 'if') !== colorOf(line, '!=')
    })()
  await expect.poll(settled, { message: 'Monaco never finished tokenising the line' }).toBe(true)
  return lineStartingWith(await segmentsByLine(page), 'if [')!
}

test.beforeEach(async ({ page }) => {
  await installTauriMock(page, {
    connections: [DEMO_CONN],
    pollOutputChunks: [['root@demo:~$ ']],
    fileEntries: [
      {
        name: FILE_NAME,
        path: `/home/root/${FILE_NAME}`,
        isDir: false,
        size: CONTENT.length,
        mode: '-rw-r--r--',
        modified: '',
      },
    ],
    fileContent: {
      path: `/home/root/${FILE_NAME}`,
      content: CONTENT,
      size: CONTENT.length,
      mode: '-rw-r--r--',
      isBinary: false,
      isTooLarge: false,
      encoding: 'utf-8',
      needsEncoding: false,
    },
  })
  await page.goto('/')
  await page.locator('.connection-item').click()
  await selectRailMode(page, 'files')
  await expect(page.locator('.tree-row.file', { hasText: FILE_NAME })).toBeVisible()
  await page.locator('.tree-row.file', { hasText: FILE_NAME }).click()
  await expect(page.locator('.monaco-editor .view-line').first()).toBeVisible()
})

test('a quoted `)` cannot turn the following lines into one string run', async ({ page }) => {
  const conditional = await settledIfLine(page)

  // One uniform run was the failure mode: the keyword, the brackets, the quotes
  // and the parameter each need their own colour.
  expect(new Set(conditional.map((s) => s.color)).size).toBeGreaterThanOrEqual(3)
  expect(colorOf(conditional, 'if')).not.toEqual(colorOf(conditional, 'SYSTEM_NAME'))
})

test('a comment after code colours like a comment at the line start', async ({ page }) => {
  await settledIfLine(page) // gate: the whole viewport has been tokenised
  const lines = await segmentsByLine(page)
  const echoed = lineStartingWith(lines, '  echo matched')
  const inline = colorOf(echoed, '# inline comment')
  const ownLine = colorOf(lineStartingWith(lines, '# a whole-line'), '# a whole-line comment')
  expect(inline).toBeTruthy()
  expect(inline).toEqual(ownLine)
  // not merely "uncoloured like the rest of the line"
  expect(inline).not.toEqual(colorOf(echoed, 'matched'))
})

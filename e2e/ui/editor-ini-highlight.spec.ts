/**
 * INI highlighting: a key and its value must not render in one colour.
 *
 * Monaco's built-in ini tokenizer only recognises `^\w+=`; a colon separator,
 * dotted/dashed keys and (crucially) unquoted values were left untokenised, so
 * the whole line inherited the default foreground. The replacement provider in
 * customLanguages.ts keeps the built-in language configuration and re-tokenises
 * these forms.
 */
import { test, expect, type Page } from './helpers/fixtures'
import { selectRailMode } from './helpers/sections'
import { installTauriMock } from './helpers/tauriMock'

const DEMO_CONN = { id: 'c1', name: 'Demo', host: 'demo.local', port: 22, username: 'root' }

const CONTENT = [
  '[main]',
  'plain=value',
  '  indented = spaced value',
  '\ttabbed: colon value',
  'dotted.key = 1',
  '# a comment',
].join('\n')

async function openIni(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('wrolp-lang', 'en')
    localStorage.setItem('wrolp-theme', 'dark')
  })
  const name = 'app.ini'
  const path = `/srv/${name}`
  await installTauriMock(page, {
    connections: [DEMO_CONN],
    pollOutputChunks: [['root@demo:~$ ']],
    fileEntries: [
      { name, path, isDir: false, size: CONTENT.length, mode: '-rw-r--r--', modified: '' },
    ],
    fileContent: {
      path,
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
  await page.locator('.tree-row.file', { hasText: name }).click()
  await expect(page.locator('.monaco-editor')).toBeVisible()
}

/** Leaf span colours of the row holding `needle` (Monaco nests a line wrapper). */
async function spanColours(page: Page, needle: string) {
  const row = page.locator('.view-line').filter({ hasText: needle }).first()
  return row.evaluate((el) =>
    Array.from(el.querySelectorAll('span'))
      .filter((s) => s.children.length === 0)
      .map((s) => ({ text: s.textContent ?? '', colour: getComputedStyle(s).color })),
  )
}

async function expectKeyValueColours(page: Page, rowNeedle: string, key: string, value: string) {
  // Tokenization lands a frame or two after the editor mounts, so poll rather
  // than reading the very first painted row.
  await expect
    .poll(
      async () => {
        const spans = await spanColours(page, rowNeedle)
        const keyColour = spans.find((s) => s.text.includes(key))?.colour
        const valueColour = spans.find((s) => s.text.includes(value))?.colour
        if (!keyColour || !valueColour) return `missing span: ${JSON.stringify(spans)}`
        // The user's report: these two were the same colour.
        return keyColour === valueColour ? `same colour ${keyColour}` : 'ok'
      },
      { timeout: 5_000 },
    )
    .toBe('ok')
}

test('key and value are coloured differently in every INI shape', async ({ page }) => {
  await openIni(page)

  // Before the fix the first two cases already worked; the rest did not.
  await expectKeyValueColours(page, 'plain=value', 'plain', 'value')
  await expectKeyValueColours(page, 'indented', 'indented', 'spaced')
  await expectKeyValueColours(page, 'tabbed', 'tabbed', 'colon')
  await expectKeyValueColours(page, 'dotted.key', 'dotted.key', '1')
})

import { test, expect, type Page } from './helpers/fixtures'
import { installTauriMock } from './helpers/tauriMock'

// BUGS.md B38 — indent-guide alignment guard.
//
// Monaco lays indent guides on a fixed grid: the n-th guide of a line sits at
// `(n - 1) * indentSize` visible columns, and the number of guides is
// `ceil(indent / indentSize)` — see
// `node_modules/monaco-editor/esm/vs/editor/browser/viewParts/indentGuides/indentGuides.js`
// and `.../common/model/guidesTextModelPart.js`. `indentSize` comes from the model
// options, which `detectIndentation` derives from the file contents, so a cleanly
// indented file must get exactly one guide per real indentation level — i.e. the
// guides line up with the text.
//
// This pins that baseline: the reported B38 symptom ("indent 2 characters, the line
// lands on the 3rd character") is NOT reproducible here on the default path with
// well-formed files, so the guide grid follows the file's own step (2 → 2, 4 → 4).

const FILE_PATH = '/home/root/a.xml'

const XML_2_SPACE = ['<root>', '  <a>', '    <b/>', '  </a>', '</root>'].join('\n')
const XML_4_SPACE = ['<root>', '    <a>', '        <b/>', '    </a>', '</root>'].join('\n')

async function openXml(page: Page, content: string) {
  await installTauriMock(page, {
    connections: [{ id: 'c1', name: 'Demo', host: 'demo.local', port: 22, username: 'root' }],
    pollOutputChunks: [['root@demo:~$ ']],
    fileEntries: [
      { name: 'a.xml', path: FILE_PATH, isDir: false, size: 40, mode: '-rw-r--r--', modified: '' },
    ],
    fileContent: {
      path: FILE_PATH,
      content,
      size: content.length,
      mode: '-rw-r--r--',
      isBinary: false,
      isTooLarge: false,
      encoding: 'utf-8',
      needsEncoding: false,
    },
  })
  await page.goto('/')
  await page.locator('.connection-item').click()
  await page.locator('.tree-row.file', { hasText: 'a.xml' }).click()
  await expect(page.locator('.monaco-editor')).toBeVisible()
  await expect(page.locator('.tree-row.file', { hasText: 'a.xml' })).toBeVisible()
  // The first guides only appear once the model is tokenized/rendered.
  await expect.poll(async () => (await guideRows(page)).length).toBeGreaterThan(0)
}

/**
 * Each visible line that has guides, with the guide offsets converted from pixels to
 * character columns (`left / spaceWidth`, where the guide's own width *is* the
 * measured space width).
 */
async function guideRows(page: Page) {
  return page.evaluate(() => {
    const lines = Array.from(document.querySelectorAll('.view-lines .view-line'))
    const overlays = Array.from(document.querySelectorAll('.view-overlays > div'))
    const rows: Array<{ text: string; columns: number[] }> = []
    overlays.forEach((overlay, i) => {
      const guides = Array.from(overlay.querySelectorAll('.core-guide-indent')) as HTMLElement[]
      if (!guides.length) return
      const spaceWidth = parseFloat(guides[0].style.width)
      rows.push({
        // Monaco renders leading whitespace as non-breaking spaces.
        text: (lines[i]?.textContent ?? '').replace(/\u00a0/g, ' '),
        columns: guides.map((g) => Math.round((parseFloat(g.style.left) / spaceWidth) * 100) / 100),
      })
    })
    return rows
  })
}

test('a 2-space XML gets one guide per level, 2 columns apart (B38)', async ({ page }) => {
  await openXml(page, XML_2_SPACE)

  expect(await guideRows(page)).toEqual([
    { text: '  <a>', columns: [0] },
    { text: '    <b/>', columns: [0, 2] },
    { text: '  </a>', columns: [0] },
  ])
})

test('a 4-space XML gets one guide per level, 4 columns apart (B38)', async ({ page }) => {
  await openXml(page, XML_4_SPACE)
  // The toolbar mirrors the step the model detected from the file contents.
  await expect(page.locator('.editor-select.tab-size select')).toHaveValue('4')

  expect(await guideRows(page)).toEqual([
    { text: '    <a>', columns: [0] },
    { text: '        <b/>', columns: [0, 4] },
    { text: '    </a>', columns: [0] },
  ])
})

test('the Tab size select re-grids the indent guides (B38)', async ({ page }) => {
  await openXml(page, XML_2_SPACE)
  const select = page.locator('.editor-select.tab-size select')
  await expect(select).toHaveValue('2')
  expect((await guideRows(page))[1].columns).toEqual([0, 2])

  // `tabSize` is a model option — before the fix the select wrote
  // `editor.updateOptions({ tabSize })`, which Monaco silently ignores, so the grid
  // (and the tab width, and the auto-indent) never changed.
  await select.selectOption('4')
  await expect.poll(async () => (await guideRows(page))[1].columns).toEqual([0])
  expect(await guideRows(page)).toEqual([
    { text: '  <a>', columns: [0] },
    { text: '    <b/>', columns: [0] },
    { text: '  </a>', columns: [0] },
  ])
})

test('a wider Tab size clears the stray guide on a Tab-indented continuation (B38)', async ({
  page,
}) => {
  // The reported case: a FreeSWITCH-style continuation indented with TAB + 3 spaces.
  // At the detected step of 2 the tab renders 2 columns wide, so the line is 5 columns
  // in and `ceil(5 / 2) = 3` guides are drawn — one of them on the 3rd character, right
  // against the tab. At a step of 4 the whitespace is 4 + 3 = 7 columns and only
  // `ceil(7 / 4) = 2` guides remain, none of them floating inside the tab.
  const content = ['<root>', '  <a>', '\t   text', '  </a>', '</root>'].join('\n')
  await openXml(page, content)

  expect(await guideRows(page)).toEqual([
    { text: '  <a>', columns: [0] },
    { text: '     text', columns: [0, 2, 4] },
    { text: '  </a>', columns: [0] },
  ])

  await page.locator('.editor-select.tab-size select').selectOption('4')
  await expect.poll(async () => (await guideRows(page))[1].columns).toEqual([0, 4])
})

import { test, expect, type Page } from './helpers/fixtures'
import { installTauriMock } from './helpers/tauriMock'

// Markdown preview in the file editor (task/plans/markdown-preview-plan.md).
//
// The source view (Monaco) and the rendered Markdown live in the same slot. Monaco is
// only *hidden* while previewing — unmounting its host would detach the editor instance
// and the source view would come back blank, which test 3 guards against.

const DEMO_CONN = { id: 'c1', name: 'Demo', host: 'demo.local', port: 22, username: 'root' }
const MD_NAME = 'README.md'
const MD_PATH = '/home/root/README.md'
const TXT_NAME = 'notes.txt'
const TXT_PATH = '/home/root/notes.txt'

const MD_CONTENT = [
  '# Hello',
  '',
  'Some **bold** text.',
  '',
  '| name | value |',
  '| ---- | ----- |',
  '| a | 1 |',
  '',
  '- [ ] todo',
  '- [x] done',
  '',
  '```bash',
  'echo hi',
  '```',
  '',
  '![screenshot](./shot.png)',
  '',
  '[link](https://example.com)',
].join('\n')

const entry = (name: string, path: string, size = 10) => ({
  name,
  path,
  isDir: false,
  size,
  mode: '-rw-r--r--',
  modified: '',
})

async function openFile(page: Page, name: string, path: string, content: string) {
  await installTauriMock(page, {
    connections: [DEMO_CONN],
    pollOutputChunks: [['root@demo:~$ ']],
    fileEntries: [entry(MD_NAME, MD_PATH, MD_CONTENT.length), entry(TXT_NAME, TXT_PATH)],
    fileContent: {
      path,
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
  await page.locator('.tree-row.file', { hasText: name }).click()
  await expect(page.locator('.tab-item', { hasText: name })).toHaveCount(1)
  await expect(page.locator('.monaco-editor')).toBeVisible()
}

test('the preview switch is only offered for Markdown files', async ({ page }) => {
  await openFile(page, TXT_NAME, TXT_PATH, 'plain text\n')

  await expect(page.locator('.editor-toolbar')).toBeVisible()
  await expect(page.locator('.editor-btn.preview-toggle')).toHaveCount(0)
})

test('the preview renders the Markdown and hides the source', async ({ page }) => {
  await openFile(page, MD_NAME, MD_PATH, MD_CONTENT)

  const toggle = page.locator('.editor-btn.preview-toggle')
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await toggle.click()

  const preview = page.locator('.md-preview')
  await expect(preview).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')

  await expect(preview.locator('h1')).toHaveText('Hello')
  // GFM table + task list.
  await expect(preview.locator('table th').first()).toHaveText('name')
  await expect(preview.locator('input[type="checkbox"]')).toHaveCount(2)
  await expect(preview.locator('input[type="checkbox"]').nth(1)).toBeChecked()
  // Fenced code block with its language label and a copy button.
  await expect(preview.locator('.md-preview-code-lang')).toHaveText('bash')
  await expect(preview.locator('.md-preview-code code')).toHaveText('echo hi')
  await expect(preview.locator('.md-preview-code-copy')).toHaveCount(1)
  // A relative image cannot be fetched from the remote host — it shows a placeholder.
  await expect(preview.locator('.md-preview-img-local')).toContainText('screenshot')

  // The source is hidden, not unmounted.
  await expect(page.locator('.monaco-editor')).toBeHidden()
})

test('the source view survives a preview round-trip', async ({ page }) => {
  await openFile(page, MD_NAME, MD_PATH, MD_CONTENT)

  const toggle = page.locator('.editor-btn.preview-toggle')
  await toggle.click()
  await expect(page.locator('.md-preview')).toBeVisible()

  await toggle.click()
  await expect(page.locator('.md-preview')).toHaveCount(0)
  await expect(page.locator('.monaco-editor')).toBeVisible()

  // …and it is still a live editor, not a detached shell.
  await page.locator('.monaco-editor').click()
  await page.keyboard.type('x')
  await expect(page.locator('.editor-btn.primary')).toBeEnabled()
})

test('edits show up in the preview', async ({ page }) => {
  await openFile(page, MD_NAME, MD_PATH, MD_CONTENT)

  const heading = page.locator('.monaco-editor .view-line', { hasText: 'Hello' })
  await heading.click()
  await page.keyboard.press('End')
  await page.keyboard.type(' world')

  await page.locator('.editor-btn.preview-toggle').click()
  await expect(page.locator('.md-preview h1')).toHaveText('Hello world')
})

test('Ctrl+S saves while previewing', async ({ page }) => {
  await openFile(page, MD_NAME, MD_PATH, MD_CONTENT)

  // Make the file dirty so the save button is enabled.
  await page.locator('.monaco-editor').click()
  await page.keyboard.type('x')
  await expect(page.locator('.editor-btn.primary')).toBeEnabled()

  await page.locator('.editor-btn.preview-toggle').click()
  await expect(page.locator('.md-preview')).toBeVisible()

  // Monaco can't receive the shortcut while hidden — the preview forwards it.
  await page.keyboard.press('Control+s')
  await expect(page.locator('.editor-btn.primary')).toBeDisabled()
})

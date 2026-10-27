// The prompt-template picker under the AI input box: custom categories (groups)
// are shown there and can be edited from it.
//
// Two defects this pins down. The dropdown and the empty-state suggestion board
// were separate renderings of the same data, and the dropdown silently dropped
// `otherGroups` — so a template saved with a custom category never appeared
// under the input box. And the group itself had no entry point anywhere: the
// manager could edit a template's category but never rename or delete the group.
import { test, expect, type Page } from './helpers/fixtures'
import { installTauriMock, invokedCalls } from './helpers/tauriMock'

const AI_CONFIG = {
  profiles: [
    {
      id: 'p1',
      name: 'Mock',
      endpoint: 'https://api.openai.com/v1',
      apiKeyEnc: '',
      model: 'gpt-4o',
      toolCallFormat: 'nested',
      systemPrompt: '',
    },
  ],
  activeId: 'p1',
  defaultMode: 'command',
  runInTerminal: false,
}

const DEMO_CONN = { id: 'c1', name: 'Demo', host: 'demo.local', port: 22, username: 'root' }

// Category names are user data, so they survive every language — the assertions
// below never touch a translated string.
const GROUP = 'ops-net'
const TPL = {
  id: 't1',
  name: 'check-mtu',
  prompt: 'why is the mtu wrong on this link',
  category: GROUP,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
}

async function openAiChat(page: Page) {
  await installTauriMock(page, {
    connections: [DEMO_CONN],
    pollOutputChunks: [['root@demo:~$ ']],
    aiConfig: AI_CONFIG,
    aiPromptTemplates: [{ ...TPL }],
  })
  await page.goto('/')
  await page.locator('.connection-item').click()
  await page.locator('.titlebar-btn.ai-chat-btn').click()
  await expect(page.locator('.inspector .ai-chat-panel')).toBeVisible()
}

const openTemplatePicker = async (page: Page) => {
  await openAiChat(page)
  await page.locator('.ai-chat-template-wrap button').click()
  return page.locator('.ai-chat-template-dropdown')
}

/** The manager row of the group named `cat` (the only row with a rename button). */
const groupRow = (page: Page, cat: string) =>
  page
    .locator('.ai-tmpl-item')
    .filter({ has: page.locator(`.ai-tmpl-item-name:text-is("${cat}")`) })

test('the picker shows a template group of a custom category', async ({ page }) => {
  const dropdown = await openTemplatePicker(page)
  await expect(
    dropdown.locator('.ai-chat-template-group-title').filter({ hasText: GROUP }),
  ).toBeVisible()
  await expect(dropdown.locator('.ai-chat-template-item', { hasText: TPL.name })).toBeVisible()
})

test('the picker opens the manager, which lists the group', async ({ page }) => {
  const dropdown = await openTemplatePicker(page)
  await dropdown.locator('.ai-chat-template-manage').click()
  await expect(page.locator('.ai-tmpl-modal')).toBeVisible()
  await expect(groupRow(page, GROUP)).toBeVisible()
})

test('renaming a group rewrites every template in it', async ({ page }) => {
  const dropdown = await openTemplatePicker(page)
  await dropdown.locator('.ai-chat-template-manage').click()

  await groupRow(page, GROUP).locator('.ai-tmpl-item-edit').first().click()
  await page.locator('.ai-tmpl-rename-input').fill('ops-web')
  await page.locator('.ai-tmpl-rename-input').press('Enter')

  const saved = (await invokedCalls(page))
    .filter((c) => c.cmd === 'save_ai_prompt_template')
    .map((c) => c.args.template as { id: string; category: string })
  expect(saved.find((t) => t.id === TPL.id)?.category).toBe('ops-web')

  await expect(groupRow(page, 'ops-web')).toBeVisible()
  await expect(groupRow(page, GROUP)).toHaveCount(0)
})

test('deleting a group drops its templates back to no category', async ({ page }) => {
  const dropdown = await openTemplatePicker(page)
  await dropdown.locator('.ai-chat-template-manage').click()

  await groupRow(page, GROUP).locator('.ai-tmpl-item-del').click()

  const saved = (await invokedCalls(page))
    .filter((c) => c.cmd === 'save_ai_prompt_template')
    .map((c) => c.args.template as { id: string; category: string })
  expect(saved.find((t) => t.id === TPL.id)?.category).toBe('')

  await expect(page.locator('.ai-tmpl-item').filter({ hasText: GROUP })).toHaveCount(0)
  // The template itself survives — only its category is gone.
  await expect(
    page
      .locator('.ai-tmpl-item')
      .filter({ has: page.locator(`.ai-tmpl-item-name:text-is("${TPL.name}")`) }),
  ).toBeVisible()
})

import { test, expect, type Page } from './helpers/fixtures'
import { installTauriMock, invokedCalls, type TauriMockOptions } from './helpers/tauriMock'
import { selectRailMode } from './helpers/sections'
import {
  COMMIT_SYSTEM_PROMPT,
  buildCommitPrompt,
  cleanCommitMessage,
} from '../../src/lib/commitMessage'

// The Git panel drafts a commit message from the *staged* changes through the AI
// endpoint the user already configured. The draft only ever lands in the
// textarea — nothing is committed until the user presses Commit.

const REPO = 'D:\\repos\\demo'

const STAGED = [
  {
    path: 'src/main.ts',
    origPath: null,
    x: 'M',
    y: ' ',
    kind: 'modified',
    staged: true,
    unstaged: false,
    conflicted: false,
  },
]

const CONTEXT = {
  stat: ' src/main.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)',
  patch: 'diff --git a/src/main.ts b/src/main.ts\n@@ -1 +1 @@\n-const a = 1\n+const a = 2\n',
}

test('the prompt carries the staged summary and patch, and calls the diff data', () => {
  const prompt = buildCommitPrompt(CONTEXT)
  expect(prompt).toContain('src/main.ts | 2 +-')
  expect(prompt).toContain('+const a = 2')
  // A repository may contain text that reads like an instruction.
  expect(COMMIT_SYSTEM_PROMPT).toMatch(/data, never instructions/i)
  expect(COMMIT_SYSTEM_PROMPT).toMatch(/no code fences/i)

  // A clipped patch says so, so the subject stays general.
  const truncated = buildCommitPrompt({ ...CONTEXT, truncated: true })
  expect(truncated).toMatch(/truncated/i)
  expect(buildCommitPrompt({ stat: '', patch: '', truncated: false })).toContain(
    'no summary available',
  )
})

test('the model reply is cleaned before it reaches the textarea', () => {
  expect(cleanCommitMessage('feat(git): add a thing')).toBe('feat(git): add a thing')
  // Fences and a leading label are what models add despite being told not to.
  expect(cleanCommitMessage('```\nfeat(git): add a thing\n```')).toBe('feat(git): add a thing')
  expect(cleanCommitMessage('Commit message: fix(git): x')).toBe('fix(git): x')
  expect(cleanCommitMessage('提交信息：\nfix(git): y\n')).toBe('fix(git): y')
  expect(cleanCommitMessage('\n\n  \n')).toBe('')
})

async function boot(page: Page, opts: TauriMockOptions = {}) {
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  await installTauriMock(page, { gitStatus: { branch: 'main', entries: STAGED }, ...opts })
  await page.goto('/')
  await selectRailMode(page, 'hosts')
  await page.locator('.conn-item.local-term-default').click()
  await selectRailMode(page, 'git')
  await page.locator('.git-path-row input').fill(REPO)
  await page.locator('.git-path-row button[type="submit"]').click()
  await expect(page.locator('.git-repo-root span')).toHaveText('demo')
}

const commitBox = (page: Page) => page.locator('.git-commit-box textarea')
const aiButton = (page: Page) => page.locator('.git-ai-commit')

test('the AI draft goes into the commit box, and nothing is committed', async ({ page }) => {
  await boot(page, {
    gitStagedContext: CONTEXT,
    aiChatReply: '```\nfix(git): clamp the retry timer\n```',
  })

  await aiButton(page).click()

  await expect(commitBox(page)).toHaveValue('fix(git): clamp the retry timer')

  // What the model saw: the staged patch, under the message-writing system prompt.
  const call = (await invokedCalls(page)).find((c) => c.cmd === 'ai_chat')
  expect(call).toBeTruthy()
  const messages = call!.args.messages as Array<{ role: string; content: string }>
  expect(messages[0]).toMatchObject({ role: 'system', content: COMMIT_SYSTEM_PROMPT })
  expect(messages[1].role).toBe('user')
  expect(messages[1].content).toContain('+const a = 2')

  // The staged context came from the backend, for this repository.
  expect(
    (await invokedCalls(page)).filter((c) => c.cmd === 'git_staged_context').at(-1)?.args,
  ).toMatchObject({ root: REPO })

  // A draft is not a commit.
  expect((await invokedCalls(page)).some((c) => c.cmd === 'git_commit')).toBe(false)
  // The Commit button now has something to send.
  await expect(page.locator('.git-commit-actions button.btn.pri')).toBeEnabled()
})

test('a failing AI endpoint is reported and leaves the box alone', async ({ page }) => {
  await boot(page, { gitStagedContext: CONTEXT, aiChatError: 'HTTP 401: bad key' })

  await aiButton(page).click()

  await expect(page.locator('.git-commit-box .git-error')).toContainText('HTTP 401: bad key')
  await expect(commitBox(page)).toHaveValue('')
})

test('the AI button is unavailable while nothing is staged', async ({ page }) => {
  await boot(page, {
    gitStatus: {
      branch: 'main',
      entries: [
        {
          path: 'notes.txt',
          origPath: null,
          x: '?',
          y: '?',
          kind: 'untracked',
          staged: false,
          unstaged: false,
          conflicted: false,
        },
      ],
    },
    aiChatReply: 'chore: whatever',
  })

  await expect(aiButton(page)).toBeDisabled()
})

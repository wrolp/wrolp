import { test, expect, type Page } from './helpers/fixtures'
import { installTauriMock, invokedCalls, type TauriMockOptions } from './helpers/tauriMock'
import { selectRailMode } from './helpers/sections'

// `GIT-PANEL-PLAN.md`: the Git mode is one repository at a time, driven entirely by
// the `git` CLI on the host. The panel's contract is the invokes it makes and the
// status rows it reads, so these specs drive the real component against a stateful
// mock working tree rather than asserting a canned render.

const REPO = 'D:\\repos\\demo'

const DIFF = [
  'diff --git a/src/main.ts b/src/main.ts',
  'index 1111111..2222222 100644',
  '--- a/src/main.ts',
  '+++ b/src/main.ts',
  '@@ -1,1 +1,2 @@',
  '-const a = 1',
  '+const a = 2',
  '+const b = 3',
  '',
].join('\n')

const ORIGIN = {
  name: 'origin',
  fetchUrl: 'https://example.com/demo.git',
  pushUrl: 'https://example.com/demo.git',
}

/**
 * The Git mode follows the focused terminal, and the home tab has no host — so a
 * spec reaches it the way a user does: open the built-in local shell first.
 */
async function boot(page: Page, opts: TauriMockOptions = {}) {
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  await installTauriMock(page, { gitRemotes: [ORIGIN], ...opts })
  await page.goto('/')
  await selectRailMode(page, 'hosts')
  await page.locator('.conn-item.local-term-default').click()
  await selectRailMode(page, 'git')
}

async function openRepo(page: Page) {
  await page.locator('.git-path-row input').fill(REPO)
  await page.locator('.git-path-row button[type="submit"]').click()
  // The repo bar names the folder (the last path segment), not the full path.
  await expect(page.locator('.git-repo-root span')).toHaveText('demo')
}

// Match the head from its start: "Changes" is a substring of "Staged changes",
// and the two sections would otherwise both match.
const section = (page: Page, title: string) =>
  page.locator('.git-section').filter({
    has: page.locator('.git-section-head', { hasText: new RegExp(`^${title}`) }),
  })

test('a folder opens as a repository and a clean tree says so', async ({ page }) => {
  await boot(page)

  await expect(page.locator('.git-empty-title')).toHaveText('Open a repository to get started')
  await openRepo(page)

  // Not a bare repo, so the branch bar and the worktree sections are what render.
  await expect(page.locator('.git-branch-chip')).toContainText('main')
  await expect(page.locator('.git-clean')).toContainText('Working tree clean')

  const infoCalls = (await invokedCalls(page)).filter((c) => c.cmd === 'git_repo_info')
  expect(infoCalls[0]?.args).toMatchObject({ path: REPO, host: { kind: 'local' } })
  // Status is read against the resolved root, not the folder the user typed.
  const statusCall = (await invokedCalls(page)).find((c) => c.cmd === 'git_status')
  expect(statusCall?.args).toMatchObject({ root: REPO, host: { kind: 'local' } })

  // Fetch / pull / push are first-class verbs (D1): each names the first remote and
  // the branch, and carries the op id the progress events are filtered by.
  await page.locator('.git-network-actions button', { hasText: 'Fetch' }).click()
  await expect
    .poll(async () =>
      (await invokedCalls(page)).filter((c) => c.cmd === 'git_fetch').map((c) => c.args),
    )
    .toContainEqual(
      expect.objectContaining({ root: REPO, remote: 'origin', opId: expect.any(String) }),
    )

  await page.locator('.git-network-actions button', { hasText: 'Push' }).click()
  await expect
    .poll(async () =>
      (await invokedCalls(page)).filter((c) => c.cmd === 'git_push').map((c) => c.args),
    )
    .toContainEqual(expect.objectContaining({ root: REPO, remote: 'origin', branch: 'main' }))
})

test('staging moves a row into the staged section and a commit drains it', async ({ page }) => {
  await boot(page, {
    gitStatus: {
      branch: 'main',
      upstream: 'origin/main',
      ahead: 1,
      behind: 0,
      entries: [
        // `MM`: already staged, with further worktree edits — it belongs to both
        // sections on purpose.
        {
          path: 'src/main.ts',
          origPath: null,
          x: 'M',
          y: 'M',
          kind: 'modified',
          staged: true,
          unstaged: true,
          conflicted: false,
        },
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
  })
  await openRepo(page)

  await expect(section(page, 'Staged changes')).toContainText('src/main.ts')
  await expect(section(page, 'Changes')).toContainText('src/main.ts')
  await expect(section(page, 'Untracked')).toContainText('notes.txt')
  await expect(page.locator('.git-branch-chip')).toContainText('↑1')

  // Stage the untracked file: it leaves Untracked and joins Staged.
  await page.locator('.git-row', { hasText: 'notes.txt' }).locator('.git-mini-btn').first().click()
  await expect
    .poll(async () =>
      (await invokedCalls(page)).filter((c) => c.cmd === 'git_stage').map((c) => c.args.paths),
    )
    .toContainEqual(['notes.txt'])
  await expect(section(page, 'Untracked')).toHaveCount(0)
  await expect(section(page, 'Staged changes')).toContainText('notes.txt')

  // Commit: the staged section empties, and the new commit heads the history.
  await page.locator('.git-commit-box textarea').fill('feat: add notes')
  await page.locator('.git-commit-box .btn-primary').click()
  await expect
    .poll(async () =>
      (await invokedCalls(page)).filter((c) => c.cmd === 'git_commit').map((c) => c.args),
    )
    .toContainEqual(
      expect.objectContaining({ root: REPO, message: 'feat: add notes', amend: false }),
    )

  await expect(page.locator('.git-ok')).toContainText('Committed d1e2f3a: feat: add notes')
  // The `MM` row keeps its worktree edits, so only the commit itself is gone.
  await expect(section(page, 'Staged changes')).toHaveCount(0)
  await expect(section(page, 'Changes')).toContainText('src/main.ts')
  await expect(page.locator('.git-commit-row').first()).toContainText('feat: add notes')
})

test('a changed row opens its diff in a read-only dialog', async ({ page }) => {
  await boot(page, {
    gitDiff: DIFF,
    gitStatus: {
      branch: 'main',
      entries: [
        {
          path: 'src/main.ts',
          origPath: null,
          x: 'M',
          y: 'M',
          kind: 'modified',
          staged: true,
          unstaged: true,
          conflicted: false,
        },
      ],
    },
  })
  await openRepo(page)

  await section(page, 'Changes').locator('.git-row-main').click()
  await expect(page.locator('.git-diff-modal')).toBeVisible()
  await expect(page.locator('.git-diff-modal .git-diff-add').first()).toContainText('const a = 2')
  await expect(page.locator('.git-diff-modal .git-diff-del').first()).toContainText('const a = 1')

  await expect
    .poll(async () =>
      (await invokedCalls(page)).filter((c) => c.cmd === 'git_diff').map((c) => c.args),
    )
    .toContainEqual(
      expect.objectContaining({ root: REPO, path: 'src/main.ts', scope: 'unstaged', oid: null }),
    )

  await page.locator('.git-diff-modal .k8s-modal-close').click()
  await expect(page.locator('.git-diff-modal')).toHaveCount(0)
})

test('a host without git says so instead of failing every command', async ({ page }) => {
  await boot(page, {
    gitProbe: { installed: false, message: 'git: command not found' },
  })

  await expect(page.locator('.git-empty-title')).toHaveText('Git is not available on this host')
  await expect(page.locator('.git-empty-detail')).toHaveText('git: command not found')
  await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible()
  // Not installed means not asked: the repository read never runs.
  await expect
    .poll(async () => (await invokedCalls(page)).filter((c) => c.cmd === 'git_repo_info').length)
    .toBe(0)

  // D5: a manual executable path is handed to the probe instead of being ignored.
  const BIN = 'C:\\Program Files\\Git\\cmd\\git.exe'
  await page.locator('.git-empty .git-path-row input').fill(BIN)
  await page.locator('.git-empty .git-path-row button[type="submit"]').click()
  await expect
    .poll(async () =>
      (await invokedCalls(page))
        .filter((c) => c.cmd === 'git_probe')
        .map((c) => c.args.bin),
    )
    .toContain(BIN)
})

test('a folder that is not a repository reports it and stays in the picker', async ({ page }) => {
  await boot(page, { gitNotRepoPaths: [REPO] })

  await page.locator('.git-path-row input').fill(REPO)
  await page.locator('.git-path-row button[type="submit"]').click()

  await expect(page.locator('.git-error')).toContainText('Not a Git repository')
  await expect(page.locator('.git-error')).toContainText(REPO)
  // The picker is still there, so the user can correct the path.
  await expect(page.locator('.git-path-row input')).toHaveValue(REPO)
})

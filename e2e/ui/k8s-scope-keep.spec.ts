import { test, expect, type Page } from './helpers/fixtures'
import { installTauriMock, invokedCalls } from './helpers/tauriMock'
import { selectRailMode } from './helpers/sections'
import type { K8sContext, K8sNamespace } from '../../src/types'

const DEMO = { id: 'scope-ssh', name: 'Scope SSH', host: 'jump.local', port: 22, username: 'root' }
const ns = (...names: string[]): K8sNamespace[] => names.map((name) => ({ name, status: 'Active' }))

interface HostLists {
  contexts: K8sContext[]
  namespaces: Record<string, K8sNamespace[]>
}

const LOCAL: HostLists = {
  contexts: [
    { name: 'prod', cluster: 'local-prod', user: 'u', namespace: 'apps', current: true },
    { name: 'dev', cluster: 'local-dev', user: 'u', namespace: 'dev-home', current: false },
  ],
  namespaces: {
    prod: ns('apps', 'default', 'audit', 'team-b'),
    dev: ns('default', 'dev-home', 'team-b', 'audit'),
  },
}
const SSH: HostLists = {
  // Same context names on different hosts must NOT make an old namespace list valid.
  contexts: [
    { name: 'prod', cluster: 'ssh-prod', user: 'u', namespace: 'ops', current: true },
    { name: 'dev', cluster: 'ssh-dev', user: 'u', namespace: 'default', current: false },
  ],
  namespaces: { prod: ns('ops', 'ops-extra', 'default'), dev: ns('default', 'remote-team') },
}

type ListCommand = 'k8s_list_contexts' | 'k8s_list_namespaces'
type ScopeWindow = Window & {
  __TAURI_INTERNALS__: {
    invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
  }
  __K8S_SCOPE_TEST__: {
    hosts: Record<string, HostLists>
    hold: ListCommand | null
    fail: ListCommand | null
    pending: Array<{ cmd: string; context: string; host: string; finish: () => void }>
  }
}

/** Dynamic responses stay local to this spec; the shared mock still records every invoke. */
async function boot(page: Page) {
  await installTauriMock(page, {
    connections: [DEMO],
    pollOutputChunks: [['root@jump:~# ']],
    helmProbe: { installed: true, version: '3.16.2', message: 'v3.16.2' },
  })
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  await page.goto('/')
  await page.evaluate(
    ({ local, ssh }) => {
      const win = window as unknown as ScopeWindow
      const state: ScopeWindow['__K8S_SCOPE_TEST__'] = {
        hosts: { local, ssh },
        hold: null,
        fail: null,
        pending: [],
      }
      win.__K8S_SCOPE_TEST__ = state
      const invoke = win.__TAURI_INTERNALS__.invoke.bind(win.__TAURI_INTERNALS__)
      win.__TAURI_INTERNALS__.invoke = async (cmd, args = {}) => {
        const original = invoke(cmd, args)
        if (cmd !== 'k8s_list_contexts' && cmd !== 'k8s_list_namespaces') return original
        await original
        const host = args.host as { kind: string; jumpTabId?: number }
        const hostKey = host.kind === 'ssh' ? `ssh:${host.jumpTabId}` : 'local'
        const lists = state.hosts[hostKey] ?? state.hosts[host.kind]
        const context = String(args.context ?? '')
        // Snapshot before holding: a late response must really belong to the old request.
        const rows = structuredClone(
          cmd === 'k8s_list_contexts' ? lists.contexts : (lists.namespaces[context] ?? []),
        )
        const fail = state.fail === cmd
        if (state.hold === cmd) {
          await new Promise<void>((finish) => {
            state.pending.push({ cmd, context, host: hostKey, finish })
          })
        }
        if (fail) throw new Error(`scope-test transport failure: ${cmd}`)
        return rows
      }
    },
    { local: LOCAL, ssh: SSH },
  )
}

const contextSelect = (page: Page) => page.locator('.k8s-filters .k8s-select').nth(0)
const namespaceSelect = (page: Page) => page.locator('.k8s-filters .k8s-select').nth(1)
const kindSelect = (page: Page) => page.locator('.k8s-filters .k8s-select').nth(2)
const modeTab = (page: Page, mode: 'Resources' | 'Helm') =>
  page.getByRole('tab', { name: mode, exact: true })

async function listCalls(page: Page, since = 0) {
  return (await invokedCalls(page))
    .slice(since)
    .filter((c) => c.cmd === 'k8s_list_resources' || c.cmd === 'helm_list_releases')
}

async function expectResource(page: Page, since: number, args: Record<string, unknown>) {
  await expect
    .poll(async () =>
      (await listCalls(page, since))
        .filter((c) => c.cmd === 'k8s_list_resources')
        .map((c) => c.args),
    )
    .toContainEqual(expect.objectContaining(args))
}

async function chooseDev(page: Page) {
  await selectRailMode(page, 'k8s')
  await expect(namespaceSelect(page)).toHaveValue('apps')
  await contextSelect(page).selectOption('dev')
  await expect(namespaceSelect(page)).toHaveValue('dev-home')
  await namespaceSelect(page).selectOption('team-b')
  await kindSelect(page).selectOption('services')
  await expectResource(page, 0, { context: 'dev', namespace: 'team-b', kind: 'services' })
}

async function hold(page: Page, cmd: ListCommand | null) {
  await page.evaluate((cmd) => {
    ;(window as unknown as ScopeWindow).__K8S_SCOPE_TEST__.hold = cmd
  }, cmd)
}

async function expectPending(page: Page, cmd: ListCommand, context = '') {
  await expect
    .poll(() =>
      page.evaluate(
        ({ cmd, context }) =>
          (window as unknown as ScopeWindow).__K8S_SCOPE_TEST__.pending.some(
            (p) => p.cmd === cmd && p.context === context,
          ),
        { cmd, context },
      ),
    )
    .toBe(true)
}

async function release(page: Page, context?: string) {
  await page.evaluate((context) => {
    const state = (window as unknown as ScopeWindow).__K8S_SCOPE_TEST__
    const ready = state.pending.filter((p) => context === undefined || p.context === context)
    state.pending = state.pending.filter((p) => !ready.includes(p))
    for (const p of ready) p.finish()
  }, context)
}

/** Let passive effects run while responses remain explicitly held, without timer sleeps. */
async function settlePanel(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )
}

test('Resources retains context, nondefault namespace and kind across modes and sidebar collapse', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  await boot(page)
  await chooseDev(page)

  for (const exit of ['hosts', 'collapse'] as const) {
    if (exit === 'collapse') await page.locator('.rail-item[data-mode="k8s"]').click()
    else await selectRailMode(page, exit)
    await expect(page.locator('.k8s-panel')).toHaveCount(0)
    const since = (await invokedCalls(page)).length
    await selectRailMode(page, 'k8s')
    await expect(modeTab(page, 'Resources')).toHaveAttribute('aria-selected', 'true')
    await expect(contextSelect(page)).toHaveValue('dev')
    await expect(namespaceSelect(page)).toHaveValue('team-b')
    await expect(kindSelect(page)).toHaveValue('services')
    await expectResource(page, since, { context: 'dev', namespace: 'team-b', kind: 'services' })
    const reads = (await invokedCalls(page)).slice(since)
    expect(reads.some((c) => c.cmd === 'k8s_list_contexts')).toBe(true)
    expect(reads.some((c) => c.cmd === 'k8s_list_namespaces')).toBe(true)
  }
  await page.screenshot({ path: test.info().outputPath('restored-scope.png') })
  expect(errors).toEqual([])
})

test('Helm retains its scope and the hidden Resources kind through a Files round trip', async ({
  page,
}) => {
  await boot(page)
  await page.locator('.conn-item.local-term-default').click()
  await expect(page.locator('.rail-item[data-mode="files"]')).toBeVisible()
  await chooseDev(page)
  await modeTab(page, 'Helm').click()
  await selectRailMode(page, 'files')
  await expect(page.locator('.k8s-panel')).toHaveCount(0)
  const since = (await invokedCalls(page)).length
  await selectRailMode(page, 'k8s')
  await expect(modeTab(page, 'Helm')).toHaveAttribute('aria-selected', 'true')
  await expect(contextSelect(page)).toHaveValue('dev')
  await expect(namespaceSelect(page)).toHaveValue('team-b')
  await expect(page.locator('.k8s-filters .k8s-select')).toHaveCount(2)
  await expect
    .poll(async () =>
      (await listCalls(page, since))
        .filter((c) => c.cmd === 'helm_list_releases')
        .map((c) => c.args),
    )
    .toContainEqual(expect.objectContaining({ context: 'dev', namespace: 'team-b' }))
  await modeTab(page, 'Resources').click()
  await expect(kindSelect(page)).toHaveValue('services')
})

test('all namespaces survives revalidation and reaches kubectl as null', async ({ page }) => {
  await boot(page)
  await chooseDev(page)
  await namespaceSelect(page).selectOption('*')
  await selectRailMode(page, 'hosts')
  const since = (await invokedCalls(page)).length
  await selectRailMode(page, 'k8s')
  await expect(namespaceSelect(page)).toHaveValue('*')
  await expectResource(page, since, { context: 'dev', namespace: null, kind: 'services' })
  expect((await listCalls(page, since)).every((c) => c.args.namespace === null)).toBe(true)
})

test('removed namespace and context fall back without querying the invalid saved scope', async ({
  page,
}) => {
  await boot(page)
  await chooseDev(page)
  await selectRailMode(page, 'hosts')
  await page.evaluate(() => {
    const local = (window as unknown as ScopeWindow).__K8S_SCOPE_TEST__.hosts.local
    local.namespaces.dev = local.namespaces.dev.filter((n) => n.name !== 'team-b')
  })
  let since = (await invokedCalls(page)).length
  await selectRailMode(page, 'k8s')
  await expect(namespaceSelect(page)).toHaveValue('dev-home')
  await expectResource(page, since, { context: 'dev', namespace: 'dev-home', kind: 'services' })
  expect((await listCalls(page, since)).every((c) => c.args.namespace === 'dev-home')).toBe(true)

  // Restore team-b, save it again, then remove dev. prod ALSO contains team-b:
  // changing context must clear it, not accidentally validate it against prod.
  await selectRailMode(page, 'hosts')
  await page.evaluate((local) => {
    ;(window as unknown as ScopeWindow).__K8S_SCOPE_TEST__.hosts.local = local
  }, LOCAL)
  await selectRailMode(page, 'k8s')
  await expect(namespaceSelect(page)).toHaveValue('dev-home')
  await namespaceSelect(page).selectOption('team-b')
  await selectRailMode(page, 'hosts')
  await page.evaluate(() => {
    const local = (window as unknown as ScopeWindow).__K8S_SCOPE_TEST__.hosts.local
    local.contexts = local.contexts.filter((c) => c.name !== 'dev')
  })
  since = (await invokedCalls(page)).length
  await selectRailMode(page, 'k8s')
  await expect(contextSelect(page)).toHaveValue('prod')
  await expect(namespaceSelect(page)).toHaveValue('apps')
  await expect(kindSelect(page)).toHaveValue('services')
  await expectResource(page, since, { context: 'prod', namespace: 'apps' })
  expect(
    (await listCalls(page, since)).every(
      (c) => c.args.context === 'prod' && c.args.namespace === 'apps',
    ),
  ).toBe(true)
  const namespaceReads = (await invokedCalls(page))
    .slice(since)
    .filter((c) => c.cmd === 'k8s_list_namespaces')
  expect(namespaceReads.every((c) => c.args.context === 'prod')).toBe(true)
})

for (const mode of ['Resources', 'Helm'] as const) {
  test(`${mode} waits for namespace validation even when the restored selection is unchanged`, async ({
    page,
  }) => {
    await boot(page)
    await chooseDev(page)
    if (mode === 'Helm') await modeTab(page, mode).click()
    await selectRailMode(page, 'hosts')
    await hold(page, 'k8s_list_namespaces')
    const since = (await invokedCalls(page)).length
    await selectRailMode(page, 'k8s')
    await expectPending(page, 'k8s_list_namespaces', 'dev')
    await expect(namespaceSelect(page)).toBeDisabled()
    if (mode === 'Helm') {
      await expect
        .poll(async () =>
          (await invokedCalls(page)).slice(since).some((c) => c.cmd === 'helm_probe'),
        )
        .toBe(true)
    }
    await settlePanel(page)
    expect(await listCalls(page, since)).toEqual([])
    await hold(page, null)
    await release(page)
    await expect(namespaceSelect(page)).toHaveValue('team-b')
    await expect(modeTab(page, mode)).toHaveAttribute('aria-selected', 'true')
    await expectResource(page, since, { context: 'dev', namespace: 'team-b', kind: 'services' })
    if (mode === 'Helm') {
      await expect
        .poll(async () =>
          (await listCalls(page, since)).some((c) => c.cmd === 'helm_list_releases'),
        )
        .toBe(true)
    }
    expect(
      (await listCalls(page, since)).every(
        (c) => c.args.context === 'dev' && c.args.namespace === 'team-b',
      ),
    ).toBe(true)
  })
}

test('late context discovery merges choices made while loading instead of overwriting them', async ({
  page,
}) => {
  await boot(page)
  await hold(page, 'k8s_list_contexts')
  const since = (await invokedCalls(page)).length
  await selectRailMode(page, 'k8s')
  await expectPending(page, 'k8s_list_contexts')
  await kindSelect(page).selectOption('services')
  await modeTab(page, 'Helm').click()
  await settlePanel(page)
  expect(await listCalls(page, since)).toEqual([])
  expect(
    (await invokedCalls(page)).slice(since).filter((c) => c.cmd === 'k8s_list_namespaces'),
  ).toEqual([])
  await hold(page, null)
  await release(page)
  await expect(namespaceSelect(page)).toHaveValue('apps')
  await expect(modeTab(page, 'Helm')).toHaveAttribute('aria-selected', 'true')
  await modeTab(page, 'Resources').click()
  await expect(kindSelect(page)).toHaveValue('services')
  await expectResource(page, since, { context: 'prod', namespace: 'apps', kind: 'services' })
  // No dependence on changing scope/callback objects in the contexts effect.
  expect(
    (await invokedCalls(page)).slice(since).filter((c) => c.cmd === 'k8s_list_contexts'),
  ).toHaveLength(1)
})

test('context changes clear namespace atomically and ignore superseded namespace responses', async ({
  page,
}) => {
  await boot(page)
  await selectRailMode(page, 'k8s')
  await expect(namespaceSelect(page)).toHaveValue('apps')
  await namespaceSelect(page).selectOption('audit')
  await modeTab(page, 'Helm').click()
  await expect
    .poll(async () => (await listCalls(page)).some((c) => c.cmd === 'helm_list_releases'))
    .toBe(true)

  await hold(page, 'k8s_list_namespaces')
  const since = (await invokedCalls(page)).length
  await contextSelect(page).selectOption('dev')
  await expectPending(page, 'k8s_list_namespaces', 'dev')
  await settlePanel(page)
  expect(await listCalls(page, since)).toEqual([])
  await hold(page, null)
  await release(page)
  // audit exists in dev, too, but a deliberate context change starts with its default.
  await expect(namespaceSelect(page)).toHaveValue('dev-home')
  await expectResource(page, since, { context: 'dev', namespace: 'dev-home' })
  expect((await listCalls(page, since)).every((c) => c.args.namespace === 'dev-home')).toBe(true)

  await hold(page, 'k8s_list_namespaces')
  await contextSelect(page).selectOption('prod')
  await expectPending(page, 'k8s_list_namespaces', 'prod')
  await hold(page, null)
  await contextSelect(page).selectOption('dev')
  await expect(namespaceSelect(page)).toHaveValue('dev-home')
  await settlePanel(page)
  const afterSwitch = (await invokedCalls(page)).length
  await release(page, 'prod')
  await settlePanel(page)
  await expect(contextSelect(page)).toHaveValue('dev')
  await expect(namespaceSelect(page)).toHaveValue('dev-home')
  expect(await listCalls(page, afterSwitch)).toEqual([])
})

test('local and SSH hosts retain independent scopes even with identical context names', async ({
  page,
}) => {
  await boot(page)
  await selectRailMode(page, 'hosts')
  await page.locator('.conn-item.local-term-default').click()
  await expect(page.locator('.tab-item:not(.tab-home)')).toHaveCount(1)
  await page.locator('.connection-item', { hasText: DEMO.name }).click()
  await expect(page.locator('.tab-item:not(.tab-home)')).toHaveCount(2)
  const localTab = page.locator('.tab-item:not(.tab-home)').nth(0)
  const sshTab = page.locator('.tab-item:not(.tab-home)').nth(1)
  await localTab.click()
  await selectRailMode(page, 'k8s')
  await expect(namespaceSelect(page)).toHaveValue('apps')
  await namespaceSelect(page).selectOption('audit')
  await kindSelect(page).selectOption('services')
  await expectResource(page, 0, { host: { kind: 'local' }, namespace: 'audit', kind: 'services' })

  await sshTab.click()
  await expect(contextSelect(page)).toHaveValue('prod')
  await expect(namespaceSelect(page)).toHaveValue('ops')
  await expect(kindSelect(page)).toHaveValue('pods')
  await namespaceSelect(page).selectOption('ops-extra')
  await kindSelect(page).selectOption('configmaps')
  await modeTab(page, 'Helm').click()
  await expect
    .poll(async () =>
      (await listCalls(page)).some(
        (c) => c.cmd === 'helm_list_releases' && c.args.namespace === 'ops-extra',
      ),
    )
    .toBe(true)

  await hold(page, 'k8s_list_namespaces')
  const since = (await invokedCalls(page)).length
  await localTab.click()
  await expect(modeTab(page, 'Resources')).toHaveAttribute('aria-selected', 'true')
  await expect(kindSelect(page)).toHaveValue('services')
  await expectPending(page, 'k8s_list_namespaces', 'prod')
  await settlePanel(page)
  expect(await listCalls(page, since)).toEqual([])
  await hold(page, null)
  await release(page)
  await expect(namespaceSelect(page)).toHaveValue('audit')
  await expectResource(page, since, {
    host: { kind: 'local' },
    context: 'prod',
    namespace: 'audit',
    kind: 'services',
  })
  await sshTab.click()
  await expect(modeTab(page, 'Helm')).toHaveAttribute('aria-selected', 'true')
  await expect(namespaceSelect(page)).toHaveValue('ops-extra')
  await modeTab(page, 'Resources').click()
  await expect(kindSelect(page)).toHaveValue('configmaps')
  await expectResource(page, since, {
    host: { kind: 'ssh', jumpTabId: expect.any(Number) },
    context: 'prod',
    namespace: 'ops-extra',
    kind: 'configmaps',
  })
  for (const call of await listCalls(page, since)) {
    expect(call.args.namespace).toBe(
      (call.args.host as { kind: string }).kind === 'local' ? 'audit' : 'ops-extra',
    )
  }
})

for (const failure of [
  'k8s_list_contexts',
  'k8s_list_namespaces',
  'empty-contexts',
  'empty-namespaces',
] as const) {
  test(`${failure} blocks queries without erasing the last good scope`, async ({ page }) => {
    await boot(page)
    await chooseDev(page)
    await selectRailMode(page, 'hosts')
    await page.evaluate((failure) => {
      const state = (window as unknown as ScopeWindow).__K8S_SCOPE_TEST__
      if (failure === 'empty-contexts') state.hosts.local.contexts = []
      else if (failure === 'empty-namespaces') state.hosts.local.namespaces.dev = []
      else state.fail = failure
    }, failure)
    const since = (await invokedCalls(page)).length
    await selectRailMode(page, 'k8s')
    if (failure.startsWith('k8s_')) {
      await expect(page.locator('.k8s-list .file-error')).toContainText(
        'scope-test transport failure',
      )
    } else {
      await expect
        .poll(async () =>
          (await invokedCalls(page))
            .slice(since)
            .some(
              (c) =>
                c.cmd ===
                (failure === 'empty-contexts' ? 'k8s_list_contexts' : 'k8s_list_namespaces'),
            ),
        )
        .toBe(true)
    }
    await settlePanel(page)
    await expect(namespaceSelect(page)).toHaveValue('')
    expect(await listCalls(page, since)).toEqual([])
    if (failure === 'k8s_list_contexts' || failure === 'empty-contexts') {
      expect(
        (await invokedCalls(page)).slice(since).filter((c) => c.cmd === 'k8s_list_namespaces'),
      ).toEqual([])
    }
    await selectRailMode(page, 'hosts')
    await page.evaluate((local) => {
      const state = (window as unknown as ScopeWindow).__K8S_SCOPE_TEST__
      state.hosts.local = local
      state.fail = null
    }, LOCAL)
    const retry = (await invokedCalls(page)).length
    await selectRailMode(page, 'k8s')
    await expect(contextSelect(page)).toHaveValue('dev')
    await expect(namespaceSelect(page)).toHaveValue('team-b')
    await expect(kindSelect(page)).toHaveValue('services')
    await expectResource(page, retry, { context: 'dev', namespace: 'team-b', kind: 'services' })
  })
}

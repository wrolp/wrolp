import { test, expect, type Page } from './helpers/fixtures'
import { installTauriMock, invokedCalls } from './helpers/tauriMock'
import { selectRailMode } from './helpers/sections'

// The Kubernetes mode with a stubbed kubectl: the panel's contract is the set of
// invokes it makes and the shapes it reads, so these specs drive the real
// component and assert what reached the backend.

const CONTEXTS = [
  { name: 'prod', cluster: 'c1', user: 'u1', namespace: 'apps', current: true },
  { name: 'dev', cluster: 'c2', user: 'u2', current: false },
]

const NAMESPACES = [
  { name: 'apps', status: 'Active' },
  { name: 'default', status: 'Active' },
]

const POD = {
  kind: 'pods',
  name: 'web-0',
  namespace: 'apps',
  status: 'Running',
  ready: '1/1',
  restarts: 2,
  detail: 'nginx:1.29 · node-1',
  containers: ['web'],
  createdAt: '2026-10-01T00:00:00Z',
}

async function boot(page: Page) {
  await installTauriMock(page, {
    k8sContexts: CONTEXTS,
    k8sNamespaces: NAMESPACES,
    k8sResources: { pods: [POD] },
    k8sYaml: 'apiVersion: v1\nkind: Pod\nmetadata:\n  name: web-0\n',
    k8sLogs: 'one-shot web-0 log\n',
    // Two drains, then the stream reports itself ended — enough to prove the viewer
    // appends across polls instead of replacing its buffer each time.
    k8sLogChunks: [['hello from '], ['web-0\n']],
  })
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  await page.goto('/')
  await selectRailMode(page, 'k8s')
}

const menuItem = (page: Page, text: RegExp) =>
  page.locator('.context-menu .context-menu-item').filter({ hasText: text })

test('the panel lists the current context and shows the row YAML', async ({ page }) => {
  await boot(page)

  // Context defaults to the kubeconfig's current one; namespace to the context's
  // own default (`apps`), not the alphabetically first entry.
  await expect(page.locator('.k8s-select').first()).toHaveValue('prod')
  await expect(page.locator('.k8s-select').nth(1)).toHaveValue('apps')

  const row = page.locator('.k8s-item')
  await expect(row).toHaveCount(1)
  await expect(row).toContainText('web-0')
  await expect(row.locator('.k8s-chip.ok')).toHaveText('Running')
  await expect(row).toContainText('1/1')

  await row.click()
  await expect(page.locator('.k8s-yaml')).toContainText('kind: Pod')

  const named = (await invokedCalls(page)).filter((c) => c.cmd === 'k8s_list_resources')
  expect(named[0]?.args).toMatchObject({ kind: 'pods', namespace: 'apps', context: 'prod' })
})

// The dialogs sit on top of the list they were opened from, so each one moves: the
// grab handle is the header and nothing else, and the offset is per opening.
test('a dialog drags by its header and reopens centred', async ({ page }) => {
  await boot(page)

  const box = page.locator('.k8s-modal')
  const at = () =>
    box.evaluate((el) => {
      const r = el.getBoundingClientRect()
      return { x: r.x, y: r.y }
    })

  await page.locator('.k8s-item').click()
  await expect(box).toHaveCount(1)
  const centred = await at()

  const grip = await page.locator('.k8s-modal .modal-header').evaluate((el) => {
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })
  await page.mouse.move(grip.x, grip.y)
  await page.mouse.down()
  await page.mouse.move(grip.x + 60, grip.y + 40, { steps: 4 })
  await page.mouse.up()
  expect(await at()).toEqual({ x: centred.x + 60, y: centred.y + 40 })

  // The close affordance in that same header still closes rather than drags.
  await page.locator('.k8s-modal-close').click()
  await expect(box).toHaveCount(0)

  await page.locator('.k8s-item').click()
  await expect(box).toHaveCount(1)
  expect(await at()).toEqual(centred)

  // Backdrop press still dismisses.
  await page.mouse.click(12, 12)
  await expect(box).toHaveCount(0)
})

test('logs stream into the viewer and delete is scoped to its namespace', async ({ page }) => {
  await boot(page)

  await page.locator('.k8s-item').click({ button: 'right' })
  await menuItem(page, /^Logs$/).click()

  // Follow is on by default, so the viewer opens a `kubectl logs -f` rather than
  // asking for the same tail over and over.
  await expect
    .poll(async () =>
      (await invokedCalls(page))
        .filter((c) => c.cmd === 'k8s_logs_stream_start')
        .map((c) => c.args),
    )
    .toContainEqual(
      expect.objectContaining({
        pod: 'web-0',
        namespace: 'apps',
        context: 'prod',
        tailLines: 500,
      }),
    )
  // Both scripted drains are in the buffer: the second appended, it did not replace.
  await expect(page.locator('.k8s-log-output')).toContainText('hello from web-0')
  // The scripted stream runs out, and the backend says so.
  await expect(page.locator('.k8s-note')).toContainText('Stream ended')
  await expect
    .poll(async () =>
      (await invokedCalls(page))
        .filter((c) => c.cmd === 'stop_k8s_logs_stream')
        .map((c) => c.args.streamId),
    )
    .toContain('mock-k8s-log')

  // Follow off switches to the one-shot `kubectl logs --tail N` read.
  await page.locator('.k8s-log-toolbar input[type="checkbox"]').uncheck()
  await expect(page.locator('.k8s-log-output')).toContainText('one-shot web-0 log')
  await page.locator('.k8s-modal-close').click()

  await page.locator('.k8s-item').click({ button: 'right' })
  await menuItem(page, /^Delete$/).click()
  await expect(page.locator('.confirm-dialog')).toContainText('Delete pods')
  await page.locator('.confirm-dialog .btn-danger').click()

  await expect
    .poll(async () =>
      (await invokedCalls(page)).filter((c) => c.cmd === 'k8s_delete_resource').map((c) => c.args),
    )
    .toContainEqual(
      expect.objectContaining({ kind: 'pods', name: 'web-0', namespace: 'apps', context: 'prod' }),
    )
})

test('apply sends the editor text and exec opens a local kubectl shell', async ({ page }) => {
  await boot(page)

  await page.getByRole('button', { name: 'Apply YAML' }).click()
  await page
    .locator('.k8s-apply-input')
    .fill('apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: x')
  await page.locator('.k8s-modal .btn-primary').click()

  await expect
    .poll(async () =>
      (await invokedCalls(page)).filter((c) => c.cmd === 'k8s_apply_yaml').map((c) => c.args),
    )
    .toContainEqual(
      expect.objectContaining({
        namespace: 'apps',
        context: 'prod',
        yaml: expect.stringContaining('kind: ConfigMap'),
      }),
    )

  await page.locator('.k8s-item').click({ button: 'right' })
  await menuItem(page, /^Open shell$/).click()
  await expect
    .poll(async () =>
      (await invokedCalls(page))
        .filter((c) => c.cmd === 'open_local_kubectl_shell')
        .map((c) => c.args),
    )
    .toContainEqual(
      expect.objectContaining({
        namespace: 'apps',
        pod: 'web-0',
        container: 'web',
        context: 'prod',
      }),
    )
})

// The pod's own filesystem, browsed by the same Files panel that reads containers.
test('browsing a pod points the Files panel at its filesystem', async ({ page }) => {
  await boot(page)

  await page.locator('.k8s-item').click({ button: 'right' })
  await menuItem(page, /^Browse files$/).click()
  await selectRailMode(page, 'files')

  // The head names the target — container and all, since a multi-container pod has
  // to be browsed through one of them — and the listing asks for `/`.
  await expect(page.locator('.file-panel .cnt').first()).toHaveText('pod:apps/web-0:web')
  await expect
    .poll(async () =>
      (await invokedCalls(page)).filter((c) => c.cmd === 'target_list_files').map((c) => c.args),
    )
    .toContainEqual(expect.objectContaining({ path: '/' }))
  const call = (await invokedCalls(page)).find((c) => c.cmd === 'target_list_files')
  expect(call?.args.target).toMatchObject({
    kind: 'k8sPod',
    namespace: 'apps',
    pod: 'web-0',
    container: 'web',
    host: { kind: 'local' },
  })
})

// Port forwarding: the dialog's two fields become the kubectl spec, and the strip
// below the list is the only place a running forward is visible.
test('a service can be forwarded and the running forward is stopped', async ({ page }) => {
  await installTauriMock(page, {
    k8sContexts: CONTEXTS,
    k8sNamespaces: NAMESPACES,
    k8sResources: {
      services: [
        {
          kind: 'services',
          name: 'api',
          namespace: 'apps',
          status: 'ClusterIP',
          ready: '',
          restarts: 0,
          detail: '10.0.0.7 · 80/TCP',
          containers: [],
          ports: [80],
        },
      ],
    },
    k8sPortForwards: [
      {
        id: 1,
        hostKind: 'local',
        jumpTabId: null,
        context: 'prod',
        namespace: 'apps',
        target: 'pod/web-0',
        remotePort: '8080',
        listenAddr: '127.0.0.1:18080',
        localPort: 18080,
        startedAt: 1,
        running: true,
        message: 'Forwarding from 127.0.0.1:18080 -> 8080',
      },
    ],
  })
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  await page.goto('/')
  await selectRailMode(page, 'k8s')

  // The pre-existing forward is listed without waiting for an action.
  await expect(page.locator('.k8s-forward')).toHaveCount(1)
  await expect(page.locator('.k8s-forward-addr')).toHaveText('127.0.0.1:18080')

  await page.locator('.k8s-select').nth(2).selectOption('services')
  const row = page.locator('.k8s-item')
  await expect(row).toHaveCount(1)
  await row.click({ button: 'right' })
  await menuItem(page, /^Port forward/).click()

  // Both ports prefilled from the service's own `spec.ports`.
  const dialog = page.locator('.modal').filter({ hasText: 'Forward service/api' })
  await expect(dialog).toHaveCount(1)
  const localInput = dialog.locator('input[type="number"]')
  await expect(localInput).toHaveValue('80')
  await localInput.fill('19090')
  await dialog.locator('.k8s-input').nth(1).fill('http')
  await dialog.locator('.btn-primary').click()

  await expect
    .poll(async () =>
      (await invokedCalls(page))
        .filter((c) => c.cmd === 'k8s_port_forward_start')
        .map((c) => c.args),
    )
    .toContainEqual(
      expect.objectContaining({
        target: 'service/api',
        namespace: 'apps',
        context: 'prod',
        localPort: 19090,
        remotePort: 'http',
        allInterfaces: false,
      }),
    )
  // "Remember this forward" is on by default, so the rule is saved with the start.
  await expect
    .poll(async () =>
      (await invokedCalls(page))
        .filter((c) => c.cmd === 'save_k8s_forward_rule')
        .map((c) => c.args.rule),
    )
    .toContainEqual(
      expect.objectContaining({
        hostKind: 'local',
        target: 'service/api',
        localPort: 19090,
        remotePort: 'http',
      }),
    )

  await page.locator('.k8s-forward .icon-btn').first().click()
  await expect
    .poll(async () =>
      (await invokedCalls(page))
        .filter((c) => c.cmd === 'k8s_stop_port_forward')
        .map((c) => c.args.id),
    )
    .toContain(1)
})

// A saved rule is the panel's way of surviving a restart: it names a connection, not
// a tab, and is only startable while a session to that host is open.
test('a saved forward rule restarts and can be forgotten', async ({ page }) => {
  await installTauriMock(page, {
    k8sContexts: CONTEXTS,
    k8sNamespaces: NAMESPACES,
    k8sResources: { pods: [POD] },
    k8sForwardRules: [
      {
        id: 'r1',
        hostKind: 'local',
        connectionId: null,
        connectionName: null,
        context: 'prod',
        namespace: 'apps',
        target: 'pod/web-0',
        localPort: 19090,
        remotePort: '8080',
        allInterfaces: false,
      },
    ],
  })
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  await page.goto('/')
  await selectRailMode(page, 'k8s')

  const saved = page.locator('.k8s-forward.saved')
  await expect(saved).toHaveCount(1)
  await expect(saved.locator('.k8s-forward-addr')).toHaveText('127.0.0.1:19090')

  await saved.getByRole('button', { name: 'Start' }).click()
  await expect
    .poll(async () =>
      (await invokedCalls(page))
        .filter((c) => c.cmd === 'k8s_port_forward_start')
        .map((c) => c.args),
    )
    .toContainEqual(
      expect.objectContaining({
        target: 'pod/web-0',
        namespace: 'apps',
        context: 'prod',
        localPort: 19090,
        remotePort: '8080',
      }),
    )

  await saved.getByRole('button', { name: 'Forget this rule' }).click()
  await expect(page.locator('.k8s-forward.saved')).toHaveCount(0)
})

// The Helm mode shares the panel's scope pickers and swaps the list underneath them.
test('helm releases list, read values, roll back and install', async ({ page }) => {
  await installTauriMock(page, {
    k8sContexts: CONTEXTS,
    k8sNamespaces: NAMESPACES,
    helmProbe: { installed: true, version: '3.16.2', message: 'v3.16.2' },
    helmReleases: [
      {
        name: 'web',
        namespace: 'apps',
        revision: '7',
        updated: '2026-10-24 09:00:00 +0000 UTC',
        status: 'deployed',
        chart: 'nginx-1.2.3',
        app_version: '1.25',
      },
      {
        name: 'queue',
        namespace: 'apps',
        revision: '1',
        updated: '2026-10-23 09:00:00 +0000 UTC',
        status: 'failed',
        chart: 'redis-8.0.1',
        app_version: '7.2',
      },
    ],
    helmHistory: [
      {
        revision: 1,
        updated: 'then',
        status: 'superseded',
        chart: 'nginx-1.2.2',
        app_version: '1.25',
        description: 'Install complete',
      },
      {
        revision: 2,
        updated: 'now',
        status: 'deployed',
        chart: 'nginx-1.2.3',
        app_version: '1.25',
        description: 'Upgrade complete',
      },
    ],
    helmValues: 'replicas: 2\nimage:\n  tag: "1.25"\n',
  })
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  await page.goto('/')
  await selectRailMode(page, 'k8s')

  await page.locator('.k8s-mode', { hasText: 'Helm' }).click()
  const rows = page.locator('.k8s-item')
  await expect(rows).toHaveCount(2)
  await expect(rows.first()).toContainText('nginx-1.2.3')
  await expect(rows.nth(1).locator('.k8s-chip.bad')).toHaveText('failed')

  // A click reads the values; the head says whose.
  await rows.first().click()
  await expect(page.locator('.k8s-modal .k8s-yaml')).toContainText('replicas: 2')
  await expect(page.locator('.k8s-modal h3')).toHaveText('web — Values')
  await page.locator('.k8s-modal-close').click()

  await rows.first().click({ button: 'right' })
  await menuItem(page, /^History$/).click()
  await expect(page.locator('.k8s-history-row')).toHaveCount(2)
  // Newest first, so the superseded revision to roll back to is the second row —
  // and the deployed one has nothing to roll back to.
  await expect(page.locator('.k8s-history-row').first().locator('button')).toBeDisabled()
  const rollback = page.locator('.k8s-history-row').nth(1).locator('button')
  await expect(rollback).toBeEnabled()
  await rollback.click()
  await expect
    .poll(async () =>
      (await invokedCalls(page)).filter((c) => c.cmd === 'helm_rollback').map((c) => c.args),
    )
    .toContainEqual(
      expect.objectContaining({ release: 'web', namespace: 'apps', revision: 1, context: 'prod' }),
    )

  await rows.last().click({ button: 'right' })
  await menuItem(page, /^Uninstall$/).click()
  await expect(page.locator('.confirm-dialog')).toContainText('Uninstall release')
  await page.locator('.confirm-dialog .btn-danger').click()
  await expect
    .poll(async () =>
      (await invokedCalls(page)).filter((c) => c.cmd === 'helm_uninstall').map((c) => c.args),
    )
    .toContainEqual(expect.objectContaining({ release: 'queue', namespace: 'apps' }))

  // Install / upgrade: the dialog's fields become the helm argv, values over stdin.
  await page.getByRole('button', { name: 'Install / upgrade' }).click()
  const dialog = page.locator('.modal').filter({ hasText: 'Install / upgrade a release' })
  await dialog.locator('.k8s-field .k8s-input').first().fill('web')
  await dialog.locator('.k8s-field .k8s-input').nth(2).fill('bitnami/nginx')
  await dialog.locator('.k8s-apply-input').fill('replicas: 3')
  await dialog.locator('.k8s-check', { hasText: 'Wait for the rollout to finish' }).click()
  await dialog.locator('.btn-primary').click()
  await expect
    .poll(async () =>
      (await invokedCalls(page)).filter((c) => c.cmd === 'helm_upgrade_install').map((c) => c.args),
    )
    .toContainEqual(
      expect.objectContaining({
        release: 'web',
        chart: 'bitnami/nginx',
        namespace: 'apps',
        context: 'prod',
        values: 'replicas: 3',
        wait: true,
      }),
    )
})

// No helm on the host is a statement about the host, not a broken list.
test('the Helm mode says so when the host has no helm', async ({ page }) => {
  await installTauriMock(page, {
    k8sContexts: CONTEXTS,
    k8sNamespaces: NAMESPACES,
  })
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  await page.goto('/')
  await selectRailMode(page, 'k8s')
  await page.locator('.k8s-mode', { hasText: 'Helm' }).click()
  await expect(page.locator('.k8s-list .file-empty')).toHaveText(
    'helm is not available on this host',
  )
  // Not installed means not asked: the list command never runs.
  await expect
    .poll(
      async () => (await invokedCalls(page)).filter((c) => c.cmd === 'helm_list_releases').length,
    )
    .toBe(0)
})

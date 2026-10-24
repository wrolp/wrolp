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

  await page.locator('.k8s-forward .icon-btn').first().click()
  await expect
    .poll(async () =>
      (await invokedCalls(page))
        .filter((c) => c.cmd === 'k8s_stop_port_forward')
        .map((c) => c.args.id),
    )
    .toContain(1)
})

import { test, expect, type Page } from './helpers/fixtures'
import { installTauriMock, invokedCalls } from './helpers/tauriMock'
import { expandSection } from './helpers/sections'

// `LOCAL-DOCKER-PLAN.md`: the app used to reach Docker only by SSH-ing to a jump host
// first (`exec_on_jump`), so a machine with its own daemon had no Docker UI at all.
// `probe_local_docker` now answers whether this machine has a CLI and a reachable
// daemon, and the sidebar has ONE Docker group whose host follows the focused terminal:
// a local shell (or no terminal at all) reads this machine, an SSH session reads that
// host. Only entering a container's shell is still jump-host (P2b).

const DEMO_CONN = { id: 'c1', name: 'Demo', host: 'demo.local', port: 22, username: 'root' }
const PROMPT = 'root@demo:~# '

const LOCAL = {
  id: 'aaa1111bbb2',
  name: 'wrolp-local-api',
  image: 'wrolp/api:1.4',
  state: 'running',
  status: 'Up 3 hours',
}
const REMOTE = {
  id: '9f2c1a4b8e0d',
  name: 'wrolp-remote-api',
  image: 'wrolp/api:1.4',
  state: 'running',
  status: 'Up 5 hours',
}

const RUNNING = { installed: true, serverRunning: true, bin: 'docker', serverVersion: '27.1.1' }
const fileEntry = (name: string) => ({
  name,
  path: `/${name}`,
  isDir: false,
  size: 12,
  mode: '-rwxr-xr-x',
  modified: '',
})
const NO_DAEMON = {
  installed: true,
  serverRunning: false,
  bin: 'docker',
  message: 'Cannot connect at /var/run/docker.sock',
}

const boot = async (page: Page, opts: Parameters<typeof installTauriMock>[1]) => {
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  await installTauriMock(page, {
    connections: [DEMO_CONN],
    pollOutputChunks: [[PROMPT]],
    ...opts,
  })
  await page.goto('/')
}

const row = (page: Page, name: string) => page.locator('.docker-item').filter({ hasText: name })
/** The sidebar's one Docker group — its host is whatever the focused terminal reaches. */
const dockerGroup = (page: Page) => page.locator('.docker-panel')

/** Open the built-in local shell, which makes this machine the group's host. */
async function openLocalShell(page: Page) {
  await page.locator('.conn-item.local-term-default').click()
  await expect
    .poll(async () => (await invokedCalls(page)).filter((c) => c.cmd === 'open_local_shell').length)
    .toBeGreaterThanOrEqual(1)
}

test('with no terminal open the one group reads this machine', async ({ page }) => {
  await boot(page, {
    localDockerProbe: RUNNING,
    localDockerContainers: [LOCAL],
    dockerContainers: [REMOTE],
  })
  // No connection was opened — that is the point: the group must not need a jump host.
  await expandSection(page, 'Docker')
  await expect(dockerGroup(page)).toHaveCount(1)
  // One group, so the head's metadata run is what says which daemon the rows came from.
  await expect(dockerGroup(page).locator('.cnt')).toHaveText('1 · docker 27.1.1')
  await expect(row(page, LOCAL.name)).toBeVisible()
  await expect(row(page, REMOTE.name)).toHaveCount(0)

  // Its drag-to-resize divider, sitting directly above the section it sizes.
  expect(
    await page.evaluate(() =>
      Array.from(document.querySelectorAll('.panel-divider-h')).some((d) =>
        Boolean(d.nextElementSibling?.querySelector('.docker-panel')),
      ),
    ),
  ).toBe(true)

  // Everything the jump-host group offers works here too, including the shell — P2b
  // gave it a real PTY (`open_local_docker_shell`) instead of typing `docker exec`
  // into someone else's terminal.
  await row(page, LOCAL.name).click({ button: 'right' })
  const items = await page.locator('.context-menu-item').allTextContents()
  expect(items).toContain('View Logs')
  expect(items).toContain('Stop')
  expect(items).toContain('Analyze Container')
  expect(items).toContain('Enter Shell')
})

test('entering a local container’s shell opens a PTY tab of its own', async ({ page }) => {
  await boot(page, {
    localDockerProbe: RUNNING,
    localDockerContainers: [LOCAL],
  })
  await expandSection(page, 'Docker')
  await row(page, LOCAL.name).click({ button: 'right' })
  await page.locator('.context-menu-item', { hasText: 'Enter Shell' }).click()

  // Its own tab, named for the container, whose PTY is the local CLI's `docker exec`
  // — there is no session terminal to inject a command into.
  await expect(page.locator('.tab-item.active .tab-label')).toHaveText(LOCAL.name)
  await expect
    .poll(
      async () => (await invokedCalls(page)).find((c) => c.cmd === 'open_local_docker_shell')?.args,
    )
    .toMatchObject({ container: LOCAL.name })
})

test('the group follows the focused terminal, and only one is ever mounted', async ({ page }) => {
  await boot(page, {
    localDockerProbe: RUNNING,
    localDockerContainers: [LOCAL],
    dockerContainers: [REMOTE],
  })
  await expandSection(page, 'Docker')
  // Nothing focused yet → this machine.
  await expect(row(page, LOCAL.name)).toBeVisible()

  // An SSH session takes the group over: the remote rows appear, the local ones go, and
  // the second `list_docker_containers` carries the session's host.
  await page.locator('.connection-item').first().click()
  await expect(row(page, REMOTE.name)).toBeVisible()
  await expect(row(page, LOCAL.name)).toHaveCount(0)
  await expect(dockerGroup(page)).toHaveCount(1)

  // A local shell hands it back.
  await openLocalShell(page)
  await expect(row(page, LOCAL.name)).toBeVisible()
  await expect(row(page, REMOTE.name)).toHaveCount(0)

  const hosts = (await invokedCalls(page))
    .filter((c) => c.cmd === 'list_docker_containers')
    .map((c) => (c.args as { host: unknown }).host)
  expect(hosts).toContainEqual({ kind: 'ssh', jumpTabId: expect.any(Number) })
  expect(hosts[hosts.length - 1]).toEqual({ kind: 'local' })
})

test('a local lifecycle verb is sent to the local host', async ({ page }) => {
  await boot(page, {
    localDockerProbe: RUNNING,
    localDockerContainers: [LOCAL],
    dockerContainers: [REMOTE],
  })
  await expandSection(page, 'Docker')
  await row(page, LOCAL.name).click({ button: 'right' })
  await page.locator('.context-menu-item', { hasText: 'Stop' }).click()
  await expect
    .poll(
      async () => (await invokedCalls(page)).find((c) => c.cmd === 'stop_docker_container')?.args,
    )
    .toEqual({ host: { kind: 'local' }, containerName: LOCAL.name })
})

test('logs of a local container are read from the local host', async ({ page }) => {
  await boot(page, {
    localDockerProbe: RUNNING,
    localDockerContainers: [LOCAL],
    dockerContainers: [REMOTE],
  })
  // With a terminal open the log rides that pane instead of becoming its own tab (the
  // pane-free case is below). A *local* shell, because the group follows the focused
  // terminal — and the container it then reads is the local one.
  await openLocalShell(page)
  await expandSection(page, 'Docker')
  await row(page, LOCAL.name).click({ button: 'right' })
  await page.locator('.context-menu-item', { hasText: 'View Logs' }).click()

  const viewer = page.locator('.docker-log-viewer')
  await expect(viewer).toBeVisible()
  // Follow is on by default, so the viewer opens a stream instead of fetching a tail —
  // and that stream is started against the local daemon.
  await expect
    .poll(
      async () =>
        (await invokedCalls(page)).find((c) => c.cmd === 'docker_logs_stream_start')?.args,
    )
    .toMatchObject({ host: { kind: 'local' }, containerName: LOCAL.name })
})

test('a local container’s files are addressed at the local daemon', async ({ page }) => {
  await boot(page, {
    localDockerProbe: RUNNING,
    localDockerContainers: [LOCAL],
    // Two different listings, so "entrypoint.sh showed up" can only mean the container
    // root was read — not the session's own home directory.
    fileEntries: [fileEntry('session-only.txt')],
    filesByDir: { '/': [fileEntry('entrypoint.sh')] },
  })
  // Two different listings, so "entrypoint.sh showed up" can only mean the container
  // root was read — not whatever the terminal's own filesystem is.
  await page.locator('.connection-item').first().click()
  await expect(page.locator('.tree-row.file', { hasText: 'session-only.txt' })).toBeVisible()
  // The group follows the focused terminal, so an SSH session's Docker is the remote
  // one: reaching a local container while a session is open means a local shell.
  await openLocalShell(page)
  await expandSection(page, 'Docker')
  // The name, not the row's centre: the container-id chip at the right edge stops the
  // click from reaching the row's handler.
  await row(page, LOCAL.name).locator('.docker-name').click()
  await expect(page.locator('.tree-row.file', { hasText: 'entrypoint.sh' })).toBeVisible()
  await expect(page.locator('.tree-row.file', { hasText: 'session-only.txt' })).toHaveCount(0)

  // The last listing is the container's — the earlier ones are the terminals' own
  // filesystems, which the switch has to replace rather than add to.
  await expect
    .poll(async () => {
      const lists = (await invokedCalls(page)).filter((c) => c.cmd === 'target_list_files')
      return lists[lists.length - 1]?.args
    })
    .toMatchObject({ target: { kind: 'dockerLocal', container: LOCAL.name }, path: '/' })
})

test('a local container’s files open with no session tab at all', async ({ page }) => {
  await boot(page, {
    localDockerProbe: RUNNING,
    localDockerContainers: [LOCAL],
    filesByDir: { '/': [fileEntry('entrypoint.sh')] },
  })
  await expandSection(page, 'Docker')
  await row(page, LOCAL.name).locator('.docker-name').click()

  // The Files panel used to be a session-only section; a local container's tree needs
  // nothing but the CLI, so it now appears over an empty workspace.
  await expect(page.locator('.file-panel')).toBeVisible()
  await expect(page.locator('.tree-row.file', { hasText: 'entrypoint.sh' })).toBeVisible()
  await expect(page.locator('.tab-item')).toHaveCount(0)
  await expect
    .poll(async () => (await invokedCalls(page)).find((c) => c.cmd === 'target_list_files')?.args)
    .toMatchObject({ target: { kind: 'dockerLocal', container: LOCAL.name }, path: '/' })

  // SSH and Jump both point *at* a session, so the switcher offers neither — clicking
  // them would have retargeted the panel at a tab id of 0.
  const modes = page.locator('.file-mode-switch button')
  await expect(modes).toHaveText(['Docker'])

  // The row is a toggle, and with no session behind it closing the target has to take
  // the section away — otherwise an empty panel with nothing left to browse stays open.
  await row(page, LOCAL.name).locator('.docker-name').click()
  await expect(page.locator('.file-panel')).toHaveCount(0)
})

test('a local container is analysed against the local daemon', async ({ page }) => {
  await boot(page, {
    localDockerProbe: RUNNING,
    localDockerContainers: [LOCAL],
    dockerContainers: [REMOTE],
    dockerAnalysis: {
      tabId: 0,
      containerName: LOCAL.name,
      containerId: LOCAL.id,
      image: 'wrolp/api',
      imageTag: '1.4',
      state: 'running',
      createdAt: '2026-09-26 08:00:00 +0800 CST',
      os: 'Debian GNU/Linux 12 (bookworm)',
      kernel: '6.1.0-23-amd64',
      arch: 'x86_64',
      hostname: LOCAL.id,
      packageManager: 'apt',
      packages: [],
      tools: [],
      ports: [],
      mounts: [],
      envKeys: [],
      processes: [],
      resource: null,
      orchestration: { isCompose: false },
      analyzedAt: 1758000000000,
    },
  })
  await expandSection(page, 'Docker')
  await row(page, LOCAL.name).click({ button: 'right' })
  await page.locator('.context-menu-item', { hasText: 'Analyze Container' }).click()

  // The report renders out of the inspector's Docker tab, and its three layers were all
  // asked of the local daemon.
  await expect(page.locator('.analysis-header')).toContainText(LOCAL.name)
  await expect
    .poll(
      async () =>
        (await invokedCalls(page)).find((c) => c.cmd === 'analyze_docker_container')?.args,
    )
    .toMatchObject({ host: { kind: 'local' }, containerName: LOCAL.name })
})

test('with no terminal tab open, View logs takes the main area as its own tab', async ({
  page,
}) => {
  await boot(page, {
    localDockerProbe: RUNNING,
    localDockerContainers: [LOCAL],
  })
  await expandSection(page, 'Docker')
  await row(page, LOCAL.name).click({ button: 'right' })
  await page.locator('.context-menu-item', { hasText: 'View Logs' }).click()

  // The group lists containers without any session, so the log must not demand one
  // either: with no pane to ride, the viewer is a tab-bar entry of its own and takes
  // the whole main area.
  await expect(page.locator('.dockerlog-overlay .docker-log-viewer')).toBeVisible()
  await expect(page.locator('.tab-item.active .tab-label')).toHaveText(LOCAL.name)
  await expect(page.locator('.term-workspace')).toHaveCount(0)
  await expect
    .poll(
      async () =>
        (await invokedCalls(page)).find((c) => c.cmd === 'docker_logs_stream_start')?.args,
    )
    .toMatchObject({ host: { kind: 'local' }, containerName: LOCAL.name })

  // Closing the entry tears the viewer down with it — its unmount is what stops the
  // follow stream, so nothing may keep it mounted.
  await page.locator('.tab-item.active .tab-close').click()
  await expect(page.locator('.docker-log-viewer')).toHaveCount(0)
  await expect(page.locator('.tab-item')).toHaveCount(0)
})

test('an installed CLI with no daemon offers one retry, and it lifts when the daemon answers', async ({
  page,
}) => {
  await boot(page, {
    localDockerProbe: NO_DAEMON,
    localDockerProbeAfterRefresh: RUNNING,
    localDockerContainers: [LOCAL],
  })
  const retry = page.locator('.docker-local-retry')
  await expect(retry).toBeVisible()
  await expect(retry).toContainText('Local Docker daemon not running')
  // The raw CLI diagnostic rides along as the tooltip, not as the label.
  await expect(retry).toHaveAttribute('title', /docker\.sock/)
  await expect(dockerGroup(page)).toHaveCount(0)

  await retry.click()
  // The group is there now but still collapsed, which is how it ships.
  await expect(dockerGroup(page)).toBeVisible()
  await expect(row(page, LOCAL.name)).toBeHidden()
  await expandSection(page, 'Docker')
  await expect(row(page, LOCAL.name)).toBeVisible()
})

test('the container list follows the interface font size', async ({ page }) => {
  const sizeOf = (sel: string) =>
    page.evaluate((s) => getComputedStyle(document.querySelector(s)!).fontSize, sel)

  await boot(page, {
    localDockerProbe: RUNNING,
    localDockerContainers: [LOCAL],
    // Follow is turned off below, so the viewer renders its body from one tail fetch —
    // that body text (`.dlv-output`) is what has to track the scale.
    dockerLogsByContainer: { [LOCAL.name]: '2026-09-28T10:00:00Z INFO boot\nready' },
  })
  await expandSection(page, 'Docker')
  await expect(row(page, LOCAL.name)).toBeVisible()
  // `--fs-ui` ships at 12.5px, so the name (`--fs-sm`) computes to 12px.
  const nameBefore = await sizeOf('.docker-name')
  expect(Number.parseFloat(nameBefore)).toBeCloseTo(12, 0)

  // The 界面字号 knob writes `--fs-ui` (its range tops out at 15px), and the list reads
  // the scale derived from it — so the rows move with their own section header instead
  // of staying at their px values, which is exactly what they used to do.
  await page.addInitScript(() => {
    localStorage.setItem('wrolp-ui-font-size', '15')
    localStorage.setItem('wrolp-docker-follow', '0')
  })
  await page.reload()
  await expandSection(page, 'Docker')
  await expect(row(page, LOCAL.name)).toBeVisible()
  expect(Number.parseFloat(await sizeOf('.docker-name'))).toBeCloseTo(14.5, 0)
  expect(Number.parseFloat(await sizeOf('.docker-image'))).toBeCloseTo(13.5, 0)
  expect(Number.parseFloat(await sizeOf('.docker-state'))).toBeCloseTo(13.5, 0)

  // The log viewer is the other surface of the same two partials, and it is the one
  // users stare at longest — its body and header read the same scale.
  await row(page, LOCAL.name).click({ button: 'right' })
  await page.locator('.context-menu-item', { hasText: 'View Logs' }).click()
  await expect(page.locator('.dlv-output')).toBeVisible()
  expect(Number.parseFloat(await sizeOf('.dlv-output'))).toBeCloseTo(14.5, 0)
  expect(Number.parseFloat(await sizeOf('.dlv-container-name'))).toBeCloseTo(16, 0)
})

test('a podman daemon is labelled as podman, not silently called docker', async ({ page }) => {
  // Decision ④: the probe may resolve `podman`. Everything downstream is the same CLI
  // surface, but the header has to say which daemon the rows came from.
  await boot(page, {
    localDockerProbe: {
      installed: true,
      serverRunning: true,
      bin: 'podman',
      serverVersion: '5.2.0',
    },
    localDockerContainers: [LOCAL],
  })
  await expandSection(page, 'Docker')
  await expect(dockerGroup(page).locator('.cnt')).toHaveText(`1 · podman 5.2.0`)
  await expect(row(page, LOCAL.name)).toBeVisible()
})

test('nothing installed stays silent', async ({ page }) => {
  await boot(page, { localDockerContainers: [LOCAL] })
  await expect(page.locator('.docker-local-retry')).toHaveCount(0)
  await expect(dockerGroup(page)).toHaveCount(0)
})

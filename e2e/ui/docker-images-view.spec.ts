import { test, expect, type Page } from './helpers/fixtures'
import { selectRailMode, sectionHead } from './helpers/sections'
import { installTauriMock, invokedCalls } from './helpers/tauriMock'
import type { ImageInfo } from '../../src/types'

const CONN = { id: 'c1', name: 'Remote', host: 'demo.local', port: 22, username: 'root' }
const PROBE = { installed: true, serverRunning: true, bin: 'docker', serverVersion: '27.1.1' }
const SHARED_ID = `sha256:0123456789abcdef${'0'.repeat(48)}`
const IMAGES: ImageInfo[] = [
  {
    id: SHARED_ID,
    repository: 'example/api',
    tag: 'stable',
    size: '187MB',
    created: '3 weeks ago',
  },
  {
    id: SHARED_ID,
    repository: 'example/api',
    tag: 'latest',
    size: '187MB',
    created: '3 weeks ago',
  },
  {
    id: 'abcdef1234567890',
    repository: '<none>',
    tag: '<none>',
    size: '42MB',
    created: '2 hours ago',
  },
]
const REMOTE_IMAGE: ImageInfo = {
  id: '123456abcdef',
  repository: 'remote/worker',
  tag: 'v2',
  size: '80MB',
  created: '1 day ago',
}

type InvokeArgs = Record<string, unknown>
type TestWindow = Window & {
  __TAURI_INTERNALS__: { invoke: (cmd: string, args?: InvokeArgs) => Promise<unknown> }
  __dockerCopied: string[]
  __dockerGate: { calls: InvokeArgs[]; release: () => void; finished: boolean }
}

async function boot(page: Page, localImages = IMAGES, remoteImages = [REMOTE_IMAGE]) {
  await page.addInitScript(() => {
    localStorage.setItem('wrolp-lang', 'en')
    const w = window as unknown as TestWindow
    w.__dockerCopied = []
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          w.__dockerCopied.push(text)
        },
      },
    })
  })
  await installTauriMock(page, {
    connections: [CONN],
    pollOutputChunks: [['root@demo:~# ']],
    localDockerProbe: PROBE,
    localDockerImages: localImages,
    dockerImages: remoteImages,
  })
  await page.goto('/')
  await expect(page.locator('.connection-item')).toBeVisible()
}

const row = (page: Page, ref: string) =>
  page.locator('.docker-item.image').filter({ has: page.getByText(ref, { exact: true }) })
const imageButton = (page: Page) => page.locator('.docker-view-btn', { hasText: /^Images$/ })
const containerButton = (page: Page) =>
  page.locator('.docker-view-btn', { hasText: /^Containers$/ })
const removals = async (page: Page) =>
  (await invokedCalls(page)).filter((c) => c.cmd === 'remove_docker_image')

async function openImages(page: Page) {
  await selectRailMode(page, 'containers')
  await imageButton(page).click()
  await expect(imageButton(page)).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.docker-list')).toHaveAttribute('aria-busy', 'false')
}

async function askDelete(page: Page, ref: string) {
  await row(page, ref).click({ button: 'right' })
  await page.locator('.docker-context-menu .ctx-danger').click()
  await expect(page.locator('.confirm-dialog')).toBeVisible()
}

/** Keep the panel mounted while tab focus changes its daemon. Remote tab first, local second. */
async function openBothHosts(page: Page) {
  await page.locator('.connection-item').click()
  await expect(page.locator('.tab-item:not(.tab-home)')).toHaveCount(1)
  await page.locator('.conn-item.local-term-default').click()
  await expect(page.locator('.tab-item:not(.tab-home)')).toHaveCount(2)
  await expect(page.locator('.tab-item:not(.tab-home)').last()).toHaveClass(/active/)
  await selectRailMode(page, 'containers')
}

/** Wrap the installed mock after boot, avoiding init-script ordering and real delays. */
async function gateNext(page: Page, command: string, fail = false) {
  await page.evaluate(
    ({ command, fail }) => {
      const w = window as unknown as TestWindow
      const original = w.__TAURI_INTERNALS__.invoke
      let release!: () => void
      const pending = new Promise<void>((resolve) => {
        release = resolve
      })
      const gate = { calls: [] as InvokeArgs[], release, finished: false }
      w.__dockerGate = gate
      w.__TAURI_INTERNALS__.invoke = async (cmd, args = {}) => {
        if (cmd !== command || (args.host as { kind: string } | undefined)?.kind !== 'local') {
          return original(cmd, args)
        }
        gate.calls.push(args)
        if (gate.calls.length !== 1) return original(cmd, args)
        try {
          await pending
          if (fail) throw new Error('conflict: image is used by a container')
          return await original(cmd, args)
        } finally {
          gate.finished = true
        }
      }
    },
    { command, fail },
  )
}

async function releaseGate(page: Page) {
  await page.evaluate(() => (window as unknown as TestWindow).__dockerGate.release())
  await expect
    .poll(() => page.evaluate(() => (window as unknown as TestWindow).__dockerGate.finished))
    .toBe(true)
  // Allow the released promise's React update to commit before asserting absence.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      }),
  )
}

test('images show reference, normalized short ID, size and age without browsing files', async ({
  page,
}) => {
  await boot(page)
  await selectRailMode(page, 'containers')
  await expect(containerButton(page)).toHaveAttribute('aria-pressed', 'true')
  expect((await invokedCalls(page)).filter((c) => c.cmd === 'list_docker_images')).toHaveLength(0)
  await openImages(page)

  await expect(sectionHead(page, 'Docker').locator('.docker-filter-toggle')).toHaveCount(0)
  await expect(page.locator('.docker-item.image')).toHaveCount(3)
  await expect(sectionHead(page, 'Docker').locator('.cnt')).toHaveText('3 · docker 27.1.1')
  const stable = row(page, 'example/api:stable')
  await expect(stable.locator('.docker-id')).toHaveText('0123456789ab')
  await expect(stable.locator('.docker-id')).toHaveAttribute('title', `Image ID: ${SHARED_ID}`)
  await expect(stable.locator('.docker-size')).toHaveText('187MB')
  await expect(stable.locator('.docker-age')).toHaveText('3 weeks ago')
  await expect(row(page, 'example/api:latest')).toBeVisible()
  const fileCallsBefore = (await invokedCalls(page)).filter((c) => c.cmd === 'target_list_files')
  await stable.locator('.docker-name').click()
  await expect(stable).not.toHaveClass(/active/)
  expect((await invokedCalls(page)).filter((c) => c.cmd === 'target_list_files')).toEqual(
    fileCallsBefore,
  )
  await expect(page.locator('.rail-item[data-mode="files"]')).toHaveCount(0)

  const listsBefore = (await invokedCalls(page)).filter(
    (c) => c.cmd === 'list_docker_images',
  ).length
  await sectionHead(page, 'Docker').getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect
    .poll(
      async () => (await invokedCalls(page)).filter((c) => c.cmd === 'list_docker_images').length,
    )
    .toBeGreaterThan(listsBefore)
  await containerButton(page).click()
  await expect(sectionHead(page, 'Docker').locator('.docker-filter-toggle')).toBeVisible()
  await expect(page.locator('.docker-item.image')).toHaveCount(0)
})

test('search matches repo:tag and full ID and updates the visible count', async ({ page }) => {
  await boot(page)
  await openImages(page)
  const search = page.locator('.nav-search input')
  await search.fill('API:STABLE')
  await expect(page.locator('.docker-item.image')).toHaveCount(1)
  await expect(row(page, 'example/api:stable')).toBeVisible()
  await expect(sectionHead(page, 'Docker').locator('.cnt')).toHaveText('1 · docker 27.1.1')
  await search.fill('sha256:0123456789')
  await expect(page.locator('.docker-item.image')).toHaveCount(2)
  await search.fill('missing-image')
  await expect(page.locator('.docker-item.image')).toHaveCount(0)
  await expect(page.locator('.docker-list .file-empty')).toHaveText('No images')
  await expect(sectionHead(page, 'Docker').locator('.cnt')).toHaveText('0 · docker 27.1.1')
  await search.fill('')
  await expect(page.locator('.docker-item.image')).toHaveCount(3)
})

test('a daemon with no images shows the empty state', async ({ page }) => {
  await boot(page, [])
  await openImages(page)
  await expect(page.locator('.docker-list .file-empty')).toHaveText('No images')
  await expect(page.locator('.docker-item')).toHaveCount(0)
  await expect(sectionHead(page, 'Docker').locator('.cnt')).toHaveText('0 · docker 27.1.1')
})

test('copy and cancel are non-destructive; deleting one tag preserves its shared ID sibling', async ({
  page,
}) => {
  await boot(page)
  await openImages(page)
  const stable = row(page, 'example/api:stable')
  for (const label of ['Copy image name:tag', 'Copy image ID']) {
    await stable.click({ button: 'right' })
    await page.locator('.docker-context-menu .context-menu-item', { hasText: label }).click()
    await expect(page.locator('.docker-context-menu')).toHaveCount(0)
  }
  expect(await page.evaluate(() => (window as unknown as TestWindow).__dockerCopied)).toEqual([
    'example/api:stable',
    SHARED_ID,
  ])
  await askDelete(page, 'example/api:stable')
  await expect(page.locator('.confirm-dialog')).toContainText(
    'Other tags may keep the shared image',
  )
  await expect(page.locator('.confirm-dialog')).toContainText('No force deletion')
  await page.locator('.confirm-dialog .btn-cancel').click()
  expect(await removals(page)).toHaveLength(0)
  await expect(stable).toBeVisible()

  await askDelete(page, 'example/api:stable')
  await page.locator('.confirm-dialog .btn-danger').click()
  await expect(stable).toHaveCount(0)
  await expect(row(page, 'example/api:latest')).toBeVisible()
  await expect(sectionHead(page, 'Docker').locator('.cnt')).toHaveText('2 · docker 27.1.1')
  expect((await removals(page)).map((c) => c.args)).toEqual([
    { host: { kind: 'local' }, imageRef: 'example/api:stable' },
  ])
})

test('dangling images are deleted by their full ID', async ({ page }) => {
  await boot(page)
  await openImages(page)
  await askDelete(page, '<none>:<none>')
  await expect(page.locator('.confirm-dialog')).toContainText(IMAGES[2].id)
  await expect(page.locator('.confirm-dialog')).toContainText('untagged image')
  await page.locator('.confirm-dialog .btn-danger').click()
  await expect(row(page, '<none>:<none>')).toHaveCount(0)
  expect((await removals(page)).map((c) => c.args)).toEqual([
    { host: { kind: 'local' }, imageRef: IMAGES[2].id },
  ])
})

test('busy deletion cannot be confirmed twice; a rejected deletion retains rows and allows retry', async ({
  page,
}) => {
  await boot(page)
  await openImages(page)
  await gateNext(page, 'remove_docker_image', true)
  await askDelete(page, 'example/api:stable')
  await page.locator('.confirm-dialog .btn-danger').click()
  await expect(page.locator('.confirm-dialog')).toHaveCount(0)
  await row(page, 'example/api:stable').click({ button: 'right' })
  const remove = page.locator('.docker-context-menu .ctx-danger')
  await expect(remove).toHaveAttribute('aria-disabled', 'true')
  // Dispatch tests the handler guard as well as the disabled affordance.
  await remove.dispatchEvent('click')
  await expect(page.locator('.confirm-dialog')).toHaveCount(0)
  expect(
    await page.evaluate(() => (window as unknown as TestWindow).__dockerGate.calls.length),
  ).toBe(1)
  await releaseGate(page)
  await expect(page.locator('.docker-list .file-error')).toContainText(
    'image is used by a container',
  )
  await expect(row(page, 'example/api:stable')).toBeVisible()
  await expect(page.locator('.docker-item.image')).toHaveCount(3)
  await expect(remove).toHaveAttribute('aria-disabled', 'false')
  await remove.click()
  await page.locator('.confirm-dialog .btn-danger').click()
  await expect(row(page, 'example/api:stable')).toHaveCount(0)
  await expect(row(page, 'example/api:latest')).toBeVisible()
})

test('switching views discards a late list response and closes its menu', async ({ page }) => {
  await boot(page)
  await selectRailMode(page, 'containers')
  await gateNext(page, 'list_docker_images')
  await imageButton(page).click()
  await expect
    .poll(() => page.evaluate(() => (window as unknown as TestWindow).__dockerGate.calls.length))
    .toBe(1)
  await containerButton(page).click()
  await releaseGate(page)
  await expect(containerButton(page)).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.docker-item.image')).toHaveCount(0)
  await expect(page.locator('.docker-list')).toHaveAttribute('aria-busy', 'false')
  await imageButton(page).click()
  await row(page, 'example/api:stable').click({ button: 'right' })
  await containerButton(page).click()
  await expect(page.locator('.docker-context-menu')).toHaveCount(0)
})

test('a late local image response cannot overwrite the focused SSH daemon', async ({ page }) => {
  await boot(page)
  await openBothHosts(page)
  await gateNext(page, 'list_docker_images')
  await imageButton(page).click()
  await expect
    .poll(() => page.evaluate(() => (window as unknown as TestWindow).__dockerGate.calls.length))
    .toBe(1)
  await page.locator('.tab-item:not(.tab-home)').first().click()
  await expect(row(page, 'remote/worker:v2')).toBeVisible()
  await releaseGate(page)
  await expect(row(page, 'remote/worker:v2')).toBeVisible()
  await expect(row(page, 'example/api:stable')).toHaveCount(0)
  await expect(page.locator('.docker-item.image')).toHaveCount(1)
  await expect(page.locator('.docker-list')).toHaveAttribute('aria-busy', 'false')
})

test('host changes dismiss confirmation and in-flight deletion stays on its captured daemon', async ({
  page,
}) => {
  // Identical reference on both daemons makes a wrongly re-bound delete observable.
  await boot(page, IMAGES, [IMAGES[0], REMOTE_IMAGE])
  await openBothHosts(page)
  await openImages(page)
  const tabs = page.locator('.tab-item:not(.tab-home)')
  await askDelete(page, 'example/api:stable')
  // Simulate a focus change while the modal is up (e.g. an external pane focus).
  await tabs.first().dispatchEvent('click')
  await expect(page.locator('.confirm-dialog')).toHaveCount(0)
  await expect(row(page, 'remote/worker:v2')).toBeVisible()
  expect(await removals(page)).toHaveLength(0)
  await tabs.last().click()
  await expect(page.locator('.docker-item.image')).toHaveCount(3)
  await gateNext(page, 'remove_docker_image')
  await askDelete(page, 'example/api:stable')
  await page.locator('.confirm-dialog .btn-danger').click()
  await expect
    .poll(() => page.evaluate(() => (window as unknown as TestWindow).__dockerGate.calls.length))
    .toBe(1)
  await tabs.first().click()
  await expect(row(page, 'remote/worker:v2')).toBeVisible()
  await releaseGate(page)
  await expect(row(page, 'example/api:stable')).toBeVisible()
  expect((await removals(page)).map((c) => c.args)).toEqual([
    { host: { kind: 'local' }, imageRef: 'example/api:stable' },
  ])
  await tabs.last().click()
  await expect(row(page, 'example/api:stable')).toHaveCount(0)
  await expect(row(page, 'example/api:latest')).toBeVisible()
})

import { test, expect, type Page } from './helpers/fixtures'
import { installTauriMock } from './helpers/tauriMock'
import { selectRailMode } from './helpers/sections'
import {
  NAMESPACE_COLOR_COUNT,
  namespaceColorClass,
  namespaceColorIndex,
  namespaceColorMap,
} from '../../src/lib/k8sNamespaceColor'

// All-namespaces mode mixes rows from many namespaces. The colour is derived
// from the name so it survives refreshes, context switches and restarts.

const CONTEXTS = [{ name: 'prod', cluster: 'c1', user: 'u1', current: true }]
const NAMESPACES = [
  { name: 'apps', status: 'Active' },
  { name: 'default', status: 'Active' },
]
const pod = (name: string, ns: string) => ({
  kind: 'pods',
  name,
  namespace: ns,
  status: 'Running',
  ready: '1/1',
  restarts: 0,
  detail: 'nginx:1.29',
  node: 'node-1',
  containers: ['web'],
  createdAt: '2026-10-01T00:00:00Z',
})

test('the color is stable, bounded, and differs between namespaces', () => {
  for (const name of ['apps', 'default', 'kube-system', 'prod', 'monitoring']) {
    const index = namespaceColorIndex(name)
    expect(index).toBeGreaterThanOrEqual(0)
    expect(index).toBeLessThan(NAMESPACE_COLOR_COUNT)
    expect(namespaceColorIndex(name)).toBe(index)
    expect(namespaceColorClass(name)).toBe(`k8s-ns-color-${index}`)
  }
  expect(namespaceColorIndex('apps')).not.toBe(namespaceColorIndex('default'))
})

test('namespaces that hash to the same slot still get different colors', () => {
  // `apps` and `prod` both hash to 1 — the map probes forward for the second.
  expect(namespaceColorIndex('apps')).toBe(namespaceColorIndex('prod'))
  const map = namespaceColorMap(['apps', 'prod'])
  expect(map.get('apps')).toBe(1)
  expect(map.get('prod')).toBe(2)
  expect(new Set(map.values()).size).toBe(2)

  // Assignment depends on the set, not on the arrival order.
  const reversed = namespaceColorMap(['prod', 'apps'])
  expect([...reversed.entries()].sort()).toEqual([...map.entries()].sort())

  // Up to the palette size every namespace on screen is distinct.
  const many = namespaceColorMap(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'])
  const firstSeven = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
  expect(new Set(firstSeven.map((n) => many.get(n))).size).toBe(7)
})

async function boot(page: Page) {
  await page.addInitScript(() => localStorage.setItem('wrolp-lang', 'en'))
  await installTauriMock(page, {
    k8sContexts: CONTEXTS,
    k8sNamespaces: NAMESPACES,
    k8sResources: { pods: [pod('web-0', 'apps'), pod('worker-0', 'default')] },
  })
  await page.goto('/')
  await selectRailMode(page, 'k8s')
  await expect(page.locator('.k8s-select').nth(1)).toHaveValue('*')
}

test('rows from different namespaces get different text colors', async ({ page }) => {
  await boot(page)

  const chips = page.locator('.k8s-item .k8s-ns')
  await expect(chips).toHaveCount(2)
  const apps = page.locator('.k8s-item', { hasText: 'web-0' }).locator('.k8s-ns')
  const def = page.locator('.k8s-item', { hasText: 'worker-0' }).locator('.k8s-ns')
  await expect(apps).toHaveClass(/k8s-ns-color-1/)
  await expect(def).toHaveClass(/k8s-ns-color-4/)

  // The class has to resolve to an actual colour token, not just be present.
  const color = await apps.evaluate((el) => getComputedStyle(el).color)
  const other = await def.evaluate((el) => getComputedStyle(el).color)
  expect(color).not.toBe('rgba(0, 0, 0, 0)')
  expect(color).not.toBe(other)

  // Colour only — no badge: no fill, no border, no padding.
  const box = await apps.evaluate((el) => {
    const s = getComputedStyle(el)
    return {
      background: s.backgroundColor,
      border: `${s.borderTopWidth} ${s.borderTopStyle}`,
      padding: `${s.paddingLeft} ${s.paddingRight}`,
    }
  })
  expect(box.background).toBe('rgba(0, 0, 0, 0)')
  expect(box.border).toBe('0px none')
  expect(box.padding).toBe('0px 0px')
})

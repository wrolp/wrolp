import { test, expect, type Page } from './helpers/fixtures'
import { installTauriMock, invokedCalls } from './helpers/tauriMock'
import { selectRailMode, sectionHead } from './helpers/sections'

const PROBE = { installed: true, serverRunning: true, bin: 'docker', serverVersion: '27.1.1' }
const API = {
  id: `9f2c1a4b8e0d${'a'.repeat(52)}`,
  name: 'production-api-with-a-long-container-name',
  image: 'registry.example.test/team/production-api:2026.10.28',
  state: 'running',
  status: 'Up 3 hours',
}
const STATES = ['running', 'paused', 'restarting', 'exited', 'dead', 'created', 'unrecognized', '']
const LABELS = {
  en: ['Running', 'Paused', 'Restarting', 'Exited', 'Dead', 'Created', 'unrecognized', 'Unknown'],
  zh: ['运行中', '已暂停', '重启中', '已退出', '已终止', '已创建', 'unrecognized', '未知'],
}
const COPY_LABELS = {
  en: ['Copy container name', 'Copy container ID'],
  zh: ['复制容器名', '复制容器 ID'],
}

type CopyWindow = Window & { __dockerCopied: string[] }

async function boot(page: Page, lang: 'en' | 'zh' = 'en', width = 260) {
  await page.addInitScript((lang) => {
    localStorage.setItem('wrolp-lang', lang)
    localStorage.setItem('wrolp-ui-font-size', '15')
    const w = window as unknown as CopyWindow
    w.__dockerCopied = []
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          w.__dockerCopied.push(text)
        },
      },
    })
  }, lang)
  await installTauriMock(page, {
    layout: JSON.stringify({ sidebar: { width } }),
    localDockerProbe: PROBE,
    localDockerContainers: [
      API,
      ...STATES.slice(1).map((state, index) => ({
        id: `${index}123456789ab`,
        name: `state-${index}`,
        image: 'example/worker:latest',
        state,
        status: state || 'Unknown daemon status',
      })),
    ],
    localDockerImages: [
      {
        id: 'sha256:0123456789abcdef',
        repository: 'registry.example.test/team/production-api',
        tag: '2026.10.28',
        size: '187MB',
        created: '3 weeks ago',
      },
    ],
  })
  await page.goto('/')
  await selectRailMode(page, 'containers')
  await expect(page.locator('.docker-item')).toHaveCount(1)
}

const apiRow = (page: Page) => page.locator('.docker-item').filter({ hasText: API.name })

for (const lang of ['en', 'zh'] as const) {
  test(`container ID is nested, selectable, copyable and does not browse (${lang})`, async ({
    page,
  }) => {
    await boot(page, lang)
    const row = apiRow(page)
    const id = row.locator('.docker-info .docker-meta .docker-id')
    await expect(id).toHaveText(API.id.slice(0, 12))
    await expect(id).toHaveAttribute('title', new RegExp(API.id))
    await expect(row.locator(':scope > .docker-id')).toHaveCount(0)
    expect(await id.evaluate((el) => getComputedStyle(el).userSelect)).toBe('all')
    await id.click()
    await expect(row).not.toHaveClass(/active/)
    await expect(page.locator('.rail-item[data-mode="files"]')).toHaveCount(0)
    expect((await invokedCalls(page)).filter((c) => c.cmd === 'target_list_files')).toHaveLength(0)

    for (const label of COPY_LABELS[lang]) {
      await row.click({ button: 'right' })
      await page.locator('.docker-context-menu .context-menu-item', { hasText: label }).click()
      await expect(page.locator('.docker-context-menu')).toHaveCount(0)
    }
    expect(await page.evaluate(() => (window as unknown as CopyWindow).__dockerCopied)).toEqual([
      API.name,
      API.id,
    ])
  })

  test(`all states have one fixed icon and localized accessible labels (${lang})`, async ({
    page,
  }) => {
    await boot(page, lang)
    await sectionHead(page, 'Docker').locator('.docker-filter-toggle input').check()
    const rows = page.locator('.docker-item')
    await expect(rows).toHaveCount(STATES.length)
    await expect(page.locator('.docker-state')).toHaveCount(0)
    for (let index = 0; index < STATES.length; index++) {
      const mark = rows.nth(index).locator('.docker-state-mark')
      await expect(mark).toHaveText('')
      await expect(mark).toHaveAttribute('title', LABELS[lang][index])
      await expect(mark).toHaveAttribute('aria-label', LABELS[lang][index])
      await expect(mark.locator('svg')).toHaveCount(1)
      await expect(mark.locator('svg')).toHaveAttribute('width', '13')
      await expect(mark.locator('svg')).toHaveAttribute('height', '13')
      expect(await rows.nth(index).evaluate((el) => getComputedStyle(el).opacity)).toBe('1')
    }
    const color = (state: string) =>
      page.locator(`.docker-state-mark.${state}`).evaluate((el) => getComputedStyle(el).color)
    expect(await color('paused')).toBe(await color('restarting'))
    expect(await color('paused')).not.toBe(await color('exited'))
    expect(await color('running')).not.toBe(await color('exited'))
  })

  for (const width of [240, 260]) {
    test(`header and compact rows fit ${width}px with 15px ${lang} UI type`, async ({ page }) => {
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text())
      })
      await boot(page, lang, width)
      const column = page.locator('.sidebar-container.mode-panel')
      expect(await column.evaluate((el) => el.getBoundingClientRect().width)).toBeCloseTo(width, 0)
      const head = sectionHead(page, 'Docker')
      await expect(head.locator('.docker-view-btn')).toHaveText(
        lang === 'en' ? ['Containers', 'Images'] : ['容器', '镜像'],
      )
      const clippedLabels = async () =>
        head
          .locator('.panel-title, .docker-view-btn, .docker-filter-toggle')
          .evaluateAll((els) =>
            els.filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent),
          )
      expect(await clippedLabels()).toEqual([])
      const geometry = await apiRow(page).evaluate((el) => {
        const info = el.querySelector('.docker-info')!
        const name = el.querySelector('.docker-name')!
        const image = el.querySelector('.docker-image')!
        const id = el.querySelector('.docker-id')!
        const mark = el.querySelector('.docker-state-mark')!
        return {
          rowWidth: el.clientWidth,
          rowScroll: el.scrollWidth,
          infoWidth: info.getBoundingClientRect().width,
          nameWidth: name.getBoundingClientRect().width,
          imageWidth: image.getBoundingClientRect().width,
          idRight: id.getBoundingClientRect().right,
          infoRight: info.getBoundingClientRect().right,
          markWidth: mark.getBoundingClientRect().width,
          idClipped: id.scrollWidth > id.clientWidth + 1,
          nameFont: getComputedStyle(name).fontSize,
          idFont: getComputedStyle(id).fontSize,
        }
      })
      expect(geometry.rowScroll).toBeLessThanOrEqual(geometry.rowWidth + 1)
      expect(geometry.infoWidth).toBeGreaterThan(130)
      expect(geometry.nameWidth).toBeCloseTo(geometry.infoWidth, 0)
      expect(geometry.imageWidth).toBeGreaterThan(20)
      expect(geometry.idRight).toBeLessThanOrEqual(geometry.infoRight + 1)
      expect(geometry.idClipped).toBe(false)
      expect(geometry.markWidth).toBe(13)
      expect(parseFloat(geometry.nameFont)).toBeCloseTo(14.5, 0)
      expect(parseFloat(geometry.idFont)).toBeCloseTo(13.5, 0)
      await page.screenshot({ path: test.info().outputPath('containers.png') })

      await head.locator('.docker-view-btn').nth(1).click()
      await expect(page.locator('.docker-item.image')).toHaveCount(1)
      expect(await clippedLabels()).toEqual([])
      const imageGeometry = await page.locator('.docker-item.image').evaluate((el) => ({
        rowClipped: el.scrollWidth > el.clientWidth + 1,
        fieldsClipped: [...el.querySelectorAll('.docker-id, .docker-size, .docker-age')]
          .filter((field) => field.scrollWidth > field.clientWidth + 1)
          .map((field) => field.className),
      }))
      expect(imageGeometry).toEqual({ rowClipped: false, fieldsClipped: [] })
      await page.screenshot({ path: test.info().outputPath('images.png') })
      expect(errors).toEqual([])
    })
  }
}

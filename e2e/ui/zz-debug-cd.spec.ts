import { test, expect, type Page } from './helpers/fixtures'
import { installTauriMock, invokedCalls } from './helpers/tauriMock'

const BASH_ENTRY = { id: 'lt-bash', name: 'Bash', cwd: '/var/www', shell: 'bash' }
const FILES: Record<string, unknown[]> = {
  '/var/www': Array.from({ length: 12 }, (_, i) => ({
    name: `dir-${String(i).padStart(2, '0')}`,
    path: `/var/www/dir-${String(i).padStart(2, '0')}`,
    isDir: true,
    size: 0,
    mode: 'd',
    modified: 0,
  })),
}

test('measure panel geometry', async ({ page }: { page: Page }) => {
  page.on('console', (m) => {
    if (m.text().startsWith('[cdpanel]')) console.log(m.text())
  })
  await installTauriMock(page, {
    localTerminals: [BASH_ENTRY],
    pollOutputChunks: [['user@host:~$ ']],
    filesByDir: FILES,
  })
  await page.goto('/')
  await page.locator('.conn-item.local-term-item').filter({ hasText: 'Bash' }).click()
  await page.waitForSelector('.xterm-helper-textarea', { state: 'attached' })
  await expect
    .poll(async () => (await invokedCalls(page)).filter((c) => c.cmd === 'open_local_shell').length)
    .toBeGreaterThanOrEqual(1)
  await page.waitForTimeout(400)
  await page.locator('.xterm-screen').click()
  await page.keyboard.type('cd ', { delay: 60 })
  await expect(page.locator('.term-cd-suggest')).toBeVisible()
  await page.waitForTimeout(500)
  const info = await page.evaluate(() => {
    const el = document.querySelector('.term-cd-suggest') as HTMLElement
    if (!el) return null
    const list = el.querySelector('.term-cd-suggest-list') as HTMLElement
    const rows = el.querySelectorAll('.term-cd-suggest-row')
    const first = rows[0] as HTMLElement | undefined
    const cs = getComputedStyle(el)
    return {
      panelH: el.getBoundingClientRect().height,
      inlineMaxH: el.style.maxHeight,
      computedMaxH: cs.maxHeight,
      listH: list?.getBoundingClientRect().height,
      listScrollH: list?.scrollHeight,
      listScrollTop: list?.scrollTop,
      rowCount: rows.length,
      firstRowH: first?.getBoundingClientRect().height,
      hintH: (el.querySelector('.term-cd-suggest-hint') as HTMLElement)?.getBoundingClientRect()
        .height,
      top: el.style.top,
      vh: window.innerHeight,
    }
  })
  console.log('GEOMETRY', JSON.stringify(info, null, 1))
})

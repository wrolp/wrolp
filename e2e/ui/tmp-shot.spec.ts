import { test } from './helpers/fixtures'
import { installTauriMock } from './helpers/tauriMock'

const DEMO_CONN = { id: 'c1', name: 'Demo', host: 'demo.local', port: 22, username: 'root' }
const SNIPPETS = [
  { id: 's1', command: 'git status -sb', alias: 'short status', hidden: false, connectionId: null, description: null },
  { id: 's2', command: 'git stash push -m wip', alias: null, hidden: false, connectionId: null, description: null },
]

test('shot', async ({ page }) => {
  await installTauriMock(page, {
    connections: [DEMO_CONN],
    commandSnippets: SNIPPETS,
    commandSets: [{ id: 's1', name: 'daily', connectionId: null, commands: ['git switch main'] }],
  })
  await page.goto('/')
  await page.locator('.connection-item').first().click()
  await page.locator('.xterm-rows').waitFor()
  await page.keyboard.press('Control+Shift+P')
  await page.locator('.cmd-list-search').waitFor()
  await page.waitForTimeout(500)
  const info = await page.evaluate(() => {
    const box = document.querySelector('.cmd-list-search')!
    const input = box.querySelector('input')!
    const sw = box.querySelector('.cmd-list-mode-switch')!
    const pick = (el: Element) => {
      const c = getComputedStyle(el)
      return { outline: `${c.outlineWidth} ${c.outlineStyle} ${c.outlineColor}`, border: c.border }
    }
    return {
      wrapper: pick(box),
      input: pick(input),
      modeSwitch: pick(sw),
      inputMatchesFocusVisible: input.matches(':focus-visible'),
    }
  })
  console.log(JSON.stringify(info, null, 2))
  await page.locator('.cmd-list-search').screenshot({ path: 'test-results/cmd-search-border.png' })
})

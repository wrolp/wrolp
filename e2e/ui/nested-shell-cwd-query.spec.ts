import { test, expect, type Page } from './helpers/fixtures'
import { installTauriMock, invokedCalls } from './helpers/tauriMock'

// B60: inside a nested shell (`docker exec -it … sh`) every `ls` used to inject
// the hidden `pwd` query. A container prompt (`sh-5.0# `) is printed without a
// leading CR, so the query's stripped result left its old prompt on screen and
// the next prompt concatenated onto it — `sh-5.0# sh-5.0#`.
//
// The fixes: reuse the container-side cwd once a query answered (no query per
// listing), and turn the stripped result's line break into a CR so the next
// prompt overwrites the old one.

const DEMO_CONN = { id: 'c1', name: 'Demo', host: 'demo.local', port: 22, username: 'root' }
const HOST_PROMPT = 'root@demo:~$ '
const CONTAINER_PROMPT = 'sh-5.0# '

/** A host shell that enters a container on `docker exec`, echoes typed input,
 *  answers `ls`, and answers the app's hidden `pwd` query the way a real
 *  container sh does (echo + result + a prompt WITHOUT a leading CR). */
async function installNestedShell(page: Page) {
  await page.evaluate(
    ({ hostPrompt, containerPrompt }) => {
      const internals = (
        window as unknown as {
          __TAURI_INTERNALS__: {
            invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
          }
        }
      ).__TAURI_INTERNALS__
      const orig = internals.invoke.bind(internals)
      const pending: string[] = []
      let line = ''
      let inContainer = false
      const prompt = () => (inContainer ? containerPrompt : hostPrompt)

      internals.invoke = async (cmd: string, args: Record<string, unknown> = {}) => {
        if (cmd === 'send_input') {
          const data = String(args.data ?? '')
          const clean = data.replace(/\x1b\[20[01]~/g, '').replace(/\x16/g, '')
          if (/\$\(pwd\)/.test(clean)) {
            const beg = /__WROLP_CWD_BEG_\w+__/.exec(clean)?.[0] ?? ''
            const end = /__WROLP_CWD_END_\w+__/.exec(clean)?.[0] ?? ''
            const echoed = clean.replace(/[\r\n]/g, '')
            // No `\r` before the new prompt: exactly what exposed the duplicate.
            pending.push(`${echoed}\r\n${beg}/app${end}\r\n${containerPrompt}`)
          } else if (/[\r\n]/.test(clean)) {
            const submitted = line.trim()
            line = ''
            if (/^docker\s+exec\b/.test(submitted)) inContainer = true
            pending.push('\r\n')
            if (submitted === 'ls') pending.push('app\r\n')
            pending.push(prompt())
          } else {
            line += clean
            if (clean) pending.push(clean)
          }
        }
        const res = await orig(cmd, args)
        if (cmd === 'poll_output') return [...(res as string[]), ...pending.splice(0)]
        return res
      }
    },
    { hostPrompt: HOST_PROMPT, containerPrompt: CONTAINER_PROMPT },
  )
}

const queries = async (page: Page) =>
  (await invokedCalls(page)).filter(
    (c) => c.cmd === 'send_input' && String(c.args.data ?? '').includes('__WROLP_CWD_BEG_'),
  ).length

test('a nested container shell gets one prompt per line and one cwd query', async ({ page }) => {
  await installTauriMock(page, { connections: [DEMO_CONN], pollOutputChunks: [[HOST_PROMPT]] })
  await page.goto('/')
  await installNestedShell(page)
  await page.locator('.connection-item').first().click()
  await expect(page.locator('.xterm-rows')).toContainText('root@demo')
  await page.locator('.xterm-screen').click()

  await page.keyboard.type('docker exec -it demo sh')
  await page.keyboard.press('Enter')
  await expect(page.locator('.xterm-rows')).toContainText('sh-5.0#')

  await page.keyboard.type('ls')
  await page.keyboard.press('Enter')
  await expect.poll(() => queries(page)).toBe(1)
  await expect(page.locator('.xterm-rows')).toContainText('app')

  // The hidden query's echo and result are gone, and its prompt did not stack.
  const text = await page.locator('.xterm-rows').innerText()
  expect(text).not.toMatch(/sh-5\.0#\s+sh-5\.0#/)
  expect(text).not.toContain('__WROLP_CWD_')

  // A second listing reuses the container-side cwd: no second hidden query.
  await page.keyboard.type('ls')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(500)
  expect(await queries(page)).toBe(1)
  const after = await page.locator('.xterm-rows').innerText()
  expect(after).not.toMatch(/sh-5\.0#\s+sh-5\.0#/)
})

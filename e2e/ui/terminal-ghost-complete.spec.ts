/**
 * Ghost command completion in a live terminal.
 *
 * The grey tail after the caret and the list Tab opens are both driven from the
 * projected input line (buffer + what this keystroke has not echoed yet), and
 * every accept is bytes the user could have typed themselves — so the assertions
 * here are about the payloads reaching the shell: a tail with no Enter in it, and
 * a key that reaches the shell untouched whenever nothing is on offer.
 *
 * The mock IPC has no shell, so `installEchoingShell` echoes `send_input` back
 * through `poll_output` the way a PTY would.
 */
import { test, expect, type Page } from './helpers/fixtures'
import { installTauriMock, invokedCalls, emitTauriEvent } from './helpers/tauriMock'

const DEMO_CONN = { id: 'c1', name: 'Demo', host: 'demo.local', port: 22, username: 'root' }
const PROMPT = '[root@sip ~]# '

/** The library the candidates come from: two snippets and one command set. */
const SNIPPETS = [
  {
    id: 's1',
    command: 'git status -sb',
    alias: 'short status',
    hidden: false,
    connectionId: null,
    description: null,
  },
  {
    id: 's2',
    command: 'git stash push -m wip',
    alias: null,
    hidden: false,
    connectionId: null,
    description: null,
  },
]
const SETS = [{ id: 'set1', name: 'daily', connectionId: null, commands: ['git switch main'] }]

const ghost = (page: Page) => page.locator('.term-ghost')
const rows = (page: Page) => page.locator('.term-ghost-suggest-row')

const sentInput = async (page: Page) =>
  (await invokedCalls(page)).filter((c) => c.cmd === 'send_input').map((c) => String(c.args.data))

/** The rendered HTML of the row holding `needle` — for "was this line coloured". */
const rowHtml = (page: Page, needle: string) =>
  page.locator('.xterm-rows > div', { hasText: needle }).last().innerHTML()

/** The last row that holds any text — the input line, however many blank rows sit under it. */
const renderedLine = (page: Page) =>
  page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.xterm-rows > div'))
    for (let i = rows.length - 1; i >= 0; i--) {
      const text = (rows[i].textContent ?? '').replace(/\s+$/, '')
      if (text) return text
    }
    return ''
  })

/**
 * Right edge of the `idx`-th glyph on the row holding `needle`, measured off the
 * rendered DOM (a Range over one character), so the ghost's position can be
 * checked against where the text actually ends rather than against the same
 * cell-arithmetic the component used to place it.
 */
const glyphRight = (page: Page, needle: string, idx: number) =>
  page.evaluate(
    ({ text, i }) => {
      const row = Array.from(document.querySelectorAll('.xterm-rows > div')).find((d) =>
        (d.textContent ?? '').includes(text),
      )
      if (!row) return null
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
      let pos = 0
      while (walker.nextNode()) {
        const node = walker.currentNode as Text
        if (node.length && pos + node.length > i) {
          const range = document.createRange()
          range.setStart(node, i - pos)
          range.setEnd(node, i - pos + 1)
          return range.getBoundingClientRect().right
        }
        pos += node.length
      }
      return null
    },
    { text: needle, i: idx },
  )

async function installEchoingShell(page: Page) {
  await page.evaluate((prompt) => {
    const internals = (
      window as unknown as {
        __TAURI_INTERNALS__: {
          invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
        }
      }
    ).__TAURI_INTERNALS__
    const orig = internals.invoke.bind(internals)
    const pending: string[] = []
    internals.invoke = async (cmd: string, args: Record<string, unknown> = {}) => {
      if (cmd === 'send_input') {
        const visible = String(args.data ?? '')
          .replace(/\x1b\[20[01]~/g, '')
          .replace(/\x16/g, '')
          .replace(/[\x00-\x1f\x7f]/g, '')
        pending.push(visible ? visible : '\r\n' + prompt)
      }
      const res = await orig(cmd, args)
      if (cmd === 'poll_output') return [...(res as string[]), ...pending.splice(0)]
      return res
    }
  }, PROMPT)
}

async function installLibrary(page: Page, options: Record<string, unknown> = {}) {
  await installTauriMock(page, {
    connections: [DEMO_CONN],
    pollOutputChunks: [[PROMPT]],
    commandSnippets: SNIPPETS,
    commandSets: SETS,
    ...options,
  })
  await page.goto('/')
}

async function openTerminal(page: Page, options: Record<string, unknown> = {}) {
  await installLibrary(page, options)
  await page.locator('.connection-item').first().click()
  await expect(page.locator('.xterm-rows')).toContainText(PROMPT)
  await installEchoingShell(page)
  await page.locator('.xterm-screen').click()
}

test('typing a prefix paints the likeliest command’s tail in grey', async ({ page }) => {
  await openTerminal(page)
  await page.keyboard.type('git s', { delay: 60 })
  // The curated `git status -sb` outranks the set's `git switch main` and the
  // other snippet, so the tail is exactly what → would type.
  await expect(ghost(page)).toHaveText('tatus -sb')
  await expect(ghost(page)).toBeVisible()
})

test('the tail starts one cell right of the last glyph typed, not on top of it', async ({
  page,
}) => {
  // A keystroke reaches `onData` before the shell's echo reaches the buffer, so the
  // caret the buffer reports is still one behind the text. Anchoring the tail on it
  // painted its first character over the glyph just typed (user-reported, and
  // measured at −8.3px = exactly one cell); the anchor has to be carried forward by
  // the not-yet-echoed tail.
  await openTerminal(page)
  await page.keyboard.type('git s', { delay: 90 })
  await page.waitForTimeout(300)
  const line = `${PROMPT}git s`
  const endsAt = await glyphRight(page, line, line.length - 1)
  const box = await ghost(page).boundingBox()
  expect(endsAt).not.toBeNull()
  expect(box).not.toBeNull()
  expect(box!.x).toBeGreaterThan(endsAt!)
  expect(Math.abs(box!.x - endsAt!)).toBeLessThan(1.5)
})

test('→ walks the tail a space-separated part at a time, End finishes it', async ({ page }) => {
  // The default `word` mode: one command is applied over several presses, so a
  // completion that goes wrong can be stopped where it goes wrong.
  await openTerminal(page)
  await page.keyboard.type('git s', { delay: 60 })
  await expect(ghost(page)).toHaveText('tatus -sb')

  await page.keyboard.press('ArrowRight')
  let bytes = await sentInput(page)
  expect(bytes[bytes.length - 1]).toBe('tatus')
  await expect(page.locator('.xterm-rows')).toContainText(`${PROMPT}git status`)
  // The rest of the tail stays offered, so the walk can carry on or stop.
  await expect(ghost(page)).toHaveText(' -sb')

  await page.keyboard.press('End')
  bytes = await sentInput(page)
  expect(bytes[bytes.length - 1]).toBe(' -sb')
  await expect(page.locator('.xterm-rows')).toContainText(`${PROMPT}git status -sb`)
  await expect(ghost(page)).toHaveText('')

  // Nothing left to apply: the third → is the shell's own cursor move.
  await page.keyboard.press('ArrowRight')
  expect(await sentInput(page)).toContain('\x1b[C')
  // Inserted, never run — no press above put an Enter on the wire.
  expect((await sentInput(page)).filter((b) => b.includes('\r'))).toEqual([])
})

test('the setting hands the whole tail to → and leaves the part for End', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('wrolp-terminal-ghost-accept', 'all'))
  await openTerminal(page)
  await page.keyboard.type('git s', { delay: 60 })
  await expect(ghost(page)).toHaveText('tatus -sb')

  await page.keyboard.press('ArrowRight')
  const bytes = await sentInput(page)
  expect(bytes[bytes.length - 1]).toBe('tatus -sb')
  await expect(page.locator('.xterm-rows')).toContainText(`${PROMPT}git status -sb`)
})

test('the other key is the other half, whichever way the setting is set', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('wrolp-terminal-ghost-accept', 'all'))
  await openTerminal(page)
  await page.keyboard.type('git s', { delay: 60 })

  // `End` takes the nearest part when → takes everything.
  await page.keyboard.press('End')
  const bytes = await sentInput(page)
  expect(bytes[bytes.length - 1]).toBe('tatus')
  await expect(page.locator('.xterm-rows')).toContainText(`${PROMPT}git status`)
})

test('a list pick always puts the whole command on the line', async ({ page }) => {
  // Word mode is about the walk-off-the-tail keys; choosing a row is a decision
  // about a command, so it cannot land half of one.
  await openTerminal(page)
  await page.keyboard.type('git s', { delay: 60 })
  await page.keyboard.press('Tab')
  await rows(page).first().click()
  const bytes = await sentInput(page)
  expect(bytes[bytes.length - 1]).toBe('tatus -sb')
  await expect(page.locator('.xterm-rows')).toContainText(`${PROMPT}git status -sb`)
})

test('Tab opens the list, ↓ picks, Enter inserts without running', async ({ page }) => {
  await openTerminal(page)
  await page.keyboard.type('git s', { delay: 60 })

  await page.keyboard.press('Tab')
  // Each row carries where its command came from, so a pick is not a guess.
  await expect(rows(page)).toHaveText([
    'git status -sbcommand list · short status',
    'git stash push -m wipcommand list',
    'git switch maincommand set · daily',
  ])
  // The part already on the line is marked out from the part a pick would add.
  await expect(rows(page).first().locator('.term-ghost-suggest-typed')).toHaveText('git s')

  await page.keyboard.press('ArrowDown')
  await expect(rows(page).nth(1)).toHaveClass(/is-active/)
  await page.keyboard.press('Enter')

  const bytes = await sentInput(page)
  expect(bytes).toContain('tash push -m wip')
  expect(bytes[bytes.length - 1]).not.toContain('\r')
  await expect(rows(page)).toHaveCount(0)
  await expect(page.locator('.xterm-rows')).toContainText(`${PROMPT}git stash push -m wip`)
})

test('Esc closes the list and hands the next Tab back to the shell', async ({ page }) => {
  await openTerminal(page)
  await page.keyboard.type('git s', { delay: 60 })
  await page.keyboard.press('Tab')
  await expect(rows(page)).toHaveCount(3)

  await page.keyboard.press('Escape')
  await expect(rows(page)).toHaveCount(0)

  await page.keyboard.press('Tab')
  // Nothing is on offer any more, so Tab is the shell's own completion again.
  expect(await sentInput(page)).toContain('\t')
})

/**
 * Echo `local_send_input` the way ConPTY does: repaint the prompt's row with the
 * whole line, erase what is left of the old text, and park the caret after it.
 * Deletions have to be echoed too — a shell that never erased the character the
 * user removed is not the shape the completion has to survive.
 */
async function installConpty(page: Page, prompt: string, partialFlush = false) {
  await page.evaluate(
    ({ p, partial }) => {
      const internals = (
        window as unknown as {
          __TAURI_INTERNALS__: {
            invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
          }
        }
      ).__TAURI_INTERNALS__
      const orig = internals.invoke.bind(internals)
      const pending: string[] = []
      let typed = ''
      const repaint = () => {
        if (partial && typed.length > 12) {
          // ConPTY flushes a row in pieces: the screen holds the head of the line
          // while the rest is still on its way. Half-way through that, the buffer is
          // neither the old line nor the new one.
          const cut = Math.floor(typed.length / 2)
          pending.push(`\x1b[1;${p.length + 1}H${typed.slice(0, cut)}`)
          pending.push(
            `\x1b[1;${p.length + cut + 1}H${typed.slice(cut)}\x1b[K\x1b[1;${p.length + typed.length + 1}H`,
          )
          return
        }
        pending.push(`\x1b[1;${p.length + 1}H${typed}\x1b[K\x1b[1;${p.length + typed.length + 1}H`)
      }
      internals.invoke = async (cmd: string, args: Record<string, unknown> = {}) => {
        if (cmd === 'local_send_input') {
          const data = String(args.data ?? '')
          const deletes = (data.match(/\x7f/g) ?? []).length
          if (deletes) {
            typed = typed.slice(0, Math.max(0, typed.length - deletes))
            repaint()
          }
          const visible = data.replace(/[\x00-\x1f\x7f]/g, '')
          if (visible) {
            typed += visible
            repaint()
          }
        }
        const res = await orig(cmd, args)
        if (cmd === 'poll_output') {
          // Partial mode drains one piece per poll so the mid-repaint state lasts a
          // whole frame; the plain mode delivers the row as one write, the way a
          // fast local echo does — otherwise the buffer falls arbitrarily behind the
          // keystrokes and every projection in the spec is testing a lag that no
          // real shell produces.
          const drained = partial ? pending.splice(0, 1) : pending.splice(0, pending.length)
          return [...(res as string[]), ...drained]
        }
        return res
      }
    },
    { p: prompt, partial: partialFlush },
  )
}

test('a local shell gets it too, through ConPTY’s repaint of the input row', async ({ page }) => {
  // ConPTY re-serializes the SCREEN: each keystroke comes back as an absolute
  // move onto the prompt’s row plus the command text. The tail must survive that
  // shape, because the row it repaints is the one the caret reader looks at.
  const CMD_ENTRY = { id: 'lt-cmd', name: 'Cmd', cwd: '', shell: 'cmd' }
  const WIN_PROMPT = 'D:\\repo>'
  await installLibrary(page, {
    connections: [],
    localTerminals: [CMD_ENTRY],
    pollOutputChunks: [[WIN_PROMPT]],
  })
  await installConpty(page, WIN_PROMPT)
  await page.locator('.conn-item.local-term-item').filter({ hasText: CMD_ENTRY.name }).click()
  await expect(page.locator('.xterm-rows')).toContainText(WIN_PROMPT)
  await page.locator('.xterm-screen').click()

  await page.keyboard.type('git s', { delay: 60 })
  await expect(ghost(page)).toHaveText('tatus -sb')
  await page.keyboard.press('ArrowRight')
  const localSent = async () =>
    (await invokedCalls(page))
      .filter((c) => c.cmd === 'local_send_input')
      .map((c) => String(c.args.data))
  expect((await localSent()).at(-1)).toBe('tatus')
  // End takes the rest even though ConPTY repaints the row behind the caret.
  await page.keyboard.press('End')
  expect((await localSent()).at(-1)).toBe(' -sb')
  await expect(page.locator('.xterm-rows')).toContainText(`${WIN_PROMPT}git status -sb`)
})

test('deleting after an accept leaves no stray tail down the row', async ({ page }) => {
  // What the user saw: apply a long completion, press Backspace, and a lone `-`
  // stayed painted far to the right of the text. An accept injects bytes without a
  // keystroke, so the un-echoed tail the projection carries stops being a suffix of
  // the buffer and never clears — every line projected after it is longer than the
  // screen, and the anchor drifts out by the same amount, once more per press.
  const CMD_ENTRY = { id: 'lt-cmd', name: 'Cmd', cwd: '', shell: 'cmd' }
  const WIN_PROMPT = 'D:\\repo>'
  const LONG = 'python sip_light_control.py --mode dtmf --hold=30'
  await installLibrary(page, {
    connections: [],
    localTerminals: [CMD_ENTRY],
    pollOutputChunks: [[WIN_PROMPT]],
    commandSnippets: [
      { id: 's-long', command: LONG, alias: null, hidden: false, connectionId: null },
    ],
    commandSets: [],
  })
  await installConpty(page, WIN_PROMPT)
  await page.locator('.conn-item.local-term-item').filter({ hasText: CMD_ENTRY.name }).click()
  await expect(page.locator('.xterm-rows')).toContainText(WIN_PROMPT)
  await page.locator('.xterm-screen').click()

  await page.keyboard.type('python s', { delay: 80 })
  await page.waitForTimeout(300)
  await page.keyboard.press('End')
  // No wait: the backspace goes out while the accepted bytes are still on their way
  // back. That is the case the drift needs — the buffer then does not end with the
  // un-echoed tail, so the tail is never reconciled away and every later line is
  // projected longer than the screen.
  await page.keyboard.press('Backspace')
  await page.waitForTimeout(400)
  await expect(page.locator('.xterm-rows')).toContainText(`${WIN_PROMPT}${LONG.slice(0, -1)}`)

  for (let press = 1; press <= 3; press++) {
    if (press > 1) {
      await page.keyboard.press('Backspace')
      await page.waitForTimeout(300)
    }
    const expected = `${WIN_PROMPT}${LONG.slice(0, -press)}`
    // The partial-flush mock paces its pieces, so wait for the row to settle rather
    // than assume one poll did it.
    await expect
      .poll(() => renderedLine(page), { timeout: 5_000, message: `row after backspace ${press}` })
      .toBe(expected)
    const line = expected
    const endsAt = await glyphRight(page, line, line.length - 1)
    const box = await ghost(page).boundingBox()
    expect(endsAt).not.toBeNull()
    expect(box, `the tail after backspace ${press}`).not.toBeNull()
    const tail = await ghost(page).innerText()
    expect(tail, `backspace ${press} must offer the deleted characters again`).not.toBe('')
    expect(Math.abs(box!.x - endsAt!), `backspace ${press}: tail "${tail}"`).toBeLessThan(1.5)
  }
})

test('output that scrolls the view takes a standing tail with it', async ({ page }) => {
  // The overlay is `position: fixed`: it holds its viewport coordinate while the
  // buffer scrolls up under it. A tail left on screen when asynchronous output
  // arrives therefore ends up painted over an unrelated row — a lone glyph that
  // looks like debris the shell never cleared.
  await openTerminal(page)
  await page.keyboard.type('git s', { delay: 60 })
  const before = await ghost(page).boundingBox()
  expect(before).not.toBeNull()
  await expect(ghost(page)).toHaveText('tatus -sb')

  // Unsolicited output, no keystroke: rows scroll and the prompt moves up.
  await page.evaluate(() => {
    const internals = (
      window as unknown as {
        __TAURI_INTERNALS__: {
          invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
        }
      }
    ).__TAURI_INTERNALS__
    const orig = internals.invoke.bind(internals)
    const rows = Array.from({ length: 40 }, (_, i) => `noise ${i}\r\n`).join('')
    internals.invoke = async (cmd: string, args: Record<string, unknown> = {}) => {
      const res = await orig(cmd, args)
      if (cmd === 'poll_output') return [...(res as string[]), rows]
      return res
    }
  })
  await page.waitForTimeout(400)

  // Either gone, or still hugging the text it belongs to — never stranded.
  await expect(ghost(page)).toHaveText('')
})

test('Enter submits what was typed, never the standing suggestion', async ({ page }) => {
  // A grey tail is an offer, not a decision. With the candidate list closed, Enter
  // belongs to the shell: swallowing it to insert the completion turned "run this"
  // into "type more", and the command never reached the shell at all.
  await openTerminal(page)
  await page.keyboard.type('git s', { delay: 40 })
  await expect(ghost(page)).toHaveText('tatus -sb')

  await page.keyboard.press('Enter')
  const bytes = await sentInput(page)
  expect(bytes).toContain('\r')
  expect(bytes[bytes.length - 1]).toBe('\r')
  // The suggestion stayed out of the submitted line.
  expect(bytes).not.toContain('tatus -sb')
  await expect(page.locator('.xterm-rows')).toContainText(`${PROMPT}git s`)
  await expect(ghost(page)).toHaveText('')
})

test('a write that lands on the same row cannot retire the tail', async ({ page }) => {
  // The refresh may only give up when the caret leaves the row the tail was placed
  // on. Inferring "the line is gone" from the row's *content* is wrong: a write that
  // rewrites the input line in place (the shell's own redraw, our input recolor) can
  // leave the row reading as neither a prefix nor an extension of what we matched,
  // and the completion then appears for a beat and disappears.
  await openTerminal(page)
  await page.keyboard.type('git s', { delay: 40 })
  await expect(ghost(page)).toHaveText('tatus -sb')

  await page.evaluate(() => {
    const internals = (
      window as unknown as {
        __TAURI_INTERNALS__: {
          invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
        }
      }
    ).__TAURI_INTERNALS__
    const orig = internals.invoke.bind(internals)
    internals.invoke = async (cmd: string, args: Record<string, unknown> = {}) => {
      const res = await orig(cmd, args)
      if (cmd === 'poll_output') {
        // The first byte of an in-place rewrite: the caret drops to column 0 while
        // the row still holds the whole line, so there is content to the right of it
        // and the input line cannot be read at all this instant.
        return [...(res as string[]), '\r']
      }
      return res
    }
  })
  await page.waitForTimeout(400)
  await expect(ghost(page)).toHaveText('tatus -sb')
})

test('a tail left standing while the user pauses stays where the text ended up', async ({
  page,
}) => {
  // The shape of the user's screenshot: apply a word, then stop and look. Nothing
  // is typed any more, so no keystroke re-places the tail — and ConPTY flushed the
  // row in pieces, so the position computed at the press was measured against a
  // caret that was still mid-move. Only watching the caret itself catches up with
  // the text.
  const CMD_ENTRY = { id: 'lt-cmd', name: 'Cmd', cwd: '', shell: 'cmd' }
  const WIN_PROMPT = 'D:\\repo>'
  await installLibrary(page, {
    connections: [],
    localTerminals: [CMD_ENTRY],
    pollOutputChunks: [[WIN_PROMPT]],
  })
  await installConpty(page, WIN_PROMPT, true)
  await page.locator('.conn-item.local-term-item').filter({ hasText: CMD_ENTRY.name }).click()
  await expect(page.locator('.xterm-rows')).toContainText(WIN_PROMPT)
  await page.locator('.xterm-screen').click()

  await page.keyboard.type('git s', { delay: 60 })
  await page.keyboard.press('ArrowRight')
  // Several polls, no keys: the row finishes flushing and the caret lands.
  await page.waitForTimeout(700)
  const line = await renderedLine(page)
  expect(line).toBe(`${WIN_PROMPT}git status`)
  const endsAt = await glyphRight(page, line, line.length - 1)
  const box = await ghost(page).boundingBox()
  expect(endsAt).not.toBeNull()
  expect(box, 'the tail should still be showing').not.toBeNull()
  expect(await ghost(page).innerText()).toBe(' -sb')
  expect(Math.abs(box!.x - endsAt!)).toBeLessThan(1.5)
})

test('a partial accept leaves the tail glued to the text, not adrift to its right', async ({
  page,
}) => {
  // The drift the user saw: each → pushed the tail another cell or two further
  // right, because the accept counted the already-echoed characters it had just
  // typed as "still on the way" on top of the bytes it injected. The deficit has
  // to be measured off the buffer, so this holds after one press and after three.
  await openTerminal(page, {
    commandSnippets: [
      {
        id: 's-long',
        command: 'git status -sb --porcelain',
        alias: null,
        hidden: false,
        connectionId: null,
      },
    ],
  })
  await page.keyboard.type('git s', { delay: 60 })
  for (let press = 1; press <= 3; press++) {
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(300)
    const tail = await ghost(page).innerText()
    if (!tail) {
      // Only the third press can leave nothing: the command is complete.
      expect(press, `the walk ended early, on press ${press}`).toBe(3)
      break
    }
    const line = await renderedLine(page)
    const endsAt = await glyphRight(page, line, line.length - 1)
    const box = await ghost(page).boundingBox()
    expect(endsAt, `the row after press ${press}`).not.toBeNull()
    expect(box, `the tail after press ${press}`).not.toBeNull()
    // Measured against where the echoed text ends, not against the cell arithmetic
    // that placed it — a drift of even one cell is a whole character of gap here.
    expect(Math.abs(box!.x - endsAt!), `press ${press} of ${tail}`).toBeLessThan(1.5)
  }
  await expect(page.locator('.xterm-rows')).toContainText(`${PROMPT}git status -sb --porcelain`)
  await expect(ghost(page)).toHaveText('')
})

test('a trailing space is part of the prefix once its echo has landed', async ({ page }) => {
  await openTerminal(page)
  await page.keyboard.type('git ', { delay: 60 })
  // The pause is the point: before it the line is carried by the not-yet-echoed
  // lag, after it the buffer is what gets read — and the two paths have to agree,
  // because a completion that appears while typing and vanishes the moment the
  // echo catches up is worse than none.
  await page.waitForTimeout(400)
  await page.keyboard.type('s', { delay: 60 })
  await expect(ghost(page)).toHaveText('tatus -sb')
  await page.keyboard.press('End')
  expect(await sentInput(page)).toContain('tatus -sb')
  await expect(page.locator('.xterm-rows')).toContainText(`${PROMPT}git status -sb`)
})

test('a prefix nothing matches takes no key at all', async ({ page }) => {
  await openTerminal(page)
  await page.keyboard.type('zzz', { delay: 60 })
  await expect(ghost(page)).toBeHidden()

  await page.keyboard.press('Tab')
  await page.keyboard.press('ArrowRight')
  const bytes = await sentInput(page)
  expect(bytes).toContain('\t')
  expect(bytes).toContain('\x1b[C')
})

test('a candidate that only differs in case paints no tail, so → stays the shell’s', async ({
  page,
}) => {
  await openTerminal(page, {
    commandSnippets: [{ id: 's9', command: 'GIT LOG', hidden: false, connectionId: null }],
    commandSets: [],
  })
  await page.keyboard.type('git l', { delay: 60 })
  // `git l` + `OG` would leave `git OG` on the line, which is not the command the
  // library holds — so nothing is greyed out.
  await expect(ghost(page)).toHaveText('')
  await page.keyboard.press('ArrowRight')
  expect(await sentInput(page)).toContain('\x1b[C')
})

test('the list still offers a case-different command, and picking rewrites the line', async ({
  page,
}) => {
  await openTerminal(page, {
    commandSnippets: [{ id: 's9', command: 'GIT LOG', hidden: false, connectionId: null }],
    commandSets: [],
  })
  await page.keyboard.type('git l', { delay: 60 })
  await page.keyboard.press('Tab')
  await expect(rows(page)).toHaveText(['GIT LOGcommand list'])
  await page.keyboard.press('Enter')
  // Ctrl-A Ctrl-K clears the line in a POSIX shell first, then the library's own
  // text goes down it — the user's casing cannot be kept.
  expect(await sentInput(page)).toContain('\x01\x0bGIT LOG')
})

test('the switch in Settings takes the whole feature away', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('wrolp-terminal-ghost-suggest', 'false'))
  await openTerminal(page)
  await page.keyboard.type('git s', { delay: 60 })
  await expect(ghost(page)).toBeHidden()

  await page.keyboard.press('Tab')
  expect(await sentInput(page)).toContain('\t')
})

test('a command installed on the device is offered even though it was never run', async ({
  page,
}) => {
  // The whole reason the index exists: a fresh session has no history, and the box
  // has `journalctl` on it. Nothing in the local pools could suggest this one.
  await openTerminal(page, {
    hostCommands: [
      { command: 'journalctl', sources: 'path' },
      { command: 'jobs', sources: 'builtin' },
    ],
  })
  const tabId = Number((await invokedCalls(page)).find((c) => c.cmd === 'connect')!.args.tabId)
  await emitTauriEvent(page, 'host-identified', {
    tabId,
    fingerprint: 'SHA256:journalctljournalctljournalctljournalcn',
    kind: 'ssh',
    host: 'demo.local',
    port: 22,
    username: 'root',
    isNew: false,
    changed: false,
    previousFingerprint: null,
  })
  // The read that follows the identity event is what warms the pool; asserting it
  // keeps "the ghost never appeared" from being mistaken for "the event was lost".
  await expect
    .poll(async () => {
      const cmds = (await invokedCalls(page)).map((c) => c.cmd)
      return cmds.filter((c) => c === 'list_host_commands').length
    })
    .toBeGreaterThanOrEqual(1)

  await page.keyboard.type('journal', { delay: 60 })
  await expect(ghost(page)).toContainText('ctl')

  // → types it; the command only lands on the line, and is never run.
  await page.keyboard.press('ArrowRight')
  await expect(page.locator('.xterm-rows')).toContainText(`${PROMPT}journalctl`)
  expect(await sentInput(page)).not.toContain('\r')
})

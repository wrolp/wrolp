import type { Page } from '@playwright/test'
import type { AiFlowEvent, AiFlowEventDetail, AiPollResult, ToolCallEvent } from '../../src/types'
import { test, expect } from './helpers/fixtures'
import { installTauriMock, invokedCalls } from './helpers/tauriMock'

const profile = {
  id: 'flow-profile',
  name: 'Flow endpoint',
  endpoint: 'https://api.openai.com/v1',
  apiKeyEnc: 'enc-flow-test',
  model: 'flow-model',
  systemPrompt: '',
}

interface FlowMock {
  queue: (AiPollResult | null)[]
  starts: number
  holdStart: boolean
  releaseStart?: () => void
  holdPoll: boolean
  releasePoll?: (reply: AiPollResult) => void
  confirmations: boolean[]
  cancels: string[]
  startError: string | null
  pollError: string | null
  confirmError: string | null
  cancelError: string | null
}

type MockWindow = Window & {
  __AI_FLOW_TEST__: FlowMock
  __TAURI_INTERNALS__: {
    invoke: (cmd: string, args: Record<string, unknown>) => Promise<unknown>
  }
}

function flow(
  seq: number,
  phase: AiFlowEvent['phase'],
  round = 1,
  detail?: AiFlowEventDetail,
): AiFlowEvent {
  return { seq, phase, round, elapsedMs: seq * 25, detail }
}

function tool(id: string, status: ToolCallEvent['status']): ToolCallEvent {
  return { id, name: 'set_ui_settings', arguments: '{"theme":"dark"}', status }
}

const panel = (page: Page) => page.locator('.inspector .ai-chat-panel')
const timeline = (page: Page) => panel(page).locator('.ai-call-flow')

async function setup(page: Page, withTerminal = false) {
  await installTauriMock(page, {
    connections: withTerminal
      ? [{ id: 'flow-connection', name: 'Flow host', host: 'demo.local', port: 22 }]
      : [],
    aiConfig: {
      profiles: [profile, { ...profile, id: 'other-profile', name: 'Other', model: 'other-model' }],
      activeId: profile.id,
      defaultMode: 'command',
      runInTerminal: false,
    },
  })
  await page.goto('/')
  await page.evaluate(() => {
    const w = window as unknown as MockWindow
    const original = w.__TAURI_INTERNALS__.invoke
    const state: FlowMock = {
      queue: [],
      starts: 0,
      holdStart: false,
      holdPoll: false,
      confirmations: [],
      cancels: [],
      startError: null,
      pollError: null,
      confirmError: null,
      cancelError: null,
    }
    w.__AI_FLOW_TEST__ = state
    w.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
      const result = await original(cmd, args)
      if (cmd === 'start_ai_agent') {
        state.starts++
        if (state.startError) throw new Error(state.startError)
        const id = `flow-run-${state.starts}`
        if (state.holdStart) {
          return new Promise<string>((resolve) => {
            state.releaseStart = () => resolve(id)
          })
        }
        return id
      }
      if (cmd === 'poll_ai_chunks') {
        if (state.pollError) throw new Error(state.pollError)
        if (state.holdPoll) {
          return new Promise<AiPollResult>((resolve) => {
            state.releasePoll = resolve
          })
        }
        return state.queue.length ? state.queue.shift() : ['', false, null, [], []]
      }
      if (cmd === 'confirm_ai_tool') {
        state.confirmations.push(Boolean(args.approved))
        if (state.confirmError) throw new Error(state.confirmError)
        return null
      }
      if (cmd === 'cancel_ai_chat') {
        state.cancels.push(String(args.chatId))
        if (state.cancelError) throw new Error(state.cancelError)
        state.queue.push([
          '',
          true,
          null,
          [],
          [{ seq: 999, round: 1, phase: 'cancelled', elapsedMs: 999 }],
        ])
        return null
      }
      return result
    }
  })
  await page.locator('.titlebar-btn.ai-chat-btn').click()
  await expect(panel(page)).toBeVisible()
}

async function enqueue(page: Page, ...replies: (AiPollResult | null)[]) {
  await page.evaluate((values) => {
    ;(window as unknown as MockWindow).__AI_FLOW_TEST__.queue.push(...values)
  }, replies)
}

async function send(page: Page, message = 'Explain the configuration') {
  await panel(page).locator('.ai-chat-input').fill(message)
  await panel(page).locator('.ai-chat-input').press('Enter')
}

test('real events stay with each reply and preserve endpoint snapshots in a narrow panel', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await setup(page)
  await enqueue(page, [
    'First reply',
    true,
    null,
    [],
    [flow(1, 'request'), flow(2, 'response'), flow(3, 'completed')],
  ])
  await send(page)
  await expect(timeline(page)).toHaveAttribute('data-status', 'completed')
  const toggle = timeline(page).locator('.ai-call-flow-toggle')
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await toggle.focus()
  await page.keyboard.press('Enter')
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(timeline(page).locator('li')).toHaveCount(3)
  await expect(timeline(page)).toContainText('Backend elapsed: 75 ms')
  await expect(timeline(page)).toContainText('Global (no terminal)')
  await expect(timeline(page)).toContainText('flow-model')
  await expect(timeline(page)).not.toContainText('enc-flow-test')
  await expect(timeline(page)).not.toContainText(profile.endpoint)
  await page.screenshot({ path: test.info().outputPath('ai-call-flow.png') })
  await expect
    .poll(
      async () =>
        (await invokedCalls(page)).find((call) => call.cmd === 'start_ai_agent')?.args.tabId,
    )
    .toBeNull()

  await panel(page).locator('select').first().selectOption('other-profile')
  await enqueue(page, ['Second reply', true, null, [], [flow(1, 'request'), flow(2, 'completed')]])
  await send(page, 'Another question')
  await expect(timeline(page)).toHaveCount(2)
  await timeline(page).nth(1).locator('.ai-call-flow-toggle').click()
  await expect(timeline(page).nth(0)).toContainText('Flow endpoint')
  await expect(timeline(page).nth(0)).not.toContainText('other-model')
  await expect(timeline(page).nth(1)).toContainText('other-model')
  await expect(panel(page).locator('.ai-chat-msg-assistant')).toHaveCount(2)
  await expect(panel(page).locator('.ai-chat-msg-content')).toContainText([
    'Explain the configuration',
    'First reply',
    'Another question',
    'Second reply',
  ])
  await expect
    .poll(() =>
      timeline(page).evaluateAll((nodes) =>
        nodes.every((node) => node.scrollWidth <= node.clientWidth + 1),
      ),
    )
    .toBe(true)
  expect(errors).toEqual([])
})

test('flow nodes expand to request parameters and the commands they called', async ({ page }) => {
  await setup(page)
  await enqueue(page, [
    'Run done',
    true,
    null,
    [],
    [
      flow(1, 'request', 1, {
        model: 'flow-model',
        messages: 3,
        tools: ['run_command', 'read_file'],
        format: 'nested',
        maxTokens: 4096,
        temperature: 0.7,
      }),
      flow(2, 'response'),
      flow(3, 'tools', 1, {
        calls: [{ name: 'run_command', arguments: '{"command":"ls -la /etc","tabId":1}' }],
      }),
      flow(4, 'confirmation', 1, {
        calls: [{ name: 'run_command', arguments: '{"command":"rm -rf /tmp/cache"}' }],
      }),
      flow(5, 'resume', 2, { approved: false }),
      flow(6, 'completed', 2),
    ],
  ])
  await send(page)
  await expect(timeline(page)).toHaveAttribute('data-status', 'completed')
  await timeline(page).locator('.ai-call-flow-toggle').click()
  await expect(timeline(page).locator('li')).toHaveCount(6)
  await expect(timeline(page).locator('.ai-call-flow-node')).toHaveCount(6)

  const request = timeline(page).locator('li[data-phase="request"]')
  await request.locator('.ai-call-flow-detail-toggle').click()
  await expect(request).toContainText('flow-model')
  await expect(request).toContainText('run_command')
  await expect(request).toContainText('4096')

  const tools = timeline(page).locator('li[data-phase="tools"]')
  await tools.locator('.ai-call-flow-detail-toggle').click()
  await expect(tools.locator('.ai-call-flow-call-command')).toHaveText('ls -la /etc')
  await expect(tools.locator('.ai-call-flow-call-args')).toContainText('"tabId": 1')

  const confirmation = timeline(page).locator('li[data-phase="confirmation"]')
  await expect(confirmation.locator('.ai-call-flow-count')).toHaveText('1')
  await confirmation.locator('.ai-call-flow-detail-toggle').click()
  await expect(confirmation).toContainText('rm -rf /tmp/cache')

  const resume = timeline(page).locator('li[data-phase="resume"]')
  await resume.locator('.ai-call-flow-detail-toggle').click()
  await expect(resume).toContainText('Declined')

  await expect(timeline(page)).not.toContainText('enc-flow-test')
  await expect(timeline(page)).not.toContainText('Bearer')
  await timeline(page).evaluate((node) => node.scrollIntoView({ block: 'start' }))
  await page.screenshot({ path: test.info().outputPath('ai-call-flow-details.png') })
  await expect
    .poll(() =>
      timeline(page)
        .locator('.ai-call-flow-call-args')
        .first()
        .evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
    )
    .toBe(true)
})

test('multiple confirmation batches resume the same reply without losing text or rounds', async ({
  page,
}) => {
  await setup(page)
  await enqueue(page, [
    'Before approval. ',
    false,
    null,
    [tool('one', 'executing'), tool('one', 'needs-confirmation')],
    [flow(1, 'request'), flow(2, 'response'), flow(3, 'tools'), flow(4, 'confirmation')],
  ])
  await send(page)
  await expect(timeline(page)).toHaveAttribute('data-status', 'waiting')
  await panel(page).locator('.ai-tool-confirm-allow').click()
  await enqueue(page, [
    'After approval. ',
    false,
    null,
    [tool('one', 'needs-confirmation'), tool('one', 'done'), tool('two', 'needs-confirmation')],
    [
      flow(5, 'resume'),
      flow(6, 'request', 2),
      flow(7, 'response', 2),
      flow(8, 'tools', 2),
      flow(9, 'confirmation', 2),
    ],
  ])
  await expect(panel(page).locator('.ai-tool-confirm-deny')).toHaveCount(1)
  await panel(page).locator('.ai-tool-confirm-deny').click()
  await enqueue(page, [
    'After denial.',
    true,
    null,
    [tool('two', 'denied')],
    [
      flow(10, 'resume', 2),
      flow(11, 'request', 3),
      flow(12, 'response', 3),
      flow(13, 'completed', 3),
    ],
  ])
  await expect(timeline(page)).toHaveAttribute('data-status', 'completed')
  await expect(panel(page).locator('.ai-chat-msg-assistant')).toHaveCount(1)
  await expect(panel(page).locator('.ai-chat-msg-assistant .ai-chat-msg-content')).toHaveText(
    'Before approval. After approval. After denial.',
  )
  await timeline(page).locator('.ai-call-flow-toggle').click()
  await expect(timeline(page).locator('li')).toHaveCount(13)
  await expect(timeline(page).locator('[data-phase="confirmation"]')).toHaveCount(2)
  await expect(timeline(page)).toContainText('Round 3')
  expect(
    await page.evaluate(() => (window as unknown as MockWindow).__AI_FLOW_TEST__.confirmations),
  ).toEqual([true, false])
  await expect(panel(page).locator('.ai-tool-confirm-actions')).toHaveCount(0)
})

test('a pending poll survives closing and reopening the inspector', async ({ page }) => {
  await setup(page)
  await page.evaluate(() => {
    ;(window as unknown as MockWindow).__AI_FLOW_TEST__.holdPoll = true
  })
  await send(page)
  await expect
    .poll(() =>
      page.evaluate(() => !!(window as unknown as MockWindow).__AI_FLOW_TEST__.releasePoll),
    )
    .toBe(true)
  await page.locator('.titlebar-btn.ai-chat-btn').click()
  await page.evaluate(
    (reply) => {
      const state = (window as unknown as MockWindow).__AI_FLOW_TEST__
      state.holdPoll = false
      state.releasePoll?.(reply)
    },
    [
      'Remount-safe reply',
      true,
      null,
      [],
      [flow(1, 'request'), flow(2, 'completed')],
    ] as AiPollResult,
  )
  await page.locator('.titlebar-btn.ai-chat-btn').click()
  await expect(timeline(page)).toHaveAttribute('data-status', 'completed')
  await expect(panel(page).locator('.ai-chat-msg-assistant')).toHaveCount(1)
  await expect(panel(page)).toContainText('Remount-safe reply')
})

test('stop during submission cancels the eventual backend run without inventing events', async ({
  page,
}) => {
  await setup(page)
  await page.evaluate(() => {
    ;(window as unknown as MockWindow).__AI_FLOW_TEST__.holdStart = true
  })
  await send(page)
  await expect(timeline(page)).toContainText('Submitting')
  await timeline(page).locator('.ai-call-flow-toggle').click()
  await expect(timeline(page).locator('li')).toHaveCount(0)
  await panel(page).locator('.ai-chat-send-btn').click()
  await page.evaluate(() => (window as unknown as MockWindow).__AI_FLOW_TEST__.releaseStart?.())
  await expect(timeline(page)).toHaveAttribute('data-status', 'cancelled')
  await expect(timeline(page)).toContainText('Commands already executed will not be undone')
  expect(
    await page.evaluate(() => (window as unknown as MockWindow).__AI_FLOW_TEST__.cancels),
  ).toEqual(['flow-run-1'])
  await expect(panel(page).locator('.ai-chat-msg-assistant')).toHaveCount(1)
})

test('stop while waiting disables historical confirmation actions', async ({ page }) => {
  await setup(page)
  await enqueue(page, [
    '',
    false,
    null,
    [tool('pending', 'needs-confirmation')],
    [flow(1, 'request'), flow(2, 'confirmation')],
  ])
  await send(page)
  await expect(timeline(page)).toHaveAttribute('data-status', 'waiting')
  await panel(page).locator('.ai-chat-send-btn').click()
  await expect(timeline(page)).toHaveAttribute('data-status', 'cancelled')
  await expect(panel(page).locator('.ai-tool-confirm-actions')).toHaveCount(0)
})

test('closing a terminal waits for AI cancellation and keeps the global draft', async ({
  page,
}) => {
  await setup(page, true)
  await panel(page).locator('.ai-chat-input').fill('Global draft stays here')
  await page.locator('.connection-item').click()
  await page.locator('.term-pane-ai-toggle').click()
  const dock = page.locator('.ai-dock-pane .ai-chat-panel')
  await page.evaluate(() => {
    ;(window as unknown as MockWindow).__AI_FLOW_TEST__.holdStart = true
  })
  await dock.locator('.ai-chat-input').fill('A terminal-bound question')
  await dock.locator('.ai-chat-input').press('Enter')
  await expect(dock.locator('.ai-call-flow')).toContainText('Submitting')
  await page.locator('.tab-item:not(.tab-home) .tab-close').click()
  await expect(page.locator('.tab-item:not(.tab-home)')).toHaveCount(1)
  await page.evaluate(() => (window as unknown as MockWindow).__AI_FLOW_TEST__.releaseStart?.())
  await expect(page.locator('.tab-item:not(.tab-home)')).toHaveCount(0)
  const calls = await invokedCalls(page)
  expect(calls.findIndex((call) => call.cmd === 'cancel_ai_chat')).toBeLessThan(
    calls.findIndex((call) => call.cmd === 'disconnect'),
  )
  expect(calls.find((call) => call.cmd === 'start_ai_agent')?.args.tabId).not.toBeNull()
  await expect(panel(page).locator('.ai-chat-input')).toHaveValue('Global draft stays here')
})

test('a terminal stays open if stopping its AI call fails', async ({ page }) => {
  await setup(page, true)
  await page.locator('.connection-item').click()
  await page.locator('.term-pane-ai-toggle').click()
  const dock = page.locator('.ai-dock-pane .ai-chat-panel')
  await enqueue(page, ['', false, null, [], [flow(1, 'request')]])
  await dock.locator('.ai-chat-input').fill('Keep running')
  await dock.locator('.ai-chat-input').press('Enter')
  await expect(dock.locator('.ai-call-flow')).toContainText('Sending request')
  await page.evaluate(() => {
    ;(window as unknown as MockWindow).__AI_FLOW_TEST__.cancelError = 'IPC stop failed'
  })
  await page.locator('.tab-item:not(.tab-home) .tab-close').click()
  await expect(
    page.getByText('The terminal was not closed because its AI call could not be stopped.', {
      exact: false,
    }),
  ).toBeVisible()
  await expect(page.locator('.tab-item:not(.tab-home)')).toHaveCount(1)
  expect((await invokedCalls(page)).some((call) => call.cmd === 'disconnect')).toBe(false)
  await page.locator('.toast-close').click()
  await page.evaluate(() => {
    ;(window as unknown as MockWindow).__AI_FLOW_TEST__.cancelError = null
  })
  await page.locator('.tab-item:not(.tab-home) .tab-close').click()
  await expect(page.locator('.tab-item:not(.tab-home)')).toHaveCount(0)
})

test('a renewed confirmation for the same tool remains actionable', async ({ page }) => {
  await setup(page)
  await enqueue(page, [
    '',
    false,
    null,
    [tool('again', 'needs-confirmation')],
    [flow(1, 'request'), flow(2, 'confirmation')],
  ])
  await send(page)
  await panel(page).locator('.ai-tool-confirm-allow').click()
  await enqueue(page, [
    '',
    false,
    null,
    [tool('again', 'needs-confirmation')],
    [flow(3, 'resume'), flow(4, 'confirmation')],
  ])
  await expect(panel(page).locator('.ai-tool-confirm-deny')).toBeVisible()
  await panel(page).locator('.ai-tool-confirm-deny').click()
  await enqueue(page, [
    'Denied',
    true,
    null,
    [tool('again', 'denied')],
    [flow(5, 'resume'), flow(6, 'completed')],
  ])
  await expect(timeline(page)).toHaveAttribute('data-status', 'completed')
  expect(
    await page.evaluate(() => (window as unknown as MockWindow).__AI_FLOW_TEST__.confirmations),
  ).toEqual([true, false])
})

for (const scenario of ['start', 'backend', 'missing', 'poll'] as const) {
  test(`a ${scenario} failure is not reported as completed`, async ({ page }) => {
    await setup(page)
    if (scenario === 'start' || scenario === 'poll') {
      await page.evaluate((kind) => {
        const state = (window as unknown as MockWindow).__AI_FLOW_TEST__
        if (kind === 'start') state.startError = 'Cannot start model'
        else state.pollError = 'IPC unavailable'
      }, scenario)
    } else if (scenario === 'backend') {
      await enqueue(page, [
        'Partial answer',
        true,
        'Provider unavailable',
        [],
        [flow(1, 'request'), flow(2, 'error')],
      ])
    } else {
      await enqueue(page, null)
    }
    await send(page)
    await expect(timeline(page)).toHaveAttribute('data-status', 'error')
    await expect(panel(page).locator('.ai-chat-msg-assistant')).toHaveCount(1)
    await expect(panel(page).locator('.ai-chat-error')).toBeVisible()
    await expect(timeline(page)).not.toContainText('Completed')
    await timeline(page).locator('.ai-call-flow-toggle').click()
    await expect(timeline(page).locator('[data-phase="completed"]')).toHaveCount(0)
  })
}

test('confirmation failure can be retried and a cancellation failure remains visible', async ({
  page,
}) => {
  await setup(page)
  await enqueue(page, [
    '',
    false,
    null,
    [tool('pending', 'needs-confirmation')],
    [flow(1, 'request'), flow(2, 'confirmation')],
  ])
  await send(page)
  await page.evaluate(() => {
    const state = (window as unknown as MockWindow).__AI_FLOW_TEST__
    state.confirmError = 'Confirmation unavailable'
    state.cancelError = 'Cancellation unavailable'
  })
  await panel(page).locator('.ai-tool-confirm-allow').click()
  await expect(panel(page).locator('.ai-chat-error')).toContainText('Confirmation unavailable')
  await expect(panel(page).locator('.ai-tool-confirm-allow')).toBeVisible()
  await panel(page).locator('.ai-chat-send-btn').click()
  await expect(panel(page).locator('.ai-chat-error')).toContainText('Cancellation unavailable')
  await expect(timeline(page)).toHaveAttribute('data-status', 'waiting')
  await page.evaluate(() => {
    const state = (window as unknown as MockWindow).__AI_FLOW_TEST__
    state.confirmError = null
    state.cancelError = null
  })
  await panel(page).locator('.ai-tool-confirm-deny').click()
  await enqueue(page, [
    'Continued',
    true,
    null,
    [tool('pending', 'denied')],
    [flow(3, 'resume'), flow(4, 'request', 2), flow(5, 'completed', 2)],
  ])
  await expect(timeline(page)).toHaveAttribute('data-status', 'completed')
  await expect(panel(page).locator('.ai-chat-error')).toHaveCount(0)
})

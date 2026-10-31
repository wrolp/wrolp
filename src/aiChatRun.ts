import { cancelAiChat, confirmAiTool, pollAiChunks, startAiAgent } from './commands'
import type { AiEndpointProfile, AiMessage, AiRunTrace, ToolCallEvent } from './types'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  images?: string[]
  toolCalls?: ToolCallEvent[]
  flow?: AiRunTrace
  error?: string
}

export interface AiConv {
  /** Stable id of the persisted conversation (the session id on disk). */
  sessionId: string
  /** User-visible title; empty = auto-generate from the first user message. */
  sessionTitle: string
  messages: ChatMessage[]
  input: string
  streaming: boolean
  streamingText: string
  error: string | null
  toolCalls: ToolCallEvent[]
  showSuggestions: boolean
  toolCallFormat: 'flat' | 'nested'
  /** Chat mode this conversation is currently in (persisted with the session). */
  mode: 'chat' | 'command' | 'read_only'
  flow: AiRunTrace | null
  run: AiChatRun | null
}

interface AiChatRun {
  start: () => void
  confirm: (approved: boolean) => void
  cancel: () => Promise<void>
}

interface RunRequest {
  messages: AiMessage[]
  tabId: number | null
  profile: AiEndpointProfile
  mode: 'chat' | 'command' | 'read_only'
  maxRounds: number
  toolCallFormat: 'flat' | 'nested'
  interruptedMessage: string
  stopFailedMessage: string
}

// A run outlives panel remounts so a drained poll cannot disappear while docking.
export function createAiChatRun(
  request: RunRequest,
  setConv: (updater: (c: AiConv) => AiConv) => void,
): { run: AiChatRun; trace: AiRunTrace } {
  let trace: AiRunTrace = {
    profileName: request.profile.name,
    model: request.profile.model,
    tabId: request.tabId,
    events: [],
    status: 'running',
  }
  let chatId: string | null = null
  let text = ''
  let tools: ToolCallEvent[] = []
  let finished = false
  let confirming = false
  let cancelRequested = false
  let startPromise: Promise<string> | null = null
  let cancelPromise: Promise<void> | null = null
  let error: string | null = null
  const confirmedIds = new Set<string>()
  let confirmedThroughSeq = 0
  const replyId = crypto.randomUUID()

  const publish = () => {
    const snapshot = trace
    const toolSnapshot = tools
    const content = text
    const runError = error
    const terminal = finished
    setConv((c) => {
      if (c.run !== run) return c
      return {
        ...c,
        streaming: !terminal,
        streamingText: terminal ? '' : content.replace(/^\s+/, ''),
        toolCalls: terminal ? [] : toolSnapshot,
        flow: terminal ? null : snapshot,
        run: terminal ? null : run,
        error: runError,
        messages: terminal
          ? [
              ...c.messages,
              {
                id: replyId,
                role: 'assistant',
                content: content.trim(),
                toolCalls: toolSnapshot,
                flow: snapshot,
                error: runError ?? undefined,
              },
            ]
          : c.messages,
      }
    })
  }

  const fail = (reason: unknown) => {
    if (finished) return
    finished = true
    error = String(reason)
    trace = { ...trace, status: 'error' }
    publish()
  }

  const poll = async () => {
    if (!chatId || finished) return
    try {
      const result = await pollAiChunks(chatId)
      if (finished) return
      if (!result) {
        fail(request.interruptedMessage)
        return
      }
      const [chunk, done, pollError, incomingTools, incomingFlow] = result
      text += chunk
      const byId = new Map(tools.map((tool) => [tool.id, tool]))
      const newConfirmation = incomingFlow.some(
        (event) => event.phase === 'confirmation' && event.seq > confirmedThroughSeq,
      )
      for (const tool of incomingTools) {
        if (tool.status === 'needs-confirmation' && confirmedIds.has(tool.id)) {
          if (!newConfirmation) continue
          confirmedIds.delete(tool.id)
        }
        byId.set(tool.id, tool)
      }
      tools = [...byId.values()]
      const bySeq = new Map(trace.events.map((event) => [event.seq, event]))
      for (const event of incomingFlow) bySeq.set(event.seq, event)
      const events = [...bySeq.values()].sort((a, b) => a.seq - b.seq)
      const phase = events[events.length - 1]?.phase
      const terminal = phase === 'completed' || phase === 'error' || phase === 'cancelled'
      trace = {
        ...trace,
        events,
        status: terminal
          ? phase
          : pollError
            ? 'error'
            : done
              ? 'completed'
              : phase === 'confirmation'
                ? 'waiting'
                : 'running',
      }
      error = pollError || error
      finished = done || !!pollError || terminal
      publish()
      if (!finished) window.setTimeout(() => void poll(), 100)
    } catch (reason) {
      let failure = String(reason)
      try {
        await cancelAiChat(chatId)
      } catch {
        failure += `\n${request.stopFailedMessage}`
      }
      fail(failure)
    }
  }

  const cancel = async () => {
    if (finished) return
    cancelRequested = true
    try {
      if (!chatId && startPromise) chatId = await startPromise
      if (!chatId) return
      cancelPromise ??= cancelAiChat(chatId)
      await cancelPromise
      if (!finished) {
        error = null
        publish()
      }
    } catch (reason) {
      if (!finished) {
        cancelRequested = false
        cancelPromise = null
        error = `${request.stopFailedMessage}\n${String(reason)}`
        publish()
      }
      throw reason
    }
  }

  const confirm = async (approved: boolean) => {
    if (!chatId || finished || confirming || cancelRequested) return
    const pending = tools.filter((tool) => tool.status === 'needs-confirmation')
    if (!pending.length) return
    confirming = true
    confirmedThroughSeq = trace.events[trace.events.length - 1]?.seq ?? 0
    for (const tool of pending) confirmedIds.add(tool.id)
    tools = tools.map((tool) =>
      confirmedIds.has(tool.id) && tool.status === 'needs-confirmation'
        ? { ...tool, status: 'pending' }
        : tool,
    )
    error = null
    publish()
    try {
      await confirmAiTool(chatId, approved, request.mode, request.maxRounds)
    } catch (reason) {
      if (!finished) {
        for (const tool of pending) confirmedIds.delete(tool.id)
        const pendingById = new Map(pending.map((tool) => [tool.id, tool]))
        tools = tools.map((tool) =>
          tool.status === 'pending' ? (pendingById.get(tool.id) ?? tool) : tool,
        )
        error = String(reason)
        publish()
      }
    } finally {
      confirming = false
    }
  }

  const start = async () => {
    try {
      startPromise = startAiAgent(
        request.messages,
        request.tabId,
        request.profile,
        request.mode,
        request.maxRounds,
        request.toolCallFormat,
      )
      chatId = await startPromise
      if (cancelRequested) await cancel().catch(() => {})
      void poll()
    } catch (reason) {
      fail(reason)
    }
  }

  const run: AiChatRun = {
    start: () => void start(),
    confirm: (approved) => void confirm(approved),
    cancel,
  }
  return { run, trace }
}

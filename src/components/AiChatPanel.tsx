import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { AiEndpointProfile, AiMessage, ToolCallEvent } from '../types'
import { startAiAgent, pollAiChunks, listAiModels, confirmAiTool, sendInput } from '../commands'
import { Icon } from './Icon'
import { useI18n } from '../i18n'

// Map markdown elements to our existing chat styles so the look stays
// consistent with the previous (hand-rolled) renderer.
function makeMarkdownComponents(onSendToShell: (text: string) => void) {
  return {
    code(props: { className?: string; children?: React.ReactNode }) {
      const { className, children } = props
      const match = /language-(\w+)/.exec(className || '')
      const code = String(children ?? '')
      // A fenced code block: has a language class, OR its content spans multiple
      // lines (AI often returns ``` without a language tag). In both cases we
      // render the block with a copy button. Single-line ```foo``` or bare
      // backticks are treated as inline code.
      const isBlock = Boolean(match) || code.includes('\n')
      if (isBlock) {
        return (
          <CodeBlock
            lang={match?.[1] ?? ''}
            code={code.replace(/\n$/, '')}
            onSendToShell={onSendToShell}
          />
        )
      }
      return <code className="ai-chat-inline-code">{children}</code>
    },
  }
}

/** Code block with copy and "send to terminal" buttons. */
function CodeBlock({
  lang,
  code,
  onSendToShell,
}: {
  lang: string
  code: string
  onSendToShell?: (text: string) => void
}) {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  const [sent, setSent] = useState(false)
  const handleCopy = useCallback(() => {
    const write = async () => {
      try {
        await navigator.clipboard.writeText(code)
      } catch {
        // Fallback for non-secure contexts / older WebViews.
        const ta = document.createElement('textarea')
        ta.value = code
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
      }
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    }
    write()
  }, [code])

  const handleSend = useCallback(() => {
    if (!onSendToShell) return
    onSendToShell(code)
    setSent(true)
    window.setTimeout(() => setSent(false), 1500)
  }, [code, onSendToShell])

  return (
    <pre className="ai-chat-code-block">
      {lang && <span className="ai-chat-code-lang">{lang}</span>}
      <div className="ai-chat-code-actions">
        {onSendToShell && (
          <button
            className="ai-chat-code-send"
            onClick={handleSend}
            title={t('sendToShell')}
            type="button"
          >
            {sent ? `✓ ${t('sentToShell')}` : '➤'}
          </button>
        )}
        <button
          className="ai-chat-code-copy"
          onClick={handleCopy}
          title={copied ? t('copied') : t('copyMessage')}
          type="button"
        >
          {copied ? '✓' : '⧉'}
        </button>
      </div>
      <code>{code}</code>
    </pre>
  )
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
}

interface AiConv {
  messages: ChatMessage[]
  input: string
  streaming: boolean
  streamingText: string
  error: string | null
  toolCalls: ToolCallEvent[]
  showSuggestions: boolean
}

interface AiChatPanelProps {
  config: AiEndpointProfile
  /** All available endpoint profiles, for the in-panel endpoint switcher. */
  profiles: AiEndpointProfile[]
  /** Switch the active endpoint (persisted by the parent). */
  onSelectProfile: (id: string) => void
  /** Change the model for the current endpoint (persisted by the parent). */
  onSelectModel: (model: string) => void
  tabId: number
  /** Conversation state for this tab, owned by App (per-shell persistence). */
  conv: AiConv
  setConv: (updater: AiConv | ((c: AiConv) => AiConv)) => void
  floating?: boolean
  onToggleFloat?: () => void
  onClose?: () => void
  /** Text to auto-send as initial user message (e.g. terminal selection). */
  initialContext?: string | null
  /** Called when initialContext has been consumed. */
  onContextConsumed?: () => void
}

/** Simple unique-id generator (no external dependency). */
let _msgSeq = 0
function nextId(): string {
  return 'ai-msg-' + Date.now().toString(36) + '-' + (++_msgSeq).toString(36)
}

const TOOL_LABELS: Record<string, { label: string; icon: 'terminal' | 'desktop' | 'folder' | 'file' | 'link' | 'search' }> = {
  run_command: { label: 'Run command', icon: 'terminal' },
  analyze_server: { label: 'Analyze server', icon: 'desktop' },
  list_directory: { label: 'List directory', icon: 'folder' },
  read_file: { label: 'Read file', icon: 'file' },
  list_connections: { label: 'List connections', icon: 'link' },
  search_help: { label: 'Search help', icon: 'search' },
}

const SUGGESTIONS = [
  'Explain this error and how to fix it',
  'Optimize my server performance',
  'Check for security vulnerabilities',
  'Write a backup script',
]

export default function AiChatPanel({
  config,
  profiles,
  onSelectProfile,
  onSelectModel,
  tabId,
  conv,
  setConv,
  floating = false,
  onToggleFloat,
  onClose,
  initialContext,
  onContextConsumed,
}: AiChatPanelProps) {
  const { t } = useI18n()
  const { messages, input, streaming, streamingText, error, toolCalls, showSuggestions } = conv

  // Insert command text into the active shell at the cursor position WITHOUT
  // executing it (no trailing newline). Reuses the same keystroke path as the
  // terminal's own input.
  const handleSendToShell = useCallback(
    (text: string) => {
      const trimmed = text.replace(/\s+$/, '')
      if (trimmed.length === 0) return
      sendInput(tabId, trimmed)
    },
    [tabId],
  )

  // Memoize the markdown component map so unrelated re-renders (e.g. the
  // floating selection toolbar appearing) don't force react-markdown to
  // re-parse and rebuild the DOM — which would wipe the native text selection
  // highlight and make selecting feel sluggish.
  const mdComponents = useMemo(() => makeMarkdownComponents(handleSendToShell), [handleSendToShell])

  // Capture the current text selection within the chat and position a floating
  // "send to terminal" toolbar above it.
  const handleSelectionMouseUp = useCallback(() => {
    const sel = window.getSelection()
    const text = sel?.toString().trim() ?? ''
    const container = messagesRef.current
    if (!sel || !container || text.length === 0) {
      setSelection(null)
      return
    }
    // Ignore selections that start outside the chat messages container.
    let node: Node | null = sel.anchorNode
    let inside = false
    while (node) {
      if (node === container) {
        inside = true
        break
      }
      node = node.parentNode
    }
    if (!inside) {
      setSelection(null)
      return
    }
    const range = sel.getRangeAt(0)
    const rect = range.getBoundingClientRect()
    setSelection({
      text,
      top: rect.top - 8,
      left: rect.left + rect.width / 2,
    })
  }, [])

  const clearSelection = useCallback(() => {
    setSelection(null)
    window.getSelection()?.removeAllRanges()
  }, [])


  // Alias setters that operate on the per-tab conversation object so the rest
  // of the logic (runAgent / handleSend) stays unchanged.
  const setMessages = (u: ChatMessage[] | ((p: ChatMessage[]) => ChatMessage[])) =>
    setConv((c) => ({ ...c, messages: typeof u === 'function' ? u(c.messages) : u }))
  const setInput = (u: string | ((p: string) => string)) =>
    setConv((c) => ({ ...c, input: typeof u === 'function' ? u(c.input) : u }))
  const setStreaming = (u: boolean | ((p: boolean) => boolean)) =>
    setConv((c) => ({ ...c, streaming: typeof u === 'function' ? u(c.streaming) : u }))
  const setStreamingText = (u: string | ((p: string) => string)) =>
    setConv((c) => ({ ...c, streamingText: typeof u === 'function' ? u(c.streamingText) : u }))
  const setError = (u: string | null | ((p: string | null) => string | null)) =>
    setConv((c) => ({ ...c, error: typeof u === 'function' ? u(c.error) : u }))
  const setToolCalls = (u: ToolCallEvent[] | ((p: ToolCallEvent[]) => ToolCallEvent[])) =>
    setConv((c) => ({ ...c, toolCalls: typeof u === 'function' ? u(c.toolCalls) : u }))
  const setShowSuggestions = (u: boolean | ((p: boolean) => boolean)) =>
    setConv((c) => ({ ...c, showSuggestions: typeof u === 'function' ? u(c.showSuggestions) : u }))

  // Active agent chat id (set once a run starts); used to resume after a
  // sensitive-tool confirmation.
  const [chatId, setChatId] = useState<string | null>(null)

  // "Copy whole message" feedback: id of the message currently marked copied.
  const [msgCopied, setMsgCopied] = useState<string | null>(null)
  // Floating toolbar shown when the user selects text inside the chat: the
  // selected text plus its position (relative to the messages container).
  const messagesRef = useRef<HTMLDivElement>(null)
  const [selection, setSelection] = useState<{ text: string; top: number; left: number } | null>(
    null,
  )
  const copyMessage = useCallback((id: string, text: string) => {
    const write = async () => {
      try {
        await navigator.clipboard.writeText(text)
      } catch {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
      }
      setMsgCopied(id)
      window.setTimeout(() => setMsgCopied((cur) => (cur === id ? null : cur)), 1500)
    }
    write()
  }, [])

  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const pollRef = useRef<number>(0)

  // Per-endpoint model list + manual fallback, fetched from /v1/models.
  const [models, setModels] = useState<string[]>([])
  const [modelManual, setModelManual] = useState(false)
  const [fetchingModels, setFetchingModels] = useState(false)

  useEffect(() => {
    let cancelled = false
    setModelManual(false)
    setModels([])
    if (!config?.endpoint) return
    setFetchingModels(true)
    listAiModels(config.apiKeyEnc ?? '', config.endpoint)
      .then((ms) => {
        if (cancelled) return
        setModels(ms)
      })
      .catch(() => {
        if (!cancelled) setModelManual(true)
      })
      .finally(() => {
        if (!cancelled) setFetchingModels(false)
      })
    return () => {
      cancelled = true
    }
  }, [config?.id, config?.endpoint, config?.apiKeyEnc])

  // Auto-scroll to bottom
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streamingText, toolCalls])

  // Merge incoming tool events into the displayed list (by id, latest status wins)
  const mergeToolEvents = useCallback((incoming: ToolCallEvent[]) => {
    if (incoming.length === 0) return
    setToolCalls((prev) => {
      const byId = new Map(prev.map((t) => [t.id, t]))
      for (const ev of incoming) byId.set(ev.id, ev)
      const order = [...prev.map((t) => t.id), ...incoming.map((t) => t.id)]
      const seen = new Set<string>()
      const ordered: ToolCallEvent[] = []
      for (const id of order) {
        if (seen.has(id)) continue
        seen.add(id)
        if (byId.has(id)) ordered.push(byId.get(id)!)
      }
      return ordered
    })
  }, [])

  const finalizeAssistant = useCallback((text: string, err?: string | null) => {
    if (text) {
      setMessages((prev) => [...prev, { id: nextId(), role: 'assistant', content: text }])
    } else if (err) {
      setMessages((prev) => [...prev, { id: nextId(), role: 'assistant', content: 'Error: ' + err }])
    }
  }, [])

  // Poll the backend for streamed chunks until the agent run finishes.
  const startPolling = useCallback((id: string) => {
    let accumulated = ''
    const poll = () => {
      pollAiChunks(id).then((result) => {
        if (result === null) {
          setStreaming(false)
          finalizeAssistant(accumulated)
          return
        }
        const [newText, done, err, events] = result
        if (events && events.length) mergeToolEvents(events)
        if (newText) {
          accumulated += newText
          setStreamingText(accumulated.replace(/^\s+/, ''))
        }
        if (done || err) {
          setStreaming(false)
          finalizeAssistant(accumulated.trim(), err)
          setStreamingText('')
          if (err) setError(err)
          return
        }
        pollRef.current = window.setTimeout(poll, 100)
      }).catch((e) => {
        setStreaming(false)
        setError(String(e))
        finalizeAssistant(accumulated.trim(), String(e))
        setStreamingText('')
      })
    }
    poll()
  }, [finalizeAssistant, mergeToolEvents, setStreaming, setStreamingText, setError])

  // Resume the agent after the user approves/declines a sensitive tool call.
  const confirmAndResume = useCallback(
    (approved: boolean) => {
      if (!chatId) return
      const id = chatId
      // Optimistically clear the confirmation prompt.
      setToolCalls((prev) =>
        prev.map((tc) =>
          tc.status === 'needs-confirmation'
            ? { ...tc, status: approved ? 'executing' : 'denied' }
            : tc,
        ),
      )
      confirmAiTool(id, approved)
        .then(() => startPolling(id))
        .catch((e) => setError(String(e)))
    },
    [chatId, setToolCalls, setError, startPolling],
  )

  const runAgent = useCallback(
    (apiMessages: AiMessage[], userDisplay: string) => {
      setShowSuggestions(false)
      setStreaming(true)
      setStreamingText('')
      setToolCalls([])
      setError(null)
      if (userDisplay) {
        setMessages((prev) => [...prev, { id: nextId(), role: 'user', content: userDisplay }])
      }

      startAiAgent(apiMessages, tabId, config)
        .then((id: string) => {
          setChatId(id)
          startPolling(id)
        })
        .catch((e) => {
          setStreaming(false)
          setError(String(e))
          finalizeAssistant('', String(e))
        })
    },
    [mergeToolEvents, finalizeAssistant, tabId, config],
  )

  const handleSend = useCallback(
    (textOverride?: string) => {
      const text = (textOverride ?? input).trim()
      if (!text || streaming) return
      setInput('')

      const apiMessages: AiMessage[] = [
        { role: 'system' as const, content: config.systemPrompt },
        ...messages.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
        { role: 'user' as const, content: text },
      ]
      runAgent(apiMessages, text)
    },
    [input, streaming, messages, config, runAgent],
  )

  // Auto-send initial context text when provided
  const initialSentRef = useRef(false)
  useEffect(() => {
    if (initialContext && !initialSentRef.current) {
      initialSentRef.current = true
      const askMsg = `Help me with this terminal output:\n\n\`\`\`\n${initialContext}\n\`\`\``
      const apiMessages: AiMessage[] = [
        { role: 'system' as const, content: config.systemPrompt },
        { role: 'user' as const, content: askMsg },
      ]
      runAgent(apiMessages, askMsg)
      if (onContextConsumed) onContextConsumed()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialContext])

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearTimeout(pollRef.current)
    }
  }, [])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleClear = () => {
    if (streaming) return
    setMessages([])
    setError(null)
    setToolCalls([])
    setShowSuggestions(true)
  }

  const hasContent = messages.length > 0 || streaming || toolCalls.length > 0

  return (
    <div className="ai-chat-panel">
      {/* Header */}
      <div className="ai-chat-header">
        <div className="ai-chat-avatar" aria-hidden>
          <Icon name="sparkles" size={16} />
        </div>
        <div className="ai-chat-title-group">
          <span className="ai-chat-title">{t('aiSettingsHeader')}</span>
          <div className="ai-chat-selectors">
            <select
              className="ai-chat-select"
              value={config?.id ?? ''}
              onChange={(e) => onSelectProfile(e.target.value)}
              title={t('selectAiEndpoint')}
            >
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name || p.endpoint}
                </option>
              ))}
            </select>
            {modelManual ? (
              <input
                className="ai-chat-select ai-chat-model-input"
                value={config.model || ''}
                onChange={(e) => onSelectModel(e.target.value)}
                placeholder={t('modelName')}
                title={t('enterModelNameManually')}
              />
            ) : (
              <select
                className="ai-chat-select"
                value={config.model || ''}
                onChange={(e) => onSelectModel(e.target.value)}
                title={t('selectModel')}
                disabled={fetchingModels}
              >
                {fetchingModels && <option value={config.model || ''}>{t('loadingModels')}</option>}
                {models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
                {!fetchingModels && models.length === 0 && (
                  <option value={config.model || ''}>{t('noModelsAvailable')}</option>
                )}
              </select>
            )}
          </div>
        </div>
        {!floating && onToggleFloat && (
          <button
            className="ai-chat-clear-btn"
            onClick={onToggleFloat}
            title={t('aiChatPopOut')}
          >
            <Icon name="externalLink" size={13} />
            {t('aiChatPopOut')}
          </button>
        )}
        {floating && onToggleFloat && (
          <button
            className="ai-chat-clear-btn"
            onClick={onToggleFloat}
            title={t('aiChatDock')}
          >
            <Icon name="minimize" size={13} />
            {t('aiChatDock')}
          </button>
        )}
        {onClose && (
          <button
            className="ai-chat-clear-btn"
            onClick={onClose}
            disabled={streaming}
            title={t('aiChatClose')}
          >
            <Icon name="x" size={13} />
          </button>
        )}
        <button
          className="ai-chat-clear-btn"
          onClick={handleClear}
          disabled={streaming}
          title={t('clear')}
        >
          <Icon name="trash" size={13} />
          Clear
        </button>
      </div>

      {/* Messages */}
      <div
        className="ai-chat-messages"
        ref={messagesRef}
        onMouseUp={handleSelectionMouseUp}
        onScroll={() => setSelection(null)}
      >
        {!hasContent && (
          <div className="ai-chat-empty">
            <div className="ai-chat-empty-icon">
              <Icon name="sparkles" size={32} />
            </div>
            <h3 className="ai-chat-empty-title">{t('aiChatEmptyTitle')}</h3>
            <p className="ai-chat-empty-text">{t('aiChatEmptyText')}</p>
            <p className="ai-chat-empty-hint">
              {t('aiChatEmptyHint').replace('“Ask AI”', '“' + t('aiChatAskAi') + '”')}
            </p>

            {showSuggestions && (
              <div className="ai-chat-suggestions">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    className="ai-chat-suggestion"
                    onClick={() => handleSend(s)}
                    disabled={streaming}
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {messages.map((msg) => (
          <div key={msg.id} className={`ai-chat-msg ai-chat-msg-${msg.role}`}>
            <div className="ai-chat-msg-avatar" aria-hidden>
              {msg.role === 'user' ? <Icon name="user" size={14} /> : <Icon name="sparkles" size={14} />}
            </div>
            <div className="ai-chat-msg-body">
              <div className="ai-chat-msg-role">
                <span>{msg.role === 'user' ? t('aiChatRoleYou') : t('aiChatRoleAi')}</span>
              </div>
              <div className="ai-chat-msg-content">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                  {msg.content}
                </ReactMarkdown>
              </div>
              {msg.role === 'assistant' && !streaming && (
                <button
                  className="ai-chat-msg-copy"
                  type="button"
                  title={msgCopied === msg.id ? t('copied') : t('copyMessage')}
                  onClick={() => copyMessage(msg.id, msg.content)}
                >
                  <Icon name={msgCopied === msg.id ? 'clipboard' : 'copy'} size={12} />
                  {msgCopied === msg.id ? t('copied') : t('copyMessage')}
                </button>
              )}
            </div>
          </div>
        ))}

        {/* Floating toolbar for a text selection inside the chat */}
        {selection && (
          <div
            className="ai-chat-selection-bar"
            style={{
              top: selection.top,
              left: selection.left,
              transform:
                selection.top < 28 ? 'translate(-50%, 8px)' : 'translate(-50%, -100%)',
            }}
            onMouseDown={(e) => e.preventDefault()}
          >
            <button
              type="button"
              className="ai-chat-selection-send"
              title={t('sendToShell')}
              onClick={() => {
                // Prefer the live selection (still highlighted); fall back to the
                // captured text so it works even if the highlight was cleared.
                const live = window.getSelection()?.toString().trim() ?? ''
                handleSendToShell(live.length > 0 ? live : selection.text)
                clearSelection()
              }}
            >
              <Icon name="send" size={12} />
              {t('sendToShell')}
            </button>
          </div>
        )}

        {/* Tool-call cards (during agent loop) */}
        {toolCalls.length > 0 && (
          <div className="ai-tool-calls">
              <div className="ai-tool-calls-label">
                <Icon name="settings" size={12} /> {t('aiChatToolsUsed')}
              </div>
            {toolCalls.map((tc) => (
              <ToolCallCard key={tc.id} tool={tc} onConfirm={confirmAndResume} />
            ))}
          </div>
        )}

        {/* Streaming indicator */}
        {streaming && streamingText && (
          <div className="ai-chat-msg ai-chat-msg-assistant">
            <div className="ai-chat-msg-avatar" aria-hidden>
              <Icon name="sparkles" size={14} />
            </div>
            <div className="ai-chat-msg-body">
              <div className="ai-chat-msg-role">{t('aiChatRoleAi')}</div>
              <div className="ai-chat-msg-content streaming">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                  {streamingText}
                </ReactMarkdown>
                <span className="ai-chat-cursor" />
              </div>
            </div>
          </div>
        )}
        {streaming && !streamingText && toolCalls.length === 0 && (
          <div className="ai-chat-msg ai-chat-msg-assistant">
            <div className="ai-chat-msg-avatar" aria-hidden>
              <Icon name="sparkles" size={14} />
            </div>
              <div className="ai-chat-msg-body">
                <div className="ai-chat-msg-role">{t('aiChatRoleAi')}</div>
                <div className="ai-chat-msg-content">
                  <span className="ai-chat-typing">
                    {t('aiChatThinking')}
                    <span className="ai-chat-cursor" />
                  </span>
                </div>
            </div>
          </div>
        )}

        {error && !streaming && (
          <div className="ai-chat-error">
            <Icon name="x" size={13} /> {error}
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="ai-chat-input-area">
        <div className="ai-chat-input-wrap">
          <textarea
            ref={inputRef}
            className="ai-chat-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('aiChatPlaceholder')}
            rows={1}
            disabled={streaming}
          />
          <button
            className="ai-chat-send-btn"
            onClick={() => handleSend()}
            disabled={streaming || !input.trim()}
            title={t('aiChatSend')}
          >
            {streaming ? <Icon name="pause" size={15} /> : <Icon name="send" size={15} />}
          </button>
        </div>
        <div className="ai-chat-input-hint">{t('aiChatInputHint')}</div>
      </div>
    </div>
  )
}

function ToolCallCard({
  tool,
  onConfirm,
}: {
  tool: ToolCallEvent
  onConfirm: (approved: boolean) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const { t } = useI18n()
  const meta = TOOL_LABELS[tool.name] ?? { label: tool.name, icon: 'terminal' as const }
  const isError = tool.status === 'error' || (tool.result?.includes('"error"') ?? false)
  const isConfirmation = tool.status === 'needs-confirmation'
  const icon =
    tool.status === 'done'
      ? isError
        ? '✗'
        : '✓'
      : tool.status === 'executing'
        ? '⟳'
        : isConfirmation
          ? '⚠'
          : '⚙'

  let summary = meta.label
  try {
    const args = JSON.parse(tool.arguments || '{}')
    const parts = Object.entries(args)
      .filter(([k]) => k !== 'tabId')
      .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    if (parts.length) summary += ` · ${parts.join(', ')}`
    else if (args.tabId !== undefined) summary += ` · tab ${args.tabId}`
  } catch {
    if (tool.arguments) summary += ` · ${tool.arguments}`
  }

  return (
    <div
      className={`ai-tool-card ai-tool-${tool.status}${isError ? ' ai-tool-error' : ''}${
        isConfirmation ? ' ai-tool-confirm' : ''
      }`}
    >
      <div className="ai-tool-head" onClick={() => setExpanded((v) => !v)}>
        <span className="ai-tool-icon">
          <Icon name={meta.icon} size={13} />
        </span>
        <span className="ai-tool-name">{summary}</span>
        <span className="ai-tool-status">
          <span className="ai-tool-spinner">{icon}</span>
          {tool.status}
        </span>
      </div>
      {expanded && (
        <div className="ai-tool-detail">
          {tool.arguments && (
            <div className="ai-tool-detail-block">
              <div className="ai-tool-detail-label">{t('aiToolArgs')}</div>
              <pre className="ai-tool-args">{tool.arguments}</pre>
            </div>
          )}
          {(tool.result || tool.error) && (
            <div className="ai-tool-detail-block">
              <div className="ai-tool-detail-label">{t('aiToolResult')}</div>
              <pre className="ai-tool-result">
                {tool.error ? `Error: ${tool.error}` : tool.result}
              </pre>
            </div>
          )}
        </div>
      )}
      {isConfirmation && (
        <div className="ai-tool-confirm-bar">
          <span className="ai-tool-confirm-text">{t('aiToolConfirm')}</span>
          <div className="ai-tool-confirm-actions">
            <button
              type="button"
              className="ai-tool-confirm-deny"
              onClick={() => onConfirm(false)}
            >
              {t('aiToolDeny')}
            </button>
            <button
              type="button"
              className="ai-tool-confirm-allow"
              onClick={() => onConfirm(true)}
            >
              {t('aiToolAllow')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/** Very simple markdown-ish rendering: code blocks, inline code, bold, italic. */


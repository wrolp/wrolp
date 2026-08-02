import { useState, useRef, useEffect, useCallback } from 'react'
import type { AiEndpointProfile, AiMessage, ToolCallEvent } from '../types'
import { startAiAgent, pollAiChunks, listAiModels } from '../commands'
import { Icon } from './Icon'

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
  const { messages, input, streaming, streamingText, error, toolCalls, showSuggestions } = conv

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
        .then((chatId) => {
          let accumulated = ''
          const poll = () => {
            pollAiChunks(chatId).then((result) => {
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
          <span className="ai-chat-title">AI Assistant</span>
          <div className="ai-chat-selectors">
            <select
              className="ai-chat-select"
              value={config?.id ?? ''}
              onChange={(e) => onSelectProfile(e.target.value)}
              title="Select AI endpoint"
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
                placeholder="Model name"
                title="Enter model name manually"
              />
            ) : (
              <select
                className="ai-chat-select"
                value={config.model || ''}
                onChange={(e) => onSelectModel(e.target.value)}
                title="Select model"
                disabled={fetchingModels}
              >
                {fetchingModels && <option value={config.model || ''}>Loading…</option>}
                {models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
                {!fetchingModels && models.length === 0 && (
                  <option value={config.model || ''}>No models available</option>
                )}
              </select>
            )}
          </div>
        </div>
        {!floating && onToggleFloat && (
          <button
            className="ai-chat-clear-btn"
            onClick={onToggleFloat}
            title="Pop out as floating window"
          >
            <Icon name="externalLink" size={13} />
            Float
          </button>
        )}
        {floating && onToggleFloat && (
          <button
            className="ai-chat-clear-btn"
            onClick={onToggleFloat}
            title="Dock back"
          >
            <Icon name="minimize" size={13} />
            Dock
          </button>
        )}
        {onClose && (
          <button
            className="ai-chat-clear-btn"
            onClick={onClose}
            disabled={streaming}
            title="Close"
          >
            <Icon name="x" size={13} />
          </button>
        )}
        <button
          className="ai-chat-clear-btn"
          onClick={handleClear}
          disabled={streaming}
          title="Clear conversation"
        >
          <Icon name="trash" size={13} />
          Clear
        </button>
      </div>

      {/* Messages */}
      <div className="ai-chat-messages">
        {!hasContent && (
          <div className="ai-chat-empty">
            <div className="ai-chat-empty-icon">
              <Icon name="sparkles" size={32} />
            </div>
            <h3 className="ai-chat-empty-title">How can I help you today?</h3>
            <p className="ai-chat-empty-text">
              I can run read-only tools on your connected servers — execute commands, browse
              files, analyze systems, and look up help — to give you accurate answers.
            </p>
            <p className="ai-chat-empty-hint">
              Tip: select text in the terminal, right-click, and choose <b>Ask AI</b> to send it
              as context.
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
              <div className="ai-chat-msg-role">{msg.role === 'user' ? 'You' : 'AI'}</div>
              <div className="ai-chat-msg-content">
                <MarkdownText text={msg.content} />
              </div>
            </div>
          </div>
        ))}

        {/* Tool-call cards (during agent loop) */}
        {toolCalls.length > 0 && (
          <div className="ai-tool-calls">
            <div className="ai-tool-calls-label">
              <Icon name="settings" size={12} /> Tools used
            </div>
            {toolCalls.map((tc) => (
              <ToolCallCard key={tc.id} tool={tc} />
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
              <div className="ai-chat-msg-role">AI</div>
              <div className="ai-chat-msg-content streaming">
                <MarkdownText text={streamingText} />
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
              <div className="ai-chat-msg-role">AI</div>
              <div className="ai-chat-msg-content">
                <span className="ai-chat-typing">
                  Thinking
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
            placeholder="Message the AI assistant…  (Enter to send, Shift+Enter for newline)"
            rows={1}
            disabled={streaming}
          />
          <button
            className="ai-chat-send-btn"
            onClick={() => handleSend()}
            disabled={streaming || !input.trim()}
            title="Send"
          >
            {streaming ? <Icon name="pause" size={15} /> : <Icon name="send" size={15} />}
          </button>
        </div>
        <div className="ai-chat-input-hint">
          AI can use tools on connected servers. Destructive commands are blocked.
        </div>
      </div>
    </div>
  )
}

function ToolCallCard({ tool }: { tool: ToolCallEvent }) {
  const [expanded, setExpanded] = useState(false)
  const meta = TOOL_LABELS[tool.name] ?? { label: tool.name, icon: 'terminal' as const }
  const isError = tool.status === 'error' || (tool.result?.includes('"error"') ?? false)
  const icon = tool.status === 'done' ? (isError ? '✗' : '✓') : tool.status === 'executing' ? '⟳' : '⚙'

  let summary = meta.label
  try {
    const args = JSON.parse(tool.arguments || '{}')
    const parts = Object.entries(args)
      .filter(([k]) => k !== 'tabId')
      .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    if (parts.length) summary += ` · ${parts.join(', ')}`
    else if (args.tabId !== undefined) summary += ` · tab ${args.tabId}`
  } catch {
    if (tool.arguments) summary += ` · ${tool.arguments.slice(0, 50)}`
  }

  return (
    <div className={`ai-tool-card ai-tool-${tool.status}${isError ? ' ai-tool-error' : ''}`}>
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
      {expanded && (tool.result || tool.error) && (
        <pre className="ai-tool-result">
          {tool.error ? `Error: ${tool.error}` : tool.result}
        </pre>
      )}
    </div>
  )
}

/** Very simple markdown-ish rendering: code blocks, inline code, bold, italic. */
function MarkdownText({ text }: { text: string }) {
  const parts: { type: 'text' | 'code'; content: string; lang?: string }[] = []
  let remaining = text
  const codeBlockRegex = /```(\w*)\n?([\s\S]*?)```/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = codeBlockRegex.exec(remaining)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: 'text', content: remaining.slice(lastIndex, match.index) })
    }
    parts.push({ type: 'code', content: match[2].replace(/\n$/, ''), lang: match[1] || undefined })
    lastIndex = match.index + match[0].length
  }
  if (lastIndex < remaining.length) {
    parts.push({ type: 'text', content: remaining.slice(lastIndex) })
  }

  return (
    <>
      {parts.map((part, i) =>
        part.type === 'code' ? (
          <pre key={i} className="ai-chat-code-block">
            {part.lang && <span className="ai-chat-code-lang">{part.lang}</span>}
            <code>{part.content}</code>
          </pre>
        ) : (
          <span key={i} dangerouslySetInnerHTML={{ __html: renderInlineMarkdown(part.content) }} />
        ),
      )}
    </>
  )
}

function renderInlineMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code class="ai-chat-inline-code">$1</code>')
    .replace(/\n/g, '<br/>')
}

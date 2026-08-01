import { useState, useRef, useEffect, useCallback } from 'react'
import type { AiConfig, AiMessage, ToolCallEvent } from '../types'
import { startAiAgent, pollAiChunks } from '../commands'

interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
}

interface AiChatPanelProps {
  config: AiConfig
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

const TOOL_LABELS: Record<string, string> = {
  run_command: 'Run command',
  analyze_server: 'Analyze server',
  list_directory: 'List directory',
  read_file: 'Read file',
  list_connections: 'List connections',
  search_help: 'Search help',
}

export default function AiChatPanel({ config, initialContext, onContextConsumed }: AiChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [streamingText, setStreamingText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [toolCalls, setToolCalls] = useState<ToolCallEvent[]>([])
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const pollRef = useRef<number>(0)

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
      // Preserve first-seen order
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

  // Run the agent loop (streaming text + tool calls)
  const runAgent = useCallback(
    (apiMessages: AiMessage[], userDisplay: string) => {
      setStreaming(true)
      setStreamingText('')
      setToolCalls([])
      setError(null)
      if (userDisplay) {
        setMessages((prev) => [
          ...prev,
          { id: nextId(), role: 'user', content: userDisplay },
        ])
      }

      startAiAgent(apiMessages)
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
                setStreamingText(accumulated)
              }
              if (done || err) {
                setStreaming(false)
                finalizeAssistant(accumulated, err)
                setStreamingText('')
                if (err) setError(err)
                return
              }
              pollRef.current = window.setTimeout(poll, 100)
            }).catch((e) => {
              setStreaming(false)
              setError(String(e))
              finalizeAssistant(accumulated, String(e))
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
    [mergeToolEvents],
  )

  const finalizeAssistant = useCallback((text: string, err?: string | null) => {
    if (text) {
      setMessages((prev) => [...prev, { id: nextId(), role: 'assistant', content: text }])
    } else if (err) {
      setMessages((prev) => [...prev, { id: nextId(), role: 'assistant', content: 'Error: ' + err }])
    }
  }, [])

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

  const handleSend = useCallback(async () => {
    const text = input.trim()
    if (!text || streaming) return
    setInput('')

    const apiMessages: AiMessage[] = [
      { role: 'system' as const, content: config.systemPrompt },
      ...messages.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      { role: 'user' as const, content: text },
    ]
    runAgent(apiMessages, text)
  }, [input, streaming, messages, config, runAgent])

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
  }

  return (
    <div className="ai-chat-panel">
      {/* Header */}
      <div className="ai-chat-header">
        <span className="ai-chat-title">AI Assistant</span>
        <span className="ai-chat-model">{config.model}</span>
        <button
          className="ai-chat-clear-btn"
          onClick={handleClear}
          disabled={streaming}
          title="Clear conversation"
        >
          Clear
        </button>
      </div>

      {/* Messages */}
      <div className="ai-chat-messages">
        {messages.length === 0 && !streaming && toolCalls.length === 0 && (
          <div className="ai-chat-empty">
            <p>Ask me anything about system administration, commands, debugging, or server management.</p>
            <p>Select text in the terminal, right-click, and choose "Ask AI" to send it as context.</p>
            <p>The assistant can run read-only tools (run commands, list files, analyze servers) when needed.</p>
          </div>
        )}

        {messages.map((msg) => (
          <div key={msg.id} className={`ai-chat-msg ai-chat-msg-${msg.role}`}>
            <div className="ai-chat-msg-role">{msg.role === 'user' ? 'You' : 'AI'}</div>
            <div className="ai-chat-msg-content">
              <MarkdownText text={msg.content} />
            </div>
          </div>
        ))}

        {/* Tool-call cards (during agent loop) */}
        {toolCalls.length > 0 && (
          <div className="ai-tool-calls">
            {toolCalls.map((tc) => (
              <ToolCallCard key={tc.id} tool={tc} />
            ))}
          </div>
        )}

        {/* Streaming indicator */}
        {streaming && streamingText && (
          <div className="ai-chat-msg ai-chat-msg-assistant">
            <div className="ai-chat-msg-role">AI</div>
            <div className="ai-chat-msg-content streaming">
              <MarkdownText text={streamingText} />
              <span className="ai-chat-cursor" />
            </div>
          </div>
        )}
        {streaming && !streamingText && toolCalls.length === 0 && (
          <div className="ai-chat-msg ai-chat-msg-assistant">
            <div className="ai-chat-msg-role">AI</div>
            <div className="ai-chat-msg-content">
              <span className="ai-chat-typing">Thinking<span className="ai-chat-cursor" /></span>
            </div>
          </div>
        )}

        {error && !streaming && (
          <div className="ai-chat-error">Error: {error}</div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="ai-chat-input-area">
        <textarea
          ref={inputRef}
          className="ai-chat-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type a message... (Enter to send, Shift+Enter for newline)"
          rows={2}
          disabled={streaming}
        />
        <button
          className="ai-chat-send-btn"
          onClick={handleSend}
          disabled={streaming || !input.trim()}
        >
          {streaming ? '...' : 'Send'}
        </button>
      </div>
    </div>
  )
}

function ToolCallCard({ tool }: { tool: ToolCallEvent }) {
  const [expanded, setExpanded] = useState(false)
  const label = TOOL_LABELS[tool.name] ?? tool.name
  const isError = tool.status === 'error' || (tool.result?.includes('"error"') ?? false)
  const icon = tool.status === 'done' ? (isError ? '❌' : '✅') : tool.status === 'executing' ? '⏳' : '🔧'

  let summary = label
  try {
    const args = JSON.parse(tool.arguments || '{}')
    const parts = Object.entries(args)
      .filter(([k]) => k !== 'tabId')
      .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    if (parts.length) summary += ` (${parts.join(', ')})`
    else if (args.tabId !== undefined) summary += ` [tab ${args.tabId}]`
  } catch {
    summary += ` ${tool.arguments.slice(0, 60)}`
  }

  return (
    <div className={`ai-tool-card ai-tool-${tool.status}${isError ? ' ai-tool-error' : ''}`}>
      <div className="ai-tool-head" onClick={() => setExpanded((v) => !v)}>
        <span className="ai-tool-icon">{icon}</span>
        <span className="ai-tool-name">{summary}</span>
        <span className="ai-tool-status">{tool.status}</span>
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
  // Split text by code blocks (``` ... ```)
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
  return (
    text
      // Bold: **text**
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      // Italic: *text*
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      // Inline code: `text`
      .replace(/`([^`]+)`/g, '<code class="ai-chat-inline-code">$1</code>')
      // Line breaks
      .replace(/\n/g, '<br/>')
  )
}

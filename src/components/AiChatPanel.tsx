import { useState, useRef, useEffect, useCallback } from 'react'
import type { AiConfig, AiMessage } from '../types'
import { startAiChatStream, pollAiChunks } from '../commands'

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

export default function AiChatPanel({ config, initialContext, onContextConsumed }: AiChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [streamingText, setStreamingText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const pollRef = useRef<number>(0)

  // Auto-scroll to bottom
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streamingText])

  // Auto-send initial context text when provided
  const initialSentRef = useRef(false)
  useEffect(() => {
    if (initialContext && !initialSentRef.current) {
      initialSentRef.current = true
      // Build message and call handleSend logic directly
      const askMsg: ChatMessage = {
        id: nextId(),
        role: 'user',
        content: `Help me with this terminal output:\n\n\`\`\`\n${initialContext}\n\`\`\``,
      }
      setMessages([askMsg])
      setStreaming(true)

      const apiMessages: AiMessage[] = [
        { role: 'system' as const, content: config.systemPrompt },
        { role: 'user' as const, content: askMsg.content },
      ]

      startAiChatStream(apiMessages)
        .then((chatId) => {
          let accumulated = ''
          const poll = () => {
            pollAiChunks(chatId).then((result) => {
              if (result === null) {
                setStreaming(false)
                if (accumulated) {
                  setMessages((prev) => [
                    ...prev,
                    { id: nextId(), role: 'assistant', content: accumulated },
                  ])
                }
                return
              }
              const [newText, done, err] = result
              if (newText) {
                accumulated += newText
                setStreamingText(accumulated)
              }
              if (done || err) {
                setStreaming(false)
                if (accumulated) {
                  setMessages((prev) => [
                    ...prev,
                    { id: nextId(), role: 'assistant', content: accumulated },
                  ])
                }
                if (err) setError(err)
                setStreamingText('')
                return
              }
              pollRef.current = window.setTimeout(poll, 100)
            }).catch((e) => {
              setStreaming(false)
              setError(String(e))
            })
          }
          poll()
        })
        .catch((e) => {
          setStreaming(false)
          setError(String(e))
        })

      if (onContextConsumed) onContextConsumed()
    }
  }, [initialContext])

  const handleSend = useCallback(async () => {
    const text = input.trim()
    if (!text || streaming) return

    const userMsg: ChatMessage = { id: nextId(), role: 'user', content: text }
    setMessages((prev) => [...prev, userMsg])
    setInput('')
    setError(null)
    setStreaming(true)
    setStreamingText('')

    // Build API messages: system prompt + history + current
    const apiMessages: AiMessage[] = [
      { role: 'system' as const, content: config.systemPrompt },
      ...messages.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      { role: 'user' as const, content: text },
    ]

    try {
      const chatId = await startAiChatStream(apiMessages)

      // Poll for streaming chunks
      let accumulated = ''
      const poll = async () => {
        try {
          const result = await pollAiChunks(chatId)
          if (result === null) {
            // Chat already cleaned up
            setStreaming(false)
            if (accumulated) {
              setMessages((prev) => [
                ...prev,
                { id: nextId(), role: 'assistant', content: accumulated },
              ])
            }
            return
          }
          const [newText, done, err] = result
          if (newText) {
            accumulated += newText
            setStreamingText(accumulated)
          }
          if (done || err) {
            setStreaming(false)
            if (err) {
              setError(err)
            }
            if (accumulated) {
              setMessages((prev) => [
                ...prev,
                { id: nextId(), role: 'assistant', content: accumulated },
              ])
            } else if (err && !accumulated) {
              setMessages((prev) => [
                ...prev,
                { id: nextId(), role: 'assistant', content: 'Error: ' + err },
              ])
            }
            setStreamingText('')
            return
          }
          // Continue polling
          pollRef.current = window.setTimeout(poll, 100)
        } catch (e) {
          setStreaming(false)
          setError(String(e))
          setStreamingText('')
        }
      }
      poll()
    } catch (e) {
      setStreaming(false)
      setError(String(e))
      setMessages((prev) => [
        ...prev,
        { id: nextId(), role: 'assistant', content: 'Error: ' + String(e) },
      ])
    }
  }, [input, streaming, messages, config])

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
        {messages.length === 0 && !streaming && (
          <div className="ai-chat-empty">
            <p>Ask me anything about system administration, commands, debugging, or server management.</p>
            <p>Select text in the terminal, right-click, and choose "Ask AI" to send it as context.</p>
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
        {streaming && !streamingText && (
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

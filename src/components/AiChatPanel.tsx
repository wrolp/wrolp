import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { AiEndpointProfile, AiMessage, ToolCallEvent, AiPromptTemplate } from '../types'
import {
  startAiAgent,
  pollAiChunks,
  listAiModels,
  confirmAiTool,
  sendInput,
  listAiPromptTemplates,
  saveAiPromptTemplate,
  deleteAiPromptTemplate,
  listHiddenBuiltinTemplates,
  hideBuiltinTemplate,
  restoreBuiltinTemplate,
} from '../commands'
import { Icon } from './Icon'
import { useI18n } from '../i18n'
import type { TranslationKey } from '../i18n/en'

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
  /** Images attached to a user message (Base64 data URLs), shown in the chat. */
  images?: string[]
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
  config: AiEndpointProfile | null
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
  /** Height (px) of the input area; controlled by the parent for persistence. */
  inputHeight?: number
  /** Called when the user drags the input area resize handle. */
  onInputHeightChange?: (height: number) => void
  /** Open the Settings tab (AI section) — used when no endpoint is configured. */
  onOpenSettings?: () => void
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

// Built-in server-ops prompt templates, grouped and localized. Each item is an
// i18n key whose value doubles as the prompt text sent to the AI. `id` is the
// stable category identifier used by custom templates to join a built-in group.
type SuggestionGroup = { id: string; titleKey: TranslationKey; keys: TranslationKey[] }

export const SUGGESTION_GROUPS: SuggestionGroup[] = [
  {
    id: 'troubleshoot',
    titleKey: 'aiChatSugTroubleshoot',
    keys: ['sugExplainError', 'sugTopProcesses', 'sugDiskUsage', 'sugLogErrors'],
  },
  {
    id: 'security',
    titleKey: 'aiChatSugSecurity',
    keys: ['sugSecurityAudit', 'sugSshHarden', 'sugFirewall'],
  },
  {
    id: 'backup',
    titleKey: 'aiChatSugBackup',
    keys: ['sugBackupScript', 'sugCronPlan'],
  },
  {
    id: 'perf',
    titleKey: 'aiChatSugPerf',
    keys: ['sugPerfTune', 'sugNetworkIssues'],
  },
]

const BUILTIN_GROUP_IDS = new Set(SUGGESTION_GROUPS.map((g) => g.id))

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
  inputHeight,
  onInputHeightChange,
  onOpenSettings,
}: AiChatPanelProps) {
  const { t } = useI18n()
  const { messages, input, streaming, streamingText, error, toolCalls, showSuggestions } = conv

  // Whether a usable AI endpoint is configured (endpoint + model + saved key).
  const configured =
    !!config?.endpoint.trim() && !!config?.model.trim() && !!config?.apiKeyEnc

  // User-defined prompt templates (Plan B) loaded from the backend.
  const [userTemplates, setUserTemplates] = useState<AiPromptTemplate[]>([])
  // Built-in template i18n keys the user has hidden (deleted).
  const [hiddenBuiltins, setHiddenBuiltins] = useState<string[]>([])
  const [showTemplateManager, setShowTemplateManager] = useState(false)

  const loadUserTemplates = useCallback(async () => {
    try {
      setUserTemplates(await listAiPromptTemplates())
    } catch {
      /* ignore */
    }
  }, [])

  const loadHiddenBuiltins = useCallback(async () => {
    try {
      setHiddenBuiltins(await listHiddenBuiltinTemplates())
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => {
    loadUserTemplates()
    loadHiddenBuiltins()
  }, [loadUserTemplates, loadHiddenBuiltins])

  // Template manager state (Plan B)
  const [editingTemplate, setEditingTemplate] = useState<AiPromptTemplate | null>(null)
  const [tmplName, setTmplName] = useState('')
  const [tmplPrompt, setTmplPrompt] = useState('')
  const [tmplCategory, setTmplCategory] = useState('')
  const [tmplCategoryCustom, setTmplCategoryCustom] = useState('')
  const [tmplSaving, setTmplSaving] = useState(false)
  const [tmplFormOpen, setTmplFormOpen] = useState(false)

  // Category <select> value: '' = none, '__custom__' = free-text custom name,
  // otherwise a built-in group id.
  const tmplCatSelectValue = BUILTIN_GROUP_IDS.has(tmplCategory)
    ? tmplCategory
    : tmplCategory.trim().length > 0
      ? '__custom__'
      : ''

  const openNewTemplate = useCallback(() => {
    setEditingTemplate(null)
    setTmplName('')
    setTmplPrompt('')
    setTmplCategory('')
    setTmplCategoryCustom('')
    setTmplFormOpen(true)
    setShowTemplateManager(true)
  }, [])

  const openEditTemplate = useCallback((tpl: AiPromptTemplate) => {
    setEditingTemplate(tpl)
    setTmplName(tpl.name)
    setTmplPrompt(tpl.prompt)
    setTmplCategory(tpl.category ?? '')
    setTmplCategoryCustom(BUILTIN_GROUP_IDS.has((tpl.category ?? '').trim()) ? '' : (tpl.category ?? '').trim())
    setTmplFormOpen(true)
    setShowTemplateManager(true)
  }, [])

  const closeTemplateForm = useCallback(() => {
    setTmplFormOpen(false)
    setEditingTemplate(null)
    setTmplName('')
    setTmplPrompt('')
    setTmplCategory('')
    setTmplCategoryCustom('')
  }, [])

  // Open the manager in list mode (close any open form).
  const openTemplateManager = useCallback(() => {
    closeTemplateForm()
    setShowTemplateManager(true)
  }, [closeTemplateForm])

  const handleTmplCategorySelect = useCallback((value: string) => {
    if (value === '__custom__') {
      setTmplCategory(tmplCategoryCustom.trim() || value)
    } else {
      setTmplCategory(value)
    }
  }, [tmplCategoryCustom])

  const handleSaveTemplate = useCallback(async () => {
    const name = tmplName.trim()
    const prompt = tmplPrompt.trim()
    if (name.length === 0 || prompt.length === 0) return
    // Resolve the final category: custom select → the free-text custom name.
    const category = tmplCatSelectValue === '__custom__' ? tmplCategoryCustom.trim() : tmplCatSelectValue
    setTmplSaving(true)
    try {
      const id = editingTemplate?.id ?? crypto.randomUUID()
      const now = new Date().toISOString()
      await saveAiPromptTemplate({
        id,
        name,
        prompt,
        category,
        createdAt: editingTemplate?.createdAt ?? now,
        updatedAt: now,
      })
      await loadUserTemplates()
      setTmplFormOpen(false)
      setEditingTemplate(null)
      setTmplName('')
      setTmplPrompt('')
      setTmplCategory('')
      setTmplCategoryCustom('')
    } catch {
      // ignore
    } finally {
      setTmplSaving(false)
    }
  }, [tmplName, tmplPrompt, tmplCatSelectValue, tmplCategoryCustom, editingTemplate, loadUserTemplates])

  const handleDeleteTemplate = useCallback(
    async (id: string) => {
      try {
        await deleteAiPromptTemplate(id)
        await loadUserTemplates()
        setTmplFormOpen(false)
        setEditingTemplate(null)
        setTmplName('')
        setTmplPrompt('')
        setTmplCategory('')
      } catch {
        // ignore
      }
    },
    [loadUserTemplates],
  )

  // Hide/restore built-in templates (soft delete: persists the i18n key).
  const handleHideBuiltin = useCallback(
    async (key: string) => {
      try {
        await hideBuiltinTemplate(key)
        await loadHiddenBuiltins()
      } catch {
        // ignore
      }
    },
    [loadHiddenBuiltins],
  )

  const handleRestoreBuiltin = useCallback(
    async (key: string) => {
      try {
        await restoreBuiltinTemplate(key)
        await loadHiddenBuiltins()
      } catch {
        // ignore
      }
    },
    [loadHiddenBuiltins],
  )

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
  const fileInputRef = useRef<HTMLInputElement>(null)
  const pollRef = useRef<number>(0)
  const templatePickerRef = useRef<HTMLDivElement>(null)

  // Pending images selected via the "add image" button (data URLs).
  const [pendingImages, setPendingImages] = useState<string[]>([])
  // Whether the template picker dropdown (next to the image previews) is open.
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false)
  // URL of an image currently shown in the fullscreen lightbox (null = closed).
  const [previewImage, setPreviewImage] = useState<string | null>(null)

  // Close the template picker when clicking outside of it.
  useEffect(() => {
    if (!templatePickerOpen) return
    const onDocClick = (e: MouseEvent) => {
      if (!templatePickerRef.current?.contains(e.target as Node)) {
        setTemplatePickerOpen(false)
      }
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [templatePickerOpen])

  // Close the image lightbox with Escape.
  useEffect(() => {
    if (!previewImage) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPreviewImage(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [previewImage])

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
    (apiMessages: AiMessage[], userDisplay: string, userImages?: string[]) => {
      setShowSuggestions(false)
      setStreaming(true)
      setStreamingText('')
      setToolCalls([])
      setError(null)
      if (userDisplay) {
        setMessages((prev) => [
          ...prev,
          { id: nextId(), role: 'user', content: userDisplay, images: userImages },
        ])
      }

      startAiAgent(apiMessages, tabId, config ?? undefined)
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

  const handleImageSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (files && files.length) {
      const readers = Array.from(files).map(
        (f) =>
          new Promise<string>((resolve, reject) => {
            const reader = new FileReader()
            reader.onload = () => resolve(reader.result as string)
            reader.onerror = reject
            reader.readAsDataURL(f)
          }),
      )
      Promise.all(readers)
        .then((urls) => setPendingImages((prev) => [...prev, ...urls]))
        .catch(() => {})
    }
    e.target.value = ''
  }, [])

  // Fill the input box with text (e.g. a clicked template) instead of sending it,
  // so the user can review/edit before asking.
  const fillInput = useCallback(
    (text: string) => {
      setInput((prev) => {
        const next = prev.trim().length > 0 ? prev + '\n' + text : text
        // Defer until the controlled value has rendered, then move the caret to
        // the end and scroll the textarea to the last line.
        requestAnimationFrame(() => {
          const el = inputRef.current
          if (!el) return
          const pos = el.value.length
          el.focus()
          el.setSelectionRange(pos, pos)
          el.scrollTop = el.scrollHeight
        })
        return next
      })
    },
    [],
  )

  const handleSend = useCallback(
    (textOverride?: string) => {
      // Block sending when no usable AI endpoint is configured; prompt the user
      // to configure it in Settings instead.
      if (!configured) {
        onOpenSettings?.()
        return
      }
      const text = (textOverride ?? input).trim()
      if (!text || streaming) return
      const images = pendingImages.length ? pendingImages : undefined
      setInput('')
      setPendingImages([])

      const apiMessages: AiMessage[] = [
        { role: 'system' as const, content: config.systemPrompt },
        ...messages.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
        { role: 'user' as const, content: text, images },
      ]
      runAgent(apiMessages, text, images)
    },
    [input, streaming, messages, pendingImages, config, configured, onOpenSettings, runAgent],
  )

  // Fill the input box with the initial context text (e.g. terminal selection)
  // instead of auto-sending, so the user can review/edit before asking.
  const initialSentRef = useRef(false)
  useEffect(() => {
    if (initialContext && !initialSentRef.current) {
      initialSentRef.current = true
      const ctxText = `Help me with this terminal output:\n\n\`\`\`\n${initialContext}\n\`\`\``
      setInput(ctxText)
      // Defer focus/caret/scroll until after the controlled value has rendered.
      requestAnimationFrame(() => {
        const el = inputRef.current
        if (!el) return
        const pos = el.value.length
        el.focus()
        el.setSelectionRange(pos, pos)
        el.scrollTop = el.scrollHeight
      })
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

  // Drag-to-resize the input area (controlled by the parent for persistence).
  // When the user has dragged (inputHeight set), it becomes a hard fixed height
  // so the handle can size the input freely; otherwise the area flexes with the panel.
  const inputAreaRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ startY: number; startH: number } | null>(null)
  const onResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const startH = inputAreaRef.current?.offsetHeight ?? inputHeight ?? 120
      dragRef.current = { startY: e.clientY, startH }
      const onMove = (ev: MouseEvent) => {
        if (!dragRef.current) return
        const delta = dragRef.current.startY - ev.clientY
        const next = Math.max(40, Math.min(2000, dragRef.current.startH + delta))
        onInputHeightChange?.(next)
      }
      const onUp = () => {
        dragRef.current = null
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [inputHeight, onInputHeightChange],
  )

  const handleClear = () => {
    if (streaming) return
    setMessages([])
    setError(null)
    setToolCalls([])
    setShowSuggestions(true)
  }

  const hasContent = messages.length > 0 || streaming || toolCalls.length > 0

  // Split user templates by category:
  //  - `category` matching a built-in group id → join that built-in group.
  //  - empty category → the generic "custom" group.
  //  - any other category → its own group titled with the category name.
  const customByBuiltin = useMemo(() => {
    const map = new Map<string, AiPromptTemplate[]>()
    const generic: AiPromptTemplate[] = []
    const otherGroups = new Map<string, AiPromptTemplate[]>()
    for (const tpl of userTemplates) {
      const cat = (tpl.category ?? '').trim()
      if (BUILTIN_GROUP_IDS.has(cat)) {
        const list = map.get(cat) ?? []
        list.push(tpl)
        map.set(cat, list)
      } else if (cat.length === 0) {
        generic.push(tpl)
      } else {
        const list = otherGroups.get(cat) ?? []
        list.push(tpl)
        otherGroups.set(cat, list)
      }
    }
    return { map, generic, otherGroups }
  }, [userTemplates])

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
                value={config?.model || ''}
                onChange={(e) => onSelectModel(e.target.value)}
                placeholder={t('modelName')}
                title={t('enterModelNameManually')}
              />
            ) : (
              <select
                className="ai-chat-select"
                value={config?.model || ''}
                onChange={(e) => onSelectModel(e.target.value)}
                title={t('selectModel')}
                disabled={fetchingModels}
              >
                {fetchingModels && <option value={config?.model || ''}>{t('loadingModels')}</option>}
                {models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
                {!fetchingModels && models.length === 0 && (
                  <option value={config?.model || ''}>{t('noModelsAvailable')}</option>
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
                {SUGGESTION_GROUPS.map((group) => {
                  const visibleKeys = group.keys.filter((key) => !hiddenBuiltins.includes(key))
                  const customInGroup = customByBuiltin.map.get(group.id) ?? []
                  if (visibleKeys.length === 0 && customInGroup.length === 0) return null
                  return (
                    <div className="ai-chat-suggestion-group" key={group.id}>
                      <div className="ai-chat-suggestion-group-title">{t(group.titleKey)}</div>
                      <div className="ai-chat-suggestion-chips">
                        {visibleKeys.map((key) => (
                          <button
                            key={key}
                            className="ai-chat-suggestion"
                            onClick={() => fillInput(t(key))}
                            disabled={streaming}
                          >
                            {t(key)}
                          </button>
                        ))}
                        {customInGroup.map((tpl) => (
                          <button
                            key={tpl.id}
                            className="ai-chat-suggestion ai-chat-suggestion-custom"
                            onClick={() => fillInput(tpl.prompt)}
                            disabled={streaming}
                            title={tpl.prompt}
                          >
                            {tpl.name}
                          </button>
                        ))}
                      </div>
                    </div>
                  )
                })}

                {Array.from(customByBuiltin.otherGroups.entries()).map(([cat, tpls]) => (
                  <div className="ai-chat-suggestion-group" key={cat}>
                    <div className="ai-chat-suggestion-group-title">{cat}</div>
                    <div className="ai-chat-suggestion-chips">
                      {tpls.map((tpl) => (
                        <button
                          key={tpl.id}
                          className="ai-chat-suggestion ai-chat-suggestion-custom"
                          onClick={() => fillInput(tpl.prompt)}
                          disabled={streaming}
                          title={tpl.prompt}
                        >
                          {tpl.name}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}

                {customByBuiltin.generic.length > 0 && (
                  <div className="ai-chat-suggestion-group">
                    <div className="ai-chat-suggestion-group-title">
                      {t('aiChatSugCustom')}
                    </div>
                    <div className="ai-chat-suggestion-chips">
                      {customByBuiltin.generic.map((tpl) => (
                        <button
                          key={tpl.id}
                          className="ai-chat-suggestion ai-chat-suggestion-custom"
                          onClick={() => fillInput(tpl.prompt)}
                          disabled={streaming}
                          title={tpl.prompt}
                        >
                          {tpl.name}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div className="ai-chat-suggestion-manage-row">
                  <button
                    type="button"
                    className="ai-chat-suggestion-manage"
                    onClick={() => openNewTemplate()}
                    disabled={streaming}
                  >
                    <Icon name="plus" size={12} />
                    {t('aiChatSugAdd')}
                  </button>
                  {(userTemplates.length > 0 || hiddenBuiltins.length > 0) && (
                    <button
                      type="button"
                      className="ai-chat-suggestion-manage"
                      onClick={() => openTemplateManager()}
                      disabled={streaming}
                    >
                      <Icon name="edit" size={12} />
                      {t('aiChatSugManage')}
                    </button>
                  )}
                </div>
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
              {msg.images && msg.images.length > 0 && (
                <div className="ai-chat-msg-images">
                  {msg.images.map((url, i) => (
                    <button
                      type="button"
                      className="ai-chat-msg-image-chip"
                      key={i}
                      onClick={() => setPreviewImage(url)}
                      title={t('aiChatViewImage')}
                    >
                      <img src={url} alt="" />
                    </button>
                  ))}
                </div>
              )}
              {!streaming && (
                <button
                  className="ai-chat-msg-copy"
                  type="button"
                  title={msgCopied === msg.id ? t('copied') : t('copyMessage')}
                  onClick={() => copyMessage(msg.id, msg.content)}
                >
                  <Icon name={msgCopied === msg.id ? 'clipboard' : 'copy'} size={12} />
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
      {!configured && (
        <div className="ai-chat-config-warning">
          <span>{t('aiConfigRequired')}</span>
          <button type="button" className="ai-chat-config-warning-btn" onClick={() => onOpenSettings?.()}>
            {t('aiOpenSettings')}
          </button>
        </div>
      )}
      <div
        className="ai-chat-input-area"
        ref={inputAreaRef}
        style={
          inputHeight !== undefined
            ? { height: inputHeight, flex: '0 0 auto' }
            : { flex: '1 1 0' }
        }
      >
        <div
          className="ai-chat-input-resizer"
          onMouseDown={onResizeStart}
          title={t('aiChatResizeInput')}
        />
        <div className="ai-chat-input-wrap">
          {pendingImages.length > 0 && (
            <div className="ai-chat-image-previews">
              {pendingImages.map((url, i) => (
                <div className="ai-chat-image-chip" key={i}>
                  <img src={url} alt="" />
                  <button
                    type="button"
                    className="ai-chat-image-remove"
                    onClick={() => setPendingImages((prev) => prev.filter((_, idx) => idx !== i))}
                    title={t('aiChatRemoveImage')}
                  >
                    <Icon name="x" size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
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
          <div className="ai-chat-input-actions">
            <div className="ai-chat-input-actions-left">
              <button
                type="button"
                className="ai-chat-action-btn"
                onClick={() => fileInputRef.current?.click()}
                disabled={streaming}
                title={t('aiChatAddImage')}
              >
                <Icon name="image" size={16} />
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                style={{ display: 'none' }}
                onChange={handleImageSelect}
              />
              <div className="ai-chat-template-wrap" ref={templatePickerRef}>
              <button
                type="button"
                className="ai-chat-action-btn"
                onClick={() => setTemplatePickerOpen((v) => !v)}
                disabled={streaming}
                title={t('aiChatPickTemplate')}
              >
                <Icon name="sparkles" size={16} />
              </button>
              {templatePickerOpen && (
                <div className="ai-chat-template-dropdown">
                  {SUGGESTION_GROUPS.map((group) => {
                    const visibleKeys = group.keys.filter((key) => !hiddenBuiltins.includes(key))
                    const customInGroup = customByBuiltin.map.get(group.id) ?? []
                    if (visibleKeys.length === 0 && customInGroup.length === 0) return null
                    return (
                      <div className="ai-chat-template-group" key={group.id}>
                        <div className="ai-chat-template-group-title">{t(group.titleKey)}</div>
                        {visibleKeys.map((key) => (
                          <button
                            key={key}
                            type="button"
                            className="ai-chat-template-item"
                            onClick={() => {
                              fillInput(t(key))
                              setTemplatePickerOpen(false)
                            }}
                          >
                            {t(key)}
                          </button>
                        ))}
                        {customInGroup.map((tpl) => (
                          <button
                            key={tpl.id}
                            type="button"
                            className="ai-chat-template-item"
                            title={tpl.prompt}
                            onClick={() => {
                              fillInput(tpl.prompt)
                              setTemplatePickerOpen(false)
                            }}
                          >
                            {tpl.name}
                          </button>
                        ))}
                      </div>
                    )
                  })}
                  {customByBuiltin.generic.length > 0 && (
                    <div className="ai-chat-template-group">
                      <div className="ai-chat-template-group-title">{t('aiChatSugCustom')}</div>
                      {customByBuiltin.generic.map((tpl) => (
                        <button
                          key={tpl.id}
                          type="button"
                          className="ai-chat-template-item"
                          title={tpl.prompt}
                          onClick={() => {
                            fillInput(tpl.prompt)
                            setTemplatePickerOpen(false)
                          }}
                        >
                          {tpl.name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
            </div>
            <button
              className="ai-chat-send-btn"
              onClick={() => handleSend()}
              disabled={streaming || !input.trim() || !configured}
              title={t('aiChatSend')}
            >
              {streaming ? <Icon name="pause" size={15} /> : <Icon name="send" size={15} />}
            </button>
          </div>
        </div>
        <div className="ai-chat-input-hint">{t('aiChatInputHint')}</div>
      </div>

      {/* Template manager modal (Plan B) */}
      {showTemplateManager && (
        <div className="ai-tmpl-overlay" onClick={() => setShowTemplateManager(false)}>
          <div className="ai-tmpl-modal" onClick={(e) => e.stopPropagation()}>
            <div className="ai-tmpl-modal-head">
              <span className="ai-tmpl-modal-title">
                {tmplFormOpen ? (editingTemplate ? t('aiChatSugManage') : t('aiChatSugAdd')) : t('aiChatSugList')}
              </span>
              <button
                type="button"
                className="ai-chat-clear-btn"
                onClick={() => setShowTemplateManager(false)}
                title={t('clear')}
              >
                <Icon name="x" size={13} />
              </button>
            </div>

            {tmplFormOpen ? (
              <div className="ai-tmpl-form">
                <label className="ai-tmpl-field">
                  <span className="ai-tmpl-label">{t('aiChatSugNamePlaceholder')}</span>
                  <input
                    className="ai-tmpl-input"
                    value={tmplName}
                    onChange={(e) => setTmplName(e.target.value)}
                    placeholder={t('aiChatSugNamePlaceholder')}
                  />
                </label>
                <label className="ai-tmpl-field">
                  <span className="ai-tmpl-label">{t('aiChatSugCategory')}</span>
                  <select
                    className="ai-tmpl-input"
                    value={tmplCatSelectValue}
                    onChange={(e) => handleTmplCategorySelect(e.target.value)}
                  >
                    <option value="">{t('aiChatSugCategoryNone')}</option>
                    {SUGGESTION_GROUPS.map((g) => (
                      <option key={g.id} value={g.id}>
                        {t(g.titleKey)}
                      </option>
                    ))}
                    <option value="__custom__">{t('aiChatSugCategoryCustom')}</option>
                  </select>
                </label>
                {tmplCatSelectValue === '__custom__' && (
                  <label className="ai-tmpl-field">
                    <span className="ai-tmpl-label">{t('aiChatSugCategoryCustomPlaceholder')}</span>
                    <input
                      className="ai-tmpl-input"
                      value={tmplCategoryCustom}
                      onChange={(e) => {
                        setTmplCategoryCustom(e.target.value)
                        setTmplCategory(e.target.value.trim() || '__custom__')
                      }}
                      placeholder={t('aiChatSugCategoryCustomPlaceholder')}
                    />
                  </label>
                )}
                <label className="ai-tmpl-field">
                  <span className="ai-tmpl-label">{t('aiChatSugPromptPlaceholder')}</span>
                  <textarea
                    className="ai-tmpl-textarea"
                    value={tmplPrompt}
                    onChange={(e) => setTmplPrompt(e.target.value)}
                    placeholder={t('aiChatSugPromptPlaceholder')}
                    rows={5}
                  />
                </label>
                <div className="ai-tmpl-form-actions">
                  <button
                    type="button"
                    className="ai-tmpl-save"
                    onClick={handleSaveTemplate}
                    disabled={tmplSaving || !tmplName.trim() || !tmplPrompt.trim()}
                  >
                    {t('aiChatSugSave')}
                  </button>
                  {editingTemplate && (
                    <button
                      type="button"
                      className="ai-tmpl-delete"
                      onClick={() => handleDeleteTemplate(editingTemplate.id)}
                    >
                      {t('aiChatSugDelete')}
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <div className="ai-tmpl-list">
                {/* Built-in templates: soft-delete (hide) / restore. */}
                <div className="ai-tmpl-section-title">{t('aiChatSugBuiltin')}</div>
                {SUGGESTION_GROUPS.flatMap((group) =>
                  group.keys
                    .filter((key) => !hiddenBuiltins.includes(key))
                    .map((key) => ({ key, title: t(key), groupId: group.id })),
                ).length === 0 ? (
                  <div className="ai-tmpl-empty">{t('aiChatSugBuiltinEmpty')}</div>
                ) : (
                  SUGGESTION_GROUPS.flatMap((group) =>
                    group.keys
                      .filter((key) => !hiddenBuiltins.includes(key))
                      .map((key) => (
                        <div className="ai-tmpl-item" key={`builtin:${key}`}>
                          <div className="ai-tmpl-item-body">
                            <div className="ai-tmpl-item-name">{t(key)}</div>
                            <div className="ai-tmpl-item-prompt">
                              {t(group.titleKey)}
                            </div>
                          </div>
                          <div className="ai-tmpl-item-actions">
                            <button
                              type="button"
                              className="ai-tmpl-item-del"
                              onClick={() => handleHideBuiltin(key)}
                              title={t('aiChatSugHide')}
                            >
                              <Icon name="trash" size={12} />
                            </button>
                          </div>
                        </div>
                      )),
                  )
                )}

                {hiddenBuiltins.length > 0 && (
                  <>
                    <div className="ai-tmpl-section-title">{t('aiChatSugHidden')}</div>
                    {hiddenBuiltins.map((key) => (
                      <div className="ai-tmpl-item ai-tmpl-item-hidden" key={`hidden:${key}`}>
                        <div className="ai-tmpl-item-body">
                          <div className="ai-tmpl-item-name">{t(key as TranslationKey)}</div>
                        </div>
                        <div className="ai-tmpl-item-actions">
                          <button
                            type="button"
                            className="ai-tmpl-item-edit"
                            onClick={() => handleRestoreBuiltin(key)}
                            title={t('aiChatSugRestore')}
                          >
                            <Icon name="undo" size={12} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </>
                )}

                <div className="ai-tmpl-section-title">{t('aiChatSugCustom')}</div>
                {userTemplates.length === 0 ? (
                  <div className="ai-tmpl-empty">{t('aiChatSugCustomEmpty')}</div>
                ) : (
                  userTemplates.map((tpl) => {
                    const cat = (tpl.category ?? '').trim()
                    const builtinTitle = SUGGESTION_GROUPS.find((g) => g.id === cat)?.titleKey
                    const catLabel = builtinTitle
                      ? t(builtinTitle)
                      : cat.length > 0
                        ? cat
                        : t('aiChatSugCategoryNone')
                    return (
                      <div className="ai-tmpl-item" key={tpl.id}>
                        <div className="ai-tmpl-item-body">
                          <div className="ai-tmpl-item-name">{tpl.name}</div>
                          <div className="ai-tmpl-item-prompt">{tpl.prompt}</div>
                          {cat.length > 0 && (
                            <div className="ai-tmpl-item-cat">{catLabel}</div>
                          )}
                        </div>
                        <div className="ai-tmpl-item-actions">
                          <button
                            type="button"
                            className="ai-tmpl-item-edit"
                            onClick={() => openEditTemplate(tpl)}
                            title={t('aiChatSugManage')}
                          >
                            <Icon name="edit" size={12} />
                          </button>
                          <button
                            type="button"
                            className="ai-tmpl-item-del"
                            onClick={() => handleDeleteTemplate(tpl.id)}
                            title={t('aiChatSugDelete')}
                          >
                            <Icon name="trash" size={12} />
                          </button>
                        </div>
                      </div>
                    )
                  })
                )}
                <button
                  type="button"
                  className="ai-tmpl-add-new"
                  onClick={() => {
                    setEditingTemplate(null)
                    setTmplName('')
                    setTmplPrompt('')
                    setTmplCategory('')
                    setTmplCategoryCustom('')
                    setTmplFormOpen(true)
                  }}
                >
                  <Icon name="plus" size={12} />
                  {t('aiChatSugAdd')}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Fullscreen image lightbox */}
      {previewImage && (
        <div className="ai-chat-lightbox" onClick={() => setPreviewImage(null)}>
          <button
            type="button"
            className="ai-chat-lightbox-close"
            onClick={(e) => {
              e.stopPropagation()
              setPreviewImage(null)
            }}
            title={t('close')}
          >
            <Icon name="x" size={20} />
          </button>
          <img
            src={previewImage}
            alt=""
            className="ai-chat-lightbox-img"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
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


import React, { useEffect, useRef } from 'react'

export interface EditorTab {
  key: string
  sshTabId: number
  path: string
  name: string
  content: string
  original: string
  isBinary: boolean
  isTooLarge: boolean
  isDirty: boolean
  loading: boolean
  size: number
  saving?: boolean
  error?: string
}

interface FileEditorProps {
  tabs: EditorTab[]
  activeKey: string | null
  onSelect: (key: string) => void
  onClose: (key: string) => void
  onContentChange: (key: string, content: string) => void
  onSave: (key: string) => void
}

export function FileEditor({
  tabs,
  activeKey,
  onSelect,
  onClose,
  onContentChange,
  onSave,
}: FileEditorProps) {
  const active = tabs.find((t) => t.key === activeKey) || null
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Ctrl/Cmd+S saves the active editor tab
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        if (activeKey) {
          e.preventDefault()
          onSave(activeKey)
        }
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [activeKey, onSave])

  if (tabs.length === 0) return null

  return (
    <div className="file-editor">
      <div className="editor-tabs">
        {tabs.map((t) => (
          <div
            key={t.key}
            className={`editor-tab ${t.key === activeKey ? 'active' : ''} ${t.isDirty ? 'dirty' : ''}`}
            onClick={() => onSelect(t.key)}
            title={t.path}
          >
            <span className="editor-tab-name">{t.name}</span>
            {t.isDirty && <span className="editor-tab-dirty">●</span>}
            <span
              className="editor-tab-close"
              onClick={(e) => {
                e.stopPropagation()
                onClose(t.key)
              }}
            >
              ×
            </span>
          </div>
        ))}
      </div>

      <div className="editor-body">
        {!active && <div className="editor-empty">No file open</div>}

        {active && active.loading && (
          <div className="editor-loading">Loading {active.path}…</div>
        )}

        {active && active.error && (
          <div className="editor-error">Failed to open: {active.error}</div>
        )}

        {active && !active.loading && !active.error && (active.isBinary || active.isTooLarge) && (
          <div className="editor-readonly">
            <div className="editor-readonly-msg">
              {active.isBinary
                ? 'This file appears to be binary and cannot be edited as text.'
                : `This file is too large (${(active.size / 1024 / 1024).toFixed(1)} MB) to edit inline.`}
            </div>
            <div className="editor-readonly-hint">
              Use the file panel's download feature to fetch it instead.
            </div>
          </div>
        )}

        {active && !active.loading && !active.error && !active.isBinary && !active.isTooLarge && (
          <>
            {active.saving && <div className="editor-saving">Saving…</div>}
            <textarea
              ref={textareaRef}
              className="editor-textarea"
              value={active.content}
              spellCheck={false}
              onChange={(e) => onContentChange(active.key, e.target.value)}
            />
          </>
        )}
      </div>
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'
import monaco from '../editor/monacoSetup'
import { LANGUAGE_OPTIONS, ENCODING_OPTIONS } from '../editor/languages'
import type { TargetRef } from '../types'

export interface EditorTab {
  key: string
  sshTabId: number
  /** Remote filesystem this file lives on (defaults to the tab session). */
  targetRef?: TargetRef
  path: string
  name: string
  content: string
  savedContent: string
  isBinary: boolean
  isTooLarge: boolean
  isDirty: boolean
  loading: boolean
  size: number
  saving?: boolean
  error?: string
  language: string
  encoding: string
  needsEncoding: boolean
  lineEnding: 'LF' | 'CRLF'
}

interface FileEditorProps {
  tabs: EditorTab[]
  activeKey: string | null
  onSelect: (key: string) => void
  onClose: (key: string) => void
  onContentChange: (key: string, content: string) => void
  onSave: (key: string) => void
  onChangeLanguage: (key: string, lang: string) => void
  onChangeEncoding: (key: string, enc: string) => void
  onChangeLineEnding: (key: string, eol: 'LF' | 'CRLF') => void
}

const EOF_SEQ: Record<string, monaco.editor.EndOfLineSequence> = {
  LF: monaco.editor.EndOfLineSequence.LF,
  CRLF: monaco.editor.EndOfLineSequence.CRLF,
}

export function FileEditor({
  tabs,
  activeKey,
  onSelect,
  onClose,
  onContentChange,
  onSave,
  onChangeLanguage,
  onChangeEncoding,
  onChangeLineEnding,
}: FileEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const suppressRef = useRef(false)
  const handlersRef = useRef({ onContentChange, onSave })
  handlersRef.current = { onContentChange, onSave }

  const [showMinimap, setShowMinimap] = useState(false)

  const active = tabs.find((t) => t.key === activeKey) || null

  // Create / recreate editor when active tab changes
  useEffect(() => {
    const canEdit =
      active &&
      !active.loading &&
      !active.error &&
      !active.isBinary &&
      !active.isTooLarge
    if (!containerRef.current || !canEdit) {
      return
    }

    const editor = monaco.editor.create(containerRef.current, {
      value: active.content,
      language: active.language,
      theme: 'vs-dark',
      automaticLayout: true,
      fontSize: 13,
      minimap: { enabled: showMinimap },
      scrollBeyondLastLine: false,
      scrollbar: {
        verticalScrollbarSize: 4,
        horizontalScrollbarSize: 4,
      },
      tabSize: 2,
      readOnly: false,
    })
    editorRef.current = editor

    const disposable = editor.onDidChangeModelContent(() => {
      if (suppressRef.current) return
      handlersRef.current.onContentChange(active.key, editor.getValue())
    })

    // Ctrl/Cmd+S inside the editor
    editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
      () => handlersRef.current.onSave(active.key),
    )

    // Set initial EOL
    const model = editor.getModel()
    if (model && active.lineEnding) {
      model.setEOL(EOF_SEQ[active.lineEnding])
    }

    return () => {
      disposable.dispose()
      editor.dispose()
      editorRef.current = null
    }
  }, [active?.key, active?.loading])

  // Sync content / language / EOL from external prop changes
  useEffect(() => {
    const editor = editorRef.current
    if (!editor || !active) return
    const model = editor.getModel()
    if (!model) return

    if (model.getValue() !== active.content) {
      suppressRef.current = true
      model.setValue(active.content)
      suppressRef.current = false
    }

    if (model.getLanguageId() !== active.language) {
      monaco.editor.setModelLanguage(model, active.language)
    }

    if (active.lineEnding) {
      model.setEOL(EOF_SEQ[active.lineEnding])
    }
  }, [active?.content, active?.language, active?.lineEnding])

  // Sync minimap visibility (no need to recreate editor)
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    editor.updateOptions({ minimap: { enabled: showMinimap } })
  }, [showMinimap])

  if (tabs.length === 0) return null

  const editable =
    active &&
    !active.loading &&
    !active.error &&
    !active.isBinary &&
    !active.isTooLarge

  return (
    <div className="file-editor">
      {/* Tab bar */}
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

      {/* Editor body */}
      <div className="editor-body">
        {!active && <div className="editor-empty">No file open</div>}

        {active && active.loading && (
          <div className="editor-loading">Loading {active.path}…</div>
        )}

        {active && active.error && (
          <div className="editor-error">Failed to open: {active.error}</div>
        )}

        {active &&
          !active.loading &&
          !active.error &&
          (active.isBinary || active.isTooLarge) && (
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

        {editable && (
          <>
            {/* Toolbar */}
            <div className="editor-toolbar">
              <span className="editor-filename" title={active.path}>
                {active.name}
                {active.isDirty && (
                  <span className="dirty-dot" title="Unsaved changes">
                    ●
                  </span>
                )}
                {active.needsEncoding && (
                  <span
                    className="enc-warn"
                    title={`Needs ${active.encoding.toUpperCase()} encoding to avoid data loss`}
                  >
                    {active.encoding.toUpperCase()}
                  </span>
                )}
              </span>
              <div className="editor-toolbar-spacer" />
              <label className="editor-select">
                <select
                  value={active.language}
                  onChange={(e) =>
                    onChangeLanguage(active.key, e.target.value)
                  }
                >
                  {LANGUAGE_OPTIONS.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="editor-select">
                <select
                  value={active.encoding}
                  onChange={(e) =>
                    onChangeEncoding(active.key, e.target.value)
                  }
                >
                  {ENCODING_OPTIONS.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="editor-select">
                <select
                  value={active.lineEnding}
                  onChange={(e) =>
                    onChangeLineEnding(
                      active.key,
                      e.target.value as 'LF' | 'CRLF',
                    )
                  }
                >
                  <option value="LF">LF</option>
                  <option value="CRLF">CRLF</option>
                </select>
              </label>
              <button
                className="editor-btn"
                onClick={() => setShowMinimap((v) => !v)}
                title={showMinimap ? 'Hide minimap' : 'Show minimap'}
              >
                {showMinimap ? '◫' : '▢'} Map
              </button>
              <button
                className="editor-btn primary"
                onClick={() => onSave(active.key)}
                disabled={!active.isDirty}
                title="Save (Ctrl+S)"
              >
                Save
              </button>
            </div>
            {active.saving && <div className="editor-saving">Saving…</div>}
            <div className="editor-host" ref={containerRef} />
          </>
        )}
      </div>
    </div>
  )
}

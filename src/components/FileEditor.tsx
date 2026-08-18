import { useEffect, useRef, useState } from 'react'
import monaco from '../editor/monacoSetup'
import { LANGUAGE_OPTIONS_SORTED, ENCODING_OPTIONS } from '../editor/languages'
import type { TargetRef } from '../types'
import HexViewer from './HexViewer'

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
  /** Raw bytes as Base64 for binary files (hex view). */
  hexBase64?: string
  /** MIME type for image files — when set the file renders as a preview. */
  imageMime?: string
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
  /** When true, the editor's own tab bar is hidden (tabs live in the shell
   *  pane header instead). */
  hideTabs?: boolean
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
  hideTabs = false,
}: FileEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const suppressRef = useRef(false)
  const handlersRef = useRef({ onContentChange, onSave })
  handlersRef.current = { onContentChange, onSave }

  const [showMinimap, setShowMinimap] = useState(false)
  const [showWhitespace, setShowWhitespace] = useState<'none' | 'all' | 'boundary' | 'trailing'>('none')
  const [tabSize, setTabSize] = useState(2)

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
      tabSize,
      renderWhitespace: showWhitespace,
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

  // Sync minimap visibility
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    editor.updateOptions({ minimap: { enabled: showMinimap } })
  }, [showMinimap])

  // Sync whitespace rendering
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    editor.updateOptions({ renderWhitespace: showWhitespace })
  }, [showWhitespace])

  // Sync tab size
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    editor.updateOptions({ tabSize })
  }, [tabSize])

  if (tabs.length === 0) return null

  const editable =
    active &&
    !active.loading &&
    !active.error &&
    !active.isBinary &&
    !active.isTooLarge

  return (
    <div className="file-editor">
      {/* Tab bar (hidden when tabs live in the shell pane header) */}
      {!hideTabs && (
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
      )}

      {/* Editor body */}
      <div className="editor-body">
        {!active && <div className="editor-empty">No file open</div>}

        {active && active.loading && (
          <div className="editor-loading">Loading {active.path}…</div>
        )}

        {active && active.error && (
          <div className="editor-error">Failed to open: {active.error}</div>
        )}

        {active && !active.loading && !active.error && active.imageMime && active.hexBase64 && (
          <div className="image-viewer">
            <div className="image-toolbar">
              <span className="image-filename" title={active.path}>
                {active.name}
              </span>
              <span className="image-meta">
                {(active.size / 1024).toFixed(1)} KB · {active.imageMime}
              </span>
            </div>
            <div className="image-body">
              <img src={`data:${active.imageMime};base64,${active.hexBase64}`} alt={active.name} />
            </div>
          </div>
        )}

        {active &&
          !active.loading &&
          !active.error &&
          active.isBinary &&
          !active.imageMime &&
          active.hexBase64 && (
            <HexViewer base64={active.hexBase64} name={active.name} size={active.size} />
          )}

        {active &&
          !active.loading &&
          !active.error &&
          active.isBinary &&
          !active.hexBase64 && (
            <div className="editor-readonly">
              <div className="editor-readonly-msg">
                This file appears to be binary and cannot be edited as text.
              </div>
              <div className="editor-readonly-hint">
                Use the file panel's download feature to fetch it instead.
              </div>
            </div>
          )}

        {active &&
          !active.loading &&
          !active.error &&
          active.isTooLarge && (
            <div className="editor-readonly">
              <div className="editor-readonly-msg">
                {`This file is too large (${(active.size / 1024 / 1024).toFixed(1)} MB) to edit inline.`}
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
                  {LANGUAGE_OPTIONS_SORTED.map((o) => (
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
                className={`editor-btn${showWhitespace !== 'none' ? ' active' : ''}`}
                onClick={() =>
                  setShowWhitespace((v) =>
                    v === 'none' ? 'all' : 'none',
                  )
                }
                title={showWhitespace !== 'none' ? 'Hide whitespace' : 'Show whitespace'}
              >
                ¶ {showWhitespace !== 'none' ? 'On' : 'Off'}
              </button>
              <label className="editor-select tab-size" title="Tab size">
                <select
                  value={tabSize}
                  onChange={(e) => setTabSize(Number(e.target.value))}
                >
                  <option value={2}>2</option>
                  <option value={4}>4</option>
                  <option value={8}>8</option>
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

import { useEffect, useRef, useState } from 'react'
import monaco from '../editor/monacoSetup'
import { LANGUAGE_OPTIONS_SORTED, ENCODING_OPTIONS } from '../editor/languages'
import type { TargetRef } from '../types'
import HexViewer from './HexViewer'
import MarkdownPreview from './MarkdownPreview'
import { useScrollbarGrabZone } from '../hooks/useScrollbarGrabZone'
import { monacoThemeId } from '../lib/theme'
import { getResolvedTheme, subscribeTheme } from '../lib/themeStore'
import { loadEditorPrefs, saveEditorPrefs, subscribeEditorPrefs } from '../lib/editorPrefs'
import { useI18n } from '../i18n'

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
  // Rendering the Markdown instead of the source (only offered for `markdown` files).
  // Pane-scoped, like `showWhitespace` / `showMinimap` — no persistence.
  const [showPreview, setShowPreview] = useState(false)
  const [showWhitespace, setShowWhitespace] = useState<'none' | 'all' | 'boundary' | 'trailing'>(
    'none',
  )
  const [tabSize, setTabSize] = useState(2)
  // Persisted display preferences (see lib/editorPrefs) — the hex viewer reads
  // the same store, so one switch covers both views.
  const [prefs, setPrefs] = useState(() => loadEditorPrefs())

  const { t } = useI18n()

  // `tab` (not `t`): `t` is the i18n translator below.
  const active = tabs.find((tab) => tab.key === activeKey) || null

  // Monaco's scrollbar is a 4px sliver by default — widen it while the pointer
  // is in the grab zone so it can actually be grabbed and dragged.
  const nearScrollbar = useScrollbarGrabZone(containerRef)

  // Create / recreate editor when active tab changes
  useEffect(() => {
    const canEdit =
      active && !active.loading && !active.error && !active.isBinary && !active.isTooLarge
    if (!containerRef.current || !canEdit) {
      return
    }

    const editor = monaco.editor.create(containerRef.current, {
      value: active.content,
      language: active.language,
      // Built-in Monaco light/dark themes — see src/lib/theme.ts.
      theme: monacoThemeId(getResolvedTheme()),
      automaticLayout: true,
      fontSize: 13,
      minimap: { enabled: showMinimap },
      // One viewport of spare room below the last line, so the tail of the file can
      // be scrolled up to the top of the viewport (Monaco otherwise pins the last
      // line to the bottom edge). Default on, toggleable in the toolbar.
      scrollBeyondLastLine: prefs.scrollBeyondLastLine,
      wordWrap: prefs.wordWrap ? 'on' : 'off',
      // Pin the enclosing scope (function / class / block) to the top of the
      // viewport while the body is scrolled through. Off by default (Monaco's own
      // default), toggleable in the toolbar.
      stickyScroll: { enabled: prefs.stickyScroll },
      scrollbar: {
        verticalScrollbarSize: 4,
        horizontalScrollbarSize: 4,
      },
      tabSize,
      renderWhitespace: showWhitespace,
      readOnly: false,
    })
    editorRef.current = editor

    // Tab size is a *model* option (Monaco's editor option list has no `tabSize`), and
    // the model picks its own value from the file contents — `detectIndentation` is on by
    // default. That detected value is what sizes the tab, the auto-indent and the
    // indent-guide grid, so mirror it in the toolbar: the select then shows the step the
    // file is really rendered with (BUGS.md B38).
    const detectedTabSize = editor.getModel()?.getOptions().tabSize
    if (detectedTabSize === 2 || detectedTabSize === 4 || detectedTabSize === 8) {
      setTabSize(detectedTabSize)
    }

    const disposable = editor.onDidChangeModelContent(() => {
      if (suppressRef.current) return
      handlersRef.current.onContentChange(active.key, editor.getValue())
    })

    // Ctrl/Cmd+S inside the editor
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () =>
      handlersRef.current.onSave(active.key),
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

  // Follow theme changes (Monaco keeps its palette in JS, not CSS).
  useEffect(
    () =>
      subscribeTheme(() => {
        monaco.editor.setTheme(monacoThemeId(getResolvedTheme()))
      }),
    [],
  )

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

  // Follow preference changes made in another pane / by the hex viewer.
  useEffect(() => subscribeEditorPrefs(setPrefs), [])

  // Sync the tail room (one screen of room after the last line).
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    editor.updateOptions({ scrollBeyondLastLine: prefs.scrollBeyondLastLine })
  }, [prefs.scrollBeyondLastLine])

  // Sync soft wrapping.
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    editor.updateOptions({ wordWrap: prefs.wordWrap ? 'on' : 'off' })
  }, [prefs.wordWrap])

  // Sync sticky scroll (the pinned enclosing-scope header).
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    editor.updateOptions({ stickyScroll: { enabled: prefs.stickyScroll } })
  }, [prefs.stickyScroll])

  // Widen the scrollbar while the pointer is in the grab zone (4px → 10px) so it
  // is comfortable to drag. `active?.key` is a dependency because switching tabs
  // builds a brand-new editor that starts at the default width.
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    const size = nearScrollbar ? 10 : 4
    editor.updateOptions({
      scrollbar: { verticalScrollbarSize: size, horizontalScrollbarSize: size },
    })
  }, [nearScrollbar, active?.key])

  if (tabs.length === 0) return null

  const editable =
    active && !active.loading && !active.error && !active.isBinary && !active.isTooLarge

  // Markdown files can be read as source or as rendered HTML (the toggle is only shown
  // for them). The language select drives this, so it also follows a manual switch.
  const isMarkdown = active?.language === 'markdown'
  const previewOn = isMarkdown && showPreview

  return (
    <div className="file-editor">
      {/* Tab bar (hidden when tabs live in the shell pane header) */}
      {!hideTabs && (
        <div className="editor-tabs">
          {tabs.map((tab) => (
            <div
              key={tab.key}
              className={`editor-tab ${tab.key === activeKey ? 'active' : ''} ${tab.isDirty ? 'dirty' : ''}`}
              onClick={() => onSelect(tab.key)}
              title={tab.path}
            >
              <span className="editor-tab-name">{tab.name}</span>
              {tab.isDirty && <span className="editor-tab-dirty">●</span>}
              <span
                className="editor-tab-close"
                onClick={(e) => {
                  e.stopPropagation()
                  onClose(tab.key)
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

        {active && active.loading && <div className="editor-loading">Loading {active.path}…</div>}

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

        {active && !active.loading && !active.error && active.isBinary && !active.hexBase64 && (
          <div className="editor-readonly">
            <div className="editor-readonly-msg">
              This file appears to be binary and cannot be edited as text.
            </div>
            <div className="editor-readonly-hint">
              Use the file panel's download feature to fetch it instead.
            </div>
          </div>
        )}

        {active && !active.loading && !active.error && active.isTooLarge && (
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
            {/* Toolbar. Clicking a button here is a side trip inside the file: cancelling
                the mousedown's default action is what keeps the keyboard in Monaco (a
                `<button>` takes focus on mousedown otherwise), so the very next keystroke
                still lands in the document. It also covers `Save`, which used to drop the
                focus to `<body>` — the button it was clicked on turns `disabled` as soon as
                the file is clean, and a disabled button cannot hold focus. Keyboard
                activation has no mousedown, so Tab/Enter still reach every button.
                `<select>`s are deliberately left out: they need the mousedown to open and
                are meant to keep focus themselves. */}
            <div
              className="editor-toolbar"
              onMouseDown={(e) => {
                if ((e.target as HTMLElement).closest('button')) e.preventDefault()
              }}
            >
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
                  onChange={(e) => onChangeLanguage(active.key, e.target.value)}
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
                  onChange={(e) => onChangeEncoding(active.key, e.target.value)}
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
                  onChange={(e) => onChangeLineEnding(active.key, e.target.value as 'LF' | 'CRLF')}
                >
                  <option value="LF">LF</option>
                  <option value="CRLF">CRLF</option>
                </select>
              </label>
              <button
                className={`editor-btn tail-toggle${prefs.scrollBeyondLastLine ? ' active' : ''}`}
                aria-pressed={prefs.scrollBeyondLastLine}
                onClick={() =>
                  setPrefs(saveEditorPrefs({ scrollBeyondLastLine: !prefs.scrollBeyondLastLine }))
                }
                title={t('editorTailRoomTitle')}
              >
                ⇣ {t('editorTailRoom')} {t(prefs.scrollBeyondLastLine ? 'on' : 'off')}
              </button>
              <button
                className={`editor-btn wrap-toggle${prefs.wordWrap ? ' active' : ''}`}
                aria-pressed={prefs.wordWrap}
                onClick={() => setPrefs(saveEditorPrefs({ wordWrap: !prefs.wordWrap }))}
                title={t('editorWrapLinesTitle')}
              >
                ↵ {t('editorWrapLines')} {t(prefs.wordWrap ? 'on' : 'off')}
              </button>
              <button
                className={`editor-btn sticky-toggle${prefs.stickyScroll ? ' active' : ''}`}
                aria-pressed={prefs.stickyScroll}
                onClick={() => setPrefs(saveEditorPrefs({ stickyScroll: !prefs.stickyScroll }))}
                title={t('editorStickyScrollTitle')}
              >
                📌 {t('editorStickyScroll')} {t(prefs.stickyScroll ? 'on' : 'off')}
              </button>
              <button
                className={`editor-btn${showWhitespace !== 'none' ? ' active' : ''}`}
                onClick={() => setShowWhitespace((v) => (v === 'none' ? 'all' : 'none'))}
                title={showWhitespace !== 'none' ? 'Hide whitespace' : 'Show whitespace'}
              >
                ¶ {showWhitespace !== 'none' ? 'On' : 'Off'}
              </button>
              <label className="editor-select tab-size" title="Tab size">
                <select
                  value={tabSize}
                  onChange={(e) => {
                    const next = Number(e.target.value)
                    setTabSize(next)
                    // `tabSize` is a *model* option — the editor itself has no such
                    // option, so `editor.updateOptions({ tabSize })` (what this used to
                    // call) was a silent no-op. Writing the model is also what re-grids
                    // the indent guides, so `indentSize` follows along. See BUGS.md B38.
                    editorRef.current
                      ?.getModel()
                      ?.updateOptions({ tabSize: next, indentSize: 'tabSize' })
                  }}
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
              {isMarkdown && (
                <button
                  className={`editor-btn preview-toggle${showPreview ? ' active' : ''}`}
                  aria-pressed={showPreview}
                  onClick={() => setShowPreview((v) => !v)}
                  title={t('editorPreviewTitle')}
                >
                  👁 {t('editorPreview')} {t(showPreview ? 'on' : 'off')}
                </button>
              )}
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
            <div className={`editor-views${previewOn ? ' is-preview' : ''}`}>
              {/* Monaco stays mounted (only hidden) while previewing — unmounting its
                  host would leave the editor instance without a home and the source
                  view would come back blank. */}
              <div className="editor-host" ref={containerRef} />
              {previewOn && (
                <MarkdownPreview content={active.content} onSave={() => onSave(active.key)} />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

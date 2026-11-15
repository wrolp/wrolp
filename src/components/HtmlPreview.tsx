import { useI18n } from '../i18n'

interface HtmlPreviewProps {
  /** The editor's current buffer — unsaved edits are previewed as well. */
  content: string
}

/** Same ceiling as MarkdownPreview: a larger document freezes the WebView. */
const MAX_RENDER_CHARS = 1024 * 1024

/**
 * Read-only, sandboxed rendering of a remote HTML file. `sandbox=""` is the strictest
 * setting there is: no scripts, forms, top-level navigation or popups. The file comes
 * from a remote host and cannot be trusted — unsandboxed script would run in this
 * WebView and could invoke any backend command through `__TAURI_INTERNALS__`.
 * `srcDoc` has no base URL, so relative assets cannot resolve; absolute http(s) ones load.
 */
export default function HtmlPreview({ content }: HtmlPreviewProps) {
  const { t } = useI18n()

  return (
    <div className="editor-preview html-preview">
      {content.length > MAX_RENDER_CHARS ? (
        <pre className="html-preview-raw" title={t('htmlPreviewTooLarge')}>
          {content}
        </pre>
      ) : (
        <iframe
          className="html-preview-frame"
          sandbox=""
          srcDoc={content}
          title={t('htmlPreviewTitle')}
        />
      )}
    </div>
  )
}

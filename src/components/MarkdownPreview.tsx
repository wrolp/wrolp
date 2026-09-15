import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useI18n } from '../i18n'
import { useCustomScrollbar } from '../hooks/useCustomScrollbar'
import { handleMarkdownLinkClick } from '../lib/externalLink'
import { copyText } from '../lib/clipboard'

interface MarkdownPreviewProps {
  /** The editor's current buffer — unsaved edits are previewed as well. */
  content: string
  /** Save handler: Monaco is hidden (not unmounted) while previewing, so the
   *  Ctrl/Cmd+S shortcut is forwarded from here instead. */
  onSave?: () => void
}

/** Above this size the rendered tree is slow enough to freeze the WebView; the source
 *  is shown verbatim instead (the editor itself already caps file size). */
const MAX_RENDER_CHARS = 1024 * 1024

/** Fenced code block: language label + copy button (no syntax highlighting yet). */
function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)

  return (
    <div className="md-preview-code">
      <div className="md-preview-code-bar">
        <span className="md-preview-code-lang">{lang || 'text'}</span>
        <button
          type="button"
          className="md-preview-code-copy"
          title={copied ? t('copied') : t('copyMessage')}
          onClick={() => {
            void copyText(code).then(() => {
              setCopied(true)
              window.setTimeout(() => setCopied(false), 1500)
            })
          }}
        >
          {copied ? '✓' : '⧉'}
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  )
}

/**
 * Read-only Markdown rendering of a remote file, shown in place of the source while the
 * editor's preview switch is on. Raw HTML is never rendered (`rehype-raw` is not used),
 * links are handed to the OS browser, and images only load for absolute `http(s)` URLs —
 * the file itself lives on the remote host, so relative paths cannot be resolved.
 */
export default function MarkdownPreview({ content, onSave }: MarkdownPreviewProps) {
  const { t } = useI18n()
  const rootRef = useRef<HTMLDivElement>(null)
  const {
    listRef,
    thumbHeight,
    thumbTop,
    showThumb,
    onScroll,
    onThumbMouseDown,
    onMouseEnter,
    onMouseLeave,
  } = useCustomScrollbar()

  // Monaco stays mounted but hidden, so its own Ctrl/Cmd+S command never fires. Take
  // the focus here so the shortcut keeps working while previewing.
  useEffect(() => {
    rootRef.current?.focus()
  }, [])

  const components = useMemo(
    () => ({
      // The block styling lives in `code` (below); dropping the default `<pre>` keeps
      // the markup valid instead of nesting two of them.
      pre: ({ children }: { children?: ReactNode }) => <>{children}</>,
      code: ({ className, children }: { className?: string; children?: ReactNode }) => {
        const match = /language-(\w+)/.exec(className || '')
        const code = String(children ?? '')
        // A fenced block carries a language class — or spans lines (``` with no tag).
        if (match || code.includes('\n')) {
          return <CodeBlock lang={match?.[1] ?? ''} code={code.replace(/\n$/, '')} />
        }
        return <code className="md-preview-inline">{children}</code>
      },
      a: ({ href, children }: { href?: string; children?: ReactNode }) => (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => handleMarkdownLinkClick(e, href)}
        >
          {children}
        </a>
      ),
      img: ({ src, alt }: { src?: unknown; alt?: string }) => {
        if (typeof src === 'string' && /^https?:\/\//i.test(src)) {
          return <img className="md-preview-img" src={src} alt={alt ?? ''} />
        }
        // Relative / `file:` sources can't be fetched — show what was referenced.
        return (
          <span className="md-preview-img-local" title={t('mdPreviewImageLocal')}>
            {`🖼 ${alt || String(src ?? '')}`}
          </span>
        )
      },
    }),
    [t],
  )

  const tooLarge = content.length > MAX_RENDER_CHARS

  return (
    <div
      className="editor-preview"
      ref={rootRef}
      tabIndex={-1}
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
          e.preventDefault()
          onSave?.()
        }
      }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="md-preview" ref={listRef} onScroll={onScroll}>
        {tooLarge ? (
          <pre className="md-preview-raw" title={t('mdPreviewTooLarge')}>
            {content}
          </pre>
        ) : (
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
            {content}
          </ReactMarkdown>
        )}
      </div>
      {thumbHeight > 0 && (
        <div className={`sidebar-scrollbar${showThumb ? ' show' : ''}`}>
          <div
            className="sidebar-scrollbar-thumb"
            style={{ height: thumbHeight, top: thumbTop }}
            onMouseDown={onThumbMouseDown}
          />
        </div>
      )}
    </div>
  )
}

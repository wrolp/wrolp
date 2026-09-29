import { useState, useEffect, useRef } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useI18n } from '../i18n'
import { Icon } from './Icon'

interface TitlebarProps {
  onSettings?: () => void
  onAiChat?: () => void
  /** Toggle the floating command list (command *snippets* — not the palette). */
  onCommandList?: () => void
  /** Open the Ctrl+K command palette. */
  onCommandPalette?: () => void
  /** Put the built-in FTP/HTTP/TFTP tools in the rail's mode column. */
  onNetTools?: () => void
  /**
   * The workspace pill. It lives here rather than at the top of the mode panel
   * because it describes the whole window, not the panel — and the panel can be
   * hidden, which used to hide the workspace switcher with it.
   * The caller renders the element so this file stays free of app state.
   */
  workspace?: React.ReactNode
}

export const Titlebar: React.FC<TitlebarProps> = ({
  onSettings,
  onAiChat,
  onCommandList,
  onCommandPalette,
  onNetTools,
  workspace,
}) => {
  const { t } = useI18n()
  const [isMaximized, setIsMaximized] = useState(false)
  const [alwaysOnTop, setAlwaysOnTop] = useState(false)
  const titlebarRef = useRef<HTMLDivElement>(null)
  const controlsRef = useRef<HTMLDivElement>(null)
  const appWindow = getCurrentWindow()

  const toggleAlwaysOnTop = async () => {
    const next = !alwaysOnTop
    await appWindow.setAlwaysOnTop(next)
    setAlwaysOnTop(next)
  }

  useEffect(() => {
    const checkMaximized = async () => {
      setIsMaximized(await appWindow.isMaximized())
    }
    checkMaximized()

    const unlisten = appWindow.onResized(async () => {
      setIsMaximized(await appWindow.isMaximized())
    })

    return () => {
      unlisten.then((fn) => fn())
    }
  }, [])

  // Double-click on titlebar → toggle maximize
  // Window dragging is handled natively via data-tauri-drag-region attribute.
  useEffect(() => {
    const el = titlebarRef.current
    if (!el) return

    const DOUBLE_CLICK_MS = 350
    let lastClickTime = 0

    const handleMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return
      if (controlsRef.current?.contains(e.target as Node)) return

      const now = Date.now()
      if (now - lastClickTime < DOUBLE_CLICK_MS) {
        lastClickTime = 0
        appWindow.toggleMaximize()
        return
      }
      lastClickTime = now
    }

    el.addEventListener('mousedown', handleMouseDown)
    return () => {
      el.removeEventListener('mousedown', handleMouseDown)
    }
  }, [])

  return (
    <div className="titlebar" ref={titlebarRef} data-tauri-drag-region>
      <div className="tb-left">
        <span className="titlebar-title">
          <img src="/icon.png" alt="" className="titlebar-icon" />
          <span className="brand-name">Wrolp Terminal</span>
        </span>
        <span className="vdiv" />
        {workspace}
      </div>

      <div className="tb-center">
        {onCommandPalette && (
          <button
            type="button"
            className="cmd-trigger"
            onClick={onCommandPalette}
            title={`${t('commandPalette')} (Ctrl+K)`}
          >
            <Icon name="search" size={14} />
            <span className="cmd-ph">{t('commandPalettePlaceholder')}</span>
            <kbd>Ctrl K</kbd>
          </button>
        )}
      </div>

      <div className="tb-right" ref={controlsRef}>
        {onAiChat && (
          <button
            className="titlebar-btn ai-chat-btn"
            onClick={onAiChat}
            title={t('titlebarAi')}
            aria-label={t('titlebarAi')}
          >
            <Icon name="sparkles" size={15} />
          </button>
        )}
        {onCommandList && (
          <button
            className="titlebar-btn cmd-list-btn"
            onClick={onCommandList}
            title={t('commandList')}
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              {/* terminal — command list */}
              <polyline points="4 17 10 11 4 5" />
              <line x1="12" y1="19" x2="20" y2="19" />
            </svg>
          </button>
        )}
        {onNetTools && (
          <button
            className="titlebar-btn net-tools-btn"
            onClick={onNetTools}
            title={t('netToolTitle')}
            aria-label={t('netToolTitle')}
          >
            <Icon name="network" size={14} />
          </button>
        )}
        <button
          className={`titlebar-btn pin-btn${alwaysOnTop ? ' active' : ''}`}
          onClick={toggleAlwaysOnTop}
          title={alwaysOnTop ? t('alwaysOnTopOn') : t('alwaysOnTop')}
        >
          <Icon name="pin" size={14} />
        </button>
        {onSettings && (
          <button
            className="titlebar-btn settings-btn"
            onClick={onSettings}
            title={t('titlebarSettings')}
          >
            <Icon name="settings" size={14} />
          </button>
        )}
        <span className="vdiv" />
        <div className="titlebar-controls">
          <button
            className="titlebar-btn"
            onClick={() => appWindow.minimize()}
            title={t('minimize')}
          >
            <svg width="12" height="12" viewBox="0 0 12 12">
              <rect x="1" y="5.5" width="10" height="1" fill="currentColor" />
            </svg>
          </button>
          <button
            className="titlebar-btn"
            onClick={() => appWindow.toggleMaximize()}
            title={isMaximized ? t('restore') : t('maximize')}
          >
            {isMaximized ? (
              <svg width="12" height="12" viewBox="0 0 12 12">
                <rect
                  x="3"
                  y="0"
                  width="9"
                  height="9"
                  rx="1"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1"
                />
                <rect x="0" y="3" width="9" height="9" rx="1" fill="currentColor" />
                <rect x="1" y="4" width="7" height="7" rx="0.5" fill="#252526" />
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 12 12">
                <rect
                  x="1"
                  y="1"
                  width="10"
                  height="10"
                  rx="1"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1"
                />
              </svg>
            )}
          </button>
          <button
            className="titlebar-btn titlebar-close"
            onClick={() => appWindow.close()}
            title={t('close')}
          >
            <svg width="12" height="12" viewBox="0 0 12 12">
              <line x1="1" y1="1" x2="11" y2="11" stroke="currentColor" strokeWidth="1.5" />
              <line x1="11" y1="1" x2="1" y2="11" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  )
}

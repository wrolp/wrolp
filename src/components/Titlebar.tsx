import { useState, useEffect, useRef } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useI18n } from '../i18n'

interface TitlebarProps {
  onSettings?: () => void
  onAiChat?: () => void
}

export const Titlebar: React.FC<TitlebarProps> = ({ onSettings, onAiChat }) => {
  const { t } = useI18n()
  const [isMaximized, setIsMaximized] = useState(false)
  const titlebarRef = useRef<HTMLDivElement>(null)
  const controlsRef = useRef<HTMLDivElement>(null)
  const appWindow = getCurrentWindow()

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
      <span className="titlebar-title">
        <img src="/icon.png" alt="" className="titlebar-icon" />
        Wrolp Terminal
      </span>

      <div className="titlebar-actions" ref={controlsRef}>
        {onAiChat && (
          <button className="titlebar-btn ai-chat-btn" onClick={onAiChat} title={t('titlebarAi')}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              {/* sparkle — AI */}
              <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z" fill="currentColor" stroke="none" />
              <path d="M19 15l.9 2.4L22 18.3l-2.1.9L19 21.6l-.9-2.4-2.1-.9 2.1-.9L19 15z" fill="currentColor" stroke="none" />
              <path d="M5.5 14l.6 1.6L7.7 16.2l-1.6.6L5.5 18.4l-.6-1.6-1.6-.6 1.6-.6L5.5 14z" fill="currentColor" stroke="none" />
            </svg>
          </button>
        )}
        {onSettings && (
          <button className="titlebar-btn settings-btn" onClick={onSettings} title={t('titlebarSettings')}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        )}
        <div className="titlebar-controls">
          <button className="titlebar-btn" onClick={() => appWindow.minimize()} title={t('minimize')}>
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
                <rect x="3" y="0" width="9" height="9" rx="1" fill="none" stroke="currentColor" strokeWidth="1" />
                <rect x="0" y="3" width="9" height="9" rx="1" fill="currentColor" />
                <rect x="1" y="4" width="7" height="7" rx="0.5" fill="#252526" />
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 12 12">
                <rect x="1" y="1" width="10" height="10" rx="1" fill="none" stroke="currentColor" strokeWidth="1" />
              </svg>
            )}
          </button>
          <button className="titlebar-btn titlebar-close" onClick={() => appWindow.close()} title={t('close')}>
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

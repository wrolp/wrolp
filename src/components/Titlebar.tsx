import { useState, useEffect, useRef } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'

interface TitlebarProps {
  onSettings?: () => void
}

export const Titlebar: React.FC<TitlebarProps> = ({ onSettings }) => {
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

  // Native mousedown listener — React synthetic events don't reliably
  // satisfy the "primary mouse button press" requirement of startDragging()
  useEffect(() => {
    const el = titlebarRef.current
    if (!el) return

    const handleMouseDown = (e: MouseEvent) => {
      // Only left mouse button
      if (e.button !== 0) return
      // Skip when clicking on window control buttons
      if (controlsRef.current?.contains(e.target as Node)) return
      appWindow.startDragging()
    }

    el.addEventListener('mousedown', handleMouseDown)
    return () => el.removeEventListener('mousedown', handleMouseDown)
  }, [])

  return (
    <div className="titlebar" ref={titlebarRef}>
      <span className="titlebar-title">⚡ SSH Terminal</span>

      <div className="titlebar-actions" ref={controlsRef}>
        {onSettings && (
          <button className="titlebar-btn settings-btn" onClick={onSettings} title="Settings">
            <svg width="14" height="14" viewBox="0 0 16 16">
              <path
                d="M7.5 0a1 1 0 011 1v1.2c.4.2.8.4 1.2.7l.8-.8a1 1 0 011.4 1.4l-.8.8c.3.4.5.8.7 1.2H13a1 1 0 010 2h-1.2c-.2.4-.4.8-.7 1.2l.8.8a1 1 0 01-1.4 1.4l-.8-.8c-.4.3-.8.5-1.2.7V13a1 1 0 01-2 0v-1.2c-.4-.2-.8-.4-1.2-.7l-.8.8a1 1 0 01-1.4-1.4l.8-.8c-.3-.4-.5-.8-.7-1.2H2a1 1 0 010-2h1.2c.2-.4.4-.8.7-1.2l-.8-.8a1 1 0 111.4-1.4l.8.8c.4-.3.8-.5 1.2-.7V1a1 1 0 011-1zm0 5a2.5 2.5 0 100 5 2.5 2.5 0 000-5z"
                fill="currentColor"
              />
            </svg>
          </button>
        )}
        <div className="titlebar-controls">
          <button className="titlebar-btn" onClick={() => appWindow.minimize()} title="Minimize">
            <svg width="12" height="12" viewBox="0 0 12 12">
              <rect x="1" y="5.5" width="10" height="1" fill="currentColor" />
            </svg>
          </button>
          <button
            className="titlebar-btn"
            onClick={() => appWindow.toggleMaximize()}
            title={isMaximized ? 'Restore' : 'Maximize'}
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
          <button className="titlebar-btn titlebar-close" onClick={() => appWindow.close()} title="Close">
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

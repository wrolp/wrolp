// The only chrome minimal mode keeps: a strip along the top edge that appears
// when the pointer reaches the very top of the window. With the titlebar
// unmounted this is also the only thing left that can drag the window, so it
// carries `data-tauri-drag-region` (and `app-region: drag` from the stylesheet).
//
// It stays collapsed to a sliver until hovered — the mode exists to give the
// terminal the whole window, so the escape hatch must not itself take a band of
// it. Esc is deliberately not an exit key: inside a shell or vim it means
// "cancel" and must keep reaching the session.

import { useEffect, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useI18n } from '../i18n'
import { useShortcutLabel } from '../hooks/useShortcuts'

interface MinimalModeBarProps {
  onExit: () => void
  /** True while the mode has the OS fullscreen — window controls are meaningless there. */
  fullscreen: boolean
}

export const MinimalModeBar: React.FC<MinimalModeBarProps> = ({ onExit, fullscreen }) => {
  const { t } = useI18n()
  const keys = useShortcutLabel('toggleMinimalMode')
  const appWindow = getCurrentWindow()
  const [isMaximized, setIsMaximized] = useState(false)

  useEffect(() => {
    let alive = true
    const sync = async () => {
      const maximized = await appWindow.isMaximized()
      if (alive) setIsMaximized(maximized)
    }
    void sync()
    const unlisten = appWindow.onResized(() => void sync())
    return () => {
      alive = false
      void unlisten.then((fn) => fn())
    }
  }, [appWindow])

  return (
    <div className="minimal-bar" data-tauri-drag-region>
      <div className="tb-left">
        <button
          type="button"
          className="minimal-exit"
          onClick={onExit}
          title={`${t('exitMinimalMode')} (${keys})`}
          aria-label={t('exitMinimalMode')}
        >
          {/* No glyph: a downward chevron used to sit here and read as "open a
              menu" / "collapse the bar", for a button that leaves the mode. The
              label and its shortcut are the whole affordance. */}
          <span>{t('exitMinimalMode')}</span>
          <kbd>{keys.replace(/\+/g, ' ')}</kbd>
        </button>
      </div>

      {!fullscreen && (
        <div className="minimal-window-controls">
          <button
            type="button"
            className="titlebar-btn"
            onClick={() => appWindow.minimize()}
            title={t('minimize')}
            aria-label={t('minimize')}
          >
            <svg width="12" height="12" viewBox="0 0 12 12">
              <rect x="1" y="5.5" width="10" height="1" fill="currentColor" />
            </svg>
          </button>
          <button
            type="button"
            className="titlebar-btn"
            onClick={() => appWindow.toggleMaximize()}
            title={isMaximized ? t('restore') : t('maximize')}
            aria-label={isMaximized ? t('restore') : t('maximize')}
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
            type="button"
            className="titlebar-btn titlebar-close"
            onClick={() => appWindow.close()}
            title={t('close')}
            aria-label={t('close')}
          >
            <svg width="12" height="12" viewBox="0 0 12 12">
              <line x1="1" y1="1" x2="11" y2="11" stroke="currentColor" strokeWidth="1.5" />
              <line x1="11" y1="1" x2="1" y2="11" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </button>
        </div>
      )}
    </div>
  )
}

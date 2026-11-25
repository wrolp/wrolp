import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useI18n } from '../../i18n'
import { Icon } from '../Icon'
import type { PathHistory } from './pathHistory'

interface Props {
  id: string
  label: string
  state: PathHistory
  placeholder?: string
  disabled?: boolean
  /** Opens the OS picker; the caller writes the picked path through `state.setValue`. */
  onBrowse?: () => void
}

interface MenuSpot {
  left: number
  top: number
  width: number
}

/**
 * One path field of the network tools: the input, Browse, and a menu of the paths
 * used before. The menu is portaled so the panel's scroll container cannot clip
 * it, and every row carries its own remove button — a share that moved is one
 * click away from leaving the list.
 */
export default function PathField({ id, label, state, placeholder, disabled, onBrowse }: Props) {
  const { t } = useI18n()
  const [spot, setSpot] = useState<MenuSpot | null>(null)
  const rowRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const openMenu = () => {
    const row = rowRef.current
    if (!row) return
    const rect = row.getBoundingClientRect()
    setSpot({
      left: Math.max(8, rect.left),
      top: rect.bottom + 4,
      width: Math.max(rect.width, 240),
    })
  }

  // Below the field, unless it would run past the bottom; pulled inside the right
  // edge when the column sits near it. Measured after the portal paints.
  useLayoutEffect(() => {
    if (!spot) return
    const menu = menuRef.current
    const row = rowRef.current
    if (!menu || !row) return
    const rect = menu.getBoundingClientRect()
    const field = row.getBoundingClientRect()
    const left = Math.max(8, Math.min(spot.left, window.innerWidth - rect.width - 8))
    const below = spot.top + rect.height > window.innerHeight - 8
    const top = below ? Math.max(8, field.top - rect.height - 4) : spot.top
    menu.style.left = `${left}px`
    menu.style.top = `${top}px`
  }, [spot])

  useEffect(() => {
    if (!spot) return
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (menuRef.current?.contains(target) || buttonRef.current?.contains(target)) return
      setSpot(null)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSpot(null)
    }
    const close = () => setSpot(null)
    const onScroll = (event: Event) => {
      // The menu's own list scrolls; only the page behind it dismisses the menu.
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return
      setSpot(null)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [spot])

  return (
    <div className="nt-field">
      <label htmlFor={id}>{label}</label>
      <div className="nt-actions" ref={rowRef}>
        <input
          id={id}
          className="nt-input"
          value={state.value}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(event) => state.setValue(event.target.value)}
          onBlur={() => state.remember()}
        />
        <button
          ref={buttonRef}
          type="button"
          className="nt-btn nt-btn-sm nt-path-history"
          title={t('ntPathHistory')}
          aria-label={t('ntPathHistory')}
          aria-haspopup="listbox"
          aria-expanded={!!spot}
          disabled={disabled}
          onClick={() => (spot ? setSpot(null) : openMenu())}
        >
          <Icon name="history" size={13} />
        </button>
        {onBrowse && (
          <button className="nt-btn nt-btn-sm" type="button" onClick={onBrowse} disabled={disabled}>
            {t('ntBrowse')}
          </button>
        )}
      </div>
      {spot &&
        createPortal(
          <div
            ref={menuRef}
            className="wl-select-menu nt-path-menu"
            style={{ left: spot.left, top: spot.top, width: spot.width }}
            role="listbox"
            aria-label={t('ntPathHistory')}
          >
            <div className="wl-select-list">
              {state.history.length === 0 ? (
                <div className="nt-path-empty">{t('ntPathHistoryEmpty')}</div>
              ) : (
                state.history.map((path) => (
                  <div
                    key={path}
                    className={
                      'wl-select-option nt-path-row' + (path === state.value ? ' selected' : '')
                    }
                    role="option"
                    aria-selected={path === state.value}
                    title={path}
                    onClick={() => {
                      state.pick(path)
                      setSpot(null)
                    }}
                  >
                    <span className="nt-path-text">{path}</span>
                    <button
                      type="button"
                      className="nt-path-remove"
                      title={t('ntPathForget')}
                      aria-label={t('ntPathForget')}
                      onClick={(event) => {
                        event.stopPropagation()
                        state.forget(path)
                      }}
                    >
                      ✕
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>,
          document.body,
        )}
    </div>
  )
}

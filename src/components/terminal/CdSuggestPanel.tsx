import React, { useEffect, useLayoutEffect, useRef } from 'react'
import { useI18n } from '../../i18n'
import { Icon } from '../Icon'
import type { CdCandidate } from './cdSuggest'

/** Where the panel hangs: the caret cell, already translated to viewport px. */
export interface CdSuggestAnchor {
  x: number
  /** Top edge of the caret row. */
  y: number
  cellH: number
}

export interface CdSuggestPanelProps {
  items: readonly CdCandidate[]
  activeIndex: number
  /** Matches dropped by the 200-item cap. */
  omitted: number
  loading: boolean
  anchor: CdSuggestAnchor
  maxHeight: number
  onPick: (index: number) => void
  onHover: (index: number) => void
}

/**
 * The `cd` directory candidate panel (Warp-style). Presentational only — it owns
 * no keystroke handling (see `keyIntercept.ts`) and no data fetching; it just
 * draws `items` under the caret and reports picks upward.
 *
 * Positioning mirrors the `ls` hover card: `position: fixed` inside the terminal
 * wrapper, anchored to a cell, clamped into the viewport and flipped above the
 * row when the space below is too tight.
 */
export function CdSuggestPanel({
  items,
  activeIndex,
  omitted,
  loading,
  anchor,
  maxHeight,
  onPick,
  onHover,
}: CdSuggestPanelProps) {
  const { t } = useI18n()
  const rootRef = useRef<HTMLDivElement | null>(null)

  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el) return
    const vh = window.innerHeight
    const vw = window.innerWidth
    const rowH = anchor.cellH || 18
    const belowTop = anchor.y + rowH
    // The container's own scrollHeight is useless for sizing: once a small
    // maxHeight lands, flex squashes the list to fit and the container only
    // reports that squashed height ever after (the panel never grew — BUGS
    // found on a real machine). The list's scrollHeight, by contrast, always
    // reports the full row content regardless of how small it is squeezed.
    const listEl = el.querySelector('.term-cd-suggest-list') as HTMLElement | null
    const hintEl = el.querySelector('.term-cd-suggest-hint') as HTMLElement | null
    const contentH = (listEl?.scrollHeight ?? 0) + (hintEl?.offsetHeight ?? 0) + 2
    const wanted = Math.max(rowH * 3, Math.min(maxHeight, contentH))
    const spaceBelow = vh - belowTop - 8
    const spaceAbove = anchor.y - 8
    // Open downwards by default (the terminal scrolls, so "below" is where the
    // user is heading); flip above only when that would clip the list.
    const flip = spaceBelow < wanted && spaceAbove > spaceBelow
    const avail = Math.max(rowH * 3, flip ? spaceAbove : spaceBelow)
    const height = Math.min(wanted, avail)
    el.style.maxHeight = `${height}px`
    el.style.top = `${flip ? Math.max(8, anchor.y - height) : belowTop}px`
    const left = Math.min(Math.max(8, anchor.x), Math.max(8, vw - el.offsetWidth - 8))
    el.style.left = `${left}px`
  }, [anchor, maxHeight, items.length, loading, omitted])

  // Keep the highlighted row visible when ↑/↓ walks off the scroll box. `block:
  // 'nearest'` scrolls the minimum amount and does nothing when it already fits.
  useEffect(() => {
    const el = rootRef.current?.querySelector('.term-cd-suggest-row.is-active')
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, items.length])

  // An empty list only ever means "still listing": an empty RESULT closes the
  // panel instead (plan §2 — nothing to act on).
  const hint =
    omitted > 0
      ? t('cdSuggestMore', { n: String(omitted) })
      : items.length === 0 && loading
        ? t('cdSuggestLoading')
        : t('cdSuggestHint')

  return (
    <div
      className="term-cd-suggest"
      ref={rootRef}
      style={{ top: anchor.y + anchor.cellH, left: anchor.x }}
      role="listbox"
      aria-label={t('cdSuggest')}
      // Never take focus from xterm: the keystrokes must keep reaching it.
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="term-cd-suggest-list">
        {items.map((item, i) => (
          <div
            key={item.fullPath}
            className={'term-cd-suggest-row' + (i === activeIndex ? ' is-active' : '')}
            role="option"
            aria-selected={i === activeIndex}
            onMouseEnter={() => onHover(i)}
            onClick={() => onPick(i)}
          >
            {/* The linear folder from the shared icon set, not the 📁 emoji: an
                emoji is a full-colour glyph that ignores the theme and its
                outline weight does not match the 2px stroke every other icon in
                the app is drawn with. */}
            <Icon name="folder" size={12} className="term-cd-suggest-icon" />
            <span className="term-cd-suggest-name">{item.name}</span>
            <span className="term-cd-suggest-path">{item.fullPath}</span>
          </div>
        ))}
      </div>
      <div className="term-cd-suggest-hint">{hint}</div>
    </div>
  )
}

import React, { useEffect, useLayoutEffect, useRef } from 'react'
import { useI18n } from '../../i18n'
import type { GhostCandidate } from './ghostComplete'
import type { CdSuggestAnchor } from './CdSuggestPanel'

export interface GhostSuggestPanelProps {
  items: readonly GhostCandidate[]
  /** What is on the input line — every row starts with it, and it is drawn in the
   *  normal text colour so a row reads as "this prefix + that tail". */
  typed: string
  activeIndex: number
  anchor: CdSuggestAnchor
  onPick: (index: number) => void
  onHover: (index: number) => void
}

/**
 * The candidate list under the caret (Tab opens it). Presentational only: the
 * keystrokes stay Terminal.tsx's business, and the grey tail beside the caret is a
 * separate element (`term-ghost`) that must not disappear when this opens.
 *
 * Placement is the `cd` panel's, duplicated rather than shared: its clamp/flip
 * arithmetic encodes a bug found on a real machine (the container's own
 * `scrollHeight` reports the squashed height once a `maxHeight` applies), and
 * reading it back out for one more caller would couple two features that are
 * otherwise free to evolve apart.
 */
export function GhostSuggestPanel({
  items,
  typed,
  activeIndex,
  anchor,
  onPick,
  onHover,
}: GhostSuggestPanelProps) {
  const { t } = useI18n()
  const rootRef = useRef<HTMLDivElement | null>(null)
  const sourceLabel: Record<GhostCandidate['source'], string> = {
    history: t('ghostSrcHistory'),
    snippet: t('ghostSrcSnippet'),
    set: t('ghostSrcSet'),
    index: t('ghostSrcIndex'),
  }

  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el) return
    const listEl = el.querySelector('.term-ghost-suggest-list') as HTMLElement | null
    const hintEl = el.querySelector('.term-ghost-suggest-hint') as HTMLElement | null
    const rowH = anchor.cellH || 18
    const contentH = (listEl?.scrollHeight ?? 0) + (hintEl?.offsetHeight ?? 0) + 2
    const wanted = Math.max(rowH * 3, Math.min(240, contentH))
    const belowTop = anchor.y + rowH
    const spaceBelow = window.innerHeight - belowTop - 8
    const spaceAbove = anchor.y - 8
    const flip = spaceBelow < wanted && spaceAbove > spaceBelow
    const height = Math.min(wanted, Math.max(rowH * 3, flip ? spaceAbove : spaceBelow))
    el.style.maxHeight = `${height}px`
    el.style.top = `${flip ? Math.max(8, anchor.y - height) : belowTop}px`
    el.style.left = `${Math.min(Math.max(8, anchor.x), Math.max(8, window.innerWidth - el.offsetWidth - 8))}px`
  }, [anchor, items.length])

  useEffect(() => {
    const el = rootRef.current?.querySelector('.term-ghost-suggest-row.is-active')
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, items.length])

  return (
    <div
      className="term-ghost-suggest"
      ref={rootRef}
      role="listbox"
      aria-label={t('ghostSuggest')}
      // Never take focus from xterm: the keystrokes must keep reaching it.
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="term-ghost-suggest-list">
        {items.map((item, i) => (
          <div
            key={`${item.source}:${item.command}`}
            className={'term-ghost-suggest-row' + (i === activeIndex ? ' is-active' : '')}
            role="option"
            aria-selected={i === activeIndex}
            onMouseEnter={() => onHover(i)}
            onClick={() => onPick(i)}
          >
            <span className="term-ghost-suggest-cmd">
              <span className="term-ghost-suggest-typed">
                {item.command.slice(0, typed.length)}
              </span>
              {item.command.slice(typed.length)}
            </span>
            <span className="term-ghost-suggest-src" title={item.label || undefined}>
              {item.label
                ? `${sourceLabel[item.source]} · ${item.label}`
                : sourceLabel[item.source]}
            </span>
          </div>
        ))}
      </div>
      <div className="term-ghost-suggest-hint">{t('ghostSuggestHint')}</div>
    </div>
  )
}

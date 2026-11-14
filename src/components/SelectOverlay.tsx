import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * Custom popup for native <select> elements.
 *
 * Windows WebView2 draws a <select>'s expanded list with the OS widget: the row
 * highlight stays light grey even with `color-scheme: dark`, which reads as a
 * white flash on the dark panel. No amount of CSS on `option` reaches it.
 *
 * Rather than replacing all 46 call sites (and their e2e `selectOption` calls),
 * this intercepts the mousedown that would open the native popup, prevents it,
 * and renders a themed listbox instead. The <select> stays in the DOM with its
 * own value, options, optgroups, form semantics and React `onChange` — choosing
 * a row writes through the native `value` setter and dispatches `change`.
 *
 * Keyboard (arrows / Enter / Escape) and outside-click closing are handled here;
 * `select[multiple]`, `select[size>1]`, disabled selects and any select marked
 * `data-native-select` keep the browser's own behaviour.
 */

interface MenuItem {
  value: string
  label: string
  disabled: boolean
  /** `optgroup` label, or null for a top-level option. */
  group: string | null
}

interface OpenMenu {
  select: HTMLSelectElement
  items: MenuItem[]
  rect: DOMRect
}

function readItems(select: HTMLSelectElement): MenuItem[] {
  const out: MenuItem[] = []
  for (const child of Array.from(select.children)) {
    if (child instanceof HTMLOptGroupElement) {
      for (const opt of Array.from(child.children)) {
        if (opt instanceof HTMLOptionElement) {
          out.push({
            value: opt.value,
            label: opt.text,
            disabled: opt.disabled,
            group: child.label,
          })
        }
      }
    } else if (child instanceof HTMLOptionElement) {
      out.push({ value: child.value, label: child.text, disabled: child.disabled, group: null })
    }
  }
  return out
}

export function SelectOverlay() {
  const [open, setOpen] = useState<OpenMenu | null>(null)
  const [active, setActive] = useState(0)
  const menuRef = useRef<HTMLDivElement>(null)
  // Read inside document-level listeners without re-binding them every render.
  const openRef = useRef<OpenMenu | null>(null)
  openRef.current = open
  const activeRef = useRef(0)
  activeRef.current = active

  const close = useCallback(() => setOpen(null), [])

  const openMenu = useCallback((select: HTMLSelectElement) => {
    const items = readItems(select)
    if (items.length === 0) return
    setOpen({ select, items, rect: select.getBoundingClientRect() })
    const selected = items.findIndex((i) => i.value === select.value && !i.disabled)
    setActive(selected >= 0 ? selected : items.findIndex((i) => !i.disabled))
    select.focus()
  }, [])

  const choose = useCallback(
    (menu: OpenMenu, item: MenuItem) => {
      if (item.disabled) return
      const { select } = menu
      // React installs a value tracker on the element. Writing `select.value`
      // directly updates that tracker too, so the following `change` would look
      // like a no-op to React. Go through the native prototype setter.
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
      setter?.call(select, item.value)
      select.dispatchEvent(new Event('change', { bubbles: true }))
      select.focus()
      close()
    },
    [close],
  )

  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Element | null
      if (target?.closest?.('.wl-select-menu')) return
      const select = target?.closest?.('select') as HTMLSelectElement | null
      if (
        !select ||
        e.button !== 0 ||
        select.disabled ||
        select.multiple ||
        select.size > 1 ||
        select.hasAttribute('data-native-select')
      ) {
        return
      }
      // Preventing mousedown is what stops WebView2 from opening its own popup.
      e.preventDefault()
      if (openRef.current?.select === select) {
        close()
        return
      }
      openMenu(select)
    }

    // A focused select also opens the OS popup on Enter / Space / Alt+Arrow /
    // F4. Those must go through the custom menu too, otherwise a keyboard user
    // still lands on the light-grey highlight. Plain Arrow keys stay native —
    // they change the value without opening a popup.
    const onKeyDown = (e: KeyboardEvent) => {
      if (openRef.current) return
      const select = (e.target as Element | null)?.closest?.('select') as HTMLSelectElement | null
      if (
        !select ||
        select.disabled ||
        select.multiple ||
        select.size > 1 ||
        select.hasAttribute('data-native-select')
      ) {
        return
      }
      const opens =
        e.key === 'Enter' ||
        e.key === ' ' ||
        e.key === 'F4' ||
        (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp'))
      if (!opens) return
      e.preventDefault()
      openMenu(select)
    }

    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Element | null
      if (target?.closest?.('.wl-select-menu') || target?.closest?.('select')) return
      close()
    }

    const onScroll = (e: Event) => {
      // Scrolling the menu itself (long lists, and the initial scroll-into-view
      // of the selected row) must not dismiss it; scrolling the page underneath
      // should, since the anchor would be in the wrong place afterwards.
      const target = e.target as Element | null
      if (target === menuRef.current || menuRef.current?.contains(target)) return
      close()
    }

    const onResize = () => close()

    document.addEventListener('mousedown', onMouseDown, true)
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('mousedown', onMouseDown, true)
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
    }
  }, [close, openMenu])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        close()
        return
      }
      if (e.key === 'Tab') {
        close()
        return
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const step = e.key === 'ArrowDown' ? 1 : -1
        setActive((cur) => {
          let next = cur
          for (let i = 0; i < open.items.length; i++) {
            next = (next + step + open.items.length) % open.items.length
            if (!open.items[next].disabled) break
          }
          return next
        })
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        const item = open.items[activeRef.current]
        if (item) choose(open, item)
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [open, close, choose])

  // Position after measuring, so a menu near the bottom flips above the select
  // and never runs off the viewport.
  useLayoutEffect(() => {
    const el = menuRef.current
    if (!open || !el) return
    const h = el.getBoundingClientRect().height
    const r = open.rect
    const below = r.bottom + 4 + h <= window.innerHeight - 8
    el.style.left = `${r.left}px`
    el.style.top = `${below ? r.bottom + 4 : Math.max(8, r.top - h - 4)}px`
    el.style.minWidth = `${r.width}px`
    el.style.maxHeight = `${below ? window.innerHeight - r.bottom - 12 : r.top - 12}px`
    const selected = el.querySelector('.wl-select-option.selected')
    selected?.scrollIntoView({ block: 'nearest' })
  }, [open, active])

  if (!open) return null

  return createPortal(
    <div
      ref={menuRef}
      className="wl-select-menu"
      role="listbox"
      aria-label={open.select.getAttribute('aria-label') ?? undefined}
      onMouseDown={(e) => e.preventDefault()}
    >
      {open.items.map((item, i) => (
        <Fragment key={`${i}:${item.value}`}>
          {item.group && (i === 0 || open.items[i - 1].group !== item.group) && (
            <div className="wl-select-group" role="presentation">
              {item.group}
            </div>
          )}
          <div
            className={
              'wl-select-option' +
              (item.value === open.select.value ? ' selected' : '') +
              (i === active ? ' active' : '') +
              (item.disabled ? ' disabled' : '')
            }
            role="option"
            aria-selected={item.value === open.select.value}
            onMouseEnter={() => !item.disabled && setActive(i)}
            onClick={(e) => {
              e.stopPropagation()
              choose(open, item)
            }}
          >
            {item.label}
          </div>
        </Fragment>
      ))}
    </div>,
    document.body,
  )
}

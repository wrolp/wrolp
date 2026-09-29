import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ConnectionConfig } from '../types'
import { listCommandSnippets } from '../commands'
import { useI18n } from '../i18n'
import { Icon } from './Icon'

/**
 * The Ctrl+K command palette — v8's single entry point for "go somewhere or do
 * something", which is why the titlebar carries nothing but this trigger.
 *
 * It is deliberately *not* a modal: it holds no state the user could lose, so
 * Esc and the explicit close button are the only ways out (the repo-wide rule
 * against closing a dialog by clicking its scrim applies here too).
 */
export interface CommandPaletteProps {
  open: boolean
  onClose: () => void
  connections: ConnectionConfig[]
  onOpenConnection: (conn: ConnectionConfig) => void
  /** Runs a literal command line in the focused terminal. */
  onRunCommand: (command: string) => void
  onOpenCommandList: () => void
  onNewConnection: () => void
  onScanNetwork: () => void
  onOpenSettings: () => void
  onOpenAi: () => void
  /** Opens the dual-pane file view (v8-P5). */
  onOpenDualPane: () => void
}

type Entry = {
  id: string
  icon:
    | 'server'
    | 'terminal'
    | 'plus'
    | 'network'
    | 'clipboard'
    | 'settings'
    | 'sparkles'
    | 'transfer'
  title: string
  sub?: string
  /** Matched against the query together with `title`. */
  keywords?: string
  run: () => void
  /** Shown on the right of the row — a connection's live session count. */
  badge?: string
}

export function CommandPalette({
  open,
  onClose,
  connections,
  onOpenConnection,
  onRunCommand,
  onOpenCommandList,
  onNewConnection,
  onScanNetwork,
  onOpenSettings,
  onOpenAi,
  onOpenDualPane,
}: CommandPaletteProps) {
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const [snippets, setSnippets] = useState<
    { id: string; command: string; alias: string | null; description: string | null }[]
  >([])
  const inputRef = useRef<HTMLInputElement>(null)
  const resultsRef = useRef<HTMLDivElement>(null)

  // Snippets live in the command list's own store, so the palette reads them
  // itself — and only while open, so a window that never opens the palette never
  // pays for the query.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    void (async () => {
      try {
        const list = await listCommandSnippets()
        if (cancelled) return
        setSnippets(
          list
            // A snippet with parameters needs its fill dialog to produce a
            // runnable line; offering it here would send `${x}` to the shell.
            .filter((s) => !s.hidden && (s.params?.length ?? 0) === 0)
            .map((s) => ({
              id: s.id,
              command: s.command,
              alias: s.alias,
              description: s.description,
            })),
        )
      } catch {
        if (!cancelled) setSnippets([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    setQuery('')
    setSelected(0)
    // Autofocus after the mount so the first keystroke lands in the input.
    const id = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(id)
  }, [open])

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const hit = (...fields: (string | undefined)[]) =>
      !q || fields.some((f) => (f ?? '').toLowerCase().includes(q))

    const hosts: Entry[] = connections
      .filter((c) => hit(c.name, c.host, c.username))
      .map((c) => ({
        id: `host:${c.id}`,
        icon: 'server' as const,
        title: c.name,
        sub: `${c.username ? `${c.username}@` : ''}${c.host}:${c.port}`,
        keywords: `${c.name} ${c.host}`,
        run: () => onOpenConnection(c),
      }))

    const commands: Entry[] = snippets
      .filter((s) => hit(s.command, s.alias ?? undefined, s.description ?? undefined))
      .map((s) => ({
        id: `cmd:${s.id}`,
        icon: 'terminal' as const,
        title: s.alias || s.command,
        sub: s.alias ? s.command : t('paletteRunInTerminal'),
        keywords: `${s.command} ${s.alias ?? ''} ${s.description ?? ''}`,
        run: () => onRunCommand(s.command),
      }))

    const actions: Entry[] = [
      { id: 'act:new', icon: 'plus', title: t('paletteNewConnection'), run: onNewConnection },
      {
        id: 'act:list',
        icon: 'clipboard',
        title: t('paletteOpenCommandList'),
        run: onOpenCommandList,
      },
      {
        id: 'act:dual',
        icon: 'transfer',
        title: t('paletteOpenDualPane'),
        sub: t('paletteOpenDualPaneSub'),
        run: onOpenDualPane,
      },
      { id: 'act:scan', icon: 'network', title: t('paletteScanNetwork'), run: onScanNetwork },
      { id: 'act:ai', icon: 'sparkles', title: t('paletteOpenAi'), run: onOpenAi },
      {
        id: 'act:settings',
        icon: 'settings',
        title: t('paletteOpenSettings'),
        run: onOpenSettings,
      },
    ].filter((a) => hit(a.title)) as Entry[]

    return [
      { label: t('railHosts'), entries: hosts },
      { label: t('paletteGroupCommands'), entries: commands },
      { label: t('paletteGroupActions'), entries: actions },
    ].filter((g) => g.entries.length > 0)
  }, [
    query,
    connections,
    snippets,
    t,
    onOpenConnection,
    onRunCommand,
    onNewConnection,
    onOpenCommandList,
    onScanNetwork,
    onOpenAi,
    onOpenSettings,
    onOpenDualPane,
  ])

  const flat = useMemo(() => groups.flatMap((g) => g.entries), [groups])

  useEffect(() => {
    setSelected((prev) => Math.min(prev, Math.max(0, flat.length - 1)))
  }, [flat.length])

  // Keep the selected row in view when the selection moves by keyboard.
  useEffect(() => {
    const el = resultsRef.current?.querySelector<HTMLElement>('.pal-row.is-selected')
    el?.scrollIntoView({ block: 'nearest' })
  }, [selected, flat.length])

  const runAt = useCallback(
    (index: number) => {
      const entry = flat[index]
      if (!entry) return
      // Close first: the action usually changes what the window shows, and a
      // palette sitting on top of it would swallow the result.
      onClose()
      entry.run()
    },
    [flat, onClose],
  )

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelected((p) => (flat.length === 0 ? 0 : (p + 1) % flat.length))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelected((p) => (flat.length === 0 ? 0 : (p - 1 + flat.length) % flat.length))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      runAt(selected)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  if (!open) return null

  let cursor = -1

  return createPortal(
    <div className="palette-overlay" role="presentation">
      <div className="palette-scrim" />
      <div
        className="palette-panel"
        role="dialog"
        aria-modal="true"
        aria-label={t('commandPalette')}
      >
        <div className="pal-inputrow">
          <Icon name="search" size={18} className="pal-search-ic" />
          <input
            ref={inputRef}
            className="pal-input"
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t('commandPalettePlaceholder')}
            aria-label={t('commandPalettePlaceholder')}
            spellCheck={false}
          />
          <button
            type="button"
            className="pal-close"
            onClick={onClose}
            title={t('close')}
            aria-label={t('close')}
          >
            <Icon name="x" size={16} />
          </button>
        </div>

        <div className="pal-results" ref={resultsRef}>
          {flat.length === 0 && <div className="pal-empty">{t('paletteEmpty')}</div>}
          {groups.map((g) => (
            <div className="pal-group" key={g.label}>
              <div className="pal-group-label">{g.label}</div>
              {g.entries.map((entry) => {
                cursor += 1
                const index = cursor
                const active = index === selected
                return (
                  <div
                    key={entry.id}
                    className={`pal-row${active ? ' is-selected' : ''}`}
                    onMouseMove={() => setSelected(index)}
                    onClick={() => runAt(index)}
                  >
                    <Icon name={entry.icon} size={16} className="pal-ic" />
                    <div className="pal-main">
                      <div className={`pal-title${entry.icon === 'terminal' ? ' mono' : ''}`}>
                        {entry.title}
                      </div>
                      {entry.sub && <div className="pal-sub mono">{entry.sub}</div>}
                    </div>
                    {entry.badge && <span className="pal-state">{entry.badge}</span>}
                  </div>
                )
              })}
            </div>
          ))}
        </div>

        <div className="pal-foot">
          <span className="pal-hint">
            <kbd className="pal-kbd">↑↓</kbd>
            {t('paletteHintNav')}
          </span>
          <span className="pal-hint">
            <kbd className="pal-kbd">↵</kbd>
            {t('paletteHintRun')}
          </span>
          <span className="pal-hint">
            <kbd className="pal-kbd">ESC</kbd>
            {t('close')}
          </span>
        </div>
      </div>
    </div>,
    document.body,
  )
}

// Settings → Shortcuts. One row per action the app binds, with a recorder that
// writes straight into the registry (`src/lib/keybindings.ts`) — the same table
// the listeners read, so a rebound combo takes effect on the next keystroke and
// the hints elsewhere (titlebar, tooltips) change with it.
//
// The recorder listens in the CAPTURE phase on `window`: the global listener in
// App.tsx is a document-bubble listener, so without capture the very combo being
// recorded would also trigger the action it is being assigned to.

import { useEffect, useMemo, useState } from 'react'
import { useI18n } from '../i18n'
import type { TranslationKey } from '../i18n/en'
import { Icon } from './Icon'
import { useShortcutsVersion } from '../hooks/useShortcuts'
import {
  bindingFromEvent,
  bindingOf,
  defaultBindingOf,
  findConflicts,
  formatBinding,
  isOverridden,
  parseBinding,
  resetAllBindings,
  resetBinding,
  serializedOf,
  setBinding,
  shortcutDefs,
  type ShortcutActionId,
  type ShortcutCheck,
  type ShortcutGroup,
  type ShortcutRejection,
} from '../lib/keybindings'

const GROUP_META: { key: ShortcutGroup; title: TranslationKey; desc: TranslationKey }[] = [
  { key: 'panel', title: 'shortcutGroupPanel', desc: 'shortcutGroupPanelDesc' },
  { key: 'command', title: 'shortcutGroupCommand', desc: 'shortcutGroupCommandDesc' },
  { key: 'terminal', title: 'shortcutGroupTerminal', desc: 'shortcutGroupTerminalDesc' },
  { key: 'editor', title: 'shortcutGroupEditor', desc: 'shortcutGroupEditorDesc' },
  { key: 'overlay', title: 'shortcutGroupOverlay', desc: 'shortcutGroupOverlayDesc' },
]

/** What a row shows under it: a refusal, or a binding that took effect with a caveat. */
interface RowNotice {
  id: ShortcutActionId
  kind: 'error' | 'caution'
  text: string
}

export function ShortcutsPane() {
  const { t } = useI18n()
  // Re-read the table on every change; the rows are rendered from it directly.
  useShortcutsVersion()
  const [recording, setRecording] = useState<ShortcutActionId | null>(null)
  const [notice, setNotice] = useState<RowNotice | null>(null)
  const [query, setQuery] = useState('')

  /** Why a combo was refused, in the user's language. `combo` is the one they
   *  just pressed — the action still holds its previous binding. */
  const rejectionText = (error: ShortcutRejection): string => {
    if (error.reason === 'conflict') {
      const other = shortcutDefs().find((d) => d.id === error.otherId)
      return t('shortcutErrConflict', { action: other ? t(other.titleKey) : error.otherId })
    }
    if (error.reason === 'reservedKey') return t('shortcutErrReserved')
    return t('shortcutErrModifier')
  }

  useEffect(() => {
    if (!recording) return
    const onKey = (e: KeyboardEvent) => {
      // Swallow everything while recording: the keystroke is an answer, not a
      // command. `Esc` cancels rather than binding, which is how every recorder
      // in this app behaves — to move an action onto Esc, bind it elsewhere first.
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setRecording(null)
        setNotice(null)
        return
      }
      const binding = bindingFromEvent(e)
      // A lone modifier is not a combo yet; wait for the key that goes with it.
      if (!binding) return
      const check: ShortcutCheck = setBinding(recording, binding)
      if (check.ok) {
        setNotice(
          check.caution === 'shell'
            ? { id: recording, kind: 'caution', text: t('shortcutShellCaution') }
            : null,
        )
      } else {
        setNotice({
          id: recording,
          kind: 'error',
          text: rejectionText(check.error),
        })
      }
      setRecording(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording, t])

  const needle = query.trim().toLowerCase()
  const rows = useMemo(() => {
    if (!needle) return GROUP_META.map((g) => ({ ...g, defs: shortcutDefs(g.key) }))
    return GROUP_META.map((g) => ({
      ...g,
      defs: shortcutDefs(g.key).filter((def) => {
        const label = formatBinding(bindingOf(def.id)).toLowerCase()
        const combo = (serializedOf(def.id) ?? '').toLowerCase()
        return (
          t(def.titleKey).toLowerCase().includes(needle) ||
          t(def.descKey).toLowerCase().includes(needle) ||
          label.includes(needle) ||
          combo.includes(needle) ||
          def.id.includes(needle)
        )
      }),
    })).filter((g) => g.defs.length > 0)
  }, [needle, t])

  // Only reachable from a hand-edited `wrolp-shortcuts`, but a silent collision
  // between two actions is worth saying out loud.
  const conflicts = findConflicts()
  const anyOverridden = shortcutDefs().some((d) => isOverridden(d.id))

  return (
    <div className="settings-card shortcut-card">
      <div className="settings-card-header">
        <div className="settings-card-icon">
          <Icon name="keyboard" size={18} />
        </div>
        <div>
          <h3 className="settings-card-title">{t('settingsPaneShortcuts')}</h3>
          <p className="settings-card-sub">{t('shortcutsCardSub')}</p>
        </div>
      </div>

      <div className="shortcut-toolbar">
        <input
          className="settings-input shortcut-search"
          type="search"
          value={query}
          placeholder={t('shortcutSearchPlaceholder')}
          aria-label={t('shortcutSearchPlaceholder')}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button
          type="button"
          className="shortcut-reset-all"
          disabled={!anyOverridden}
          onClick={() => {
            resetAllBindings()
            setNotice(null)
            setRecording(null)
          }}
        >
          {t('shortcutResetAll')}
        </button>
      </div>

      {conflicts.length > 0 && (
        <p className="shortcut-notice error">
          {t('shortcutConflictBanner', {
            combo: formatBinding(parseBinding(conflicts[0].serialized)),
          })}
        </p>
      )}

      {rows.length === 0 && <p className="shortcut-empty">{t('shortcutNoMatch')}</p>}

      {rows.map((group) => (
        <div className="shortcut-group" key={group.key}>
          <div className="shortcut-group-header">
            <h4>{t(group.title)}</h4>
            <p>{t(group.desc)}</p>
          </div>
          {group.defs.map((def) => {
            const binding = bindingOf(def.id)
            const isRecording = recording === def.id
            const rowNotice = notice?.id === def.id ? notice : null
            const showDefault = isOverridden(def.id) && defaultBindingOf(def.id) !== null
            return (
              <div className={'shortcut-row' + (isRecording ? ' recording' : '')} key={def.id}>
                <div className="shortcut-info">
                  <span className="shortcut-name">{t(def.titleKey)}</span>
                  <span className="shortcut-desc">{t(def.descKey)}</span>
                  {showDefault && (
                    <span className="shortcut-default">
                      {t('shortcutDefaultIs', { combo: formatBinding(defaultBindingOf(def.id)) })}
                    </span>
                  )}
                  {rowNotice && (
                    <span className={`shortcut-notice ${rowNotice.kind}`}>{rowNotice.text}</span>
                  )}
                </div>
                <div className="shortcut-tools">
                  {isOverridden(def.id) && (
                    <button
                      type="button"
                      className="shortcut-tool shortcut-reset"
                      title={t('shortcutResetOne')}
                      onClick={() => {
                        resetBinding(def.id)
                        setNotice(null)
                      }}
                    >
                      <Icon name="undo" size={13} />
                    </button>
                  )}
                  <button
                    type="button"
                    className={'shortcut-kbd' + (isRecording ? ' recording' : '')}
                    title={t('shortcutRecorderHelp')}
                    onClick={() => {
                      setNotice(null)
                      setRecording(isRecording ? null : def.id)
                    }}
                  >
                    {isRecording ? (
                      <span className="shortcut-press">{t('shortcutPressKeys')}</span>
                    ) : (
                      <kbd>{formatBinding(binding)}</kbd>
                    )}
                  </button>
                  {binding && (
                    <button
                      type="button"
                      className="shortcut-tool shortcut-clear"
                      title={t('shortcutUnbind')}
                      onClick={() => {
                        setBinding(def.id, null)
                        setNotice(null)
                      }}
                    >
                      <Icon name="x" size={13} />
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}

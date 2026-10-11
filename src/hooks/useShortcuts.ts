// React access to the shortcut table. The registry is a plain module (native
// keydown listeners read it, not hooks), so components need a subscription
// rather than a state copy — otherwise a tooltip would keep showing the combo
// the user just rebound away.

import { useSyncExternalStore } from 'react'
import {
  getShortcutsVersion,
  shortcutLabel,
  subscribeShortcuts,
  type ShortcutActionId,
} from '../lib/keybindings'

export function useShortcutsVersion(): number {
  return useSyncExternalStore(subscribeShortcuts, getShortcutsVersion, getShortcutsVersion)
}

/** The live, formatted combo for one action — `Ctrl+Shift+P`. */
export function useShortcutLabel(id: ShortcutActionId): string {
  useShortcutsVersion()
  return shortcutLabel(id)
}

// Ask-before-close guard: when a terminal tab / pane is closed while it still
// has open files (and possibly unsaved edits), confirm first instead of silently
// discarding them. See task/todo.md → 「有打开文件时关闭终端/pane 需二次确认」.
//
// Display-only preference → localStorage, following the other UI prefs
// (`wrolp-terminal-highlight`, `wrolp-paste-guard`, …) — no Rust / window.json.

const STORAGE_KEY = 'wrolp-confirm-close-terminal'

/** Default ON: the whole point is to stop an accidental click from silently
 *  throwing away open files / unsaved edits. */
export const CONFIRM_CLOSE_DEFAULT = true

export function loadConfirmCloseTerminal(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw === null ? CONFIRM_CLOSE_DEFAULT : raw === '1'
  } catch {
    return CONFIRM_CLOSE_DEFAULT
  }
}

export function saveConfirmCloseTerminal(enabled: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0')
  } catch {
    /* storage unavailable — keep running with the in-memory value */
  }
}

// Editor display preferences, shared by Monaco (`FileEditor`) and the hex dump
// viewer (`HexViewer`).
//
// Display-only → localStorage, the same precedent as `wrolp-paste-guard` /
// `wrolp-terminal-*` / `wrolp-docker-*`: no Rust / window.json involvement.
//
// `scrollBeyondLastLine` defaults to ON — it leaves one screen of room after the
// last line so the tail of a file can be scrolled up to the top of the viewport
// (Monaco would otherwise pin the last line to the bottom edge and stop there).

/** localStorage keys — a user-data contract, never rename them. */
export const EDITOR_PREF_KEYS = {
  scrollBeyondLastLine: 'wrolp-editor-scroll-beyond-last-line',
  wordWrap: 'wrolp-editor-word-wrap',
} as const

export interface EditorPrefs {
  /** Room after the last line, so the tail can be scrolled to the top. */
  scrollBeyondLastLine: boolean
  /** Soft-wrap long lines (display only — the file itself is untouched). */
  wordWrap: boolean
}

export const EDITOR_PREFS_DEFAULTS: EditorPrefs = {
  scrollBeyondLastLine: true,
  wordWrap: false,
}

type Listener = (prefs: EditorPrefs) => void
const listeners = new Set<Listener>()

/** Flags are stored as '1' / '0' (like `wrolp-docker-*`); a missing key — a fresh
 *  install or a cleared profile — falls back to the default. */
function readFlag(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key)
    return raw === null ? fallback : raw === '1'
  } catch {
    return fallback
  }
}

function writeFlag(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? '1' : '0')
  } catch {
    // Storage unavailable — keep running with the in-memory value.
  }
}

export function loadEditorPrefs(): EditorPrefs {
  return {
    scrollBeyondLastLine: readFlag(
      EDITOR_PREF_KEYS.scrollBeyondLastLine,
      EDITOR_PREFS_DEFAULTS.scrollBeyondLastLine,
    ),
    wordWrap: readFlag(EDITOR_PREF_KEYS.wordWrap, EDITOR_PREFS_DEFAULTS.wordWrap),
  }
}

/** Write a subset of the preferences, notify subscribers, and return the result. */
export function saveEditorPrefs(patch: Partial<EditorPrefs>): EditorPrefs {
  if (patch.scrollBeyondLastLine !== undefined) {
    writeFlag(EDITOR_PREF_KEYS.scrollBeyondLastLine, patch.scrollBeyondLastLine)
  }
  if (patch.wordWrap !== undefined) {
    writeFlag(EDITOR_PREF_KEYS.wordWrap, patch.wordWrap)
  }
  const next = loadEditorPrefs()
  for (const fn of [...listeners]) fn(next)
  return next
}

export function subscribeEditorPrefs(fn: Listener): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

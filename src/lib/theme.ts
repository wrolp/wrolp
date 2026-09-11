// Central palette dispatch for everything that paints OUTSIDE CSS.
//
// CSS follows the theme automatically through the `--token` layer
// (src/styles/_theme.scss), but xterm.js and Monaco own their colours in JS, so
// they must be handed a palette and re-applied on every theme change. Keeping the
// palettes here — instead of inline in each component — is also what fixes the
// pre-existing duplication between Terminal.tsx and SessionViewer.tsx.
//
// Note (xterm): the terminal background must stay OPAQUE. xterm alpha-blends
// shell-rendered cell backgrounds (e.g. powerlevel10k prompt blocks) against the
// theme background, so a translucent value makes those colours look wrong.

import type { ITheme } from '@xterm/xterm'
import type { ResolvedTheme } from './themeStore'

// Kept verbatim from the pre-theme code so the dark terminal is unchanged.
const DARK_XTERM_THEME: ITheme = {
  background: '#1e1e1e',
  foreground: '#ffffff',
  cursor: '#aeafad',
  selectionBackground: '#264f78',
  black: '#a0a0a0',
  red: '#f44747',
  green: '#3a8558',
  yellow: '#dcdcaa',
  blue: '#5b7fb5',
  magenta: '#c586c0',
  cyan: '#4dc9b0',
  white: '#ffffff',
  brightBlack: '#808080',
  brightRed: '#f44747',
  brightGreen: '#4daa6a',
  brightYellow: '#dcdcaa',
  brightBlue: '#5b7fb5',
  brightMagenta: '#d4a0d4',
  brightCyan: '#6ae6cc',
  brightWhite: '#ffffff',
}

// VS Code "Light+" terminal palette — the light counterpart of the above, so
// shells' ANSI colours stay legible on white.
const LIGHT_XTERM_THEME: ITheme = {
  background: '#ffffff',
  foreground: '#1f1f1f',
  cursor: '#1f1f1f',
  selectionBackground: '#add6ff',
  black: '#000000',
  red: '#cd3131',
  green: '#00bc00',
  yellow: '#949800',
  blue: '#0451a5',
  magenta: '#bc05bc',
  cyan: '#0598bc',
  white: '#555555',
  brightBlack: '#666666',
  brightRed: '#cd3131',
  brightGreen: '#14ce14',
  brightYellow: '#b5ba00',
  brightBlue: '#0451a5',
  brightMagenta: '#bc05bc',
  brightCyan: '#0598bc',
  brightWhite: '#a5a5a5',
}

/** xterm palette for the given theme. */
export function xtermTheme(theme: ResolvedTheme): ITheme {
  return theme === 'light' ? LIGHT_XTERM_THEME : DARK_XTERM_THEME
}

/**
 * Monaco theme id. `'vs'` / `'vs-dark'` are Monaco's built-in light/dark themes —
 * sufficient here, and they keep the editor's syntax colours consistent with the
 * `termHighlight` token palette used for `cat` output in the terminal.
 */
export function monacoThemeId(theme: ResolvedTheme): 'vs' | 'vs-dark' {
  return theme === 'light' ? 'vs' : 'vs-dark'
}

// NOTE: the terminal's *output highlighting* palettes (src/lib/ansi.ts,
// src/lib/termHighlight.ts, src/lib/cmdEcho.ts) and the configurable
// highlightRules schemes still carry dark-only values — they are the remaining
// work in task/plans/light-theme-plan.md (P3). Until then those features keep
// their dark colours while the surrounding UI switches.

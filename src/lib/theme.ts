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

// The ANSI 16 below are deliberately NOT the v5 status colours: `sgrContrast`'s
// dircolors guard (B29) is calibrated against these exact values, and the shell's
// own colour choices are not ours to re-tint. Only the *base* pair moves, and it
// has to, because xterm paints its own canvas — a `#1e1e1e` rectangle inside a
// `#0e1116` pane is the first thing you see.
//
// Two entries moved after real sessions, both for the same reason: prompts paint
// ANSI colours as *backgrounds* as well as text, and a palette tuned only for text
// makes those blocks unreadable.
//
//   `black`  was `#a0a0a0` — a light grey, chosen so SGR 30 *text* stays visible on
//            a dark pane. But a prompt draws its segments with `48;5;0`/SGR 40, so
//            that light grey became a pale pill, and the red text on it measured
//            1.15:1 — "看不清". It is now a dark surface, which is what a terminal
//            background colour is for. Cost: SGR 30 *text* is dim on the pane
//            (1.6:1); that is how every other terminal behaves, and the ANSI→HTML
//            renderer (`ansi.ts`) already maps 30 to the base foreground.
//
//   red      was `#f44747` (0.89 saturation), reported as eye-searing — and the
//            glare was partly the pale pill above. Now `#e27474` / `#ea7d7d`: 6.3:1
//            and 7.0:1 on `#0e1116` (more legible than before) at ~0.65 saturation.
//            Both dials matter — do not take luminance down or chroma below ~0.6.
const DARK_XTERM_THEME: ITheme = {
  background: '#0e1116',
  foreground: '#e7edf3',
  cursor: '#aeafad',
  selectionBackground: '#264f78',
  black: '#33363c',
  red: '#e27474',
  green: '#3a8558',
  yellow: '#dcdcaa',
  blue: '#5b7fb5',
  magenta: '#c586c0',
  cyan: '#4dc9b0',
  white: '#ffffff',
  brightBlack: '#808080',
  brightRed: '#ea7d7d',
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

/** Theme keys in SGR order: indices 0–7, then the bright 8–15. */
const SGR_COLOR_KEYS = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
] as const

/**
 * The SGR-addressable colours of a terminal theme, for callers that reason about
 * colour *values* outside CSS (a renderer can't — see terminal/sgrContrast.ts).
 * Pass the live theme (`term.options.theme`) so a palette switch is picked up.
 */
export interface AnsiThemeColors {
  /** Hex colours for SGR indices 0–15, in SGR order (index 0 = `black`). */
  colors: Array<string | undefined>
  /** Default foreground — SGR 39, or a cell with no foreground set. */
  foreground: string
}

export function ansiThemeColors(theme: ITheme | undefined): AnsiThemeColors {
  const t = theme ?? DARK_XTERM_THEME
  return {
    colors: SGR_COLOR_KEYS.map((key) => t[key]),
    foreground: t.foreground ?? '#ffffff',
  }
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

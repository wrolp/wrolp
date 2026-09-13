// Legibility guard for SGR colour pairs that live on a *background* colour.
//
// GNU `ls --color` (dircolors) flags "dangerous" entries with a background:
//   OTHER_WRITABLE        34;42  (world-writable dir — blue on green)
//   STICKY_OTHER_WRITABLE 30;42
//   SUID                  37;41
//   SGID                  30;43
// Those pairs are picked for a plain white-on-black terminal, so on our themed
// palettes some of them are unreadable — a world-writable directory in the dark
// palette is #5b7fb5 on #3a8558, i.e. 1.1:1 (reported from a real session:
// `storage` / `Tracker2`, both `drwxrwxrwx`).
//
// The background is the message ("this one is world-writable"), so we keep it
// and replace the foreground with whichever of black/white reads best on it —
// that is always ≥ 4.5:1. Everything else is passed through byte-for-byte.
//
// Scope is deliberately narrow: a sequence is only touched when it *determines
// both* colours itself (an explicit foreground, or an explicit default-
// foreground `39`, plus a background). Otherwise the effective foreground is
// whatever an earlier sequence left in effect, and rewriting on a guess could
// repaint output that was already fine. We also only intervene below 3:1, so a
// shell's own low-contrast-but-readable choices stay as the author intended.
//
// NOTE: xterm's `minimumContrastRatio` is deliberately left at 1. That option
// rewrites *every* cell below the ratio, which would silently override the
// themed palette and our injected 24-bit highlight colours everywhere, not just
// these dircolors pairs.

import type { AnsiThemeColors } from '../../lib/theme'

export interface Rgb {
  r: number
  g: number
  b: number
}

/** Below this ratio we consider text unreadable and step in (WCAG AA, large text). */
export const MIN_CONTRAST_RATIO = 3

const WHITE: Rgb = { r: 255, g: 255, b: 255 }
const BLACK: Rgb = { r: 0, g: 0, b: 0 }

/** 6×6×6 cube levels used by xterm's 256-colour palette. */
const CUBE_LEVELS = [0, 95, 135, 175, 215, 255]

interface Scan {
  /** Foreground in effect, when the sequence itself decides it. */
  fg: Rgb | null
  /** Background in effect, when the sequence sets one we can resolve. */
  bg: Rgb | null
  /** True when the sequence sets an explicit foreground or `39`. */
  fgKnown: boolean
  /** Params to re-emit verbatim: everything except a resolvable foreground. */
  rest: number[]
}

/**
 * Rewrite unreadable `fg;bg` pairs in a chunk of shell output. Pure: the same
 * input always produces the same output, so replaying a recorded session shows
 * the same colours as the live one.
 */
export function fixLowContrastSgr(chunk: string, theme: AnsiThemeColors): string {
  if (!chunk.includes('\x1b[')) return chunk
  // Fresh regex per call: no shared `lastIndex` state.
  return chunk.replace(/\x1b\[([0-9;]*)m/g, (seq, raw: string) => {
    const params = (raw === '' ? '0' : raw).split(';').map((s) => (s === '' ? 0 : Number(s)))
    if (params.some((n) => !Number.isFinite(n))) return seq

    const { fg, bg, fgKnown, rest } = scan(params, theme)
    if (!fg || !bg || !fgKnown) return seq
    if (contrastRatio(fg, bg) >= MIN_CONTRAST_RATIO) return seq

    const fixed = bestLegibleForeground(bg)
    // Keep every other attribute (bold, background, …) and append our colour.
    return `\x1b[${[...rest, 38, 2, fixed.r, fixed.g, fixed.b].join(';')}m`
  })
}

function scan(params: number[], theme: AnsiThemeColors): Scan {
  const rest: number[] = []
  let fg: Rgb | null = null
  let bg: Rgb | null = null
  let fgKnown = false

  for (let i = 0; i < params.length; i++) {
    const p = params[i]

    if (p === 0) {
      fg = null
      bg = null
      fgKnown = false
      rest.push(p)
      continue
    }
    if (p === 39) {
      fg = rgbOf(theme.foreground)
      fgKnown = fg !== null
      if (!fg) rest.push(p)
      continue
    }
    if (p >= 30 && p <= 37) {
      const c = indexColor(p - 30, theme)
      if (c) fg = c
      else rest.push(p)
      fgKnown = c !== null
      continue
    }
    if (p >= 90 && p <= 97) {
      const c = indexColor(p - 90 + 8, theme)
      if (c) fg = c
      else rest.push(p)
      fgKnown = c !== null
      continue
    }
    // Backgrounds are always kept in `rest` so a rewrite cannot drop them.
    if (p >= 40 && p <= 47) {
      rest.push(p)
      bg = indexColor(p - 40, theme)
      continue
    }
    if (p >= 100 && p <= 107) {
      rest.push(p)
      bg = indexColor(p - 100 + 8, theme)
      continue
    }
    if (p === 38 || p === 48) {
      const parsed = extendedColor(params, i)
      if (!parsed) {
        // Shape we don't understand — keep the code and stop guessing.
        rest.push(p)
        continue
      }
      if (p === 38) {
        fg = parsed.color
        fgKnown = true
      } else {
        bg = parsed.color
        rest.push(...params.slice(i, parsed.next))
      }
      i = parsed.next - 1
      continue
    }
    rest.push(p)
  }

  return { fg, bg, fgKnown, rest }
}

/** `38;5;n` / `38;2;r;g;b` (and the `48;` variants) → colour + index after it. */
function extendedColor(params: number[], i: number): { color: Rgb; next: number } | null {
  const mode = params[i + 1]
  if (mode === 5) {
    const index = params[i + 2]
    if (index === undefined) return null
    return { color: xterm256Color(index), next: i + 3 }
  }
  if (mode === 2) {
    const r = params[i + 2]
    const g = params[i + 3]
    const b = params[i + 4]
    if (r === undefined || g === undefined || b === undefined) return null
    return { color: { r: clampByte(r), g: clampByte(g), b: clampByte(b) }, next: i + 5 }
  }
  return null
}

/** SGR index 0–15 comes from the theme, 16–255 from the fixed xterm palette. */
function indexColor(index: number, theme: AnsiThemeColors): Rgb | null {
  return index < 16 ? rgbOf(theme.colors[index]) : xterm256Color(index)
}

/** xterm's fixed 256-colour palette (indices 16–255; 0–15 are theme colours). */
export function xterm256Color(index: number): Rgb {
  const i = clampByte(Math.trunc(index))
  if (i >= 232) {
    const level = 8 + (i - 232) * 10
    return { r: level, g: level, b: level }
  }
  const n = Math.max(i, 16) - 16
  return {
    r: CUBE_LEVELS[Math.floor(n / 36) % 6],
    g: CUBE_LEVELS[Math.floor(n / 6) % 6],
    b: CUBE_LEVELS[n % 6],
  }
}

/** `#abc` / `#aabbcc` → RGB; anything else (rgba(), named colours) → null. */
export function rgbOf(hex: string | undefined): Rgb | null {
  if (!hex) return null
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const h = m[1]
  const full = h.length === 3 ? h.replace(/./g, (c) => c + c) : h
  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16),
  }
}

/** WCAG relative luminance (0 = black, 1 = white). */
export function relativeLuminance({ r, g, b }: Rgb): number {
  const lin = (v: number): number => {
    const s = clampByte(v) / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/** WCAG contrast ratio, 1:1 … 21:1. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/**
 * The more readable of black/white on `bg`. Always ≥ 4.5:1, because the ratio of
 * the *better* of the two bottoms out at ~4.58 (where both are equal).
 */
export function bestLegibleForeground(bg: Rgb): Rgb {
  return contrastRatio(WHITE, bg) >= contrastRatio(BLACK, bg) ? WHITE : BLACK
}

function clampByte(v: number): number {
  return Math.min(255, Math.max(0, Math.round(Number.isFinite(v) ? v : 0)))
}

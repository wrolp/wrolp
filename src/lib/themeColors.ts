// Colour math for the user-configurable accent.
//
// The theme tables in src/styles/_theme.scss precompute the accent's derived
// shades at build time with Sass `color.adjust($color, $lightness: n%)`. Once the
// accent is chosen at runtime those shades have to be recomputed here, so this
// module ports that one Sass function — and only that one — rather than
// approximate it with `color-mix()` (which mixes toward a *colour*, not toward
// lightness, so it also shifts saturation and reads as a different hue).
//
// `--accent` is used both ways in this app: as a solid fill behind
// `--text-on-accent` (status bar, primary buttons) and as a foreground / border
// on a surface. A user picking e.g. amber would break the first use, so
// `textOnAccent` picks whichever of white / near-black reads better on the
// chosen fill instead of staying hardcoded to white.

export type Rgb = { r: number; g: number; b: number }

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** `#rgb` / `#rrggbb` → channels. Invalid input returns null (callers fall back). */
export function parseHex(hex: string): Rgb | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const digits = m[1]
  const expand = digits.length === 3
  const channel = (i: number): number => {
    const pair = expand ? digits[i] + digits[i] : digits.slice(i * 2, i * 2 + 2)
    return parseInt(pair, 16)
  }
  return { r: channel(0), g: channel(1), b: channel(2) }
}

function toHex({ r, g, b }: Rgb): string {
  const part = (v: number): string =>
    Math.round(clamp(v, 0, 255))
      .toString(16)
      .padStart(2, '0')
  return `#${part(r)}${part(g)}${part(b)}`
}

/**
 * Shift a colour's HSL lightness by `delta` percentage points, leaving hue and
 * saturation alone — Sass's `color.adjust($lightness:)`. The channel maths
 * follows the same sRGB→HSL definition Sass uses for legacy colours, so the
 * result matches the build-time value the theme tables would have produced.
 */
export function adjustLightness(hex: string, delta: number): string {
  const rgb = parseHex(hex)
  if (!rgb) return hex
  const r = rgb.r / 255
  const g = rgb.g / 255
  const b = rgb.b / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const deltaChannel = max - min
  const l = (max + min) / 2
  const s = deltaChannel === 0 ? 0 : deltaChannel / (1 - Math.abs(2 * l - 1))
  let h = 0
  if (deltaChannel !== 0) {
    if (max === r) h = 60 * (((g - b) / deltaChannel) % 6)
    else if (max === g) h = 60 * ((b - r) / deltaChannel + 2)
    else h = 60 * ((r - g) / deltaChannel + 4)
  }
  if (h < 0) h += 360

  const nl = clamp(l + delta / 100, 0, 1)
  if (deltaChannel === 0) {
    const grey = Math.round(nl * 255)
    return toHex({ r: grey, g: grey, b: grey })
  }

  const c = (1 - Math.abs(2 * nl - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = nl - c / 2
  const [r1, g1, b1] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x]
  return toHex({
    r: (r1 + m) * 255,
    g: (g1 + m) * 255,
    b: (b1 + m) * 255,
  })
}

/** WCAG contrast ratio between two colours (1–21); 1 when either fails to parse. */
export function contrastRatio(a: string, b: string): number {
  const lum = (hex: string): number => {
    const rgb = parseHex(hex)
    if (!rgb) return 0
    const lin = (v: number): number => {
      const s = v / 255
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
    }
    return 0.2126 * lin(rgb.r) + 0.7152 * lin(rgb.g) + 0.0722 * lin(rgb.b)
  }
  const la = lum(a)
  const lb = lum(b)
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

const ON_LIGHT = '#ffffff'
const ON_DARK = '#171717'

/**
 * The darkest surface the light theme paints behind text (`bg-active` in
 * `_theme.scss`). Accent-derived text is checked against this rather than
 * against white, because it lands on hovered and active rows as often as on a
 * plain card, and the hovered case is what decides whether the pair is readable.
 * Exported so the appearance spec asserts against the surface the clamp targets.
 */
export const LIGHT_TEXT_BG = '#e4e6f1'
const AA_NORMAL = 4.5

/** White or near-black text on `accent`, whichever reads better on it. */
export function textOnAccent(accent: string): string {
  return contrastRatio(accent, ON_LIGHT) >= contrastRatio(accent, ON_DARK) ? ON_LIGHT : ON_DARK
}

/**
 * The accent as *text*: pushed toward white on dark, pulled toward black on
 * light. The light branch cannot stop at the fixed `-22`, because that travel is
 * measured in HSL lightness points and so only reaches AA by accident — a bright
 * preset like #4d9dff lands on #0063dc, 4.42:1 on `LIGHT_TEXT_BG`, and four of
 * the six sit under 4.5. The shipped default never comes through here at all (no
 * accent means no override; `_theme.scss` hand-tunes its own `accent-soft-40`),
 * so this branch has to hold for *any* hex the picker can produce: keep pulling
 * until AA does. The step cap is a stop-loss for a pick that cannot improve —
 * lightness bottoms out at black long before it is reached.
 */
function accentTextOnLight(accent: string): string {
  let next = adjustLightness(accent, -22)
  for (let i = 0; i < 40 && contrastRatio(next, LIGHT_TEXT_BG) < AA_NORMAL; i++) {
    next = adjustLightness(next, -2)
  }
  return next
}

/** Theme-aware direction for hover: lift on dark, press down on light. */
export function accentOverrides(accent: string, dark: boolean): Record<string, string> {
  const dir = dark ? 1 : -1
  return {
    '--accent': accent,
    '--accent-hover': adjustLightness(accent, 8 * dir),
    '--accent-l8': adjustLightness(accent, 8 * dir),
    '--accent-l12': adjustLightness(accent, 12 * dir),
    '--accent-l14': adjustLightness(accent, 14 * dir),
    // Used as *text* on an accent-tinted surface, so it needs a larger travel
    // than the fills to keep contrast against the background it sits on.
    '--accent-soft-40': dark ? adjustLightness(accent, 40) : accentTextOnLight(accent),
    '--text-on-accent': textOnAccent(accent),
  }
}

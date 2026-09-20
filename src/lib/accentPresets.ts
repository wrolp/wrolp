// The six accent presets the settings page offers as swatches.
//
// These are UI sugar only: `wrolp-accent` stores the hex (or 'default'), never a
// preset name, so a preset can be recoloured or reordered here without touching a
// single user's saved preference. The active swatch is found by comparing hexes.
//
// Values are the approved static draft's (`task/designs/ui-redesign-v1/index.html`
// 屏 5). Each one is safe to use as a fill because `textOnAccent` picks the
// foreground per pick, and safe as text because `accentTextOnLight` keeps pulling
// the light-theme `--accent-soft-40` down until it clears AA on that surface.

import type { TranslationKey } from '../i18n/en'

export interface AccentPreset {
  hex: string
  /** i18n key for the swatch's title / accessible name. */
  labelKey: TranslationKey
}

export const ACCENT_PRESETS: readonly AccentPreset[] = [
  { hex: '#4d9dff', labelKey: 'presetAccentBlue' },
  { hex: '#35c4d6', labelKey: 'presetAccentCyan' },
  { hex: '#56c07b', labelKey: 'presetAccentMoss' },
  { hex: '#e0a13c', labelKey: 'presetAccentAmber' },
  { hex: '#e0714f', labelKey: 'presetAccentClay' },
  { hex: '#a97be0', labelKey: 'presetAccentIris' },
]

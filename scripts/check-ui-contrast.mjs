// Contrast audit for self-declared colour pairs in the stylesheets (B32 follow-up).
//
// Run with:  node scripts/check-ui-contrast.mjs [--all] [--min=3]
//
// Why this shape: the B32 defect was a foreground and a background declared *in the
// same rule* (`background: rgba($accent,.15); color: $accent` → blue on blue-grey,
// 2.0:1 in the dark theme). Those pairs are self-inflicted and cheap to check
// statically — including `:hover` / `:disabled` / `.active` variants, which a DOM
// sweep of a running app only reaches by poking every screen.
//
// Deliberately NOT reported: plain `$text-muted` / `$text-dim` inheritance.
// De-emphasised text (placeholders, dim labels) is intentional and depends on a
// surface this tool cannot see; it only judges pairs the rule itself decides.
//
// How it works:
//   1. `sass` compiles src/styles/index.scss so derived tokens
//      (`color.adjust($dark-accent, …)`, …) are the REAL values for both themes.
//   2. App.scss / index.scss are parsed into nested blocks (text scan, not AST —
//      the selector chain is kept for the report).
//   3. Every block declaring BOTH a `color` and a flat background is resolved per
//      theme: `$var` → `var(--token)` → token value; `rgba($x, a)` / `color-mix`
//      → colour + alpha; translucent backgrounds are blended over the nearest
//      ancestor background (falling back to the theme's `bg-primary`).
//   4. WCAG contrast is computed for the pair; anything below AA (4.5:1, or 3:1
//      for large/bold text) is printed worst-first.
//
// Exit code is always 0 — it is an audit report, not a gate.

import { readFileSync } from 'node:fs'
import * as sass from 'sass'

const STYLE_DIR = 'src/styles'
const FILES = [`${STYLE_DIR}/App.scss`, `${STYLE_DIR}/index.scss`]
const AA_NORMAL = 4.5
const AA_LARGE = 3

const args = process.argv.slice(2)
const showAll = args.includes('--all')
const showList = args.includes('--list')
const minFlag = args.find((a) => a.startsWith('--min='))
const explicitMin = minFlag ? Number(minFlag.slice(6)) : null

// ---------------------------------------------------------------------------
// Colour helpers
// ---------------------------------------------------------------------------

const NAMED = {
  white: { r: 255, g: 255, b: 255 },
  black: { r: 0, g: 0, b: 0 },
  red: { r: 255, g: 0, b: 0 },
  green: { r: 0, g: 128, b: 0 },
  blue: { r: 0, g: 0, b: 255 },
  gray: { r: 128, g: 128, b: 128 },
  grey: { r: 128, g: 128, b: 128 },
}

/** `#abc` / `#aabbcc` / `#aabbccdd` / `rgb()` / `rgba()` / `white` → {rgb, alpha}. */
function parseColor(raw) {
  const v = String(raw).trim().replace(/!important$/, '').trim()
  if (!v) return null

  const hex = /^#([0-9a-f]{3,8})$/i.exec(v)
  if (hex) {
    let h = hex[1]
    if (h.length === 3 || h.length === 4) h = h.replace(/./g, (c) => c + c)
    return {
      rgb: {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
      },
      alpha: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
    }
  }

  const fn = /^rgba?\(([^)]*)\)$/i.exec(v)
  if (fn) {
    const [r, g, b, a] = splitTop(fn[1]).map((p) => p.trim())
    return { rgb: { r: Number(r), g: Number(g), b: Number(b) }, alpha: a === undefined ? 1 : alphaOf(a) }
  }

  const lower = v.toLowerCase()
  if (lower === 'transparent') return { rgb: { r: 0, g: 0, b: 0 }, alpha: 0 }
  if (NAMED[lower]) return { rgb: NAMED[lower], alpha: 1 }
  return null
}

function alphaOf(v) {
  const s = String(v).trim()
  if (s.endsWith('%')) return Number(s.slice(0, -1)) / 100
  const n = Number(s)
  return Number.isFinite(n) ? n : 1
}

/** Split a comma-separated list, ignoring commas nested in parentheses. */
function splitTop(text) {
  const out = []
  let depth = 0
  let cur = ''
  for (const c of text) {
    if (c === '(') depth++
    if (c === ')') depth--
    if (c === ',' && depth === 0) {
      out.push(cur)
      cur = ''
      continue
    }
    cur += c
  }
  if (cur.trim()) out.push(cur)
  return out
}

const hex = (c) =>
  [c.r, c.g, c.b]
    .map((v) =>
      Math.round(Math.min(255, Math.max(0, v)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')

const luminance = ({ r, g, b }) => {
  const lin = (v) => {
    const s = Math.min(255, Math.max(0, v)) / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

const contrast = (a, b) => {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

const blend = (fg, alpha, under) => ({
  r: fg.r * alpha + under.r * (1 - alpha),
  g: fg.g * alpha + under.g * (1 - alpha),
  b: fg.b * alpha + under.b * (1 - alpha),
})

// ---------------------------------------------------------------------------
// Theme tokens (real values, straight out of Sass)
// ---------------------------------------------------------------------------

function compileTokens() {
  const css = sass.compileString(
    `@use 'theme' as t;
     :root { @include t.emit-tokens(dark); }
     html[data-theme='light'] { @include t.emit-tokens(light); }`,
    { loadPaths: [STYLE_DIR], style: 'expanded' },
  ).css

  const themes = {}
  // Sass drops the quotes of the attribute selector, so accept both forms.
  const blockRe = /(^|\n)(:root|html\[data-theme=['"]?light['"]?\])\s*\{([^}]*)\}/g
  let m
  while ((m = blockRe.exec(css))) {
    const name = m[2] === ':root' ? 'dark' : 'light'
    const map = new Map()
    for (const decl of m[3].split(';')) {
      const i = decl.indexOf(':')
      if (i < 0) continue
      const key = decl.slice(0, i).trim()
      if (!key.startsWith('--')) continue
      const parsed = parseColor(decl.slice(i + 1).trim())
      if (parsed) map.set(key.slice(2), parsed)
    }
    themes[name] = map
  }
  for (const name of ['dark', 'light']) {
    if (!themes[name]?.size) throw new Error(`no tokens compiled for the ${name} theme`)
  }
  return themes
}

/** `_variables.scss` re-exports `$x: var(--token);` — walk those to the token. */
function buildSassVars() {
  const src = readFileSync(`${STYLE_DIR}/_variables.scss`, 'utf8')
  const vars = new Map()
  for (const m of src.matchAll(/^\s*\$([\w-]+):\s*([^;]+);/gm)) vars.set(`$${m[1]}`, m[2].trim())
  return vars
}

/** Resolve a declaration value to a colour for one theme (null = unknown). */
function resolveColor(raw, theme, sassVars) {
  let v = String(raw).trim().replace(/!important$/, '').trim()
  for (let i = 0; i < 10 && v.startsWith('$'); i++) {
    const next = sassVars.get(v)
    if (!next) return null
    v = next
  }

  const varCall = /^var\((--[\w-]+)(?:\s*,\s*([^)]*))?\)$/.exec(v)
  if (varCall) {
    const token = theme.get(varCall[1].slice(2))
    if (token) return { ...token, note: `var(${varCall[1]})` }
    return varCall[2] ? resolveColor(varCall[2], theme, sassVars) : null
  }

  // rgba($accent, .15) — the project's Sass shim (2-arg form only).
  const shim = /^rgba\((.+)\)$/i.exec(v)
  if (shim) {
    const parts = splitTop(shim[1]).map((p) => p.trim())
    if (parts.length === 2) {
      const c = resolveColor(parts[0], theme, sassVars)
      if (!c) return null
      return { rgb: c.rgb, alpha: alphaOf(parts[1]), note: `rgba(${parts[0]}, ${parts[1]})` }
    }
  }

  const mix = /^color-mix\(in srgb,\s*([^,]+?)\s+([\d.]+)%\s*,\s*transparent\)$/i.exec(v)
  if (mix) {
    const c = resolveColor(mix[1], theme, sassVars)
    if (!c) return null
    return { rgb: c.rgb, alpha: Number(mix[2]) / 100, note: `color-mix(${mix[1]} ${mix[2]}%)` }
  }

  return parseColor(v)
}

// ---------------------------------------------------------------------------
// Minimal SCSS block parser (selector chain + declarations, for the report)
// ---------------------------------------------------------------------------

function parseScss(file) {
  const text = readFileSync(file, 'utf8')
  const blocks = []
  const stack = []
  let buf = ''
  let line = 1
  let segStart = 1

  const flushDecl = () => {
    const s = buf.trim()
    buf = ''
    if (!s) return
    const parent = stack.at(-1)
    if (!parent) return
    const i = s.indexOf(':')
    if (i < 0) return
    const prop = s.slice(0, i).trim().toLowerCase()
    if (prop.startsWith('@') || prop.startsWith('$')) return
    parent.decls.push({ prop, value: s.slice(i + 1).trim(), line: segStart })
  }

  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '\n') {
      line++
      buf += c
      if (!buf.trim()) segStart = line
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end < 0 ? text.length : end + 1
      continue
    }
    // `//` comment — but not the `//` of `https://`.
    if (c === '/' && text[i + 1] === '/' && !buf.trimEnd().endsWith(':')) {
      const end = text.indexOf('\n', i)
      i = end < 0 ? text.length : end - 1
      continue
    }
    if (c === '#' && text[i + 1] === '{') {
      let depth = 0
      for (let j = i + 1; j < text.length; j++) {
        if (text[j] === '{') depth++
        else if (text[j] === '}') {
          depth--
          if (depth === 0) {
            i = j
            break
          }
        }
      }
      buf += 'X'
      continue
    }
    if (c === '{') {
      stack.push({ selector: buf.trim(), line, decls: [], file, parent: stack.at(-1) ?? null })
      buf = ''
      segStart = line
      continue
    }
    if (c === '}') {
      flushDecl()
      const frame = stack.pop()
      if (frame) blocks.push(frame)
      buf = ''
      segStart = line
      continue
    }
    if (c === ';') {
      flushDecl()
      segStart = line
      continue
    }
    buf += c
  }
  return blocks
}

function selectorPath(block) {
  const parts = []
  for (let b = block; b; b = b.parent) {
    if (!b.selector || b.selector.startsWith('@')) continue
    parts.unshift(b.selector.replace(/\s+/g, ' '))
  }
  return parts.join(' ') || '(top level)'
}

function backgroundOf(block, theme, sassVars) {
  const decl =
    block.decls.find((d) => d.prop === 'background-color') ??
    block.decls.find((d) => d.prop === 'background')
  if (!decl) return null
  if (/gradient|url\(|image\(/.test(decl.value)) return { gradient: true, value: decl.value }
  const c = resolveColor(decl.value, theme, sassVars)
  return c ? { ...c, decl } : null
}

/** Nearest opaque background up the block chain, else the theme's own surface. */
function surfaceBehind(block, theme, sassVars) {
  for (let b = block.parent; b; b = b.parent) {
    const bg = backgroundOf(b, theme, sassVars)
    if (bg && !bg.gradient && bg.alpha >= 0.999) return { rgb: bg.rgb, note: b.selector || '(root)' }
  }
  const base = theme.get('bg-primary')
  return base ? { rgb: base.rgb, note: '--bg-primary' } : null
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

function main() {
  const themes = compileTokens()
  const sassVars = buildSassVars()

  if (args.includes('--tokens')) {
    for (const [name, map] of Object.entries(themes)) {
      console.log(`${name}: ${map.size} tokens`)
      for (const key of ['accent-soft-40', 'text-primary', 'accent', 'bg-primary']) {
        const t = map.get(key)
        console.log(`  ${key} = ${t ? `#${hex(t.rgb)} a=${t.alpha}` : 'MISSING'}`)
      }
    }
    return
  }

  const rows = []
  let declared = 0
  let unresolved = 0

  for (const file of FILES) {
    for (const block of parseScss(file)) {
      if (block.selector.startsWith('@')) continue
      const fgDecl = block.decls.find((d) => d.prop === 'color')
      if (!fgDecl) continue
      // A themed token resolves to a different colour per theme — never reuse one.
      const fgs = {
        dark: resolveColor(fgDecl.value, themes.dark, sassVars),
        light: resolveColor(fgDecl.value, themes.light, sassVars),
      }
      if (!fgs.dark && !fgs.light) {
        unresolved++
        continue
      }
      const bgs = {
        dark: backgroundOf(block, themes.dark, sassVars),
        light: backgroundOf(block, themes.light, sassVars),
      }
      if (bgs.dark?.gradient || bgs.light?.gradient) continue

      declared++
      const sizeDecl = block.decls.find((d) => d.prop === 'font-size')
      const size = sizeDecl ? Number.parseFloat(sizeDecl.value) : null
      const weightDecl = block.decls.find((d) => d.prop === 'font-weight')
      const weight = weightDecl
        ? weightDecl.value.trim() === 'bold'
          ? 700
          : Number.parseFloat(weightDecl.value)
        : null
      const large =
        (Number.isFinite(size) && size >= 24) ||
        (Number.isFinite(size) && size >= 18.66 && Number.isFinite(weight) && weight >= 700)
      // `--min=N` overrides the WCAG floors entirely; `--all` just drops the
      // large-text exemption (which otherwise lets 18.66px+ bold text pass at 3:1).
      const floor = explicitMin ?? (showAll ? AA_NORMAL : large ? AA_LARGE : AA_NORMAL)

      const ratios = {}
      const details = {}
      for (const theme of ['dark', 'light']) {
        const fg = fgs[theme]
        const bg = bgs[theme]
        if (!fg || !bg || bg.alpha === 0) continue
        const under = bg.alpha < 0.999 ? surfaceBehind(block, themes[theme], sassVars) : null
        const surface = under ? blend(bg.rgb, bg.alpha, under.rgb) : bg.rgb
        ratios[theme] = contrast(fg.rgb, surface)
        details[theme] = `#${hex(fg.rgb)} on #${hex(surface)}${under ? ` (over ${under.note})` : ''}`
      }
      const worst = Math.min(...Object.values(ratios))
      if (!Number.isFinite(worst)) continue
      const failing = ['dark', 'light'].filter((t) => (ratios[t] ?? Infinity) < floor)
      if (failing.length === 0) continue

      const bgDecl =
        block.decls.find((d) => d.prop === 'background-color') ??
        block.decls.find((d) => d.prop === 'background')
      rows.push({
        worst,
        ratios,
        details,
        failing,
        large,
        size,
        selector: selectorPath(block),
        line: fgDecl.line,
        file,
        // The shape of the bug: the exact declarations, so identical mistakes across
        // dozens of selectors fold into one line.
        signature: `${fgDecl.value}  |  ${bgDecl?.value ?? '?'}`,
      })
    }
  }

  rows.sort((a, b) => a.worst - b.worst)

  console.log(`${declared} rules declare both a colour and a background (${unresolved} unparsed)`)
  console.log(`${rows.length} below AA${showAll ? ` (--all: floor ${reportFloor}:1)` : ''}\n`)

  // Group identical declaration shapes — one root cause, N selectors.
  const groups = new Map()
  for (const r of rows) {
    const key = `${r.failing.join('+')}  ${r.signature}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(r)
  }
  const sorted = [...groups.entries()].sort(
    (a, b) => Math.min(...a[1].map((r) => r.worst)) - Math.min(...b[1].map((r) => r.worst)),
  )

  console.log('grouped by declaration shape (worst first):')
  for (const [key, list] of sorted) {
    const worst = Math.min(...list.map((r) => r.worst))
    const r0 = list[0]
    console.log(`\n[${r0.failing.join('+')}] x${list.length}  worst ${worst.toFixed(2)}  ${key}`)
    console.log(
      `    e.g. ${r0.file}:${r0.line}  ${r0.selector}` +
        `\n         dark: ${r0.details.dark ?? '—'}   light: ${r0.details.light ?? '—'}`,
    )
    if (showList) {
      for (const r of list) {
        const d = r.ratios.dark === undefined ? '  -  ' : r.ratios.dark.toFixed(2)
        const l = r.ratios.light === undefined ? '  -  ' : r.ratios.light.toFixed(2)
        console.log(`      ${d}/${l}  ${r.file}:${r.line}  ${r.selector}`)
      }
    }
  }
  if (!showList) console.log('\n(add --list to expand every selector)')
}

main()

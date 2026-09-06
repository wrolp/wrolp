/** Human-readable byte count, e.g. 1536 -> "1.5 KB". */
export function fmtBytes(n: number): string {
  if (!n) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  const text = i === 0 || v >= 100 ? Math.round(v).toString() : v.toFixed(1)
  return `${text} ${units[i]}`
}

/** Format an epoch-ms timestamp as a short HH:MM:SS string. */
export function fmtTime(ms: number): string {
  try {
    return new Date(ms).toLocaleTimeString()
  } catch {
    return ''
  }
}

/** Direction glyph shared by client rows ("upload"/"download") and server
 *  rows ("send"/"recv"). */
export function dirGlyph(direction: string): string {
  switch (direction) {
    case 'send':
    case 'upload':
      return '↑'
    case 'recv':
    case 'download':
      return '↓'
    default:
      return '↔'
  }
}

/** Parse a port input; falls back to `fallback` when invalid. */
export function parsePort(raw: string, fallback: number): number {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : fallback
}

/**
 * Byte sizes for file listings, transfer rows and tooltips.
 *
 * Shared by the file panel and the drawer's transfer queue — the queue was
 * extracted from the panel in v8-P4 and both render the same "x / y MB" meta.
 */
export const formatSize = (bytes: number): string => {
  if (bytes === 0) return '-'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let size = bytes
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024
    i++
  }
  return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

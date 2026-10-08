import type { TranslationKey } from '../i18n/en'

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

/** The `t()` shape from `useI18n()`, taken as an argument so this module stays
 *  free of i18n (and of React) and the helper stays pure. */
export type TranslateFn = (key: TranslationKey, params?: Record<string, string | number>) => string

/**
 * How long ago something happened, as a short phrase: "just now", "12 min ago",
 * "3 h ago", "5 d ago".
 *
 * Past a week an absolute date is the right answer — "23 days ago" stops being
 * information the user can act on — and the browser localises that for us, which
 * is why this case needs no translation key.
 *
 * `now` is injectable so a test does not have to freeze the clock.
 */
export const formatRelativeTime = (
  ms: number,
  t: TranslateFn,
  now: number = Date.now(),
): string => {
  const secs = Math.max(0, Math.round((now - ms) / 1000))
  if (secs < 60) return t('timeJustNow')
  const mins = Math.floor(secs / 60)
  if (mins < 60) return t('timeMinutesAgo', { n: mins })
  const hours = Math.floor(mins / 60)
  if (hours < 24) return t('timeHoursAgo', { n: hours })
  const days = Math.floor(hours / 24)
  if (days < 7) return t('timeDaysAgo', { n: days })
  return new Date(ms).toLocaleDateString(undefined, { month: '2-digit', day: '2-digit' })
}

import { useCallback, useEffect, useState } from 'react'

/**
 * Path fields in the network tools keep what was typed into them.
 *
 * A share folder or a firmware image is picked for a reason and is usually the
 * same one next time, but the panels unmount when another tool tab is selected,
 * so plain component state lost it. Each field gets a last-used value and a short
 * history in localStorage — display preference, like the other panel memories —
 * and the history menu can drop an entry that no longer exists.
 */

const KEY_PREFIX = 'wrolp-nettools-'
const HISTORY_LIMIT = 8

const lastKey = (field: string) => `${KEY_PREFIX}${field}-last`
const historyKey = (field: string) => `${KEY_PREFIX}${field}-history`

function readText(key: string): string {
  try {
    return localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}

function readList(key: string): string[] {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : []
  } catch {
    return []
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Storage full or disabled: the field still works for this session.
  }
}

function rememberIn(list: string[], path: string): string[] {
  return [path, ...list.filter((item) => item !== path)].slice(0, HISTORY_LIMIT)
}

export interface PathHistory {
  value: string
  setValue: (value: string) => void
  history: string[]
  /** Put the current value (or an explicit path) at the top of the history. */
  remember: (path?: string) => void
  /** Choose a remembered path: the field takes it and it becomes the newest entry. */
  pick: (path: string) => void
  /** Drop one path from the history. */
  forget: (path: string) => void
}

export function usePathHistory(field: string): PathHistory {
  const [value, setValue] = useState(
    () => readText(lastKey(field)) || readList(historyKey(field))[0] || '',
  )
  const [history, setHistory] = useState(() => readList(historyKey(field)))

  // Written per change: the value is a small string, and the panel can unmount at
  // any moment (another tool tab), which is exactly what used to lose it.
  useEffect(() => {
    write(lastKey(field), value)
  }, [field, value])

  const add = useCallback(
    (path: string) => {
      const trimmed = path.trim()
      if (!trimmed) return
      setHistory((prev) => {
        const next = rememberIn(prev, trimmed)
        write(historyKey(field), JSON.stringify(next))
        return next
      })
    },
    [field],
  )

  const remember = useCallback((path?: string) => add(path ?? value), [add, value])

  const pick = useCallback(
    (path: string) => {
      setValue(path)
      add(path)
    },
    [add],
  )

  const forget = useCallback(
    (path: string) => {
      setHistory((prev) => {
        const next = prev.filter((item) => item !== path)
        write(historyKey(field), JSON.stringify(next))
        return next
      })
    },
    [field],
  )

  return { value, setValue, history, remember, pick, forget }
}

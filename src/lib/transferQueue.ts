import { useCallback, useSyncExternalStore } from 'react'
import { listen } from '@tauri-apps/api/event'

/**
 * The transfer queue.
 *
 * Before v8-P4 this list lived inside `FilePanel` as component state, which meant
 * it died with the panel: closing the file column, switching the rail to another
 * mode, or backing out of a dual-pane view all discarded the in-flight rows — and
 * a "常驻底部抽屉" queue has nowhere to read them from. It is app-level state now
 * (a module store, since nothing else needs to own it), and both the file panel's
 * inline list and the drawer's queue tab read the same rows.
 */

export type TransferOp = 'upload' | 'download' | 'directory' | 'delete'
export type TransferStatus = 'queued' | 'active' | 'done' | 'error' | 'cancelled'

/** One row in the transfer list. */
export interface TransferRow {
  /** Stable unique key: op + full path (local path for upload, remote path for download). */
  key: string
  filename: string
  op: TransferOp
  status: TransferStatus
  transferred: number
  total: number
  speed: string
  /**
   * The session/jump tab the transfer runs under. Pause and cancel are per-tab
   * in the backend, so the drawer's controls need it; rows created before the
   * queue was hoisted (or from a tab that has since closed) leave it undefined.
   */
  tabId?: number
}

/** Payload of the backend's `transfer-progress` event. */
interface TransferProgress {
  tabId: number
  op: 'upload' | 'download' | 'directory' | 'delete' | 'upload-dir'
  filename: string
  transferred: number
  total: number
  elapsed: number
  dirName?: string
  relativePath?: string
  doneFiles?: number
  totalFiles?: number
  doneBytes?: number
  totalBytes?: number
}

export const formatSpeed = (bytesPerSec: number): string => {
  if (bytesPerSec < 1024) return `${bytesPerSec.toFixed(0)} B/s`
  if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`
  return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`
}

/* ---------- store ---------- */

let rows: TransferRow[] = []
const listeners = new Set<() => void>()
let unlisten: (() => void) | null = null
let listening = false

const emit = () => {
  for (const l of listeners) l()
}

export function getTransferRows(): TransferRow[] {
  return rows
}

/** Replace the whole queue. Takes an updater with the same shape as a state setter. */
export function updateTransferRows(updater: (prev: TransferRow[]) => TransferRow[]): void {
  const next = updater(rows)
  if (next === rows) return
  rows = next
  emit()
}

/** Append rows, replacing any that share a key (React keys stay unique). */
export function addTransferRows(next: TransferRow[]): void {
  const keys = new Set(next.map((r) => r.key))
  rows = [...rows.filter((r) => !keys.has(r.key)), ...next]
  emit()
}

export function removeTransferRow(key: string): void {
  rows = rows.filter((r) => r.key !== key)
  emit()
}

/** Drop every row that is no longer in flight — the drawer's "clear finished". */
export function clearFinishedTransfers(): void {
  rows = rows.filter((r) => r.status === 'active' || r.status === 'queued')
  emit()
}

export function subscribeTransferQueue(listener: () => void): () => void {
  listeners.add(listener)
  void startListening()
  return () => {
    listeners.delete(listener)
  }
}

/* ---------- progress ---------- */

/**
 * Row matching. The backend reports only the *basename*, while rows are keyed by
 * full path, so candidates are matched by basename/suffix — and because uploads
 * run concurrently, several rows can share one. Preference order: an active row
 * whose byte count still trails the event (per-row progress is monotonic), then
 * any active row, then a sole candidate. Finished rows are skipped so a late
 * event cannot resurrect them.
 */
const pickRow = (candidates: TransferRow[], transferred: number): TransferRow | null =>
  candidates.find((r) => r.status === 'active' && r.transferred < transferred) ??
  candidates.find((r) => r.status === 'active') ??
  (candidates.length === 1 ? candidates[0] : null)

const live = (r: TransferRow) => r.status !== 'done' && r.status !== 'error'

/**
 * Rows are matched across the whole queue, so the tab the event names is used as
 * a tie-breaker: two tabs moving a same-named file must not swap progress. Rows
 * without a tab (created before the hoist) stay eligible.
 */
const forTab = (list: TransferRow[], tabId: number) =>
  list.filter((r) => r.tabId == null || r.tabId === tabId)

async function startListening() {
  if (listening) return
  listening = true
  const stop = await listen<TransferProgress>('transfer-progress', (event) => {
    const p = event.payload
    const elapsed = p.elapsed > 0 ? p.elapsed / 1000 : 0.001

    if (p.op === 'directory') {
      // A directory download streams many files; the row is keyed by the remote
      // directory path and shows aggregate bytes + the current relative path.
      const dirName = p.dirName ?? ''
      if (dirName.length === 0) return
      const bytesPerSec = (p.doneBytes ?? 0) / elapsed
      updateTransferRows((prev) => {
        const target = pickRow(
          forTab(prev, p.tabId).filter(
            (r) =>
              r.op === 'directory' &&
              live(r) &&
              (r.key === `directory:${dirName}` || r.key.endsWith(`/${dirName}`)),
          ),
          p.doneBytes ?? 0,
        )
        if (!target) return prev
        return prev.map((r) =>
          r.key === target.key
            ? {
                ...r,
                filename: p.relativePath || p.filename,
                transferred: p.doneBytes ?? r.transferred,
                total: p.totalBytes ?? r.total,
                speed: formatSpeed(bytesPerSec),
                status: 'active',
              }
            : r,
        )
      })
      return
    }
    if (p.op === 'delete') {
      // A recursive delete streams one event per removed file; the row's
      // progress is the file count.
      const dirName = p.dirName ?? ''
      if (dirName.length === 0) return
      updateTransferRows((prev) => {
        const target = pickRow(
          forTab(prev, p.tabId).filter(
            (r) =>
              r.op === 'delete' &&
              live(r) &&
              (r.key === `delete:${dirName}` || r.key.endsWith(`/${dirName}`)),
          ),
          p.doneFiles ?? 0,
        )
        if (!target) return prev
        return prev.map((r) =>
          r.key === target.key
            ? {
                ...r,
                transferred: p.doneFiles ?? r.transferred,
                total: p.totalFiles ?? r.total,
                status: 'active',
              }
            : r,
        )
      })
      return
    }
    if (p.op === 'upload-dir') {
      // A local-directory upload streams many files on the Rust side; the row is
      // keyed by the full normalized local path.
      const dirName = p.dirName ?? ''
      if (dirName.length === 0) return
      const bytesPerSec = (p.doneBytes ?? 0) / elapsed
      updateTransferRows((prev) => {
        const target = pickRow(
          forTab(prev, p.tabId).filter(
            (r) => r.op === 'upload' && live(r) && r.key === `upload-dir:${dirName}`,
          ),
          p.doneBytes ?? 0,
        )
        if (!target) return prev
        return prev.map((r) =>
          r.key === target.key
            ? {
                ...r,
                filename: p.relativePath || r.filename,
                transferred: p.doneBytes ?? r.transferred,
                total: p.totalBytes ?? r.total,
                speed: formatSpeed(bytesPerSec),
                status: 'active',
              }
            : r,
        )
      })
      return
    }
    const bytesPerSec = p.transferred / elapsed
    updateTransferRows((prev) => {
      const base = p.filename
      if (base.length === 0) return prev
      const target = pickRow(
        forTab(prev, p.tabId).filter(
          (r) =>
            r.op === (p.op as TransferOp) &&
            live(r) &&
            (r.filename === base || r.filename.endsWith(`/${base}`)),
        ),
        p.transferred,
      )
      if (!target) return prev
      return prev.map((r) =>
        r.key === target.key
          ? {
              ...r,
              transferred: p.transferred,
              total: p.total,
              speed: formatSpeed(bytesPerSec),
              status: 'active',
            }
          : r,
      )
    })
  })
  unlisten = stop
}

/** Test seam: drop the listener and empty the queue. */
export function resetTransferQueueForTests(): void {
  unlisten?.()
  unlisten = null
  listening = false
  rows = []
  emit()
}

/* ---------- hooks ---------- */

/** The current queue. Re-renders on every row change. */
export function useTransferRows(): TransferRow[] {
  const subscribe = useCallback((cb: () => void) => subscribeTransferQueue(cb), [])
  return useSyncExternalStore(subscribe, getTransferRows, getTransferRows)
}

/** A setter with the state-setter signature, so call sites read as before. */
export function useUpdateTransferRows(): (updater: (prev: TransferRow[]) => TransferRow[]) => void {
  return updateTransferRows
}

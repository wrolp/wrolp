import React, { useMemo, useState } from 'react'
import { useI18n } from '../i18n'
import { formatSize } from '../lib/format'
import {
  useTransferRows,
  updateTransferRows,
  removeTransferRow,
  clearFinishedTransfers,
  type TransferRow,
} from '../lib/transferQueue'
import { pauseTransfer, resumeTransfer, cancelTransfer } from '../commands'
import { Icon } from './Icon'

/**
 * The drawer's transfer queue.
 *
 * The rows are the app-wide queue (v8-P4), so this is a *view* of transfers that
 * may have started in the file panel or in the dual-pane view — and it keeps
 * showing them after both closed, which is the point of a persistent drawer.
 */

type Filter = 'all' | 'done' | 'failed'

const isFailed = (r: TransferRow) => r.status === 'error' || r.status === 'cancelled'
const isLive = (r: TransferRow) => r.status === 'active' || r.status === 'queued'

export const TransferQueue: React.FC = () => {
  const { t } = useI18n()
  const rows = useTransferRows()
  const [filter, setFilter] = useState<Filter>('all')
  // Pause is per-tab in the backend, so the queue remembers it per tab too.
  const [pausedTabs, setPausedTabs] = useState<Set<number>>(new Set())

  const counts = useMemo(
    () => ({
      all: rows.length,
      done: rows.filter((r) => r.status === 'done').length,
      failed: rows.filter(isFailed).length,
      active: rows.filter(isLive).length,
      bytes: rows.reduce((n, r) => n + r.total, 0),
    }),
    [rows],
  )

  const visible = useMemo(() => {
    if (filter === 'done') return rows.filter((r) => r.status === 'done')
    if (filter === 'failed') return rows.filter(isFailed)
    return rows
  }, [rows, filter])

  const togglePause = async (tabId: number) => {
    if (pausedTabs.has(tabId)) {
      setPausedTabs((prev) => {
        const next = new Set(prev)
        next.delete(tabId)
        return next
      })
      await resumeTransfer(tabId)
    } else {
      setPausedTabs((prev) => new Set(prev).add(tabId))
      await pauseTransfer(tabId)
    }
  }

  /**
   * The backend aborts every in-flight transfer of a tab at once, so cancelling
   * one row cancels that tab's other live rows too — otherwise they would
   * surface later as spurious errors.
   */
  const cancelRow = async (row: TransferRow) => {
    if (row.tabId == null) {
      updateTransferRows((prev) =>
        prev.map((r) => (r.key === row.key ? { ...r, status: 'cancelled', speed: '' } : r)),
      )
      return
    }
    const tabId = row.tabId
    try {
      await cancelTransfer(tabId)
    } catch {
      /* the transfer loop reports its own outcome; the row still reads cancelled */
    }
    updateTransferRows((prev) =>
      prev.map((r) =>
        r.tabId === tabId && isLive(r) ? { ...r, status: 'cancelled', speed: '' } : r,
      ),
    )
  }

  return (
    <div className="drawer-transfers">
      <div className="drawer-transfers-head">
        <button
          type="button"
          className={`dq-seg${filter === 'all' ? ' active' : ''}`}
          onClick={() => setFilter('all')}
        >
          <span>{t('transfersAll')}</span>
          {counts.all > 0 && <span className="dq-chip">{counts.all}</span>}
        </button>
        <button
          type="button"
          className={`dq-seg${filter === 'done' ? ' active' : ''}`}
          onClick={() => setFilter('done')}
        >
          <span>{t('transfersDone')}</span>
          {counts.done > 0 && <span className="dq-chip">{counts.done}</span>}
        </button>
        <button
          type="button"
          className={`dq-seg${filter === 'failed' ? ' active' : ''}`}
          onClick={() => setFilter('failed')}
        >
          <span>{t('failed')}</span>
          {counts.failed > 0 && <span className="dq-chip">{counts.failed}</span>}
        </button>
        <div className="drawer-transfers-right">
          <button
            type="button"
            className="dq-clear"
            onClick={() => clearFinishedTransfers()}
            disabled={counts.done + counts.failed === 0}
            title={t('clearFinished')}
          >
            <Icon name="trash" size={13} />
            <span>{t('clearFinished')}</span>
          </button>
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="dq-empty">{t('noTransfers')}</div>
      ) : (
        <div className="dq-list">
          {visible.map((row) => {
            const paused = row.tabId != null && pausedTabs.has(row.tabId)
            const pct = row.total > 0 ? Math.min(100, (row.transferred / row.total) * 100) : 0
            return (
              <div key={row.key} className={`dq-row ${row.status}`}>
                <span className={`dq-dir ${row.op}`}>
                  <Icon
                    name={row.op === 'download' || row.op === 'directory' ? 'download' : 'upload'}
                    size={14}
                  />
                </span>
                <div className="dq-main">
                  <div className="dq-line1">
                    <span className="dq-name" title={row.filename}>
                      {row.filename}
                    </span>
                    <span className="dq-tag">
                      {row.op === 'upload'
                        ? t('upload')
                        : row.op === 'delete'
                          ? t('delete')
                          : t('download')}
                    </span>
                  </div>
                  <div className="dq-track">
                    <div className="dq-fill" style={{ width: `${pct}%` }} />
                  </div>
                  <div className="dq-meta">
                    {row.total > 0 && (
                      <span>
                        {formatSize(row.transferred)} / {formatSize(row.total)}
                      </span>
                    )}
                    {row.speed && row.status === 'active' && <span>{row.speed}</span>}
                    {row.status === 'done' && <span className="dq-ok">✓</span>}
                    {row.status === 'error' && <span className="dq-err">✗ {t('failed')}</span>}
                    {row.status === 'cancelled' && (
                      <span className="dq-err">✕ {t('cancelled')}</span>
                    )}
                    {row.status === 'queued' && <span>· · ·</span>}
                    {paused && <span>{t('paused')}</span>}
                  </div>
                </div>
                <div className="dq-right">
                  {isLive(row) && row.tabId != null && (
                    <>
                      <button
                        type="button"
                        className="dq-act"
                        onClick={() => togglePause(row.tabId!)}
                        title={paused ? t('resumeTransfers') : t('pauseTransfers')}
                        aria-label={paused ? t('resumeTransfers') : t('pauseTransfers')}
                      >
                        <Icon name={paused ? 'play' : 'pause'} size={13} />
                      </button>
                      <button
                        type="button"
                        className="dq-act"
                        onClick={() => cancelRow(row)}
                        title={t('cancelTransfer')}
                        aria-label={t('cancelTransfer')}
                      >
                        <Icon name="x" size={13} />
                      </button>
                    </>
                  )}
                  {!isLive(row) && (
                    <button
                      type="button"
                      className="dq-act"
                      onClick={() => removeTransferRow(row.key)}
                      title={t('removeFromList')}
                      aria-label={t('removeFromList')}
                    >
                      <Icon name="x" size={13} />
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {rows.length > 0 && (
        <div className="dq-note">
          {t('transferSummary', {
            active: counts.active,
            done: counts.done,
            failed: counts.failed,
            total: formatSize(counts.bytes),
          })}
        </div>
      )}
    </div>
  )
}

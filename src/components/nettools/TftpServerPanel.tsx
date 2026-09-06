import { useCallback, useEffect, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { useI18n } from '../../i18n'
import {
  startTftpServer,
  stopTftpServer,
  tftpServerStatus,
  tftpRows,
  tftpCancel,
  tftpClearRows,
} from '../../commands'
import type { AppServerStatus, TftpRow } from '../../types'
import { dirGlyph, fmtBytes, fmtTime, parsePort } from './util'

function RowPill({ status }: { status: string }) {
  const cls =
    status === 'done' || status === 'error' || status === 'canceled' || status === 'running'
      ? status
      : ''
  return <span className={`nt-pill ${cls}`}>{status}</span>
}

function ProgressCell({ row }: { row: TftpRow }) {
  const pct = row.total > 0 ? Math.min(100, (row.transferred / row.total) * 100) : 0
  return (
    <span>
      <span className="nt-prog">
        <i style={{ width: `${pct}%` }} />
      </span>
      <span className="nt-note" style={{ marginLeft: 6 }}>
        {fmtBytes(row.transferred)}
      </span>
    </span>
  )
}

/** Tools panel: start/stop the built-in TFTP server and watch its transfers. */
export default function TftpServerPanel() {
  const { t } = useI18n()
  const [rootDir, setRootDir] = useState('')
  const [bindIp, setBindIp] = useState('')
  const [port, setPort] = useState('69')
  const [status, setStatus] = useState<AppServerStatus | null>(null)
  const [rows, setRows] = useState<TftpRow[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    try {
      const [s, r] = await Promise.all([tftpServerStatus(), tftpRows('server')])
      setStatus(s)
      setRows(r)
    } catch {
      // best-effort
    }
  }, [])

  useEffect(() => {
    void refresh()
    const id = window.setInterval(() => void refresh(), 1200)
    return () => window.clearInterval(id)
  }, [refresh])

  const pickDir = async () => {
    try {
      const picked = await open({ directory: true, multiple: false, title: t('ntRootDir') })
      if (typeof picked === 'string') setRootDir(picked)
    } catch {
      // dialog dismissed
    }
  }

  const start = async () => {
    if (!rootDir.trim()) {
      setError(t('ntFillAll'))
      return
    }
    setBusy(true)
    setError('')
    try {
      const st = await startTftpServer({
        rootDir: rootDir.trim(),
        port: parsePort(port, 69),
        bindIp: bindIp.trim() || undefined,
      })
      setStatus(st)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  const stop = async () => {
    setBusy(true)
    setError('')
    try {
      await stopTftpServer()
      setStatus(null)
      await refresh()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  const cancel = async (id: number) => {
    try {
      await tftpCancel(id)
    } catch {
      // row already finished
    }
  }

  const clear = async () => {
    try {
      await tftpClearRows('server')
      await refresh()
    } catch {
      // best-effort
    }
  }

  const running = !!status?.running

  return (
    <>
      <div className="nt-card">
        <div className="nt-card-title">{t('netToolTftpServer')}</div>
        {running ? (
          <div className="nt-status">
            <span className="nt-dot on" />
            {t('ntRunning', { port: status!.port })}
          </div>
        ) : (
          <div className="nt-status">
            <span className="nt-dot off" />
            {t('ntStopped')}
          </div>
        )}
        <div className="nt-field">
          <label htmlFor="tftp-root">{t('ntRootDir')}</label>
          <div className="nt-actions">
            <input
              id="tftp-root"
              className="nt-input"
              value={rootDir}
              onChange={(e) => setRootDir(e.target.value)}
              placeholder="C:\\tftp"
              disabled={running}
            />
            <button className="nt-btn nt-btn-sm" onClick={pickDir} disabled={running}>
              {t('ntBrowse')}
            </button>
          </div>
        </div>
        <div className="nt-field">
          <label htmlFor="tftp-bind">{t('ntBindIp')}</label>
          <input
            id="tftp-bind"
            className="nt-input"
            value={bindIp}
            onChange={(e) => setBindIp(e.target.value)}
            placeholder="0.0.0.0"
            disabled={running}
          />
        </div>
        <div className="nt-field">
          <label htmlFor="tftp-port">{t('ntPort')}</label>
          <input
            id="tftp-port"
            className="nt-input"
            type="number"
            value={port}
            onChange={(e) => setPort(e.target.value)}
            disabled={running}
          />
        </div>
        <div className="nt-actions">
          {!running && (
            <button className="nt-btn nt-btn-primary" onClick={start} disabled={busy}>
              {t('ntStart')}
            </button>
          )}
          {running && (
            <button className="nt-btn nt-btn-danger" onClick={stop} disabled={busy}>
              {t('ntStop')}
            </button>
          )}
          {busy && <span className="nt-note">{t('loading')}</span>}
        </div>
        {error && <div className="nt-error">{error}</div>}
      </div>

      <div className="nt-card" style={{ flex: '1', minHeight: '150px' }}>
        <div className="nt-card-title">
          <span>{t('netToolTftpServer')} / {t('ntStatusCol')}</span>
          <button className="nt-btn nt-btn-sm" onClick={clear}>
            {t('ntClearFinished')}
          </button>
        </div>
        {rows.length === 0 ? (
          <div className="nt-note">{t('ntNoRows')}</div>
        ) : (
          <div className="nt-rows" style={{ flex: '1' }}>
            <table className="nt-tbl">
              <thead>
                <tr>
                  <th>{t('ntFile')}</th>
                  <th>{t('ntPeer')}</th>
                  <th>{t('ntProgress')}</th>
                  <th>{t('ntStatusCol')}</th>
                  <th>{t('ntStartedAt')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} title={r.message || undefined}>
                    <td>
                      <span className="nt-mono">
                        {dirGlyph(r.direction)} {r.name}
                      </span>
                    </td>
                    <td className="nt-mono">{r.peer}</td>
                    <td>
                      <ProgressCell row={r} />
                    </td>
                    <td>
                      <RowPill status={r.status} />
                    </td>
                    <td className="nt-mono">{fmtTime(r.startedMs)}</td>
                    <td>
                      {r.status === 'running' && (
                        <button className="nt-btn nt-btn-sm" onClick={() => void cancel(r.id)}>
                          {t('ntCancelRow')}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  )
}

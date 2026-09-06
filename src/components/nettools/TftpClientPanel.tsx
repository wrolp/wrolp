import { useCallback, useEffect, useState } from 'react'
import { open, save } from '@tauri-apps/plugin-dialog'
import { useI18n } from '../../i18n'
import { tftpRows, tftpStart, tftpCancel, tftpClearRows } from '../../commands'
import type { TftpDirection, TftpRow } from '../../types'
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
        {fmtBytes(row.transferred)} / {fmtBytes(row.total)}
      </span>
    </span>
  )
}

/** Tools panel: run TFTP transfers from this machine to a remote server. */
export default function TftpClientPanel() {
  const { t } = useI18n()
  const [serverHost, setServerHost] = useState('')
  const [serverPort, setServerPort] = useState('69')
  const [remoteName, setRemoteName] = useState('')
  const [localPath, setLocalPath] = useState('')
  const [direction, setDirection] = useState<TftpDirection>('download')
  const [rows, setRows] = useState<TftpRow[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    try {
      setRows(await tftpRows('client'))
    } catch {
      // best-effort
    }
  }, [])

  useEffect(() => {
    void refresh()
    const id = window.setInterval(() => void refresh(), 1000)
    return () => window.clearInterval(id)
  }, [refresh])

  const pickLocal = async () => {
    try {
      if (direction === 'upload') {
        const picked = await open({ multiple: false, title: t('ntLocalChoose') })
        if (typeof picked === 'string') setLocalPath(picked)
      } else {
        const target = await save({
          title: t('ntLocalChoose'),
          defaultPath: remoteName.trim() || 'download.bin',
        })
        if (target) setLocalPath(target)
      }
    } catch {
      // dialog dismissed
    }
  }

  const start = async () => {
    if (!serverHost.trim() || !remoteName.trim() || !localPath.trim()) {
      setError(t('ntFillAll'))
      return
    }
    setBusy(true)
    setError('')
    try {
      await tftpStart({
        serverHost: serverHost.trim(),
        serverPort: parsePort(serverPort, 69),
        remoteName: remoteName.trim(),
        localPath,
        direction,
      })
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
      await tftpClearRows('client')
      await refresh()
    } catch {
      // best-effort
    }
  }

  return (
    <>
      <div className="nt-card">
        <div className="nt-card-title">{t('netToolTftpClient')}</div>
        <div className="nt-field">
          <label htmlFor="tc-host">{t('ntServerHost')}</label>
          <input
            id="tc-host"
            className="nt-input"
            value={serverHost}
            onChange={(e) => setServerHost(e.target.value)}
            placeholder="192.168.1.10"
          />
        </div>
        <div className="nt-field">
          <label htmlFor="tc-port">{t('ntPort')}</label>
          <input
            id="tc-port"
            className="nt-input"
            type="number"
            value={serverPort}
            onChange={(e) => setServerPort(e.target.value)}
          />
        </div>
        <div className="nt-field">
          <label htmlFor="tc-remote">{t('ntRemoteName')}</label>
          <input
            id="tc-remote"
            className="nt-input"
            value={remoteName}
            onChange={(e) => setRemoteName(e.target.value)}
            placeholder="firmware.bin"
          />
        </div>
        <div className="nt-field">
          <label htmlFor="tc-local">{t('ntLocalPath')}</label>
          <div className="nt-actions">
            <input
              id="tc-local"
              className="nt-input"
              value={localPath}
              onChange={(e) => setLocalPath(e.target.value)}
              placeholder="C:\\out\\file.bin"
            />
            <button className="nt-btn nt-btn-sm" onClick={pickLocal}>
              {t('ntBrowse')}
            </button>
          </div>
        </div>
        <div className="nt-field">
          <label>{t('ntDirection')}</label>
          <div className="nt-actions">
            <label className="nt-note" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input
                type="radio"
                className="nt-check"
                checked={direction === 'download'}
                onChange={() => {
                  setDirection('download')
                  setLocalPath('')
                }}
              />
              {t('ntDownload')}
            </label>
            <label className="nt-note" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input
                type="radio"
                className="nt-check"
                checked={direction === 'upload'}
                onChange={() => {
                  setDirection('upload')
                  setLocalPath('')
                }}
              />
              {t('ntUpload')}
            </label>
          </div>
        </div>
        <div className="nt-actions">
          <button className="nt-btn nt-btn-primary" onClick={start} disabled={busy}>
            {t('ntStartTransfer')}
          </button>
          {busy && <span className="nt-note">{t('loading')}</span>}
        </div>
        {error && <div className="nt-error">{error}</div>}
      </div>

      <div className="nt-card" style={{ flex: '1', minHeight: '150px' }}>
        <div className="nt-card-title">
          <span>
            {t('netToolTftpClient')} / {t('ntStatusCol')}
          </span>
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

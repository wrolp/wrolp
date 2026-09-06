import { useCallback, useEffect, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { useI18n } from '../../i18n'
import { ftpServerStatus, startFtpServer, stopFtpServer } from '../../commands'
import type { AppServerStatus } from '../../types'
import { parsePort } from './util'

/** Tools panel: start/stop the built-in FTP server and tweak its config. */
export default function FtpServerPanel() {
  const { t } = useI18n()
  const [rootDir, setRootDir] = useState('')
  const [port, setPort] = useState('2121')
  const [readOnly, setReadOnly] = useState(true)
  const [anonymous, setAnonymous] = useState(true)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [status, setStatus] = useState<AppServerStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    try {
      setStatus(await ftpServerStatus())
    } catch {
      // status polling is best-effort
    }
  }, [])

  useEffect(() => {
    void refresh()
    const id = window.setInterval(() => void refresh(), 2000)
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
      const st = await startFtpServer({
        rootDir: rootDir.trim(),
        port: parsePort(port, 2121),
        readOnly,
        anonymous,
        username: anonymous ? undefined : username.trim() || undefined,
        password: anonymous ? undefined : password || undefined,
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
      await stopFtpServer()
      setStatus(null)
      await refresh()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  const running = !!status?.running

  return (
    <>
      <div className="nt-card">
        <div className="nt-card-title">{t('netToolFtpServer')}</div>
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
          <label htmlFor="ftp-root">{t('ntRootDir')}</label>
          <div className="nt-actions">
            <input
              id="ftp-root"
              className="nt-input"
              value={rootDir}
              onChange={(e) => setRootDir(e.target.value)}
              placeholder="C:\\share"
              disabled={running}
            />
            <button className="nt-btn nt-btn-sm" onClick={pickDir} disabled={running}>
              {t('ntBrowse')}
            </button>
          </div>
        </div>
        <div className="nt-field">
          <label htmlFor="ftp-port">{t('ntPort')}</label>
          <input
            id="ftp-port"
            className="nt-input"
            type="number"
            value={port}
            onChange={(e) => setPort(e.target.value)}
            disabled={running}
          />
        </div>
        <div className="nt-field check">
          <label>
            <input
              type="checkbox"
              className="nt-check"
              checked={readOnly}
              disabled={running}
              onChange={(e) => setReadOnly(e.target.checked)}
            />
            {t('ntReadOnly')}
          </label>
        </div>
        <div className="nt-field check">
          <label>
            <input
              type="checkbox"
              className="nt-check"
              checked={anonymous}
              disabled={running}
              onChange={(e) => setAnonymous(e.target.checked)}
            />
            {t('ntAnonymous')}
          </label>
        </div>
        {!anonymous && (
          <>
            <div className="nt-field">
              <label htmlFor="ftp-user">{t('ntUsername')}</label>
              <input
                id="ftp-user"
                className="nt-input"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                disabled={running}
              />
            </div>
            <div className="nt-field">
              <label htmlFor="ftp-pass">{t('ntPassword')}</label>
              <input
                id="ftp-pass"
                className="nt-input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={running}
              />
            </div>
          </>
        )}
        <div className="nt-note">{t('ntRootNote')}</div>
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
    </>
  )
}

import { useCallback, useEffect, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { useI18n } from '../../i18n'
import { httpGenerateCert, httpServerStatus, startHttpServer, stopHttpServer } from '../../commands'
import type { AppServerStatus } from '../../types'
import { parsePort } from './util'

/** Tools panel: start/stop the built-in HTTP(S) file server. */
export default function HttpServerPanel() {
  const { t } = useI18n()
  const [rootDir, setRootDir] = useState('')
  const [port, setPort] = useState('8080')
  const [readOnly, setReadOnly] = useState(false)
  const [requireAuth, setRequireAuth] = useState(false)
  const [token, setToken] = useState('')
  const [enableTls, setEnableTls] = useState(false)
  const [certPath, setCertPath] = useState('')
  const [keyPath, setKeyPath] = useState('')
  const [maxUpload, setMaxUpload] = useState('1024')
  const [status, setStatus] = useState<AppServerStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [certNote, setCertNote] = useState('')

  const refresh = useCallback(async () => {
    try {
      setStatus(await httpServerStatus())
    } catch {
      // best-effort
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

  const pickFile = (setter: (v: string) => void) => async () => {
    try {
      const picked = await open({ multiple: false })
      if (typeof picked === 'string') setter(picked)
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
      const st = await startHttpServer({
        rootDir: rootDir.trim(),
        port: parsePort(port, 8080),
        readOnly,
        requireAuth,
        token: requireAuth ? token || undefined : undefined,
        enableTls,
        certPath: enableTls ? certPath.trim() || undefined : undefined,
        keyPath: enableTls ? keyPath.trim() || undefined : undefined,
        maxUploadSize: Math.max(1, Math.round(Number(maxUpload) || 1024)),
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
      await stopHttpServer()
      setStatus(null)
      await refresh()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  const genCert = async () => {
    setBusy(true)
    setError('')
    setCertNote('')
    try {
      const r = await httpGenerateCert()
      setCertPath(r.certPath)
      setKeyPath(r.keyPath)
      setCertNote(t('ntGenCertOk'))
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  const running = !!status?.running

  return (
    <div className="nt-card">
      <div className="nt-card-title">{t('netToolHttpServer')}</div>
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
        <label htmlFor="http-root">{t('ntRootDir')}</label>
        <div className="nt-actions">
          <input
            id="http-root"
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
        <label htmlFor="http-port">{t('ntPort')}</label>
        <input
          id="http-port"
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
            checked={requireAuth}
            disabled={running}
            onChange={(e) => setRequireAuth(e.target.checked)}
          />
          {t('ntRequireAuth')}
        </label>
      </div>
      {requireAuth && (
        <div className="nt-field">
          <label htmlFor="http-token">{t('ntToken')}</label>
          <input
            id="http-token"
            className="nt-input"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            disabled={running}
          />
        </div>
      )}
      <div className="nt-field">
        <label htmlFor="http-max">{t('ntMaxUpload')}</label>
        <input
          id="http-max"
          className="nt-input"
          type="number"
          min={1}
          value={maxUpload}
          onChange={(e) => setMaxUpload(e.target.value)}
          disabled={running || readOnly}
        />
      </div>
      <div className="nt-field check">
        <label>
          <input
            type="checkbox"
            className="nt-check"
            checked={enableTls}
            disabled={running}
            onChange={(e) => setEnableTls(e.target.checked)}
          />
          {t('ntEnableTls')}
        </label>
      </div>
      {enableTls && (
        <>
          <div className="nt-field">
            <label htmlFor="http-cert">{t('ntCertPath')}</label>
            <div className="nt-actions">
              <input
                id="http-cert"
                className="nt-input"
                value={certPath}
                onChange={(e) => setCertPath(e.target.value)}
                placeholder="cert.pem"
                disabled={running}
              />
              <button className="nt-btn nt-btn-sm" onClick={pickFile(setCertPath)} disabled={running}>
                {t('ntBrowse')}
              </button>
            </div>
          </div>
          <div className="nt-field">
            <label htmlFor="http-key">{t('ntKeyPath')}</label>
            <div className="nt-actions">
              <input
                id="http-key"
                className="nt-input"
                value={keyPath}
                onChange={(e) => setKeyPath(e.target.value)}
                placeholder="key.pem"
                disabled={running}
              />
              <button className="nt-btn nt-btn-sm" onClick={pickFile(setKeyPath)} disabled={running}>
                {t('ntBrowse')}
              </button>
            </div>
          </div>
          <div className="nt-actions">
            <button className="nt-btn" onClick={genCert} disabled={busy || running}>
              {t('ntGenCert')}
            </button>
            {certNote && <span className="nt-note">{certNote}</span>}
          </div>
        </>
      )}
      <div className="nt-note">{t('ntTlsNote')}</div>
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
  )
}

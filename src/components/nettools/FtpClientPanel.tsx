import { useCallback, useEffect, useRef, useState } from 'react'
import { open, save } from '@tauri-apps/plugin-dialog'
import { useI18n } from '../../i18n'
import {
  connectFtp,
  disconnectFtp,
  fsDownloadFile,
  fsListFiles,
  fsUploadFile,
} from '../../commands'
import type { FileEntry, TargetRef } from '../../types'
import { fmtBytes, parsePort } from './util'

/** Sessions are keyed by a synthetic u32 tab id (no real terminal tab). */
let ftpSeq = 0
function nextFtpTabId(): number {
  ftpSeq += 1
  return 0x7f000000 + ftpSeq
}

function baseOf(p: string): string {
  const parts = p.split(/[/\\]/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : p
}

function joinDir(dir: string, name: string): string {
  if (!name) return dir
  if (name.startsWith('/')) return name
  return dir === '/' ? `/${name}` : `${dir}/${name}`
}

/** FTP client browser: connect → navigate folders → upload / download files. */
export default function FtpClientPanel() {
  const { t } = useI18n()
  const [host, setHost] = useState('')
  const [port, setPort] = useState('21')
  const [username, setUsername] = useState('anonymous')
  const [password, setPassword] = useState('')
  const [encryption, setEncryption] = useState<'none' | 'explicit' | 'implicit'>('none')
  const [skipVerify, setSkipVerify] = useState(true)
  const [session, setSession] = useState<{ id: number; host: string } | null>(null)
  const [cwd, setCwd] = useState('/')
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const sessionRef = useRef<{ id: number } | null>(null)

  const targetFor = useCallback(
    (): TargetRef | null =>
      sessionRef.current ? { kind: 'ftp', tabId: sessionRef.current.id } : null,
    [],
  )

  const load = useCallback(
    async (dir: string) => {
      const target = targetFor()
      if (!target) return
      setLoading(true)
      setError('')
      try {
        const list = await fsListFiles(target, dir)
        setEntries(list)
        setCwd(dir)
      } catch (e) {
        setError(String(e))
        setEntries([])
      } finally {
        setLoading(false)
      }
    },
    [targetFor],
  )

  useEffect(() => {
    sessionRef.current = session
  }, [session])

  // Disconnect when the component unmounts (modal closes).
  useEffect(() => {
    return () => {
      const s = sessionRef.current
      if (s) void disconnectFtp(s.id).catch(() => undefined)
    }
  }, [])

  const connect = async () => {
    if (!host.trim() || !username.trim()) {
      setError(t('ntFillAll'))
      return
    }
    setBusy(true)
    setError('')
    const id = nextFtpTabId()
    try {
      await connectFtp({
        host: host.trim(),
        port: parsePort(port, 21),
        username: username.trim(),
        password: password || undefined,
        encryption,
        tabId: id,
        skipVerify,
      })
      sessionRef.current = { id }
      setSession({ id, host: host.trim() })
      await load('/')
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  const disconnect = async () => {
    const s = sessionRef.current
    sessionRef.current = null
    setSession(null)
    setEntries([])
    setCwd('/')
    if (s) {
      try {
        await disconnectFtp(s.id)
      } catch {
        // session already gone
      }
    }
  }

  const openDir = (entry: FileEntry) => {
    void load(entry.path || joinDir(cwd, entry.name))
  }

  const goUp = () => {
    if (cwd === '/') return
    const parent = cwd.slice(0, cwd.lastIndexOf('/'))
    void load(parent || '/')
  }

  const upload = async () => {
    const target = targetFor()
    if (!target) return
    try {
      const picked = await open({ multiple: false, title: t('ntLocalChoose') })
      if (typeof picked !== 'string') return
      setBusy(true)
      setError('')
      try {
        await fsUploadFile(target, picked, joinDir(cwd, baseOf(picked)))
        await load(cwd)
      } catch (e) {
        setError(String(e))
      } finally {
        setBusy(false)
      }
    } catch {
      // dialog dismissed
    }
  }

  const download = async (entry: FileEntry) => {
    const target = targetFor()
    if (!target || entry.isDir) return
    try {
      const targetPath = await save({ title: t('ntSaveTo'), defaultPath: entry.name })
      if (!targetPath) return
      setBusy(true)
      setError('')
      try {
        await fsDownloadFile(target, entry.path || joinDir(cwd, entry.name), targetPath)
        await load(cwd)
      } catch (e) {
        setError(String(e))
      } finally {
        setBusy(false)
      }
    } catch {
      // dialog dismissed
    }
  }

  const target = targetFor()
  const connected = !!target

  return (
    <>
      {!connected ? (
        <div className="nt-card">
          <div className="nt-card-title">{t('netToolFtpClient')}</div>
          <div className="nt-field">
            <label htmlFor="fc-host">{t('ntServerHost')}</label>
            <input
              id="fc-host"
              className="nt-input"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="192.168.1.10"
            />
          </div>
          <div className="nt-field">
            <label htmlFor="fc-port">{t('ntPort')}</label>
            <input
              id="fc-port"
              className="nt-input"
              type="number"
              value={port}
              onChange={(e) => setPort(e.target.value)}
            />
          </div>
          <div className="nt-field">
            <label htmlFor="fc-user">{t('ntUsername')}</label>
            <input
              id="fc-user"
              className="nt-input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>
          <div className="nt-field">
            <label htmlFor="fc-pass">{t('ntPassword')}</label>
            <input
              id="fc-pass"
              className="nt-input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <div className="nt-field">
            <label htmlFor="fc-enc">{t('ntEncryption')}</label>
            <select
              id="fc-enc"
              className="nt-select"
              value={encryption}
              onChange={(e) => setEncryption(e.target.value as 'none' | 'explicit' | 'implicit')}
            >
              <option value="none">{t('ntEncNone')}</option>
              <option value="explicit">{t('ntEncExplicit')}</option>
              <option value="implicit">{t('ntEncImplicit')}</option>
            </select>
          </div>
          {encryption !== 'none' && (
            <div className="nt-field check">
              <label>
                <input
                  type="checkbox"
                  className="nt-check"
                  checked={skipVerify}
                  onChange={(e) => setSkipVerify(e.target.checked)}
                />
                {t('ntSkipVerify')}
              </label>
            </div>
          )}
          <div className="nt-actions">
            <button className="nt-btn nt-btn-primary" onClick={connect} disabled={busy}>
              {t('ntConnect')}
            </button>
            {busy && <span className="nt-note">{t('loading')}</span>}
          </div>
          {error && <div className="nt-error">{error}</div>}
          <div className="nt-note">{t('ntConnectFirst')}</div>
        </div>
      ) : (
        <div className="nt-card" style={{ flex: '1', minHeight: '200px', display: 'flex', flexDirection: 'column' }}>
          <div className="nt-card-title">
            <span className="nt-status" style={{ marginRight: 'auto' }}>
              <span className="nt-dot on" />
              {t('ntConnectedTo', { host: session?.host ?? '' })}
            </span>
            <button className="nt-btn nt-btn-sm" onClick={goUp} disabled={cwd === '/'}>
              {t('ntUpDir')}
            </button>
            <button className="nt-btn nt-btn-sm" onClick={() => void load(cwd)} disabled={loading}>
              {t('ntRefresh')}
            </button>
            <button className="nt-btn nt-btn-sm" onClick={upload} disabled={busy}>
              {t('ntUpload')}
            </button>
            <button className="nt-btn nt-btn-danger nt-btn-sm" onClick={disconnect}>
              {t('ntDisconnect')}
            </button>
          </div>
          <div className="nt-note nt-mono" style={{ overflowWrap: 'anywhere' }}>
            {cwd}
          </div>
          {error && <div className="nt-error">{error}</div>}
          {loading ? (
            <div className="nt-note">{t('loading')}</div>
          ) : entries.length === 0 ? (
            <div className="nt-note">{t('ntEmptyDir')}</div>
          ) : (
            <div className="nt-rows" style={{ flex: '1' }}>
              <table className="nt-tbl">
                <thead>
                  <tr>
                    <th>{t('ntFile')}</th>
                    <th>{t('ntSize')}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e, i) => (
                    <tr
                      key={`${e.path}:${i}`}
                      title={e.isDir ? `${e.path}/` : e.path}
                      onDoubleClick={() => e.isDir && openDir(e)}
                    >
                      <td>
                        <span className="nt-mono">
                          {e.isDir ? '▸ ' : ''}
                          {baseOf(e.name)}
                        </span>
                      </td>
                      <td className="nt-mono">{e.isDir ? '—' : fmtBytes(e.size)}</td>
                      <td>
                        {!e.isDir && (
                          <button className="nt-btn nt-btn-sm" onClick={() => void download(e)}>
                            {t('ntDownload')}
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
      )}
    </>
  )
}

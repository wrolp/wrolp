import type { ConnectionConfig } from '../types'
import { useI18n } from '../i18n'
import { Icon } from './Icon'

/**
 * The empty state for the main area — v8's `welcome.html`.
 *
 * It replaces the terminal stage only while there is no tab at all: a window
 * whose tabs were all closed has nothing to show but the ways back in, and an
 * empty black rectangle is the least useful answer to that.
 */
export interface WelcomePageProps {
  connections: ConnectionConfig[]
  onOpenConnection: (conn: ConnectionConfig) => void
  onNewConnection: () => void
  onOpenLocalTerminal: () => void
  onOpenFiles: () => void
  onOpenNetTools: () => void
  onOpenCommandList: () => void
  onScanNetwork: () => void
}

export function WelcomePage({
  connections,
  onOpenConnection,
  onNewConnection,
  onOpenLocalTerminal,
  onOpenFiles,
  onOpenNetTools,
  onOpenCommandList,
  onScanNetwork,
}: WelcomePageProps) {
  const { t } = useI18n()
  // Four, not "all of them": the point of this row is the two or three hosts the
  // user opens every day, and a scrollable list here would just be the sidebar
  // again.
  const recent = connections.slice(0, 4)

  return (
    <div className="welcome" data-testid="welcome-page">
      <div className="welcome-hero">
        <img src="/icon-256.png" alt="" className="welcome-brand" />
        <h1 className="welcome-title">{t('welcomeTitle')}</h1>
        <p className="welcome-sub">{t('welcomeSub')}</p>
        <div className="welcome-actions">
          <button type="button" className="btn pri" onClick={onNewConnection}>
            <Icon name="plus" size={14} />
            <span>{t('welcomeNewConn')}</span>
          </button>
          <button type="button" className="btn" onClick={onOpenLocalTerminal}>
            <Icon name="desktop" size={14} />
            <span>{t('welcomeLocalTerm')}</span>
          </button>
        </div>
      </div>

      <div className="welcome-grid">
        <section className="welcome-card">
          <div className="welcome-card-head">
            <Icon name="server" size={14} />
            <span>{t('welcomeRecentHosts')}</span>
          </div>
          {recent.length === 0 ? (
            <p className="welcome-empty">{t('welcomeNoHosts')}</p>
          ) : (
            <ul className="welcome-list">
              {recent.map((c) => (
                <li key={c.id}>
                  <button type="button" onClick={() => onOpenConnection(c)}>
                    <span className="wl-name">{c.name}</span>
                    <span className="wl-sub mono">
                      {c.username ? `${c.username}@` : ''}
                      {c.host}:{c.port}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="welcome-card">
          <div className="welcome-card-head">
            <Icon name="folderOpen" size={14} />
            <span>{t('welcomeSftp')}</span>
          </div>
          <p className="welcome-desc">{t('welcomeSftpDesc')}</p>
          <button type="button" className="btn sm" onClick={onOpenFiles}>
            <span>{t('welcomeSftp')}</span>
          </button>
        </section>

        <section className="welcome-card">
          <div className="welcome-card-head">
            <Icon name="network" size={14} />
            <span>{t('welcomeNetTools')}</span>
          </div>
          <p className="welcome-desc">{t('welcomeNetToolsDesc')}</p>
          <div className="welcome-card-actions">
            <button type="button" className="btn sm" onClick={onOpenNetTools}>
              <span>{t('welcomeNetTools')}</span>
            </button>
            <button type="button" className="btn sm" onClick={onScanNetwork}>
              <span>{t('welcomeScan')}</span>
            </button>
          </div>
        </section>

        <section className="welcome-card">
          <div className="welcome-card-head">
            <Icon name="clipboard" size={14} />
            <span>{t('welcomeCmdList')}</span>
          </div>
          <p className="welcome-desc">{t('welcomeCmdListDesc')}</p>
          <button type="button" className="btn sm" onClick={onOpenCommandList}>
            <span>{t('welcomeCmdList')}</span>
          </button>
        </section>
      </div>
    </div>
  )
}

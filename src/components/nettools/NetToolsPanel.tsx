import { useEffect, useState } from 'react'
import { useI18n } from '../../i18n'
import FtpServerPanel from './FtpServerPanel'
import FtpClientPanel from './FtpClientPanel'
import HttpServerPanel from './HttpServerPanel'
import TftpServerPanel from './TftpServerPanel'
import TftpClientPanel from './TftpClientPanel'

type ToolsTab = 'ftpServer' | 'ftpClient' | 'httpServer' | 'tftpServer' | 'tftpClient'

const TABS: { id: ToolsTab; key: string }[] = [
  { id: 'ftpServer', key: 'netToolFtpServer' },
  { id: 'ftpClient', key: 'netToolFtpClient' },
  { id: 'httpServer', key: 'netToolHttpServer' },
  { id: 'tftpServer', key: 'netToolTftpServer' },
  { id: 'tftpClient', key: 'netToolTftpClient' },
]

/** Floating tools window hosting the built-in file servers and TFTP client. */
export default function NetToolsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n()
  const [active, setActive] = useState<ToolsTab>('ftpServer')

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="nt-overlay">
      <div className="nt-dialog" role="dialog" aria-modal="true">
        <div className="nt-head">
          <div className="nt-title">{t('netToolTitle')}</div>
          <div className="nt-tabs">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                className={`nt-tab${active === tab.id ? ' active' : ''}`}
                onClick={() => setActive(tab.id)}
              >
                {t(tab.key as never)}
              </button>
            ))}
          </div>
          <button className="nt-close" title={t('ntClose')} onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="nt-body">
          <div
            style={{ display: active === 'ftpServer' ? 'flex' : 'none', flexDirection: 'column', gap: 12, flex: 1 }}
          >
            <FtpServerPanel />
          </div>
          <div
            style={{ display: active === 'ftpClient' ? 'flex' : 'none', flexDirection: 'column', gap: 12, flex: 1 }}
          >
            <FtpClientPanel />
          </div>
          <div
            style={{ display: active === 'httpServer' ? 'flex' : 'none', flexDirection: 'column', gap: 12, flex: 1 }}
          >
            <HttpServerPanel />
          </div>
          <div
            style={{ display: active === 'tftpServer' ? 'flex' : 'none', flexDirection: 'column', gap: 12, flex: 1 }}
          >
            <TftpServerPanel />
          </div>
          <div
            style={{ display: active === 'tftpClient' ? 'flex' : 'none', flexDirection: 'column', gap: 12, flex: 1 }}
          >
            <TftpClientPanel />
          </div>
        </div>
      </div>
    </div>
  )
}

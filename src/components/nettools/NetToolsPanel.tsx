import { useState } from 'react'
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

/**
 * The rail's 网络工具 mode: the built-in FTP/HTTP/TFTP servers and the TFTP
 * client, in the mode column. It used to be a modal, which meant it could only
 * be looked at — as a mode it can stay open beside a terminal.
 *
 * Only the selected tab is mounted: four of the five panels poll (1–2s), and a
 * mode stays mounted for as long as the user leaves it selected.
 */
export default function NetToolsPanel() {
  const { t } = useI18n()
  const [active, setActive] = useState<ToolsTab>('ftpServer')

  return (
    <div className="nt-panel">
      <div className="panel-head sec">
        <div className="panel-title">{t('netToolTitle')}</div>
      </div>
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
      <div className="nt-body">
        {active === 'ftpServer' && <FtpServerPanel />}
        {active === 'ftpClient' && <FtpClientPanel />}
        {active === 'httpServer' && <HttpServerPanel />}
        {active === 'tftpServer' && <TftpServerPanel />}
        {active === 'tftpClient' && <TftpClientPanel />}
      </div>
    </div>
  )
}

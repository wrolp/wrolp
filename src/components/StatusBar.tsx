import type { TabInfo } from '../types'
import { useI18n } from '../i18n'
import { Icon } from './Icon'

export type UpdateState = 'idle' | 'checking' | 'downloading' | 'installing'

type Props = {
  /** The tab the user is looking at, or nothing when no tab is open. */
  tab?: TabInfo
  /** Character grid of the focused pane, once xterm has reported one. */
  termSize?: { cols: number; rows: number }
  recording?: boolean
  update?: { version: string; state: UpdateState } | null
  onDownloadUpdate?: () => void
  onDismissUpdate?: () => void
}

// State is carried by three channels at once — a shape, a colour and a word — so
// the bar still reads correctly for someone who cannot tell `$success` from
// `$warning`. `_components.scss`'s `.dot` owns the shapes.
const DOTS = {
  connected: 'ok',
  connecting: 'busy',
  suspect: 'warn',
  error: 'err',
  disconnected: 'idle',
} as const

const STATE_KEYS = {
  connected: 'statusConnected',
  connecting: 'statusConnecting',
  suspect: 'statusSuspect',
  error: 'statusError',
  disconnected: 'statusDisconnected',
} as const

export function StatusBar({
  tab,
  termSize,
  recording,
  update,
  onDownloadUpdate,
  onDismissUpdate,
}: Props) {
  const { t } = useI18n()

  const dot = tab ? DOTS[tab.status as keyof typeof DOTS] : undefined
  const stateWord = tab ? STATE_KEYS[tab.status as keyof typeof STATE_KEYS] : undefined
  const target = tab && tab.tabType !== 'settings' ? tab : null

  return (
    <div className="status-bar">
      <div className="status-bar-left">
        {!tab && <span className="status-item dim">{t('noActiveConnection')}</span>}
        {tab?.tabType === 'settings' && (
          <span className="status-item">
            <Icon name="settings" size={12} />
            <span>{t('tabSettings')}</span>
          </span>
        )}
        {target && (
          <>
            <span className="status-item">
              <span className={`dot ${dot ?? 'idle'}`} />
              <span>{stateWord ? t(stateWord) : target.connectionName}</span>
            </span>
            {/* `host` already folds in the port (`10.0.1.22:22`) or the serial port
                name, which is why there is no separate port read-out here. */}
            {target.host && target.host !== target.connectionName && (
              <span className="status-item dim">
                <span>{target.host}</span>
              </span>
            )}
          </>
        )}
        {termSize && termSize.cols > 0 && (
          <span className="status-item mono dim" title={`${termSize.cols} × ${termSize.rows}`}>
            <span>
              {termSize.cols}×{termSize.rows}
            </span>
          </span>
        )}
        {recording && (
          <span className="status-item">
            <span className="dot rec" />
            <span>{t('statusRecording')}</span>
          </span>
        )}
      </div>
      <div className="status-bar-right">
        {update && (
          <>
            <button
              type="button"
              className="status-item upd"
              onClick={onDownloadUpdate}
              disabled={update.state !== 'idle'}
            >
              <span>
                v{update.version}{' '}
                {update.state === 'downloading'
                  ? t('downloading')
                  : update.state === 'installing'
                    ? t('installing')
                    : t('updateAvailable')}
              </span>
            </button>
            <button
              type="button"
              className="status-item"
              onClick={onDismissUpdate}
              title={t('close')}
            >
              <Icon name="x" size={12} />
            </button>
          </>
        )}
      </div>
    </div>
  )
}

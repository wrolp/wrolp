import type { IconName } from './Icon'
import { Icon } from './Icon'
import { useI18n } from '../i18n'
import type { TranslationKey } from '../i18n/en'

/**
 * The 52px activity rail — v8's replacement for "stack every sidebar section
 * vertically". Each mode owns the mode panel next to it; only one is mounted at
 * a time, which is why the collapsed/expanded plumbing the old stacked sidebar
 * needed is gone.
 */
export type RailMode = 'hosts' | 'files' | 'containers' | 'sessions' | 'nettools'

interface ActivityRailProps {
  mode: RailMode
  onModeChange: (mode: RailMode) => void
  /** A mode with nothing to show is hidden rather than rendered empty. */
  filesAvailable: boolean
  containersAvailable: boolean
  onSettings: () => void
}

const MODES: { mode: RailMode; icon: IconName; labelKey: TranslationKey }[] = [
  { mode: 'hosts', icon: 'server', labelKey: 'railHosts' },
  { mode: 'files', icon: 'folderOpen', labelKey: 'railFiles' },
  { mode: 'containers', icon: 'container', labelKey: 'railContainers' },
  { mode: 'sessions', icon: 'history', labelKey: 'railSessions' },
  { mode: 'nettools', icon: 'network', labelKey: 'railNetTools' },
]

export function ActivityRail({
  mode,
  onModeChange,
  filesAvailable,
  containersAvailable,
  onSettings,
}: ActivityRailProps) {
  const { t } = useI18n()

  const visible = (m: RailMode) =>
    m === 'files' ? filesAvailable : m === 'containers' ? containersAvailable : true

  return (
    <nav className="activity-rail" aria-label={t('railNav')}>
      <div className="rail-group">
        {MODES.filter((m) => visible(m.mode)).map((m) => (
          <button
            key={m.mode}
            type="button"
            className={`rail-item${mode === m.mode ? ' active' : ''}`}
            data-mode={m.mode}
            title={t(m.labelKey)}
            aria-label={t(m.labelKey)}
            aria-current={mode === m.mode ? 'true' : undefined}
            onClick={() => onModeChange(m.mode)}
          >
            <Icon name={m.icon} size={18} />
          </button>
        ))}
      </div>
      <div className="rail-group rail-bottom">
        <button
          type="button"
          className="rail-item"
          title={t('titlebarSettings')}
          aria-label={t('titlebarSettings')}
          onClick={onSettings}
        >
          <Icon name="settings" size={18} />
        </button>
      </div>
    </nav>
  )
}

import { useId, useState } from 'react'
import { useI18n } from '../i18n'
import type { TranslationKey } from '../i18n/en'
import type { AiFlowEvent, AiRunTrace } from '../types'
import { Icon, type IconName } from './Icon'

type FlowLabel = { label: TranslationKey; icon: IconName }

const PHASES = {
  request: { label: 'aiFlowRequest', icon: 'send' },
  response: { label: 'aiFlowResponse', icon: 'messageSquare' },
  tools: { label: 'aiFlowTools', icon: 'settings' },
  confirmation: { label: 'aiFlowWaiting', icon: 'pause' },
  resume: { label: 'aiFlowResume', icon: 'play' },
  completed: { label: 'aiFlowCompleted', icon: 'check' },
  error: { label: 'aiFlowError', icon: 'x' },
  cancelled: { label: 'aiFlowCancelled', icon: 'x' },
} satisfies Record<AiFlowEvent['phase'], FlowLabel>

const STATUSES = {
  running: { label: 'aiFlowRunning', icon: 'network' },
  waiting: PHASES.confirmation,
  completed: PHASES.completed,
  error: PHASES.error,
  cancelled: PHASES.cancelled,
} satisfies Record<AiRunTrace['status'], FlowLabel>

export default function AiCallFlow({ trace }: { trace: AiRunTrace }) {
  const { t } = useI18n()
  const [expanded, setExpanded] = useState(false)
  const id = useId()
  const detailsId = `${id}-details`
  const titleId = `${id}-title`
  const lastEvent = trace.events[trace.events.length - 1]
  // Status is authoritative even when cancellation/error arrives without an event.
  const submitting = trace.status === 'running' && !lastEvent
  const status: FlowLabel = submitting
    ? { label: 'aiFlowSubmitting', icon: 'send' }
    : trace.status === 'running' && lastEvent
      ? PHASES[lastEvent.phase]
      : STATUSES[trace.status]

  return (
    <div className="ai-call-flow" data-status={trace.status}>
      <button
        type="button"
        className="ai-call-flow-toggle"
        aria-expanded={expanded}
        aria-controls={detailsId}
        onClick={() => setExpanded((value) => !value)}
      >
        <Icon name="network" size={15} />
        <span className="ai-call-flow-heading">
          <span id={titleId} className="ai-call-flow-title">
            {t('aiFlowTitle')}
          </span>
          <span className="ai-call-flow-summary" aria-live="polite" aria-atomic="true">
            <span className="ai-call-flow-status">
              <Icon name={status.icon} size={13} />
              <span>{t(status.label)}</span>
            </span>
            <span className="ai-call-flow-elapsed">
              {lastEvent
                ? t('aiFlowElapsed', { ms: lastEvent.elapsedMs })
                : t('aiFlowElapsedPending')}
            </span>
          </span>
        </span>
        <Icon name="chevronDown" size={14} className="ai-call-flow-chevron" />
      </button>

      <div id={detailsId} className="ai-call-flow-details" hidden={!expanded}>
        <dl className="ai-call-flow-snapshot" aria-label={t('aiFlowSnapshot')}>
          <div>
            <dt>{t('aiFlowEndpoint')}</dt>
            <dd>{trace.profileName || t('unknown')}</dd>
          </div>
          <div>
            <dt>{t('model')}</dt>
            <dd>{trace.model || t('unknown')}</dd>
          </div>
          <div>
            <dt>{t('aiFlowScope')}</dt>
            <dd>
              {trace.tabId === null ? t('aiFlowGlobal') : t('aiFlowTerminal', { id: trace.tabId })}
            </dd>
          </div>
        </dl>
        <p className="ai-call-flow-note">{t('aiFlowDescription')}</p>
        {trace.events.length === 0 && (
          <p className="ai-call-flow-note">
            {t(submitting ? 'aiFlowSubmitting' : 'aiFlowNoEvents')}
          </p>
        )}
        <ol className="ai-call-flow-events" aria-labelledby={titleId}>
          {trace.events.map((event) => (
            <li key={event.seq} data-phase={event.phase}>
              <Icon name={PHASES[event.phase].icon} size={14} />
              <div className="ai-call-flow-event-body">
                <span className="ai-call-flow-phase">{t(PHASES[event.phase].label)}</span>
                <span className="ai-call-flow-event-meta">
                  <span>{t('aiFlowRound', { round: event.round })}</span>
                  <span className="ai-call-flow-elapsed">
                    {t('aiFlowElapsed', { ms: event.elapsedMs })}
                  </span>
                </span>
              </div>
            </li>
          ))}
        </ol>
      </div>
      {trace.status === 'cancelled' && (
        <p className="ai-call-flow-cancel-note">{t('aiFlowCancelNote')}</p>
      )}
    </div>
  )
}

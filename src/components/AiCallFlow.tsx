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

function prettyArguments(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

/** `run_command` carries the line it will type; surface it above the raw JSON. */
function commandOf(raw: string): string | null {
  try {
    const value: unknown = JSON.parse(raw)
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const command = (value as Record<string, unknown>).command
      if (typeof command === 'string' && command.trim()) return command.trim()
    }
  } catch {
    // Some tool arguments are free-form text rather than JSON.
  }
  return null
}

function EventDetail({ event }: { event: AiFlowEvent }) {
  const { t } = useI18n()
  const detail = event.detail
  if (!detail) return null
  if (typeof detail.approved === 'boolean') {
    return (
      <p className="ai-call-flow-approval">
        {t(detail.approved ? 'aiFlowAllowed' : 'aiFlowDenied')}
      </p>
    )
  }
  if (detail.calls) {
    return (
      <div className="ai-call-flow-calls">
        {detail.calls.length === 0 ? (
          <p className="ai-call-flow-note">{t('aiFlowNoCalls')}</p>
        ) : (
          detail.calls.map((call, index) => {
            const command = commandOf(call.arguments)
            return (
              <div className="ai-call-flow-call" key={`${call.name}-${index}`}>
                <div className="ai-call-flow-call-head">
                  <span className="ai-call-flow-call-name">{call.name}</span>
                  {command && <code className="ai-call-flow-call-command">{command}</code>}
                </div>
                <pre className="ai-call-flow-call-args">{prettyArguments(call.arguments)}</pre>
              </div>
            )
          })
        )}
      </div>
    )
  }
  return (
    <dl className="ai-call-flow-params">
      {detail.model && (
        <div>
          <dt>{t('model')}</dt>
          <dd>{detail.model}</dd>
        </div>
      )}
      {typeof detail.messages === 'number' && (
        <div>
          <dt>{t('aiFlowMessageCount')}</dt>
          <dd>{detail.messages}</dd>
        </div>
      )}
      {typeof detail.maxTokens === 'number' && (
        <div>
          <dt>{t('aiFlowMaxTokens')}</dt>
          <dd>{detail.maxTokens}</dd>
        </div>
      )}
      {typeof detail.temperature === 'number' && (
        <div>
          <dt>{t('aiFlowTemperature')}</dt>
          <dd>{detail.temperature}</dd>
        </div>
      )}
      {detail.format && (
        <div>
          <dt>{t('aiFlowToolFormat')}</dt>
          <dd>{detail.format}</dd>
        </div>
      )}
      {detail.tools && (
        <div className="ai-call-flow-params-wide">
          <dt>{t('aiFlowAvailableTools')}</dt>
          <dd>
            {detail.tools.length === 0 ? (
              t('aiFlowNoTools')
            ) : (
              <span className="ai-call-flow-tool-chips">
                {detail.tools.map((tool) => (
                  <code key={tool} className="ai-call-flow-tool-chip">
                    {tool}
                  </code>
                ))}
              </span>
            )}
          </dd>
        </div>
      )}
    </dl>
  )
}

function FlowEvent({ event }: { event: AiFlowEvent }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const id = useId()
  const detailId = `${id}-detail`
  const callCount = event.detail?.calls?.length

  return (
    <li data-phase={event.phase} data-round={event.round}>
      <span className="ai-call-flow-node" aria-hidden>
        <Icon name={PHASES[event.phase].icon} size={13} />
      </span>
      <div className="ai-call-flow-card">
        <div className="ai-call-flow-card-head">
          <span className="ai-call-flow-phase">{t(PHASES[event.phase].label)}</span>
          <span className="ai-call-flow-event-meta">
            <span>{t('aiFlowRound', { round: event.round })}</span>
            <span className="ai-call-flow-elapsed">
              {t('aiFlowElapsed', { ms: event.elapsedMs })}
            </span>
          </span>
        </div>
        {event.detail && (
          <>
            <button
              type="button"
              className="ai-call-flow-detail-toggle"
              aria-expanded={open}
              aria-controls={detailId}
              onClick={() => setOpen((value) => !value)}
            >
              <Icon name="chevronDown" size={12} />
              <span>{t(open ? 'aiFlowHideDetail' : 'aiFlowShowDetail')}</span>
              {typeof callCount === 'number' && (
                <span className="ai-call-flow-count">{callCount}</span>
              )}
            </button>
            <div id={detailId} className="ai-call-flow-event-detail" hidden={!open}>
              <EventDetail event={event} />
            </div>
          </>
        )}
      </div>
    </li>
  )
}

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
            <FlowEvent key={event.seq} event={event} />
          ))}
        </ol>
      </div>
      {trace.status === 'cancelled' && (
        <p className="ai-call-flow-cancel-note">{t('aiFlowCancelNote')}</p>
      )}
    </div>
  )
}

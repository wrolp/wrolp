import { useCallback, useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { emit, listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { TerminalComponent } from './components/Terminal'
import AiChatPanel from './components/AiChatPanel'
import { Titlebar } from './components/Titlebar'
import { Icon } from './components/Icon'
import { useI18n } from './i18n'
import { getRecordingEnabled, loadAiConfig, saveAiConfig, setRecordingEnabled } from './commands'
import { seedScrollback, serializeTerminal } from './components/terminal/registry'
import {
  AI_MAX_WIDTH,
  AI_MIN_WIDTH,
  AI_WIDTH_KEY,
  aiWidthBounds,
  focusMainWindow,
  putFloatScrollback,
  takeFloatContext,
  takeFloatScrollback,
  type FloatTerminalContext,
} from './lib/floatWindow'
import { emptyAiConv } from './lib/aiConv'
import type { AiConfig } from './types'
import type { AiConv } from './aiChatRun'
/** The connection states a terminal can be in (a float window is never a "home"). */
type Status = 'connected' | 'connecting' | 'suspect' | 'error' | 'disconnected'

/** Dot colour for the connection state (same mapping as the status bar). */
const DOTS: Record<Status, string> = {
  connected: 'ok',
  connecting: 'busy',
  suspect: 'warn',
  error: 'err',
  disconnected: 'idle',
}

const STATUS_KEYS = {
  connected: 'statusConnected',
  connecting: 'statusConnecting',
  suspect: 'statusSuspect',
  error: 'statusError',
  disconnected: 'statusDisconnected',
} as const

function readAiWidth(): number {
  try {
    const n = Number(localStorage.getItem(AI_WIDTH_KEY))
    if (Number.isFinite(n) && n >= AI_MIN_WIDTH && n <= AI_MAX_WIDTH) return n
  } catch {
    // Private mode / quota: the default is fine.
  }
  return 320
}

/**
 * The whole UI of a float window: one terminal, owning one session.
 *
 * It carries the controls that belong to *that pane* — reconnect, recording, and a
 * way back to the AI panel — because the main window's copies of them are hidden
 * behind the pane this window took over. Anything that is app-wide rather than
 * per-pane (the AI conversation, the inspector, the recordings list) stays in the
 * main window: this one asks it to come forward instead of growing a second copy.
 *
 * Two hand-overs keep the experience continuous: the screen is replayed on mount
 * (the main window serialized it before letting go) and serialized again on close,
 * before the window is destroyed, so docking back does not blank the pane.
 */
export function FloatTerminal({ tabId }: { tabId: number }) {
  const { t } = useI18n()
  const [ready, setReady] = useState(false)
  const [context, setContext] = useState<FloatTerminalContext | null>(null)
  const [status, setStatus] = useState<Status>('connecting')
  const [recording, setRecording] = useState(false)
  const [reconnectTrigger, setReconnectTrigger] = useState(0)
  /** The AI panel docked in this window, bound to this window's session. */
  const [aiOpen, setAiOpen] = useState(false)
  const [aiWidth, setAiWidth] = useState(readAiWidth)
  const [aiConfig, setAiConfig] = useState<AiConfig | null>(null)
  const [aiConv, setAiConv] = useState<AiConv>(() => emptyAiConv())
  // `profiles` may be absent on a config that was never saved (the backend returns
  // an empty object then), so this window must tolerate it like the main one does.
  const aiProfiles = aiConfig?.profiles ?? []
  const activeProfile = aiProfiles.find((p) => p.id === aiConfig?.activeId) ?? aiProfiles[0] ?? null

  useEffect(() => {
    let cancelled = false
    void Promise.all([
      takeFloatScrollback(tabId).catch(() => null),
      takeFloatContext(tabId).catch(() => null),
    ]).then(([screen, ctx]) => {
      if (cancelled) return
      if (screen) seedScrollback(tabId, screen)
      setContext(ctx)
      setReady(true)
    })
    return () => {
      cancelled = true
    }
  }, [tabId])

  useEffect(() => {
    void getRecordingEnabled(tabId)
      .then((on) => setRecording(on))
      .catch(() => {})
  }, [tabId])

  // The backend's own "this session is gone" notice. The terminal stops polling on
  // it but does not change its status, so without this the toolbar would keep saying
  // "connected" and Reconnect would stay disabled forever.
  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined
    void listen<{ tabId: number }>('connection-closed', (event) => {
      if (event.payload.tabId === tabId) setStatus('disconnected')
    }).then((fn) => {
      if (disposed) fn()
      else unlisten = fn
    })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [tabId])

  useEffect(() => {
    document.body.classList.add('float-window')
    const win = getCurrentWindow()
    let unlisten: (() => void) | undefined
    void win
      .onCloseRequested(async (event) => {
        // Hold the close until the buffer is on its way: destroying the webview
        // first would lose the hand-over payload and the docked pane would come
        // back blank.
        event.preventDefault()
        const data = serializeTerminal(tabId)
        if (data) await putFloatScrollback(tabId, data).catch(() => {})
        await win.destroy()
      })
      .then((fn) => {
        unlisten = fn
      })
    return () => {
      document.body.classList.remove('float-window')
      unlisten?.()
    }
  }, [tabId])

  // The endpoint list lives in the backend, so this window can offer the same
  // switcher as the inspector without asking the main window for anything.
  useEffect(() => {
    if (!aiOpen || aiConfig) return
    void loadAiConfig()
      .then(setAiConfig)
      .catch(() => setAiConfig(null))
  }, [aiConfig, aiOpen])

  // A remembered width can be wider than this window allows (the window was
  // resized, or the panel was dragged wide on a bigger screen). Re-clamp whenever
  // the body changes size, so the terminal never ends up below its floor.
  useEffect(() => {
    if (!aiOpen) return
    const body = document.querySelector<HTMLElement>('.float-body')
    if (!body) return
    const reclamp = () => {
      const { min, max } = aiWidthBounds(body.clientWidth)
      setAiWidth((w) => Math.min(max, Math.max(min, w)))
    }
    reclamp()
    // Observing the body, not the column: its size is what bounds the column, and it
    // does not change while the seam itself is being dragged.
    const observer = new ResizeObserver(reclamp)
    observer.observe(body)
    return () => observer.disconnect()
  }, [aiOpen])

  /**
   * Drag the seam between terminal and AI column.
   *
   * Delta-based on `clientX` (an absolute edge would jump on the first move, the
   * same trap the main window's column resize documents), clamped so neither side
   * can be squeezed away, and persisted once the drag ends rather than per frame.
   */
  const startAiResize = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      e.preventDefault()
      const startX = e.clientX
      const startWidth = aiWidth
      const body = e.currentTarget.parentElement
      const { min, max } = aiWidthBounds(body?.clientWidth ?? 0)
      let width = startWidth
      const win = getCurrentWindow()
      // A window-level resize while a column drag is in flight fights the pointer.
      void win.setResizable(false).catch(() => {})
      const onMove = (ev: MouseEvent) => {
        const delta = ev.clientX - startX
        width = Math.max(min, Math.min(max, startWidth - delta))
        setAiWidth(width)
      }
      const onUp = () => {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        // The shared seam class: `_panes.scss` lights the divider on this body class
        // for the whole gesture, so the pointer may leave the 4px strip.
        document.body.classList.remove('resize-inspector')
        void win.setResizable(true).catch(() => {})
        try {
          localStorage.setItem(AI_WIDTH_KEY, String(Math.round(width)))
        } catch {
          // Preference only; the width on screen still applies.
        }
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
      document.body.classList.add('resize-inspector')
    },
    [aiWidth],
  )

  const toggleRecording = useCallback(async () => {
    try {
      setRecording(await setRecordingEnabled(tabId, !recording))
    } catch {
      // A session that is already gone cannot record; the button simply stays put.
    }
  }, [recording, tabId])

  const title = context?.title ?? `#${tabId}`
  const canReconnect = status === 'disconnected' || status === 'error'

  return (
    <div className="float-window-root">
      {/* The app's own titlebar, not the OS one: this window is part of Wrolp, and a
          native frame would look like a second, unrelated application. */}
      <Titlebar workspace={<span className="float-tb-title">{title}</span>} />
      <div className="float-body">
        <div className="float-term">
          {ready && (
            <TerminalComponent
              tabId={tabId}
              isActive
              isFocused
              isVisible
              // The session is already open in the backend: adopt it instead of
              // connecting again (which would replace the live shell).
              attachOnly
              autoConnect
              reconnectTrigger={reconnectTrigger}
              connectConfig={context?.connectConfig}
              isLocal={context?.isLocal}
              isSerial={context?.isSerial}
              isTelnet={context?.isTelnet}
              dockerContainer={context?.dockerContainer ?? undefined}
              kubectlExec={context?.kubectlExec ?? undefined}
              localCwd={context?.localCwd}
              localShellType={context?.localShellType}
              localDistro={context?.localDistro}
              onStatusChange={(next, errorMessage) => {
                setStatus(next)
                // The main window still shows this tab's status (title, status bar),
                // so a disconnect that happens here has to reach it.
                void emit('float-window-status', { tabId, status: next, errorMessage }).catch(
                  () => {},
                )
              }}
            />
          )}
        </div>
        {aiOpen && (
          <>
            {/* The seam: without it the AI column could not be widened, which is
                worse in a float window than in the main one — there is no other
                column to steal space from. */}
            <div
              // `panel-divider` is the app's own seam (accent gradient that fades
              // at both ends); `float-ai-resizer` stays as the test/automation hook.
              className="panel-divider float-ai-resizer"
              role="separator"
              aria-orientation="vertical"
              aria-label={t('dragToResize')}
              title={t('dragToResize')}
              onMouseDown={startAiResize}
            />
            {/* Bound to *this* window's session: `tabId` is what makes the panel's
                tools and "send to terminal" act on the popped-out shell rather than
                the main window's selection. */}
            <aside className="float-ai" style={{ width: aiWidth }}>
              <AiChatPanel
                tabId={tabId}
                config={activeProfile}
                profiles={aiProfiles}
                onSelectProfile={(id) =>
                  setAiConfig((prev) => {
                    if (!prev) return prev
                    const next = { ...prev, activeId: id }
                    void saveAiConfig(next).catch(() => {})
                    return next
                  })
                }
                onSelectModel={(model) =>
                  setAiConfig((prev) => {
                    if (!prev) return prev
                    const activeId = prev.activeId
                    const profiles = prev.profiles.map((p) =>
                      p.id === activeId ? { ...p, model } : p,
                    )
                    const next = { ...prev, profiles }
                    void saveAiConfig(next).catch(() => {})
                    return next
                  })
                }
                conv={aiConv}
                setConv={(updater) =>
                  setAiConv((prev) =>
                    typeof updater === 'function'
                      ? (updater as (c: AiConv) => AiConv)(prev)
                      : { ...prev, ...updater },
                  )
                }
                onClose={() => setAiOpen(false)}
                isLocal={context?.isLocal}
                isSerial={context?.isSerial}
                isTelnet={context?.isTelnet}
                defaultMode={aiConfig?.defaultMode}
                defaultMaxAgentRounds={aiConfig?.maxAgentRounds}
                // Settings are the main window's tab; this one just brings it forward.
                onOpenSettings={() => void focusMainWindow().catch(() => {})}
              />
            </aside>
          </>
        )}
      </div>
      {/* The session's status and controls sit on the bottom edge, the way a status
          bar does in the main window — the top belongs to the titlebar alone. */}
      <div className="float-toolbar">
        <span className={`dot ${DOTS[status]}`} title={t(STATUS_KEYS[status])} />
        {context?.host && (
          <span className="float-host mono" title={context.host}>
            {context.host}
          </span>
        )}
        <div className="float-actions">
          <button
            type="button"
            className={`float-btn${recording ? ' is-rec' : ''}`}
            aria-pressed={recording}
            title={t('statusRecording')}
            onClick={() => void toggleRecording()}
          >
            <span className="dot rec" />
            <span>{t('statusRecording')}</span>
          </button>
          <button
            type="button"
            className="float-btn"
            disabled={!canReconnect}
            title={t('reconnect')}
            onClick={() => setReconnectTrigger((n) => n + 1)}
          >
            <Icon name="refresh" size={12} />
            <span>{t('reconnect')}</span>
          </button>
          <button
            type="button"
            className={`float-btn${aiOpen ? ' is-on' : ''}`}
            aria-pressed={aiOpen}
            title={t('aiChatTitle')}
            onClick={() => setAiOpen((open) => !open)}
          >
            <span>{t('aiChatTitle')}</span>
          </button>
        </div>
      </div>
    </div>
  )
}

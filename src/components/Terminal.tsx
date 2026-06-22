import React, { useEffect, useRef, useCallback } from 'react'
import { Terminal } from 'xterm'
import { FitAddon } from 'xterm-addon-fit'
import 'xterm/css/xterm.css'
import { connect, sendInput, pollOutput, resizeTerminal } from '../commands'

interface TerminalComponentProps {
  tabId: number
  isActive: boolean
  connectConfig?: {
    host: string
    port: number
    username: string
    password?: string
    keyPath?: string
  }
  autoConnect: boolean
  onStatusChange: (
    status: 'connecting' | 'connected' | 'error' | 'disconnected',
    errorMessage?: string,
  ) => void
}

export const TerminalComponent: React.FC<TerminalComponentProps> = ({
  tabId,
  isActive,
  connectConfig,
  autoConnect,
  onStatusChange,
}) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const isActiveRef = useRef(isActive)
  const tabIdRef = useRef(tabId)
  const connectConfigRef = useRef(connectConfig)
  const onStatusChangeRef = useRef(onStatusChange)
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const hasRun = useRef(false)
  const resizeObserverRef = useRef<ResizeObserver | null>(null)

  useEffect(() => {
    isActiveRef.current = isActive
  }, [isActive])
  useEffect(() => {
    tabIdRef.current = tabId
  }, [tabId])
  useEffect(() => {
    connectConfigRef.current = connectConfig
  })
  useEffect(() => {
    onStatusChangeRef.current = onStatusChange
  })

  // Calculate terminal cols/rows and send resize command
  const sendResize = useCallback((term: Terminal) => {
    const cols = term.cols
    const rows = term.rows
    console.log(`[Terminal] resizing to ${cols}x${rows}`)
    resizeTerminal(tabIdRef.current, cols, rows).catch((err) =>
      console.error('resize_terminal error:', err),
    )
  }, [])

  // Create terminal + start connection + poll output
  useEffect(() => {
    console.log(
      '[Terminal] effect running, containerRef=',
      !!containerRef.current,
      'autoConnect=',
      autoConnect,
      'hasRun=',
      hasRun.current,
    )
    if (!containerRef.current || !autoConnect || hasRun.current) {
      console.log('[Terminal] effect early return')
      return
    }
    hasRun.current = true

    const cfg = connectConfigRef.current
    console.log('[Terminal] connectConfig=', cfg)
    if (!cfg) {
      console.log('[Terminal] no cfg, return')
      return
    }

    const currentTabId = tabIdRef.current

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: '"Fira Code", "Cascadia Code", Consolas, "Courier New", monospace',
      theme: {
        background: '#00000000',
        foreground: '#d4d4d4',
        cursor: '#aeafad',
        selectionBackground: '#264f78',
        black: '#1e1e1e',
        red: '#f44747',
        green: '#3a8558',
        yellow: '#dcdcaa',
        blue: '#b8e0ff',
        magenta: '#c586c0',
        cyan: '#4dc9b0',
        white: '#d4d4d4',
        brightBlack: '#808080',
        brightRed: '#f44747',
        brightGreen: '#4daa6a',
        brightYellow: '#dcdcaa',
        brightBlue: '#d4ecff',
        brightMagenta: '#d4a0d4',
        brightCyan: '#6ae6cc',
        brightWhite: '#ffffff',
      },
      allowProposedApi: true,
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(containerRef.current)

    termRef.current = term
    fitRef.current = fitAddon

    // User input → SSH
    term.onData((data) => {
      if (!isActiveRef.current) return
      sendInput(currentTabId, data).catch((err) =>
        console.error('send_input error:', err),
      )
    })

    // Focus on click
    const handleClick = () => {
      if (isActiveRef.current) term.focus()
    }
    containerRef.current.addEventListener('click', handleClick)

    // Window resize
    const handleResize = () => {
      if (isActiveRef.current && fitRef.current) {
        fitRef.current.fit()
        sendResize(term)
      }
    }
    window.addEventListener('resize', handleResize)

    // Use ResizeObserver to monitor container size changes (more accurate than window resize)
    if (containerRef.current) {
      resizeObserverRef.current = new ResizeObserver(() => {
        if (isActiveRef.current && fitRef.current) {
          fitRef.current.fit()
          sendResize(term)
        }
      })
      resizeObserverRef.current.observe(containerRef.current)
    }

    // Poll SSH output (every 100ms), completely bypassing Tauri event system
    const startPolling = () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current)
      pollTimerRef.current = setInterval(async () => {
        try {
          const chunks = await pollOutput(currentTabId)
          if (chunks.length > 0) {
            for (const chunk of chunks) {
              term.write(chunk)
            }
          }
        } catch {
          // Silently ignore polling failures to avoid spam
        }
      }, 100)
    }

    // Wait for container to get actual layout dimensions, fit to get real cols/rows, then connect SSH with those dimensions
    const doConnect = () => {
      const cols = term.cols
      const rows = term.rows
      console.log(`[Terminal] initial fit done: ${cols}x${rows}, starting connect`)
      onStatusChangeRef.current('connecting')
      connect(
        {
          id: '',
          name: `${cfg.username}@${cfg.host}`,
          host: cfg.host,
          port: cfg.port,
          username: cfg.username,
          password: cfg.password,
          keyPath: cfg.keyPath,
        },
        currentTabId,
        cols,
        rows,
      )
        .then(() => {
          onStatusChangeRef.current('connected')
          startPolling()
        })
        .catch((err) => {
          const errMsg =
            typeof err === 'string'
              ? err
              : (err as any)?.message || String(err)
          onStatusChangeRef.current('error', errMsg)
          console.error('connect error:', err)
        })
    }

    const waitForLayoutAndFit = () => {
      const container = containerRef.current
      if (!container) return
      const w = container.clientWidth
      const h = container.clientHeight
      if (w > 0 && h > 0) {
        fitAddon.fit()
        doConnect()
      } else {
        // Container still has zero dimensions, keep waiting
        requestAnimationFrame(waitForLayoutAndFit)
      }
    }
    // Use double rAF to ensure flex layout is complete, then enter polling wait for actual dimensions
    requestAnimationFrame(() => {
      requestAnimationFrame(waitForLayoutAndFit)
    })

    return () => {
      console.log('[Terminal] cleanup, resetting hasRun')
      hasRun.current = false
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current)
        pollTimerRef.current = null
      }
      containerRef.current?.removeEventListener('click', handleClick)
      window.removeEventListener('resize', handleResize)
      resizeObserverRef.current?.disconnect()
      resizeObserverRef.current = null
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoConnect])

  // Focus when tab becomes active
  useEffect(() => {
    if (isActive && termRef.current) {
      termRef.current.focus()
    }
  }, [isActive])

  return <div ref={containerRef} style={{ height: '100%', width: '100%' }} />
}

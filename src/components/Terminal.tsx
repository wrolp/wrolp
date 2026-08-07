import React, { useEffect, useRef, useCallback, useState, useLayoutEffect } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import {
  connect,
  sendInput,
  commitCommand,
  pollOutput,
  resizeTerminal,
  openLocalShell,
  localSendInput,
  localResize,
} from '../commands'
import { Icon } from './Icon'
import { useI18n } from '../i18n'

// Tracks the single "active" terminal instance per session tabId. During a
// transient double-mount (React mounts the new terminal before unmounting the
// old one — e.g. on split/close/reconcile), two instances for the same tabId
// briefly coexist. Only the instance registered here may send input, so the
// stale duplicate can never echo the same keystroke twice into the SSH session
// (which produced bugs like typing "ls" reaching the shell as "lss").
const activeTerminalByTab = new Map<number, Terminal>()

interface TerminalComponentProps {
  tabId: number
  isActive: boolean
  isFocused?: boolean
  reconnectTrigger?: number
  connectConfig?: {
    id: string
    name?: string
    host: string
    port: number
    username: string
    password?: string
    keyPath?: string
  }
  /** When true, run a local PTY-backed shell instead of an SSH connection. */
  isLocal?: boolean
  /** Working directory to start the local shell in (local mode only). */
  localCwd?: string
  /** Shell command to use for the local shell (local mode only). */
  localShellType?: string
  autoConnect: boolean
  /** Maximum scrollback lines to retain (default 5000). */
  maxScrollback?: number
  onStatusChange: (
    status: 'connecting' | 'connected' | 'error' | 'disconnected',
    errorMessage?: string,
  ) => void
  onSizeChange?: (cols: number, rows: number) => void
  onAskAi?: (selectedText: string) => void
}

export const TerminalComponent: React.FC<TerminalComponentProps> = ({
  tabId,
  isActive,
  isFocused,
  reconnectTrigger,
  connectConfig,
  autoConnect,
  maxScrollback,
  onStatusChange,
  onSizeChange,
  onAskAi,
  isLocal,
  localCwd,
  localShellType,
}) => {
  const { t } = useI18n()
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const isActiveRef = useRef(isActive)
  const tabIdRef = useRef(tabId)
  const connectConfigRef = useRef(connectConfig)
  const onStatusChangeRef = useRef(onStatusChange)
  const onSizeChangeRef = useRef(onSizeChange)
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const hasRun = useRef(false)
  const reconnectTriggerRef = useRef(reconnectTrigger ?? 0)
  const localShellTypeRef = useRef(localShellType)
  const resizeObserverRef = useRef<ResizeObserver | null>(null)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null)
  const ctxMenuRef = useRef<HTMLDivElement | null>(null)

  // Keep the right-click menu fully on-screen (e.g. when triggered near the
  // bottom edge of the shell pane it would otherwise be clipped).
  useLayoutEffect(() => {
    if (!ctxMenu) return
    const el = ctxMenuRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const vh = window.innerHeight
    const vw = window.innerWidth
    let top = ctxMenu.y
    if (top + rect.height > vh - 8) {
      top = Math.max(8, vh - rect.height - 8)
    }
    let left = ctxMenu.x
    if (left + rect.width > vw - 8) {
      left = Math.max(8, vw - rect.width - 8)
    }
    el.style.top = `${top}px`
    el.style.left = `${left}px`
  }, [ctxMenu])

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
    localShellTypeRef.current = localShellType
  })
  useEffect(() => {
    onStatusChangeRef.current = onStatusChange
  })
  useEffect(() => {
    onSizeChangeRef.current = onSizeChange
  })

  // Calculate terminal cols/rows and send resize command
  const sendResize = useCallback((term: Terminal) => {
    const cols = term.cols
    const rows = term.rows
    console.log(`[Terminal] resizing to ${cols}x${rows}`)
    onSizeChangeRef.current?.(cols, rows)
    if (isLocal) {
      localResize(tabIdRef.current, cols, rows).catch((err) =>
        console.error('local_resize error:', err),
      )
    } else {
      resizeTerminal(tabIdRef.current, cols, rows).catch((err) =>
        console.error('resize_terminal error:', err),
      )
    }
  }, [isLocal])

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
    // Local shells have no SSH connectConfig — only SSH sessions need it. Without
    // this guard, opening a local terminal would bail here and never start.
    if (!cfg && !isLocal) {
      console.log('[Terminal] no cfg, return')
      return
    }

    const currentTabId = tabIdRef.current

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: '"Fira Code", "Cascadia Code", Consolas, "Courier New", monospace',
      scrollback: maxScrollback ?? 5000,
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

    // User input → SSH. During a transient double-mount (React mounts the new
    // terminal before unmounting the old one — e.g. on split/close/reconcile),
    // both instances for the same session can briefly be alive. The guard below
    // (activeTerminalByTab) ensures ONLY the registered, focused instance sends,
    // so a single keystroke is delivered exactly once — no dropped characters
    // (janky/laggy echo or input) and no duplicated characters (e.g. "ls"
    // reaching the shell as "lss").
    term.onData((data) => {
      // Only the registered active instance for this tabId may send. Stale
      // duplicate instances (transient double-mounts) are blocked here, so a
      // single keystroke is sent exactly once.
      if (activeTerminalByTab.get(currentTabId) !== term) return
      // Capture the full command line (with tab-completed text) when the user
      // submits it, before the remote echo changes the buffer row.
      if (data.includes('\r') || data.includes('\n')) {
        commitSubmittedCommands(term, data, currentTabId)
      }
      if (isLocal) {
        localSendInput(currentTabId, data).catch((err) =>
          console.error('local_send_input error:', err),
        )
      } else {
        sendInput(currentTabId, data)
          .then(() => {
            // Flush the output buffer right away so the remote echo of the
            // keystroke we just sent shows up immediately instead of waiting for
            // the next 100ms poll — otherwise fast typing looks like the echo
            // "doesn't keep up" (echo lagging behind). pollOutput drains the
            // buffer, so
            // this never doubles what the interval poll will later write.
            return pollOutput(currentTabId)
          })
          .then((chunks) => {
            for (const chunk of chunks) term.write(chunk)
          })
          .catch((err) => console.error('send_input error:', err))
      }
    })

    // Focus on click
    const handleClick = () => {
      term.focus()
    }
    containerRef.current.addEventListener('click', handleClick)

    // Right-click context menu for copy/paste/select-all
    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setCtxMenu({ x: e.clientX, y: e.clientY })
    }
    containerRef.current.addEventListener('contextmenu', handleContextMenu)

    // Window resize
    const handleResize = () => {
      if (isActiveRef.current && fitRef.current) {
        fitRef.current.fit()
        term.refresh(0, term.rows - 1)
        sendResize(term)
      }
    }
    window.addEventListener('resize', handleResize)

    // Use ResizeObserver to monitor container size changes (more accurate than window resize)
    if (containerRef.current) {
      resizeObserverRef.current = new ResizeObserver(() => {
        if (isActiveRef.current && fitRef.current) {
          fitRef.current.fit()
          term.refresh(0, term.rows - 1)
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
      onSizeChangeRef.current?.(cols, rows)
      onStatusChangeRef.current('connecting')
      if (isLocal) {
        openLocalShell(currentTabId, localShellTypeRef.current, localCwd)
          .then(() => {
            onStatusChangeRef.current('connected')
            startPolling()
          })
          .catch((err) => {
            const errMsg =
              typeof err === 'string' ? err : (err as any)?.message || String(err)
            // Show the error inside the terminal instead of hiding the pane,
            // so the user can see *why* the local shell failed to start.
            term.write(`\x1b[31m[local shell] failed to start: ${errMsg}\x1b[0m\r\n`)
            onStatusChangeRef.current('error', errMsg)
            console.error('open_local_shell error:', err)
          })
      } else {
        const sshCfg = cfg!
        connect(
          {
            id: sshCfg.id,
            name: sshCfg.name || `${sshCfg.username}@${sshCfg.host}`,
            host: sshCfg.host,
            port: sshCfg.port,
            username: sshCfg.username,
            password: sshCfg.password,
            keyPath: sshCfg.keyPath,
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
    }

    const waitForLayoutAndFit = () => {
      const container = containerRef.current
      if (!container) return
      const w = container.clientWidth
      const h = container.clientHeight
      if (w > 0 && h > 0) {
        fitAddon.fit()
        // B3 fix: repaint after fit so a stale trailing row / blinking cursor
        // pinned to the bottom edge is cleared.
        term.refresh(0, term.rows - 1)
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
      containerRef.current?.removeEventListener('contextmenu', handleContextMenu)
      window.removeEventListener('resize', handleResize)
      resizeObserverRef.current?.disconnect()
      resizeObserverRef.current = null
      // Drop this instance from the active registry if it was the registered
      // one (so a superseding instance isn't blocked by a disposed entry).
      if (activeTerminalByTab.get(currentTabId) === term) {
        activeTerminalByTab.delete(currentTabId)
      }
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoConnect])

  // Reconnect when trigger changes (keep xterm instance alive, preserve history)
  useEffect(() => {
    const trigger = reconnectTrigger ?? 0
    if (trigger === 0 || trigger === reconnectTriggerRef.current) return
    reconnectTriggerRef.current = trigger

    // Stop existing poll timer
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current)
      pollTimerRef.current = null
    }

    const term = termRef.current
    if (!term) return

    const cfg = connectConfigRef.current
    const currentTabId = tabIdRef.current
    // Local shells have no SSH connectConfig; only SSH sessions need it.
    if (!cfg && !isLocal) return

    // Write separator to terminal to mark new session
    term.write('\r\n\x1b[33m══════ Reconnecting ══════\x1b[0m\r\n')

    const doConnect = () => {
      const cols = term.cols
      const rows = term.rows
      console.log(`[Terminal] reconnect: ${cols}x${rows}`)
      onSizeChangeRef.current?.(cols, rows)
      onStatusChangeRef.current('connecting')

      if (isLocal) {
        openLocalShell(currentTabId, localShellTypeRef.current, localCwd)
          .then(() => {
            onStatusChangeRef.current('connected')
            if (pollTimerRef.current) clearInterval(pollTimerRef.current)
            pollTimerRef.current = setInterval(async () => {
              try {
                const chunks = await pollOutput(currentTabId)
                if (chunks.length > 0) {
                  for (const chunk of chunks) term.write(chunk)
                }
              } catch {}
            }, 100)
          })
          .catch((err) => {
            const errMsg =
              typeof err === 'string'
                ? err
                : (err as any)?.message || String(err)
            onStatusChangeRef.current('error', errMsg)
            console.error('local reconnect error:', err)
          })
        return
      }

      const sshCfg = cfg!
      connect(
        {
          id: sshCfg.id,
          name: sshCfg.name || `${sshCfg.username}@${sshCfg.host}`,
          host: sshCfg.host,
          port: sshCfg.port,
          username: sshCfg.username,
          password: sshCfg.password,
          keyPath: sshCfg.keyPath,
        },
        currentTabId,
        cols,
        rows,
      )
        .then(() => {
          onStatusChangeRef.current('connected')
          // Start polling again
          if (pollTimerRef.current) clearInterval(pollTimerRef.current)
          pollTimerRef.current = setInterval(async () => {
            try {
              const chunks = await pollOutput(currentTabId)
              if (chunks.length > 0) {
                for (const chunk of chunks) {
                  term.write(chunk)
                }
              }
            } catch {}
          }, 100)
        })
        .catch((err) => {
          const errMsg =
            typeof err === 'string'
              ? err
              : (err as any)?.message || String(err)
          onStatusChangeRef.current('error', errMsg)
          console.error('reconnect error:', err)
        })
    }

    // Ensure terminal has dimensions before connecting
    if (term.cols > 0 && term.rows > 0) {
      doConnect()
    } else {
      const waitForLayout = () => {
        if (term.cols > 0 && term.rows > 0) {
          fitRef.current?.fit()
          doConnect()
        } else {
          requestAnimationFrame(waitForLayout)
        }
      }
      requestAnimationFrame(waitForLayout)
    }
  }, [reconnectTrigger])

  // Focus when this pane becomes the focused one; explicitly blur when it
  // loses focus. On focus we also register this instance as the active one for
  // its tabId in `activeTerminalByTab`, so input is only ever sent from the
  // live, focused terminal — blocking any stale duplicate (transient
  // double-mount) from re-sending the same keystroke (e.g. "ls" reaching the
  // shell as "lss").
  useEffect(() => {
    const term = termRef.current
    if (isFocused && term) {
      activeTerminalByTab.set(tabIdRef.current, term)
      term.focus()
    } else if (!isFocused && term && document.activeElement === term.textarea) {
      term.blur()
    }
  }, [isFocused])

  // Close context menu on click anywhere
  useEffect(() => {
    if (!ctxMenu) return
    const close = () => setCtxMenu(null)
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [ctxMenu])

  // Clipboard actions
  const handleCopy = useCallback(async () => {
    setCtxMenu(null)
    termRef.current?.focus()
    const term = termRef.current
    if (!term) return
    const sel = term.getSelection()
    if (sel) {
      try {
        await navigator.clipboard.writeText(sel)
      } catch {
        // Fallback: execCommand (some WebView2 contexts)
        const ta = document.createElement('textarea')
        ta.value = sel
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
      }
    }
  }, [])

  const handlePaste = useCallback(async () => {
    setCtxMenu(null)
    termRef.current?.focus()
    const term = termRef.current
    if (!term) return
    try {
      const text = await navigator.clipboard.readText()
      if (text) {
        await sendInput(tabIdRef.current, text)
      }
    } catch {
      // Clipboard read may be blocked; silently ignore
    }
  }, [])

  const handleSelectAll = useCallback(() => {
    setCtxMenu(null)
    termRef.current?.focus()
    termRef.current?.selectAll()
  }, [])

  const handleClear = useCallback(() => {
    setCtxMenu(null)
    termRef.current?.focus()
    termRef.current?.clear()
  }, [])

  const handleAskAi = useCallback(() => {
    setCtxMenu(null)
    const term = termRef.current
    if (!term) return
    const sel = term.getSelection()
    if (sel && onAskAi) {
      onAskAi(sel)
    }
  }, [onAskAi])

  return (
    <>
      <div ref={containerRef} style={{ height: '100%', width: '100%', minHeight: 0, overflow: 'hidden' }} />
      {ctxMenu && (
        <div
          ref={ctxMenuRef}
          className="context-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="context-menu-item" onClick={handleCopy}>
            <Icon name="copy" /> {t('copy')}
          </div>
          <div className="context-menu-item" onClick={handlePaste}>
            <Icon name="paste" /> {t('paste')}
          </div>
          <div className="context-menu-divider" />
          <div className="context-menu-item" onClick={handleSelectAll}>
            🔤 {t('selectAll')}
          </div>
          <div className="context-menu-divider" />
          <div className="context-menu-item" onClick={handleClear}>
            🧹 {t('clear')}
          </div>
          <div className="context-menu-divider" />
          <div className="context-menu-item" onClick={handleAskAi}>
            🤖 {t('aiChatAskAi')}
          </div>
        </div>
      )}
    </>
  )
}

// Read the full logical line under the cursor, reassembling wrapped
// continuation lines so long tab-completed commands are not truncated.
function getCurrentCommandLine(term: Terminal): string {
  const buffer = term.buffer.active
  const line = buffer.getLine(buffer.cursorY)
  if (!line) return ''
  let text = line.translateToString(true)
  let y = buffer.cursorY
  while (y > 0) {
    const prev = buffer.getLine(y - 1)
    if (prev && prev.isWrapped) {
      text = prev.translateToString(true) + text
      y -= 1
    } else {
      break
    }
  }
  return text
}

// Remove ANSI escape sequences and strip a leading shell prompt so only the
// command itself remains.
function stripPrompt(line: string): string {
  const noAnsi = line.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
  const markers = ['$ ', '# ', '% ', '> ', '❯ ']
  let idx = -1
  for (const m of markers) {
    const pos = noAnsi.lastIndexOf(m)
    if (pos > idx) idx = pos
  }
  if (idx >= 0) {
    return noAnsi.slice(idx + 2).trimEnd()
  }
  return noAnsi.trim()
}

// Capture commands submitted by the user. A single Enter commits the current
// terminal-buffer line (which holds tab-completed text); a multi-line paste
// commits each pasted line directly.
function commitSubmittedCommands(term: Terminal, data: string, tabId: number) {
  if (/^[\r\n]+$/.test(data)) {
    const cmd = stripPrompt(getCurrentCommandLine(term))
    if (cmd.trim().length > 0) {
      commitCommand(tabId, cmd).catch((e) =>
        console.error('commit_command error:', e),
      )
    }
    return
  }
  for (const raw of data.split(/[\r\n]+/)) {
    const cmd = raw.replace(/[\x00-\x1f]/g, '').trim()
    if (cmd.length > 0) {
      commitCommand(tabId, cmd).catch((e) =>
        console.error('commit_command error:', e),
      )
    }
  }
}

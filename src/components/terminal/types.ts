import type { TargetRef } from '../../types'

/** Props for the terminal component, isolated so other modules can reference
 *  the type without importing the whole terminal component. */
export interface TerminalComponentProps {
  tabId: number
  isActive: boolean
  isFocused?: boolean
  /** Current shell view for this tab's pane ("terminal", editor key, docker
   *  log key). When transitioning back to "terminal" (e.g. from file editor),
   *  the terminal is automatically focused. */
  shellView?: string
  reconnectTrigger?: number
  connectConfig?: {
    id: string
    name?: string
    host: string
    port: number
    username: string
    password?: string
    keyPath?: string
    /** Directory the shell starts in after connecting (sent as `cd <dir>`). */
    startupDir?: string
    // Serial-port connection fields (only meaningful when the tab is serial).
    kind?: string
    portName?: string
    baudRate?: number
    dataBits?: number
    stopBits?: number
    parity?: string
    flowControl?: string
    /** Telnet only: opt-in best-effort auto-login. */
    autoLogin?: boolean
    group?: string
    workspaceId?: string
  }
  /** When true, run a local PTY-backed shell instead of an SSH connection. */
  isLocal?: boolean
  /** When true, open a serial (COM port) terminal instead of an SSH connection. */
  isSerial?: boolean
  /** When true, open a Telnet (plain TCP + IAC negotiation) terminal instead of
   *  an SSH connection. */
  isTelnet?: boolean
  /** Container name when this shell was opened as a `docker exec` from the
   *  Docker sidebar. The `docker exec` is sent programmatically (postConnectCmd),
   *  so the Enter-handler nested-session tracking never fires — this flag makes
   *  `ls` link bases come from the container's own prompt instead of the host
   *  cwd (see startLsCaptureIfMatch). Cleared on `exit`. */
  dockerContainer?: string
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
  /** Save the selected text as a command snippet (floating command list). */
  onAddCommandSnippet?: (text: string) => void
  /** Open a file (clicked in `ls` output) in the remote/local editor. */
  onOpenFile?: (target: TargetRef, path: string) => void
  /** Notify the parent of the current working directory (after connect, `cd`, etc.). */
  onCwdChange?: (cwd: string | null) => void
}

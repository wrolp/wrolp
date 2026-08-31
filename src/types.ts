export interface ConnectionConfig {
  id: string
  name: string
  host: string
  port: number
  username: string
  password?: string
  keyPath?: string
  passphrase?: string
  description?: string
  /** Directory the terminal starts in after connecting (also the directory the
   *  file panel opens to). Sent as `cd <dir>` once the shell is ready. */
  startupDir?: string
  group?: string
  /** Workspace this connection belongs to (set by backend on save). */
  workspaceId?: string
  /** Saved SSH tunnel definitions attached to this connection (not started). */
  tunnels?: TunnelConfig[]
  /** Connection kind: "ssh" (default), "serial" or "telnet". When "serial", the
   *  serial-port fields below drive the connection instead of the SSH host/port. */
  kind?: string
  /** Serial port name (e.g. "COM3" / "/dev/ttyUSB0"). */
  portName?: string
  baudRate?: number
  dataBits?: number
  stopBits?: number
  /** "none" | "odd" | "even" */
  parity?: string
  /** "none" | "software" | "hardware" */
  flowControl?: string
  /** Telnet only: opt-in best-effort auto-login (`login:` / `Password:` prompt
   *  matching). Off unless explicitly enabled — Telnet is plaintext. */
  autoLogin?: boolean
}

/** Telnet connection parameters sent to `connectTelnet`. */
export interface TelnetConfig {
  id: string
  name: string
  host: string
  port: number
  username: string
  password?: string
  /** Opt-in best-effort auto-login. */
  autoLogin: boolean
  group?: string
  workspaceId?: string
}

/** A serial (COM) port discovered on the machine, with a device-manager-style
 *  friendly description so the user can pick the right port. */
export interface SerialPortView {
  /** "COM3" / "/dev/ttyUSB0" */
  name: string
  /** Friendly description (manufacturer / product / type) */
  description: string
  /** "usb" | "bluetooth" | "pci" | "unknown" */
  portType?: string
}

/** Serial connection parameters sent to `connectSerial`. */
export interface SerialConfig {
  id: string
  name: string
  portName: string
  baudRate: number
  dataBits: number
  stopBits: number
  /** "none" | "odd" | "even" */
  parity: string
  /** "none" | "software" | "hardware" */
  flowControl: string
  group?: string
  workspaceId?: string
}

/** One probed baud rate returned by `detectSerialBaud`, best-scored first. */
export interface BaudCandidate {
  baudRate: number
  /** 0..1 confidence that this is the device's real rate. */
  score: number
  /** Bytes received during the probe window (0 = the device said nothing). */
  bytes: number
  /** Printable preview of what the device sent (non-printables as '.'). */
  sample: string
}

/** One probed `ip:port` pair returned by `scanNetwork`. */
export interface ScanResult {
  ip: string
  port: number
  /** Whether a TCP connection could be established. */
  open: boolean
  /** Service identified from the first bytes: "ssh" | "telnet" | "unknown". */
  service: 'ssh' | 'telnet' | 'unknown'
  /** First line of the service banner (e.g. "SSH-2.0-OpenSSH_9.6"). */
  banner?: string
  /** Time to establish the TCP connection, in milliseconds. */
  latencyMs?: number
}

/** A saved SSH local-port-forwarding tunnel definition (persisted config). */
export interface TunnelConfig {
  /** Stable id (uuid) used to match a definition to its running tunnel. */
  id: string
  name?: string
  /** Local bind host; defaults to "127.0.0.1". */
  localAddr?: string
  localPort: number
  remoteHost: string
  remotePort: number
}

/** A named workspace grouping connections. */
export interface WorkspaceInfo {
  id: string
  name: string
  createdAt: string
}

export interface SessionSummary {
  id: string
  connectionId: string
  connectionName: string | null
  startedAt: string
  endedAt: string | null
  durationSeconds: number | null
  title: string | null
  eventCount: number
}

export interface SessionEventDto {
  seq: number
  timestampMs: number
  direction: 'input' | 'output'
  content: string
}

export interface CommandSetDto {
  id: string
  name: string
  connectionId: string | null
  commands: string[]
  createdAt: string
  updatedAt: string
}

/** Single command snippet for the floating command list (sent to the terminal
 *  without executing). */
export interface CommandSnippetDto {
  id: string
  command: string
  alias: string | null
  favorite: boolean
  hidden: boolean
  sortOrder: number
  createdAt: string
  updatedAt: string
}

/** A single global variable shared by all command-list snippets. Commands
 *  reference it as `${name}`. A non-empty `defaultValue` is substituted
 *  directly at send time; an empty one prompts the user to fill it in. */
export interface GlobalVariable {
  name: string
  defaultValue: string
  description?: string
  createdAt: string
  updatedAt: string
}

export interface AiPromptTemplate {
  id: string
  name: string
  prompt: string
  category: string
  createdAt: string
  updatedAt: string
}

export type AuthType = 'password' | 'key'

export interface TabInfo {
  tabId: number
  connectionId?: string
  connectionName: string
  host: string
  status: 'disconnected' | 'connecting' | 'connected' | 'error' | 'suspect' | 'settings' | 'aiChat'
  errorMessage?: string
  tabType: 'terminal' | 'settings' | 'dockerLog' | 'aiChat' | 'localShell' | 'serial' | 'telnet'
  // When true, this session was created by splitting a tab and is NOT shown as
  // its own entry in the top tab bar — it lives inside its parent workspace's
  // pane layout (see App.tsx `splitTrees`).
  embedded?: boolean
  // dockerLog tab fields
  jumpTabId?: number
  containerName?: string
  containerId?: string
  containerImage?: string
  // localShell tab fields
  localShellCwd?: string
  localShellType?: string
  // Display name for a local shell tab (from the sidebar Local Terminal entry).
  // Falls back to the cwd when absent.
  localShellName?: string
  // When set, this terminal tab is a shell running inside a Docker container
  // (`docker exec`). The value is the container name.
  dockerContainer?: string
  // Command sent automatically each time this tab (re)connects. Used by the
  // docker-shell pane so floating/restoring the pane — which triggers a fresh
  // SSH connect — re-enters the container instead of showing the host shell.
  postConnectCmd?: string
}

export interface TerminalOutput {
  tabId: number
  data: string
  title: string
}

export interface TerminalError {
  tabId: number
  error: string
}

export interface FileEntry {
  name: string
  path: string
  isDir: boolean
  size: number
  mode: string
  modified: string
}

/** Summary returned by `download_directory` / `target_download_directory`. */
export interface DirDownloadSummary {
  totalFiles: number
  doneFiles: number
  totalBytes: number
  doneBytes: number
  skipped: number
}

/** Summary returned by `upload_local_dir` / `target_upload_local_dir`. */
export interface DirUploadSummary {
  totalFiles: number
  doneFiles: number
  totalBytes: number
  doneBytes: number
  skipped: number
}

/** An active SSH port-forwarding tunnel (`ssh -L`), carried by a connected tab. */
export interface TunnelInfo {
  id: number
  tabId: number
  connectionId: string | null
  /** Saved tunnel-definition id this tunnel was started from (if any). */
  configId?: string | null
  localAddr: string
  remoteHost: string
  remotePort: number
  name: string | null
  bytes: number
  active: boolean
}

/** Arguments for starting a new tunnel. */
export interface StartTunnelArgs {
  tabId: number
  connectionId?: string | null
  configId?: string
  localAddr?: string
  localPort: number
  remoteHost: string
  remotePort: number
  name?: string
}

export interface FileContent {
  path: string
  content: string
  size: number
  mode: string
  isBinary: boolean
  isTooLarge: boolean
  /** Charset used to decode the file, e.g. "utf-8" or "gbk". */
  encoding: string
  /** True when the file was not valid UTF-8 and must be re-saved with `encoding`. */
  needsEncoding: boolean
  /** For binary files only: raw bytes as Base64 for hex viewing. */
  hexBase64?: string
  /** For image files only: MIME type (e.g. "image/png") for direct preview. */
  imageMime?: string
}

// ===== P6: Jump host / Docker targets =====

/** Credentials for a secondary target (independent of the jump host). */
export interface TargetAuth {
  username: string
  password?: string
  keyPath?: string
  passphrase?: string
}

/**
 * Identifies which remote filesystem a file operation acts upon.
 * Serialized with a `kind` tag to match the Rust `TargetRef` enum.
 */
export type TargetRef =
  | { kind: 'session'; tabId: number }
  | { kind: 'jumpRemote'; jumpTabId: number; host: string; port: number; auth: TargetAuth }
  | { kind: 'docker'; jumpTabId: number; container: string; user?: string }
  | { kind: 'dockerSsh'; jumpTabId: number; host: string; port: number; auth: TargetAuth }
  | { kind: 'local'; tabId: number }

/** A Docker container discovered via `docker ps` on a connected (jump) host. */
export interface ContainerInfo {
  id: string
  name: string
  image: string
  state: string
  status: string
}

/** A recorded local-shell working directory (for the "recent directories" list). */
export interface LocalShellDir {
  path: string
  shell?: string
  lastUsed: number
}

/** SSH keepalive settings: interval in seconds and max unanswered retries. */
export interface KeepaliveConfig {
  interval: number
  max: number
}

export interface LocalTerminalEntry {
  id: string
  name: string
  cwd: string
  shell: string
}

/**
 * Which filesystem the Files panel is currently browsing. Drives the mode
 * switcher (SSH local session / ProxyJump remote / Docker container).
 */
export type FileTargetMode = 'ssh' | 'jump' | 'docker' | 'local'

/** Human-readable label for a target (used in chips / headers). */
// ===== Host Analysis =====

export interface PackageInfo {
  name: string
  version: string
  description?: string
}

export interface ToolInfo {
  name: string
  path?: string
}

export interface HostAnalysis {
  tabId: number
  os: string
  kernel: string
  arch: string
  hostname: string
  uptime: string
  packageManager: string
  packages: PackageInfo[]
  tools: ToolInfo[]
  analyzedAt: number
}

// ---- Docker analysis types ----

export interface PortMapping {
  containerPort: string
  hostIp?: string | null
  hostPort?: string | null
}

export interface MountInfo {
  source: string
  destination: string
  mode: string
}

export interface EnvEntry {
  key: string
}

export interface ProcessInfo {
  pid: number
  user: string
  cpu: string
  mem: string
  command: string
}

export interface ResourceUsage {
  cpuPercent: string
  memUsage: string
  memLimit: string
  netIO: string
  blockIO: string
  pidCount: string
}

export interface OrchestrationInfo {
  isCompose: boolean
  project?: string
  service?: string
  configFiles?: string
  workingDir?: string
  /** Inferred docker-compose.yml path from labels + mount sources */
  inferredComposeFile?: string
  startCommand?: string
}

export interface DockerAnalysis {
  tabId: number
  containerName: string
  containerId: string
  image: string
  imageTag: string
  state: string
  createdAt: string

  os: string
  kernel: string
  arch: string
  hostname: string

  packageManager: string
  packages: PackageInfo[]
  tools: ToolInfo[]

  ports: PortMapping[]
  mounts: MountInfo[]
  envKeys: EnvEntry[]
  processes: ProcessInfo[]
  resource: ResourceUsage | null
  orchestration: OrchestrationInfo

  analyzedAt: number
}

export function targetLabel(target: TargetRef): string {
  switch (target.kind) {
    case 'session':
      return 'Local session'
    case 'jumpRemote':
      return `${target.host}:${target.port}`
    case 'docker':
      return `docker:${target.container}`
    case 'dockerSsh':
      return `docker-ssh:${target.host}:${target.port}`
    case 'local':
      return 'Local machine'
  }
}

// ===== Floating (pop-out) panes =====

/** What kind of content a floating pane hosts. */
export type FloatingKind = 'terminal' | 'editor' | 'dockerLog'

/**
 * A pane that has been "popped out" of the main split tree into a draggable,
 * top-most overlay inside the same window. The underlying session (keyed by
 * `tabId` in the Rust backend) keeps running; on close the leaf is re-inserted
 * into the split tree so the pane returns to the layout.
 */
export interface FloatingItem {
  floatId: string
  kind: FloatingKind
  /** Terminal session tabId (terminal / dockerLog / the editor's host session). */
  tabId: number
  /** For `editor`: the EditorTab.key being floated. */
  editorKey?: string
  /** For `dockerLog`: the dockerLog tabId (== tabId here). */
  dockerLogTabId?: number
  title: string
  x: number
  y: number
  w: number
  h: number
  z: number
}

// ===== App Version =====

export interface AppVersion {
  version: string
  gitHash: string
  gitBranch: string
  buildTime: string
  gitCommit: string
  gitDirty: boolean
  repoUrl: string
}

// ===== AI Chat =====

/** A single AI provider endpoint configuration ("profile"). */
export interface AiEndpointProfile {
  /** Stable unique id (UUID) referencing this profile. */
  id: string
  /** User-facing label shown in the settings profile list. */
  name: string
  /** API endpoint base URL (e.g. "https://api.openai.com/v1"). */
  endpoint: string
  /** AES-GCM encrypted API key blob, or empty if no key set. */
  apiKeyEnc: string
  /** Model name (e.g. "gpt-4o"). */
  model: string
  /** Tool call response format expected from this endpoint: "nested" (standard
   *  OpenAI `tool_calls[].function.{name,arguments}`) or "flat" (`tool_calls[]`
   *  items carrying `name`/`arguments` directly). Defaults to "nested". */
  toolCallFormat: 'flat' | 'nested'
  /** System prompt for the AI assistant. */
  systemPrompt: string
}

/** Container holding all saved endpoint profiles plus the active one. */
export interface AiConfig {
  profiles: AiEndpointProfile[]
  /** Id of the active profile. Falls back to the first profile if invalid. */
  activeId: string
  /** Default AI mode when a chat is opened: start in read-only mode (only
   *  inspection commands allowed). Configurable in the global AI settings;
   *  the per-chat panel can toggle it. */
  readOnly: boolean
  /** When true, `run_command` types the command into the tab's live terminal
   *  (visible on screen + saved in the session recording) instead of running it
   *  silently on a separate channel. Automatically falls back to the silent
   *  path when the tab has no live shell. */
  runInTerminal: boolean
  /** Maximum number of agent-loop rounds (one assistant turn + its tool calls)
   *  for a single AI run. Guards against runaway loops. Optional — defaults to
   *  12 on the backend when absent. */
  maxAgentRounds?: number
}

export interface AiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string
  toolCalls?: AiToolCall[]
  toolCallId?: string
  name?: string
  images?: string[]
}

export interface AiToolCall {
  id: string
  name: string
  arguments: string
}

export type ToolCallStatus =
  | 'pending'
  | 'executing'
  | 'done'
  | 'error'
  | 'denied'
  | 'needs-confirmation'

export interface ToolCallEvent {
  id: string
  name: string
  arguments: string
  status: ToolCallStatus
  result?: string
  error?: string
}

export interface AiChatChunk {
  newText: string
  done: boolean
  error: string | null
}

/**
 * Boundary marker emitted by `run_command_on_terminal` so the frontend can
 * colorize the AI-issued command line (`begin`) and its output (until `end`)
 * differently from user-typed text, and show an execution-status badge
 * (running → done / error). `seq` pairs begin/end per tab. `elapsedMs` is set
 * on `end`; `error` is set on `error` marks (rejected/typing-failure paths).
 */
export interface AiTermMark {
  tabId: number
  kind: 'ssh' | 'local'
  command: string
  mark: 'begin' | 'end' | 'error'
  seq: number
  timedOut: boolean
  truncated: boolean
  elapsedMs?: number
  error?: string | null
}

// ===== Customizable workspace layout =====

export type DockSide = 'left' | 'right'
export type DockPos = 'bottom' | 'right'

export interface SectionLayout {
  visible: boolean
  collapsed: boolean
  height?: number
}

export interface WorkspaceLayout {
  sidebar: {
    visible: boolean
    side: DockSide
    width: number
    sections: {
      connections: SectionLayout
      files: SectionLayout
      docker: SectionLayout
    }
  }
  bottomPanel: {
    visible: boolean
    pos: DockPos
    size: number
  }
}

export const defaultLayout: WorkspaceLayout = {
  sidebar: {
    visible: true,
    side: 'left',
    width: 260,
    sections: {
      connections: { visible: true, collapsed: false, height: 200 },
      files: { visible: true, collapsed: false },
      docker: { visible: true, collapsed: false, height: 220 },
    },
  },
  bottomPanel: {
    visible: false,
    pos: 'bottom',
    size: 240,
  },
}

/**
 * Deep-merge a saved (possibly partial / older) layout onto the current default.
 * New fields introduced by updates keep the default value; existing values win.
 */
export function mergeLayout(base: WorkspaceLayout, override: unknown): WorkspaceLayout {
  const deepMerge = <T>(b: T, o: unknown): T => {
    if (o === null || o === undefined || typeof o !== 'object' || Array.isArray(o)) {
      return (o as T) ?? b
    }
    if (typeof b !== 'object' || Array.isArray(b) || b === null) return o as T
    const result: Record<string, unknown> = { ...(b as Record<string, unknown>) }
    for (const key of Object.keys(o as Record<string, unknown>)) {
      const bv = result[key]
      const ov = (o as Record<string, unknown>)[key]
      if (
        bv &&
        typeof bv === 'object' &&
        !Array.isArray(bv) &&
        ov &&
        typeof ov === 'object' &&
        !Array.isArray(ov)
      ) {
        result[key] = deepMerge(bv, ov)
      } else if (ov !== undefined) {
        result[key] = ov
      }
    }
    return result as T
  }
  return deepMerge(base, override)
}

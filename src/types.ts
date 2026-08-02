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
  group?: string
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

export type AuthType = 'password' | 'key'

export interface TabInfo {
  tabId: number
  connectionId?: string
  connectionName: string
  host: string
  status: 'disconnected' | 'connecting' | 'connected' | 'error' | 'settings' | 'aiChat'
  errorMessage?: string
  tabType: 'terminal' | 'settings' | 'dockerLog' | 'aiChat'
  // When true, this session was created by splitting a tab and is NOT shown as
  // its own entry in the top tab bar — it lives inside its parent workspace's
  // pane layout (see App.tsx `splitTrees`).
  embedded?: boolean
  // dockerLog tab fields
  jumpTabId?: number
  containerName?: string
  containerId?: string
  containerImage?: string
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

/** A Docker container discovered via `docker ps` on a connected (jump) host. */
export interface ContainerInfo {
  id: string
  name: string
  image: string
  state: string
  status: string
}

/**
 * Which filesystem the Files panel is currently browsing. Drives the mode
 * switcher (SSH local session / ProxyJump remote / Docker container).
 */
export type FileTargetMode = 'ssh' | 'jump' | 'docker'

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
  }
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
  /** System prompt for the AI assistant. */
  systemPrompt: string
}

/** Container holding all saved endpoint profiles plus the active one. */
export interface AiConfig {
  profiles: AiEndpointProfile[]
  /** Id of the active profile. Falls back to the first profile if invalid. */
  activeId: string
}

export interface AiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string
  toolCalls?: AiToolCall[]
  toolCallId?: string
  name?: string
}

export interface AiToolCall {
  id: string
  name: string
  arguments: string
}

export type ToolCallStatus = 'pending' | 'executing' | 'done' | 'error' | 'denied' | 'needs-confirmation'

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
        bv && typeof bv === 'object' && !Array.isArray(bv) &&
        ov && typeof ov === 'object' && !Array.isArray(ov)
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

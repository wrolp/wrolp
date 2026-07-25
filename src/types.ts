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
  status: 'disconnected' | 'connecting' | 'connected' | 'error' | 'settings'
  errorMessage?: string
  tabType: 'terminal' | 'settings'
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

/** Human-readable label for a target (used in chips / headers). */
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

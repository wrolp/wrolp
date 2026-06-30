export interface ConnectionConfig {
  id: string
  name: string
  host: string
  port: number
  username: string
  password?: string
  keyPath?: string
  passphrase?: string
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

export interface ConnectionConfig {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  password?: string;
  keyPath?: string;
  passphrase?: string;
}

export type AuthType = 'password' | 'key';

export interface TabInfo {
  tabId: string;
  connectionId: string;
  connectionName: string;
  host: string;
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  errorMessage?: string;
}

export interface TerminalOutput {
  tabId: string;
  data: string;
  title: string;
}

export interface TerminalError {
  tabId: string;
  error: string;
}

import { invoke } from '@tauri-apps/api/core'
import type { ConnectionConfig } from './types'

export async function listConnections(): Promise<ConnectionConfig[]> {
  const result = await invoke<string>('list_connections')
  return JSON.parse(result)
}

export async function saveConnection(config: ConnectionConfig): Promise<void> {
  await invoke('save_connection', { config })
}

export async function deleteConnection(id: string): Promise<boolean> {
  return await invoke<boolean>('delete_connection', { id })
}

export async function connect(
  config: ConnectionConfig,
  tabId: string,
): Promise<{ status: string }> {
  return await invoke<{ status: string }>('connect', { config, tabId })
}

export async function disconnect(tabId: string): Promise<boolean> {
  return await invoke<boolean>('disconnect', { tabId })
}

export async function sendInput(tabId: string, data: string): Promise<boolean> {
  return await invoke<boolean>('send_input', { tabId, data })
}

export async function resizeTerminal(tabId: string, cols: number, rows: number): Promise<boolean> {
  return await invoke<boolean>('resize_terminal', { tabId, cols, rows })
}

/// Poll for new data in SSH output buffer
export async function pollOutput(tabId: string): Promise<string[]> {
  return await invoke<string[]>('poll_output', { tabId })
}

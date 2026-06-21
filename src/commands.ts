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
  tabId: number,
  cols: number,
  rows: number,
): Promise<{ status: string }> {
  return await invoke<{ status: string }>('connect', { config, tabId, cols, rows })
}

export async function disconnect(tabId: number): Promise<boolean> {
  return await invoke<boolean>('disconnect', { tabId })
}

export async function sendInput(tabId: number, data: string): Promise<boolean> {
  return await invoke<boolean>('send_input', { tabId, data })
}

export async function resizeTerminal(tabId: number, cols: number, rows: number): Promise<boolean> {
  return await invoke<boolean>('resize_terminal', { tabId, cols, rows })
}

/// Poll for new data in SSH output buffer
export async function pollOutput(tabId: number): Promise<string[]> {
  return await invoke<string[]>('poll_output', { tabId })
}

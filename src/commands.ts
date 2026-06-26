import { invoke } from '@tauri-apps/api/core'
import type { ConnectionConfig, FileEntry } from './types'

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

// ===== File Operations =====

export async function listFiles(tabId: number, path: string): Promise<FileEntry[]> {
  return await invoke<FileEntry[]>('list_files', { tabId, path })
}

export async function downloadFile(tabId: number, remotePath: string, localPath: string): Promise<boolean> {
  return await invoke<boolean>('download_file', { tabId, remotePath, localPath })
}

export async function uploadFile(tabId: number, localPath: string, remotePath: string): Promise<boolean> {
  return await invoke<boolean>('upload_file', { tabId, localPath, remotePath })
}

/// Upload file as raw bytes (for HTML5 drag-drop where we have file data, not paths)
export async function uploadFileBytes(tabId: number, remotePath: string, fileData: number[]): Promise<boolean> {
  return await invoke<boolean>('upload_file_bytes', { tabId, remotePath, fileData })
}

export async function fileExists(tabId: number, path: string): Promise<boolean> {
  return await invoke<boolean>('file_exists', { tabId, path })
}

export async function createDirectory(tabId: number, path: string): Promise<boolean> {
  return await invoke<boolean>('create_directory', { tabId, path })
}

export async function renameFile(tabId: number, oldPath: string, newPath: string): Promise<boolean> {
  return await invoke<boolean>('rename_file', { tabId, oldPath, newPath })
}

export async function deleteFile(tabId: number, path: string, isDir: boolean): Promise<boolean> {
  return await invoke<boolean>('delete_file', { tabId, path, isDir })
}

// ===== Window Config =====

export interface WindowConfig {
  x: number
  y: number
  width: number
  height: number
  maximized: boolean
}

export async function saveWindowConfig(config: WindowConfig): Promise<void> {
  await invoke('save_window_config', { config })
}

export async function loadWindowConfig(): Promise<WindowConfig> {
  return await invoke<WindowConfig>('load_window_config')
}

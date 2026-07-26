import { invoke } from '@tauri-apps/api/core'
import type { ConnectionConfig, FileEntry, SessionSummary, SessionEventDto, CommandSetDto, FileContent, TargetRef, ContainerInfo } from './types'

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

export async function reorderConnections(
  orderedIds: string[],
  groupUpdates?: Record<string, string>,
): Promise<boolean> {
  return await invoke<boolean>('reorder_connections', {
    orderedIds,
    groupUpdates: groupUpdates ?? null,
  })
}

export async function renameGroup(oldName: string, newName: string): Promise<boolean> {
  return await invoke<boolean>('rename_group', { oldName, newName })
}

export async function deleteGroup(groupName: string): Promise<boolean> {
  return await invoke<boolean>('delete_group', { groupName })
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
  opacity: number
}

export async function saveWindowConfig(config: WindowConfig): Promise<void> {
  await invoke('save_window_config', { config })
}

export async function loadWindowConfig(): Promise<WindowConfig> {
  return await invoke<WindowConfig>('load_window_config')
}

// ===== Workspace layout =====

export async function loadLayout(): Promise<string> {
  return await invoke<string>('load_layout')
}

export async function saveLayout(layout: string): Promise<void> {
  await invoke('save_layout', { layout })
}

// ===== Transfer Control =====

export async function pauseTransfer(tabId: number): Promise<void> {
  await invoke('pause_transfer', { tabId })
}

export async function resumeTransfer(tabId: number): Promise<void> {
  await invoke('resume_transfer', { tabId })
}

// ===== SFTP User Switching =====

export async function switchSftpUser(tabId: number, username: string, password: string): Promise<void> {
  await invoke('switch_sftp_user', { tabId, username, password })
}

export async function revertSftpUser(tabId: number): Promise<void> {
  await invoke('revert_sftp_user', { tabId })
}

export async function getSftpUser(tabId: number): Promise<string | null> {
  return await invoke<string | null>('get_sftp_user', { tabId })
}

// ===== SFTP ↔ Shell Sync =====

/// Poll the remote working directory via a dedicated exec channel.
export async function pollWorkingDir(tabId: number): Promise<string | null> {
  return await invoke<string | null>('poll_working_dir', { tabId })
}

// ===== Session Recording =====

export async function listSessions(
  connectionId?: string,
  limit?: number,
): Promise<SessionSummary[]> {
  return await invoke<SessionSummary[]>('list_sessions', { connectionId, limit })
}

export async function getSessionEvents(sessionId: string): Promise<SessionEventDto[]> {
  return await invoke<SessionEventDto[]>('get_session_events', { sessionId })
}

export async function deleteSession(sessionId: string): Promise<void> {
  await invoke<void>('delete_session', { sessionId })
}

export async function renameSession(sessionId: string, title: string): Promise<void> {
  await invoke<void>('rename_session', { sessionId, title })
}

export async function extractCommands(sessionId: string): Promise<string[]> {
  return await invoke<string[]>('extract_commands', { sessionId })
}

export async function commitCommand(tabId: number, command: string): Promise<boolean> {
  return await invoke<boolean>('commit_command', { tabId, command })
}

export async function readFileContent(
  tabId: number,
  path: string,
  options?: { maxSize?: number; encoding?: string },
): Promise<FileContent> {
  return await invoke<FileContent>('read_file_content', {
    tabId,
    path,
    maxSize: options?.maxSize,
    encoding: options?.encoding,
  })
}

export async function writeFileContent(
  tabId: number,
  path: string,
  content: string,
  encoding?: string,
): Promise<boolean> {
  return await invoke<boolean>('write_file_content', { tabId, path, content, encoding })
}

// ===== Command Sets =====

export async function listCommandSets(
  connectionId?: string,
): Promise<CommandSetDto[]> {
  return await invoke<CommandSetDto[]>('list_command_sets', { connectionId })
}

export async function saveCommandSet(cmdSet: CommandSetDto): Promise<string> {
  return await invoke<string>('save_command_set', { cmdSet })
}

export async function deleteCommandSet(id: string): Promise<void> {
  await invoke<void>('delete_command_set', { id })
}

// ===== P6: Target-based file operations (jump host / Docker) =====

export async function listDockerContainers(jumpTabId: number): Promise<ContainerInfo[]> {
  return await invoke<ContainerInfo[]>('list_docker_containers', { jumpTabId })
}

function isSession(t: TargetRef): t is { kind: 'session'; tabId: number } {
  return t.kind === 'session'
}

/**
 * Filesystem dispatch: `session` targets reuse the optimized tab-based commands
 * (preserving transfer progress / pause / switched-user behaviour); every other
 * target routes to the `target_*` commands which operate via RemoteFs.
 */
export async function fsListFiles(target: TargetRef, path: string): Promise<FileEntry[]> {
  return isSession(target) ? listFiles(target.tabId, path) : invoke<FileEntry[]>('target_list_files', { target, path })
}

export async function fsDownloadFile(target: TargetRef, remotePath: string, localPath: string): Promise<boolean> {
  return isSession(target) ? downloadFile(target.tabId, remotePath, localPath) : invoke<boolean>('target_download_file', { target, remotePath, localPath })
}

export async function fsUploadFile(target: TargetRef, localPath: string, remotePath: string): Promise<boolean> {
  return isSession(target) ? uploadFile(target.tabId, localPath, remotePath) : invoke<boolean>('target_upload_file', { target, localPath, remotePath })
}

export async function fsUploadFileBytes(target: TargetRef, remotePath: string, fileData: number[]): Promise<boolean> {
  return isSession(target) ? uploadFileBytes(target.tabId, remotePath, fileData) : invoke<boolean>('target_upload_file_bytes', { target, remotePath, fileData })
}

export async function fsFileExists(target: TargetRef, path: string): Promise<boolean> {
  return isSession(target) ? fileExists(target.tabId, path) : invoke<boolean>('target_file_exists', { target, path })
}

export async function fsCreateDirectory(target: TargetRef, path: string): Promise<boolean> {
  return isSession(target) ? createDirectory(target.tabId, path) : invoke<boolean>('target_create_directory', { target, path })
}

export async function fsRenameFile(target: TargetRef, oldPath: string, newPath: string): Promise<boolean> {
  return isSession(target) ? renameFile(target.tabId, oldPath, newPath) : invoke<boolean>('target_rename_file', { target, oldPath, newPath })
}

export async function fsDeleteFile(target: TargetRef, path: string, isDir: boolean): Promise<boolean> {
  return isSession(target) ? deleteFile(target.tabId, path, isDir) : invoke<boolean>('target_delete_file', { target, path, isDir })
}

export async function fsReadFileContent(
  target: TargetRef,
  path: string,
  options?: { maxSize?: number; encoding?: string },
): Promise<FileContent> {
  return isSession(target)
    ? readFileContent(target.tabId, path, options)
    : invoke<FileContent>('target_read_file', { target, path, maxSize: options?.maxSize, encoding: options?.encoding })
}

export async function fsWriteFileContent(
  target: TargetRef,
  path: string,
  content: string,
  encoding?: string,
): Promise<boolean> {
  return isSession(target)
    ? writeFileContent(target.tabId, path, content, encoding)
    : invoke<boolean>('target_write_file', { target, path, content, encoding })
}

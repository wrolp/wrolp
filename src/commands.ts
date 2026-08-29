import { invoke } from '@tauri-apps/api/core'
import type {
  ConnectionConfig,
  FileEntry,
  SessionSummary,
  SessionEventDto,
  CommandSetDto,
  CommandSnippetDto,
  GlobalVariable,
  AiPromptTemplate,
  FileContent,
  TargetRef,
  SerialPortView,
  SerialConfig,
  ContainerInfo,
  ToolCallEvent,
  AiEndpointProfile,
  LocalShellDir,
  LocalTerminalEntry,
  WorkspaceInfo,
  DirDownloadSummary,
  DirUploadSummary,
  TunnelInfo,
  StartTunnelArgs,
  TunnelConfig,
  KeepaliveConfig,
} from './types'

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

// ===== Workspace management =====

export async function listWorkspaces(): Promise<{
  workspaces: WorkspaceInfo[]
  activeWorkspaceId: string
}> {
  const result = await invoke<string>('list_workspaces')
  return JSON.parse(result)
}

export async function createWorkspace(name: string): Promise<string> {
  return await invoke<string>('create_workspace', { name })
}

export async function deleteWorkspace(workspaceId: string): Promise<boolean> {
  return await invoke<boolean>('delete_workspace', { workspaceId })
}

export async function renameWorkspace(workspaceId: string, name: string): Promise<boolean> {
  return await invoke<boolean>('rename_workspace', { workspaceId, name })
}

export async function switchWorkspace(workspaceId: string): Promise<boolean> {
  return await invoke<boolean>('switch_workspace', { workspaceId })
}

export async function connect(
  config: ConnectionConfig,
  tabId: number,
  cols: number,
  rows: number,
  reuseExisting: boolean = true,
): Promise<{ status: string }> {
  return await invoke<{ status: string }>('connect', { config, tabId, cols, rows, reuseExisting })
}

export async function disconnect(tabId: number): Promise<boolean> {
  return await invoke<boolean>('disconnect', { tabId })
}

export async function sendInput(tabId: number, data: string): Promise<boolean> {
  return await invoke<boolean>('send_input', { tabId, data })
}

/** Enumerate serial (COM) ports available on the machine. */
export async function listSerialPorts(): Promise<SerialPortView[]> {
  return await invoke<SerialPortView[]>('list_serial_ports')
}

/** Open a serial port terminal. */
export async function connectSerial(
  config: SerialConfig,
  tabId: number,
  cols: number,
  rows: number,
): Promise<{ status: string }> {
  return await invoke<{ status: string }>('connect_serial', { cfg: config, tabId, cols, rows })
}

/** Send raw bytes to an open serial port. */
export async function serialSendInput(tabId: number, data: string): Promise<boolean> {
  return await invoke<boolean>('serial_send_input', { tabId, data })
}

export async function resizeTerminal(tabId: number, cols: number, rows: number): Promise<boolean> {
  return await invoke<boolean>('resize_terminal', { tabId, cols, rows })
}

/// Poll for new data in SSH output buffer
export async function pollOutput(tabId: number): Promise<string[]> {
  return await invoke<string[]>('poll_output', { tabId })
}

/// Open a local shell (PTY-backed local process) for a tab.
/// `cols`/`rows` set the initial PTY size so the shell lays out correctly
/// (avoids input landing on the wrong line when the default 80x24 is used).
export async function openLocalShell(
  tabId: number,
  shell?: string,
  cwd?: string,
  reuseExisting: boolean = true,
  cols?: number,
  rows?: number,
): Promise<void> {
  return await invoke('open_local_shell', {
    tabId,
    shell: shell ?? null,
    cwd: cwd ?? null,
    reuseExisting,
    cols: cols ?? 0,
    rows: rows ?? 0,
  })
}

/// Get saved local terminal entries.
export async function getLocalTerminals(): Promise<LocalTerminalEntry[]> {
  return await invoke<LocalTerminalEntry[]>('get_local_terminals')
}

/// Replace the saved local terminal entries.
export async function saveLocalTerminals(entries: LocalTerminalEntry[]): Promise<void> {
  await invoke('save_local_terminals', { entries })
}

/// Send input to a local shell.
export async function localSendInput(tabId: number, data: string): Promise<boolean> {
  return await invoke<boolean>('local_send_input', { tabId, data })
}

/// Resize a local shell PTY.
export async function localResize(tabId: number, cols: number, rows: number): Promise<boolean> {
  return await invoke<boolean>('local_resize', { tabId, cols, rows })
}

/// Close a local shell; returns the last known working directory.
export async function localClose(tabId: number): Promise<string | null> {
  return await invoke<string | null>('local_close', { tabId })
}

/// Get the recorded working-directory history for local shells.
export async function getLocalShellDirs(): Promise<LocalShellDir[]> {
  return await invoke<LocalShellDir[]>('get_local_shell_dirs')
}

/// Remove a single entry (or all) from the local-shell directory history.
export async function clearLocalShellDirs(path?: string): Promise<void> {
  return await invoke('clear_local_shell_dirs', { path: path ?? null })
}

// ===== File Operations =====

export async function listFiles(tabId: number, path: string): Promise<FileEntry[]> {
  return await invoke<FileEntry[]>('list_files', { tabId, path })
}

export async function downloadFile(
  tabId: number,
  remotePath: string,
  localPath: string,
): Promise<boolean> {
  return await invoke<boolean>('download_file', { tabId, remotePath, localPath })
}

export async function uploadFile(
  tabId: number,
  localPath: string,
  remotePath: string,
): Promise<boolean> {
  return await invoke<boolean>('upload_file', { tabId, localPath, remotePath })
}

/// Upload file as raw bytes (for HTML5 drag-drop where we have file data, not paths)
export async function uploadFileBytes(
  tabId: number,
  remotePath: string,
  fileData: number[],
): Promise<boolean> {
  return await invoke<boolean>('upload_file_bytes', { tabId, remotePath, fileData })
}

export async function fileExists(tabId: number, path: string): Promise<boolean> {
  return await invoke<boolean>('file_exists', { tabId, path })
}

export async function createDirectory(tabId: number, path: string): Promise<boolean> {
  return await invoke<boolean>('create_directory', { tabId, path })
}

export async function renameFile(
  tabId: number,
  oldPath: string,
  newPath: string,
): Promise<boolean> {
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
  aiInputHeight: number
  collapsedGroups?: string[]
  autoRecordSessions?: boolean
}

export async function saveWindowConfig(config: WindowConfig): Promise<void> {
  await invoke('save_window_config', { config })
}

export async function loadWindowConfig(): Promise<WindowConfig> {
  return await invoke<WindowConfig>('load_window_config')
}

export async function getAutoRecord(): Promise<boolean> {
  return await invoke<boolean>('get_auto_record')
}

export async function setAutoRecord(enabled: boolean): Promise<void> {
  await invoke<void>('set_auto_record', { enabled })
}

export async function getKeepalive(): Promise<KeepaliveConfig> {
  return await invoke<KeepaliveConfig>('get_keepalive')
}

export async function setKeepalive(interval: number, max: number): Promise<void> {
  await invoke<void>('set_keepalive', { interval, max })
}

export async function setRecordingEnabled(tabId: number, enabled: boolean): Promise<boolean> {
  return await invoke<boolean>('set_recording_enabled', { tabId, enabled })
}

export async function getRecordingEnabled(tabId: number): Promise<boolean> {
  return await invoke<boolean>('get_recording_enabled', { tabId })
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

export async function cancelTransfer(tabId: number): Promise<void> {
  await invoke('cancel_transfer', { tabId })
}

// ===== SFTP User Switching =====

export async function switchSftpUser(
  tabId: number,
  username: string,
  password: string,
): Promise<void> {
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

export async function deleteAllSessions(): Promise<void> {
  await invoke<void>('delete_all_sessions')
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

export async function listCommandSets(connectionId?: string): Promise<CommandSetDto[]> {
  return await invoke<CommandSetDto[]>('list_command_sets', { connectionId })
}

export async function saveCommandSet(cmdSet: CommandSetDto): Promise<string> {
  return await invoke<string>('save_command_set', { cmdSet })
}

export async function deleteCommandSet(id: string): Promise<void> {
  await invoke<void>('delete_command_set', { id })
}

// ===== Command Snippets (floating command list) =====

export async function listCommandSnippets(): Promise<CommandSnippetDto[]> {
  return await invoke<CommandSnippetDto[]>('list_command_snippets')
}

export async function saveCommandSnippet(snippet: CommandSnippetDto): Promise<string> {
  return await invoke<string>('save_command_snippet', { snippet })
}

export async function deleteCommandSnippet(id: string): Promise<void> {
  await invoke<void>('delete_command_snippet', { id })
}

// ===== Global Variables (shared by command snippets) =====

export async function listGlobalVariables(): Promise<GlobalVariable[]> {
  return await invoke<GlobalVariable[]>('list_global_variables')
}

export async function saveGlobalVariable(v: GlobalVariable): Promise<string> {
  return await invoke<string>('save_global_variable', { var: v })
}

export async function deleteGlobalVariable(name: string): Promise<void> {
  await invoke<void>('delete_global_variable', { name })
}

// ===== SSH Tunnels (local port forwarding) =====

export async function listTunnels(): Promise<TunnelInfo[]> {
  return await invoke<TunnelInfo[]>('list_tunnels')
}

export async function startTunnel(args: StartTunnelArgs): Promise<number> {
  return await invoke<number>('start_tunnel', { args })
}

export async function stopTunnel(id: number): Promise<void> {
  await invoke<void>('stop_tunnel', { id })
}

/** Save a tunnel *definition* under a connection (persisted, not started). */
export async function addTunnel(connectionId: string, config: TunnelConfig): Promise<void> {
  await invoke<void>('add_tunnel', { connectionId, config })
}

/** Update a saved tunnel definition on a connection (persisted, not restarted). */
export async function updateTunnel(
  connectionId: string,
  tunnelId: string,
  config: TunnelConfig,
): Promise<void> {
  await invoke<void>('update_tunnel', { connectionId, tunnelId, config })
}

/** Remove a saved tunnel definition (also stops it if currently running). */
export async function removeTunnel(connectionId: string, tunnelId: string): Promise<void> {
  await invoke<void>('remove_tunnel', { connectionId, tunnelId })
}

// ===== AI Prompt Templates =====

export async function listAiPromptTemplates(): Promise<AiPromptTemplate[]> {
  return await invoke<AiPromptTemplate[]>('list_ai_prompt_templates')
}

export async function saveAiPromptTemplate(tpl: AiPromptTemplate): Promise<string> {
  return await invoke<string>('save_ai_prompt_template', { template: tpl })
}

export async function deleteAiPromptTemplate(id: string): Promise<void> {
  await invoke<void>('delete_ai_prompt_template', { id })
}

export async function listHiddenBuiltinTemplates(): Promise<string[]> {
  return await invoke<string[]>('list_hidden_builtin_templates')
}

export async function hideBuiltinTemplate(key: string): Promise<void> {
  await invoke<void>('hide_builtin_template', { key })
}

export async function restoreBuiltinTemplate(key: string): Promise<void> {
  await invoke<void>('restore_builtin_template', { key })
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
  return isSession(target)
    ? listFiles(target.tabId, path)
    : invoke<FileEntry[]>('target_list_files', { target, path })
}

export async function fsDownloadFile(
  target: TargetRef,
  remotePath: string,
  localPath: string,
): Promise<boolean> {
  return isSession(target)
    ? downloadFile(target.tabId, remotePath, localPath)
    : invoke<boolean>('target_download_file', { target, remotePath, localPath })
}

export async function fsDownloadDirectory(
  target: TargetRef,
  remoteDir: string,
  localDir: string,
): Promise<DirDownloadSummary> {
  return isSession(target)
    ? invoke<DirDownloadSummary>('download_directory', { tabId: target.tabId, remoteDir, localDir })
    : invoke<DirDownloadSummary>('target_download_directory', { target, remoteDir, localDir })
}

export async function fsUploadFile(
  target: TargetRef,
  localPath: string,
  remotePath: string,
): Promise<boolean> {
  return isSession(target)
    ? uploadFile(target.tabId, localPath, remotePath)
    : invoke<boolean>('target_upload_file', { target, localPath, remotePath })
}

/// Upload a local directory (or single file) into a remote directory. The Rust
/// side scans the local tree once with walkdir and streams every file over a
/// shared SFTP connection — no per-chunk IPC from the frontend.
export async function fsUploadLocalDir(
  target: TargetRef,
  localDir: string,
  remoteDir: string,
): Promise<DirUploadSummary> {
  return isSession(target)
    ? invoke<DirUploadSummary>('upload_local_dir', {
        tabId: target.tabId,
        localDir,
        remoteDir,
      })
    : invoke<DirUploadSummary>('target_upload_local_dir', { target, localDir, remoteDir })
}

export async function fsUploadFileBytes(
  target: TargetRef,
  remotePath: string,
  fileData: number[],
): Promise<boolean> {
  return isSession(target)
    ? uploadFileBytes(target.tabId, remotePath, fileData)
    : invoke<boolean>('target_upload_file_bytes', { target, remotePath, fileData })
}

/**
 * Returns the list of local file paths copied to the system clipboard
 * (Windows: files copied with Ctrl+C in Explorer). Used by the file panel's
 * "Paste" context-menu action.
 */
export async function getClipboardFiles(): Promise<string[]> {
  return invoke<string[]>('get_clipboard_files')
}

/**
 * Returns local drive letters ("C:/", "D:/", ...) for the file panel's
 * location dropdown when browsing the local machine (Windows only).
 */
export async function listLocalDrives(): Promise<string[]> {
  return invoke<string[]>('list_local_drives')
}

export async function fsFileExists(target: TargetRef, path: string): Promise<boolean> {
  return isSession(target)
    ? fileExists(target.tabId, path)
    : invoke<boolean>('target_file_exists', { target, path })
}

export async function fsCreateDirectory(target: TargetRef, path: string): Promise<boolean> {
  return isSession(target)
    ? createDirectory(target.tabId, path)
    : invoke<boolean>('target_create_directory', { target, path })
}

export async function fsRenameFile(
  target: TargetRef,
  oldPath: string,
  newPath: string,
): Promise<boolean> {
  return isSession(target)
    ? renameFile(target.tabId, oldPath, newPath)
    : invoke<boolean>('target_rename_file', { target, oldPath, newPath })
}

export async function fsDeleteFile(
  target: TargetRef,
  path: string,
  isDir: boolean,
): Promise<boolean> {
  return isSession(target)
    ? deleteFile(target.tabId, path, isDir)
    : invoke<boolean>('target_delete_file', { target, path, isDir })
}

/** Remote-internal copy: copy `src` (file or dir) into `destDir` on the same target.
 *  `destName` is the final basename; if it clashes with an existing entry the
 *  backend refuses to overwrite (so the caller can prompt the user to rename). */
export async function fsCopy(
  target: TargetRef,
  src: string,
  destDir: string,
  destName?: string,
): Promise<void> {
  return invoke<void>('target_copy_file', {
    target,
    src,
    destDir,
    destName: destName ?? null,
  })
}

/** Whether a file/folder exists at `path` on the target (remote-internal). */
export async function fsPathExists(target: TargetRef, path: string): Promise<boolean> {
  return fsFileExists(target, path)
}

export async function fsReadFileContent(
  target: TargetRef,
  path: string,
  options?: { maxSize?: number; encoding?: string },
): Promise<FileContent> {
  return isSession(target)
    ? readFileContent(target.tabId, path, options)
    : invoke<FileContent>('target_read_file', {
        target,
        path,
        maxSize: options?.maxSize,
        encoding: options?.encoding,
      })
}

// ===== App Version =====

export async function getAppVersion(): Promise<import('./types').AppVersion> {
  return await invoke<import('./types').AppVersion>('get_app_version')
}

// ===== Config Directory =====

/** Opens the app config directory in the system file manager. */
export async function openConfigDir(): Promise<void> {
  return await invoke<void>('open_config_dir')
}

// ===== Host Analysis =====

export async function analyzeHost(tabId: number): Promise<import('./types').HostAnalysis> {
  return await invoke<import('./types').HostAnalysis>('analyze_host', { tabId })
}

export async function commandHelp(tabId: number, command: string): Promise<string> {
  return await invoke<string>('command_help', { tabId, command })
}

export async function analyzeDockerContainer(
  tabId: number,
  containerName: string,
): Promise<import('./types').DockerAnalysis> {
  return await invoke<import('./types').DockerAnalysis>('analyze_docker_container', {
    tabId,
    containerName,
  })
}

export async function dockerContainerLogs(
  tabId: number,
  containerName: string,
  tailLines?: number,
): Promise<string> {
  return await invoke<string>('docker_container_logs', { tabId, containerName, tailLines })
}

/** Restart a running Docker container on the jump host. */
export async function restartDockerContainer(tabId: number, containerName: string): Promise<void> {
  return await invoke('restart_docker_container', { tabId, containerName })
}

/** Stop a running Docker container on the jump host. */
export async function stopDockerContainer(tabId: number, containerName: string): Promise<void> {
  return await invoke('stop_docker_container', { tabId, containerName })
}

/** Start a stopped Docker container on the jump host. */
export async function startDockerContainer(tabId: number, containerName: string): Promise<void> {
  return await invoke('start_docker_container', { tabId, containerName })
}

/** Remove a stopped Docker container on the jump host. */
export async function removeDockerContainer(tabId: number, containerName: string): Promise<void> {
  return await invoke('remove_docker_container', { tabId, containerName })
}

export async function dockerLogsStreamStart(
  tabId: number,
  containerName: string,
  tailLines?: number,
): Promise<string> {
  return await invoke<string>('docker_logs_stream_start', { tabId, containerName, tailLines })
}

export async function pollDockerLogs(streamId: string): Promise<string[]> {
  return await invoke<string[]>('poll_docker_logs', { streamId })
}

export async function stopDockerLogsStream(streamId: string): Promise<boolean> {
  return await invoke<boolean>('stop_docker_logs_stream', { streamId })
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

// ===== AI Chat =====

import type { AiConfig, AiMessage } from './types'

export async function loadAiConfig(): Promise<AiConfig> {
  return await invoke<AiConfig>('load_ai_config')
}

export async function saveAiConfig(config: AiConfig): Promise<void> {
  await invoke('save_ai_config', { config })
}

export async function encryptApiKey(key: string): Promise<string> {
  return await invoke<string>('encrypt_api_key', { key })
}

export async function decryptApiKey(encrypted: string): Promise<string> {
  return await invoke<string>('decrypt_api_key', { encrypted })
}

export async function listAiModels(apiKeyEnc: string, endpoint: string): Promise<string[]> {
  return await invoke<string[]>('list_ai_models', { apiKeyEnc, endpoint })
}

export async function aiChat(messages: AiMessage[]): Promise<string> {
  return await invoke<string>('ai_chat', { messages })
}

export async function startAiChatStream(messages: AiMessage[]): Promise<string> {
  return await invoke<string>('start_ai_chat_stream', { messages })
}

export async function pollAiChunks(
  chatId: string,
): Promise<[string, boolean, string | null, ToolCallEvent[]] | null> {
  return await invoke<[string, boolean, string | null, ToolCallEvent[]] | null>('poll_ai_chunks', {
    chatId,
  })
}

export async function cancelAiChat(chatId: string): Promise<void> {
  return await invoke<void>('cancel_ai_chat', { chatId })
}

export async function startAiAgent(
  messages: AiMessage[],
  tabId?: number,
  profile?: AiEndpointProfile,
  readOnly?: boolean,
  maxAgentRounds?: number,
  toolCallFormat?: 'flat' | 'nested',
): Promise<string> {
  return await invoke<string>('start_ai_agent', {
    messages,
    tabId: tabId ?? null,
    profile: profile ?? null,
    readOnly: readOnly ?? false,
    maxAgentRounds: maxAgentRounds ?? 12,
    toolCallFormat: toolCallFormat ?? null,
  })
}

export async function confirmAiTool(
  chatId: string,
  approved: boolean,
  readOnly?: boolean,
  maxAgentRounds?: number,
): Promise<void> {
  return await invoke<void>('confirm_ai_tool', {
    chatId,
    approved,
    readOnly: readOnly ?? false,
    maxAgentRounds: maxAgentRounds ?? 12,
  })
}

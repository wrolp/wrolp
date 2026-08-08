use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};
use std::sync::atomic::{AtomicBool, AtomicU64};
use tauri::Manager;
use tokio::sync::mpsc;

use crate::ai::{AiChatState, AiEndpointProfile, AiMessage, OpenAiToolCall};

/// A tool call that needs explicit user confirmation before execution
/// (e.g. a destructive/sensitive shell command). Saved when the agent loop
/// pauses so `confirm_ai_tool` can resume it after the user decides.
pub struct AiPendingConfirm {
  pub chat_id: String,
  pub config: AiEndpointProfile,
  pub messages: Vec<AiMessage>,
  pub calls: Vec<OpenAiToolCall>,
}
use crate::db::{DbConn, RecordedEvent};

/// Path to the SSH connections config file
fn get_connections_path() -> Option<std::path::PathBuf> {
  dirs::config_dir().map(|p| p.join("wrolp-terminal").join("connections.json"))
}

/// SSH connection config
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionConfig {
  pub id: String,
  pub name: String,
  pub host: String,
  #[serde(default = "default_port")]
  pub port: u16,
  pub username: String,
  pub password: Option<String>,
  pub key_path: Option<String>,
  pub passphrase: Option<String>,
  #[serde(default)]
  pub description: Option<String>,
  #[serde(default)]
  pub group: Option<String>,
}

fn default_port() -> u16 {
  22
}

/// On-disk connection representation. Secrets are stored as AES-GCM vault blobs
/// (see `vault.rs`) instead of plaintext. Convert to/from `ConnectionConfig`
/// via the `from_conn` / `from_persisted` helpers so the in-memory
/// `ConnectionConfig` keeps holding decrypted secrets (used by `connect`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedConnection {
  pub id: String,
  pub name: String,
  pub host: String,
  #[serde(default = "default_port")]
  pub port: u16,
  pub username: String,
  /// Base64 AES-GCM blob of the password (nonce || ciphertext), or None.
  #[serde(default)]
  pub password_enc: Option<String>,
  #[serde(default)]
  pub key_path: Option<String>,
  /// Base64 AES-GCM blob of the private-key passphrase, or None.
  #[serde(default)]
  pub passphrase_enc: Option<String>,
  #[serde(default)]
  pub description: Option<String>,
  #[serde(default)]
  pub group: Option<String>,
}

/// Envelope written to `connections.json` so we can detect the encrypted format
/// (version == 1) versus legacy plaintext files (a bare JSON array).
#[derive(Debug, Serialize, Deserialize)]
struct PersistedFile {
  version: u8,
  connections: Vec<PersistedConnection>,
}

impl PersistedConnection {
  /// Build the on-disk form from an in-memory connection, encrypting any secret.
  fn from_conn(c: &ConnectionConfig) -> Result<PersistedConnection, String> {
    let password_enc = match &c.password {
      Some(p) => Some(crate::vault::seal_secret(p)?),
      None => None,
    };
    let passphrase_enc = match &c.passphrase {
      Some(p) => Some(crate::vault::seal_secret(p)?),
      None => None,
    };
    Ok(PersistedConnection {
      id: c.id.clone(),
      name: c.name.clone(),
      host: c.host.clone(),
      port: c.port,
      username: c.username.clone(),
      password_enc,
      key_path: c.key_path.clone(),
      passphrase_enc,
      description: c.description.clone(),
      group: c.group.clone(),
    })
  }
}

impl ConnectionConfig {
  /// Reconstruct an in-memory connection (with decrypted secrets) from storage.
  fn from_persisted(p: &PersistedConnection) -> Result<ConnectionConfig, String> {
    let password = match &p.password_enc {
      Some(e) => Some(crate::vault::open_secret(e)?),
      None => None,
    };
    let passphrase = match &p.passphrase_enc {
      Some(e) => Some(crate::vault::open_secret(e)?),
      None => None,
    };
    Ok(ConnectionConfig {
      id: p.id.clone(),
      name: p.name.clone(),
      host: p.host.clone(),
      port: p.port,
      username: p.username.clone(),
      password,
      key_path: p.key_path.clone(),
      passphrase,
      description: p.description.clone(),
      group: p.group.clone(),
    })
  }
}

/// Serialize a slice of connections to disk in the encrypted envelope format.
pub(crate) fn write_encrypted_connections(
  path: &std::path::Path,
  conns: &[ConnectionConfig],
) -> Result<(), String> {
  if let Some(parent) = path.parent() {
    let _ = std::fs::create_dir_all(parent);
  }
  let mut persisted = Vec::with_capacity(conns.len());
  for c in conns {
    persisted.push(PersistedConnection::from_conn(c)?);
  }
  let file = PersistedFile {
    version: 1,
    connections: persisted,
  };
  let content = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
  std::fs::write(path, content).map_err(|e| e.to_string())?;
  Ok(())
}

/// Terminal output event
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutput {
  pub tab_id: u32,
  pub data: String,
  pub title: String,
}

/// Return value of the `connect` command
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectResult {
  pub status: String,
  pub tab_id: u32,
}

/// File entry returned by list_files
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
  pub name: String,
  pub path: String,
  pub is_dir: bool,
  pub size: u64,
  pub mode: String,
  pub modified: String,
}

/// Custom error type — moved here so ssh_session types can reference it
#[derive(Debug)]
pub struct SshError(pub String);

impl std::fmt::Display for SshError {
  fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
    write!(f, "{}", self.0)
  }
}

impl std::error::Error for SshError {}

impl From<russh::Error> for SshError {
  fn from(e: russh::Error) -> Self {
    SshError(e.to_string())
  }
}

impl From<String> for SshError {
  fn from(s: String) -> Self {
    SshError(s)
  }
}

/// SSH handler — moved here to avoid circular deps with commands.rs
pub struct SshHandler {
  pub app_handle: tauri::AppHandle,
  pub tab_id: u32,
  /// When true, suppress terminal output (used for SFTP-only sessions)
  pub is_sftp: bool,
  /// Channel id of the interactive PTY shell. Only output from this channel is
  /// shown in the terminal; auxiliary channels (docker exec, ProxyJump) opened
  /// on the same connection are suppressed. Set on the first channel-open
  /// confirmation (the PTY shell), and never overwritten.
  pub shell_channel_id: Option<russh::ChannelId>,
}

impl SshHandler {
  /// Push data into AppState's output buffer (consumed by frontend via poll_output)
  pub fn emit(&self, data: &str) {
    if let Some(state) = self.app_handle.try_state::<AppState>() {
      if let Ok(mut buffers) = state.output_buffers.lock() {
        buffers
          .entry(self.tab_id)
          .or_default()
          .push(data.to_string());
      }
    }
  }

  /// Record a terminal event (input or output) for session recording
  pub fn record_event(&self, direction: &str, content: &str) {
    if let Some(state) = self.app_handle.try_state::<AppState>() {
      if let Ok(mut recordings) = state.recordings.lock() {
        if let Some(rec) = recordings.get_mut(&self.tab_id) {
          if !rec.recording_enabled {
            return;
          }
          let seq = rec.seq_counter;
          rec.seq_counter += 1;
          let elapsed = rec.started_at.elapsed().as_millis() as u64;
          rec.events.push(RecordedEvent {
            seq,
            timestamp_ms: elapsed,
            direction: direction.to_string(),
            content: content.to_string(),
          });
        }
      }
    }
  }

  /// Returns true only for data arriving on the interactive PTY shell channel.
  /// Auxiliary channels (docker exec, ProxyJump) opened on the same SSH
  /// connection are rejected so their output never reaches the terminal.
  /// Falls back to true when the shell channel id hasn't been recorded yet.
  pub fn is_shell_channel(&self, channel: russh::ChannelId) -> bool {
    self
      .shell_channel_id
      .map_or(true, |id| id == channel)
  }
}

/// Active local shell session (a PTY-backed local process, e.g. cmd/pwsh/bash).
/// Reads happen on a dedicated std::thread.
pub struct LocalShell {
  pub tab_id: u32,
  /// PTY master used for writing input and resizing.
  pub master: Box<dyn portable_pty::MasterPty + Send>,
  /// Writer half of the master (for `write_all`).
  pub writer: Box<dyn std::io::Write + Send>,
  /// Child process handle.
  pub child: Box<dyn portable_pty::Child + Send + Sync>,
  /// Monotonic version — bumped on each (re)open for the same tab, so a
  /// superseded reader thread can stop writing into the buffer.
  pub session_id: u64,
  /// Last known working directory (cwd at open, or updated by polling).
  pub cwd: Option<String>,
  /// Per-tab output queue owned by this LocalShell. The reader thread holds an
  /// `Arc` clone and writes here, so it never has to reach back into the
  /// global `AppState` (which is unreliable from a plain `std::thread`).
  pub output: Arc<StdMutex<Vec<String>>>,
}

/// Active SSH session
pub struct SshSession {
  pub tab_id: u32,
  pub config: ConnectionConfig,
  /// Sender for data to the SSH channel
  pub data_tx: Option<mpsc::UnboundedSender<Vec<u8>>>,
  /// Shutdown signal
  pub shutdown_tx: Option<tokio::sync::oneshot::Sender<()>>,
  /// PTY channel Arc (for resize)
  pub channel_arc: Option<Arc<tokio::sync::Mutex<russh::Channel<russh::client::Msg>>>>,
  /// Shared SSH session handle, kept alive for the session lifetime.
  /// Used to open extra channels (ProxyJump direct-tcpip, docker exec) for
  /// secondary targets without re-authenticating.
  pub session_handle: Option<Arc<russh::client::Handle<SshHandler>>>,
  /// Optional switched user for SFTP operations (different from connection config user)
  pub switched_sftp_user: Option<SwitchedUser>,
  /// Monotonic session version — incremented on each reconnection for the same tab
  /// Used to prevent stale tasks from emitting spurious connection-closed events
  pub session_id: u64,
}

/// Switched SFTP user — allows operating files with a different user's permissions
#[derive(Debug, Clone)]
pub struct SwitchedUser {
  pub username: String,
  pub password: String,
}

// ==================== P6: Jump host / Docker targets ====================

/// Credentials for a secondary target (independent of the jump host).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetAuth {
  pub username: String,
  pub password: Option<String>,
  pub key_path: Option<String>,
  pub passphrase: Option<String>,
}

/// Identifies which remote filesystem a file operation acts upon.
/// Constructed by the frontend, consumed by the backend.
///
/// NOTE: `rename_all = "camelCase"` is intentionally NOT used here — when
/// combined with `tag = "kind"`, serde fails to apply it to variant fields, so
/// we rename the multi-word fields explicitly to match the frontend's camelCase.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum TargetRef {
  /// The current tab's main SSH connection (backwards-compatible).
  #[serde(rename = "session")]
  Session {
    #[serde(rename = "tabId")]
    tab_id: u32,
  },
  /// A secondary remote server reached via ProxyJump through a connected jump tab.
  #[serde(rename = "jumpRemote")]
  JumpRemote {
    #[serde(rename = "jumpTabId")]
    jump_tab_id: u32,
    host: String,
    port: u16,
    auth: TargetAuth,
  },
  /// A Docker container on the jump host, accessed via `docker exec` (no sshd).
  #[serde(rename = "docker")]
  Docker {
    #[serde(rename = "jumpTabId")]
    jump_tab_id: u32,
    container: String,
    user: Option<String>,
  },
  /// A container running sshd, reached via ProxyJump (host = container IP).
  #[serde(rename = "dockerSsh")]
  DockerSsh {
    #[serde(rename = "jumpTabId")]
    jump_tab_id: u32,
    host: String,
    port: u16,
    auth: TargetAuth,
  },
  /// The user's local machine (used when the focused tab is a local shell).
  #[serde(rename = "local")]
  Local { #[serde(rename = "tabId")] tab_id: u32 },
}

/// A Docker container discovered via `docker ps` on the jump host.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerInfo {
  pub id: String,
  pub name: String,
  pub image: String,
  pub state: String,
  pub status: String,
}

/// File metadata for a remote target.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMeta {
  pub path: String,
  pub is_dir: bool,
  pub size: u64,
  pub mode: String,
  pub modified: String,
}

/// Per-tab transfer pause/resume control
pub struct TransferControl {
  pub paused: AtomicBool,
  pub notify: tokio::sync::Notify,
}

/// Active session recording — accumulates events in memory, flushed to SQLite periodically
pub struct ActiveRecording {
  pub session_id: String,
  pub session_version: u64,
  pub connection_id: String,
  pub connection_name: String,
  pub started_at: std::time::Instant,
  pub started_at_iso: String,
  pub seq_counter: u64,
  pub events: Vec<RecordedEvent>,
  pub recording_enabled: bool,
}

/// Global application state
pub struct AppState {
  pub connections: StdMutex<Vec<ConnectionConfig>>,
  pub sessions: StdMutex<HashMap<u32, SshSession>>,
  /// Polling output buffer: tab_id → pending text chunks (frontend polls every 100ms)
  pub output_buffers: StdMutex<HashMap<u32, Vec<String>>>,
  /// Transfer pause controls: tab_id → control
  pub transfer_controls: StdMutex<HashMap<u32, Arc<TransferControl>>>,
  /// Monotonic connection counter — bumped per new connect() call
  pub next_session_id: AtomicU64,
  /// SQLite database for session recording and command sets
  pub db: DbConn,
  /// Active recordings: tab_id → recording buffer
  pub recordings: StdMutex<HashMap<u32, ActiveRecording>>,
  /// Docker log streaming: stream_id → pending text chunks
  pub docker_log_buffers: StdMutex<HashMap<String, Vec<String>>>,
  /// Docker log streaming: stream_id → shutdown sender
  pub docker_log_streams: StdMutex<HashMap<String, tokio::sync::oneshot::Sender<()>>>,
  /// Docker log stream ID counter
  pub next_docker_log_stream_id: AtomicU64,
  /// AI chat streaming buffers: chat_id → state
  pub ai_chat_buffers: StdMutex<HashMap<String, AiChatState>>,
  /// Cached AI configuration (loaded at startup)
  pub ai_config: StdMutex<Option<crate::ai::AiConfig>>,
  /// Pending agent pause awaiting user confirmation of a sensitive tool call
  pub ai_pending: StdMutex<Option<AiPendingConfirm>>,
  /// Active local shell sessions: tab_id → LocalShell
  pub local_shells: StdMutex<HashMap<u32, LocalShell>>,
  /// Working directory history for local shells (most-recently-used first)
  pub local_shell_dirs: StdMutex<Vec<LocalShellDir>>,
  /// Saved local terminal entries (user-defined local shells with a cwd + shell)
  pub local_terminals: StdMutex<Vec<LocalTerminalEntry>>,
}

/// A user-defined local terminal: opens a local shell in `cwd` using `shell`.
/// `shell` is the command invoked by portable_pty (e.g. "cmd", "pwsh",
/// "powershell", "bash", "wsl", or an absolute path to git-bash.exe).
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalTerminalEntry {
  pub id: String,
  pub name: String,
  pub cwd: String,
  pub shell: String,
}

/// A recorded local-shell working directory (for the "recent directories" list).
#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct LocalShellDir {
  pub path: String,
  pub shell: Option<String>,
  pub last_used: u64,
}

impl AppState {
  pub fn new(db: DbConn) -> Self {
    let connections = get_initial_connections();

    let ai_config = crate::ai::load_ai_config().ok();
    Self {
      connections: StdMutex::new(connections),
      sessions: StdMutex::new(HashMap::new()),
      output_buffers: StdMutex::new(HashMap::new()),
      transfer_controls: StdMutex::new(HashMap::new()),
      next_session_id: AtomicU64::new(1),
      db,
      recordings: StdMutex::new(HashMap::new()),
      docker_log_buffers: StdMutex::new(HashMap::new()),
      docker_log_streams: StdMutex::new(HashMap::new()),
      next_docker_log_stream_id: AtomicU64::new(1),
      ai_chat_buffers: StdMutex::new(HashMap::new()),
      ai_config: StdMutex::new(ai_config),
      ai_pending: StdMutex::new(None),
      local_shells: StdMutex::new(HashMap::new()),
      local_shell_dirs: StdMutex::new(Vec::new()),
      local_terminals: StdMutex::new(get_initial_local_terminals()),
    }
  }
}

/// Load saved local terminal entries from `local_terminals.json`.
fn get_initial_local_terminals() -> Vec<LocalTerminalEntry> {
  let path = get_local_terminals_path();
  if let Some(ref path) = path {
    if path.exists() {
      if let Ok(content) = std::fs::read_to_string(path) {
        if let Ok(entries) = serde_json::from_str::<Vec<LocalTerminalEntry>>(&content) {
          return entries;
        }
      }
    }
  }
  Vec::new()
}

/// Path to the local terminals config file.
pub fn get_local_terminals_path() -> Option<std::path::PathBuf> {
  dirs::config_dir().map(|p| p.join("wrolp-terminal").join("local_terminals.json"))
}

/// Load initial connection list from config file.
/// Supports the encrypted envelope format (version == 1) and transparently
/// migrates legacy plaintext files (`Vec<ConnectionConfig>`) by re-writing
/// them in the encrypted format on load.
fn get_initial_connections() -> Vec<ConnectionConfig> {
  let path = get_connections_path();
  if let Some(ref path) = path {
    if path.exists() {
      if let Ok(content) = std::fs::read_to_string(path) {
        return load_connections_content(path, &content);
      }
    }
  }
  Vec::new()
}

fn load_connections_content(path: &std::path::Path, content: &str) -> Vec<ConnectionConfig> {
  // New encrypted format: { "version": 1, "connections": [...] }
  if let Ok(file) = serde_json::from_str::<PersistedFile>(content) {
    if file.version == 1 {
      let mut out = Vec::with_capacity(file.connections.len());
      for p in &file.connections {
        match ConnectionConfig::from_persisted(p) {
          Ok(c) => out.push(c),
          Err(e) => eprintln!("[connections] failed to decrypt a connection: {}", e),
        }
      }
      return out;
    }
  }

  // Legacy plaintext format (bare array of ConnectionConfig). Keep the
  // decrypted secrets in memory and re-persist them encrypted.
  if let Ok(old) = serde_json::from_str::<Vec<ConnectionConfig>>(content) {
    if let Err(e) = write_encrypted_connections(path, &old) {
      eprintln!("[connections] migration to encrypted format failed: {}", e);
    }
    return old;
  }

  Vec::new()
}

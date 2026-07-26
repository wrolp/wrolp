use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};
use std::sync::atomic::{AtomicBool, AtomicU64};
use tauri::Manager;
use tokio::sync::mpsc;

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
}

impl AppState {
  pub fn new(db: DbConn) -> Self {
    let connections = get_initial_connections();

    Self {
      connections: StdMutex::new(connections),
      sessions: StdMutex::new(HashMap::new()),
      output_buffers: StdMutex::new(HashMap::new()),
      transfer_controls: StdMutex::new(HashMap::new()),
      next_session_id: AtomicU64::new(1),
      db,
      recordings: StdMutex::new(HashMap::new()),
    }
  }
}

/// Load initial connection list from config file
fn get_initial_connections() -> Vec<ConnectionConfig> {
  let path = get_connections_path();
  if let Some(ref path) = path {
    if path.exists() {
      if let Ok(content) = std::fs::read_to_string(path) {
        if let Ok(conns) = serde_json::from_str::<Vec<ConnectionConfig>>(&content) {
          return conns;
        }
      }
    }
  }
  Vec::new()
}

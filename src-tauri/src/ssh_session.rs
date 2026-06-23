use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};
use tauri::Manager;
use tokio::sync::mpsc;

/// Path to the SSH connections config file
fn get_connections_path() -> Option<std::path::PathBuf> {
  dirs::config_dir().map(|p| p.join("ssh-terminal").join("connections.json"))
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
  /// Cloned SSH session handle for SFTP file operations
  pub session_handle: Option<russh::client::Handle<SshHandler>>,
}

/// Global application state
pub struct AppState {
  pub connections: StdMutex<Vec<ConnectionConfig>>,
  pub sessions: StdMutex<HashMap<u32, SshSession>>,
  /// Polling output buffer: tab_id → pending text chunks (frontend polls every 100ms)
  pub output_buffers: StdMutex<HashMap<u32, Vec<String>>>,
}

impl AppState {
  pub fn new() -> Self {
    let connections = get_initial_connections();

    Self {
      connections: StdMutex::new(connections),
      sessions: StdMutex::new(HashMap::new()),
      output_buffers: StdMutex::new(HashMap::new()),
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

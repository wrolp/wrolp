use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};
use tokio::sync::mpsc;

/// SSH connection config file path
fn get_connections_path() -> Option<std::path::PathBuf> {
  dirs::config_dir().map(|p| p.join("ssh-terminal").join("connections.json"))
}

/// SSH connection configuration
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

/// Return value of connect command — must match frontend invoke<{ status: string }>
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectResult {
  pub status: String,
  pub tab_id: u32,
}

/// Active SSH session — managed via russh
pub struct SshSession {
  pub tab_id: u32,
  pub config: ConnectionConfig,
  /// Sender for sending data to SSH channel
  pub data_tx: Option<mpsc::UnboundedSender<Vec<u8>>>,
  /// Shutdown signal
  pub shutdown_tx: Option<tokio::sync::oneshot::Sender<()>>,
  /// PTY channel Arc (for resize)
  pub channel_arc: Option<Arc<tokio::sync::Mutex<russh::Channel<russh::client::Msg>>>>,
}

/// Global state management
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

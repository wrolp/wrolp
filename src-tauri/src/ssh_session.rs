use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};
use tokio::io::AsyncWrite;
use tokio::sync::Mutex as TokioMutex;
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
  pub tab_id: String,
  pub data: String,
  pub title: String,
}

/// Active SSH session
pub struct SshSession {
  pub tab_id: String,
  pub config: ConnectionConfig,
  pub process: Option<tokio::process::Child>,
  pub stdin: Option<Arc<TokioMutex<Box<dyn AsyncWrite + Send + Unpin>>>>,
  pub alive: bool,
}

impl SshSession {
  pub fn new(tab_id: String, config: ConnectionConfig) -> Self {
    Self {
      tab_id,
      config,
      process: None,
      stdin: None,
      alive: false,
    }
  }
}

/// Global state management
pub struct AppState {
  pub connections: StdMutex<Vec<ConnectionConfig>>,
  pub sessions: StdMutex<HashMap<String, SshSession>>,
  pub output_tx: StdMutex<Option<mpsc::Sender<TerminalOutput>>>,
  pub output_rx: Arc<StdMutex<Option<mpsc::Receiver<TerminalOutput>>>>,
}

impl AppState {
  pub fn new() -> Self {
    let (output_tx, output_rx) = mpsc::channel(1000);

    // Load existing connections from config file
    let connections = get_initial_connections();

    Self {
      connections: StdMutex::new(connections),
      sessions: StdMutex::new(HashMap::new()),
      output_tx: StdMutex::new(Some(output_tx)),
      output_rx: Arc::new(StdMutex::new(Some(output_rx))),
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

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use tokio::sync::mpsc;

/// SSH connection configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
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
  pub stdin: Option<Box<dyn tokio::io::AsyncWrite + Send + Unpin>>,
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
  pub connections: Mutex<Vec<ConnectionConfig>>,
  pub sessions: Mutex<HashMap<String, SshSession>>,
  pub output_tx: Mutex<Option<mpsc::Sender<TerminalOutput>>>,
  pub output_rx: Mutex<Option<mpsc::Receiver<TerminalOutput>>>,
}

impl AppState {
  pub fn new() -> Self {
    let (output_tx, output_rx) = mpsc::channel(1000);
    Self {
      connections: Mutex::new(Vec::new()),
      sessions: Mutex::new(HashMap::new()),
      output_tx: Mutex::new(Some(output_tx)),
      output_rx: Mutex::new(Some(output_rx)),
    }
  }
}

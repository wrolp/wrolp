use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};
use tokio::io::AsyncWrite;
use tokio::sync::Mutex as TokioMutex;
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
    Self {
      connections: StdMutex::new(Vec::new()),
      sessions: StdMutex::new(HashMap::new()),
      output_tx: StdMutex::new(Some(output_tx)),
      output_rx: Arc::new(StdMutex::new(Some(output_rx))),
    }
  }
}

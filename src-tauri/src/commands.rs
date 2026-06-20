use super::ssh_session::{AppState, ConnectionConfig, ConnectResult, SshSession, TerminalOutput};
use russh::client::{self, Handler};
use russh::ChannelId;
use russh_keys::load_secret_key;
use std::sync::Arc;
use tauri::Emitter;

// ==================== Custom Error type ====================

#[derive(Debug)]
struct SshError(String);

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

// ==================== Handler ====================

struct SshHandler {
  app_handle: tauri::AppHandle,
  tab_id: String,
}

impl SshHandler {
  fn emit(&self, data: &str) {
    let _ = self.app_handle.emit(
      "ssh-output",
      TerminalOutput {
        tab_id: self.tab_id.clone(),
        data: data.to_string(),
        title: String::new(),
      },
    );
  }
}

#[async_trait::async_trait]
impl Handler for SshHandler {
  type Error = SshError;

  async fn check_server_key(
    &mut self,
    _server_public_key: &russh_keys::key::PublicKey,
  ) -> Result<bool, Self::Error> {
    // Accept all host keys (equivalent to StrictHostKeyChecking=accept-new)
    Ok(true)
  }

  async fn data(
    &mut self,
    _channel: ChannelId,
    data: &[u8],
    _session: &mut russh::client::Session,
  ) -> Result<(), Self::Error> {
    let text = String::from_utf8_lossy(data);
    self.emit(&text);
    Ok(())
  }

  async fn extended_data(
    &mut self,
    _channel: ChannelId,
    _code: u32,
    data: &[u8],
    _session: &mut russh::client::Session,
  ) -> Result<(), Self::Error> {
    // stderr → display in yellow
    let text = String::from_utf8_lossy(data);
    self.emit(&format!("\u{1b}[33m{}\u{1b}[0m", text));
    Ok(())
  }
}

// ==================== Data Persistence ====================

fn get_data_dir() -> Option<std::path::PathBuf> {
  dirs::config_dir().map(|p| p.join("ssh-terminal"))
}

fn get_connections_path() -> Option<std::path::PathBuf> {
  get_data_dir().map(|p| p.join("connections.json"))
}

#[tauri::command]
pub async fn list_connections(state: tauri::State<'_, AppState>) -> Result<String, String> {
  let connections = state.connections.lock().map_err(|e| e.to_string())?;
  Ok(serde_json::to_string(&*connections).map_err(|e| e.to_string())?)
}

#[tauri::command]
pub async fn save_connection(
  state: tauri::State<'_, AppState>,
  config: ConnectionConfig,
) -> Result<String, String> {
  {
    let mut connections = state.connections.lock().map_err(|e| e.to_string())?;
    let found = connections.iter_mut().find(|c| c.id == config.id);
    if let Some(existing) = found {
      *existing = config.clone();
    } else {
      connections.push(config.clone());
    }
  }

  let path = get_connections_path();
  if let Some(ref path) = path {
    if let Some(parent) = path.parent() {
      let _ = tokio::fs::create_dir_all(parent).await;
    }
    let content = {
      let all_conns = state.connections.lock().map_err(|e| e.to_string())?;
      serde_json::to_string_pretty(&*all_conns).ok()
    };
    if let Some(content) = content {
      let _ = tokio::fs::write(path, content).await;
    }
  }
  Ok(serde_json::to_string(&config).map_err(|e| e.to_string())?)
}

#[tauri::command]
pub async fn delete_connection(
  state: tauri::State<'_, AppState>,
  id: String,
) -> Result<bool, String> {
  let deleted = {
    let mut connections = state.connections.lock().map_err(|e| e.to_string())?;
    let len_before = connections.len();
    connections.retain(|c| c.id != id);
    connections.len() < len_before
  };

  if deleted {
    let path = get_connections_path();
    if let Some(ref path) = path {
      if let Some(parent) = path.parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
      }
      let content = {
        let all_conns = state.connections.lock().map_err(|e| e.to_string())?;
        serde_json::to_string_pretty(&*all_conns).ok()
      };
      if let Some(content) = content {
        let _ = tokio::fs::write(path, content).await;
      }
    }
  }

  Ok(deleted)
}

// ==================== SSH Connection (russh) ====================

#[tauri::command]
pub async fn connect(
  app: tauri::AppHandle,
  state: tauri::State<'_, AppState>,
  config: ConnectionConfig,
  tab_id: String,
) -> Result<ConnectResult, String> {
  let host = config.host.clone();
  let port = config.port;
  let username = config.username.clone();

  println!("[connect] tab={} host={}:{} user={}", tab_id, host, port, username);

  // Send connecting message
  let _ = app.emit(
    "ssh-output",
    TerminalOutput {
      tab_id: tab_id.clone(),
      data: format!("Connecting to {}:{} as {} ...\r\n", host, port, username),
      title: String::new(),
    },
  );

  // Create channels: data_tx for input, shutdown_tx for disconnect
  let (data_tx, mut data_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
  let (shutdown_tx, mut shutdown_rx) = tokio::sync::oneshot::channel::<()>();

  // Background task: establish SSH connection and read/write loop
  {
    let app_handle = app.clone();
    let tid = tab_id.clone();
    let cfg = config.clone();

    tauri::async_runtime::spawn(async move {
      println!("[russh] connecting to {}:{}", cfg.host, cfg.port);

      let emit_error = |app: &tauri::AppHandle, tid: &str, msg: &str| {
        let _ = app.emit(
          "ssh-output",
          TerminalOutput {
            tab_id: tid.to_string(),
            data: format!("\u{1b}[31m{}\u{1b}[0m\r\n", msg),
            title: String::new(),
          },
        );
      };

      // 1. Establish SSH connection
      let handler = SshHandler {
        app_handle: app_handle.clone(),
        tab_id: tid.clone(),
      };
      let ssh_config = Arc::new(client::Config::default());

      let mut handle = match client::connect(ssh_config, (cfg.host.as_str(), cfg.port), handler).await {
        Ok(h) => h,
        Err(e) => {
          println!("[russh] handshake error: {:?}", e);
          emit_error(&app_handle, &tid, &format!("SSH handshake failed: {}", e));
          return;
        }
      };

      // 2. Authentication
      if let Some(ref pw) = cfg.password {
        match handle.authenticate_password(&cfg.username, pw).await {
          Ok(true) => {}
          Ok(false) => {
            emit_error(&app_handle, &tid, "Authentication failed: wrong password");
            return;
          }
          Err(e) => {
            println!("[russh] auth error: {:?}", e);
            emit_error(&app_handle, &tid, &format!("Authentication error: {}", e));
            return;
          }
        }
      } else if let Some(ref key_path) = cfg.key_path {
        let key = match load_secret_key(key_path, cfg.passphrase.as_deref()) {
          Ok(k) => k,
          Err(e) => {
            emit_error(&app_handle, &tid, &format!("Failed to load key: {}", e));
            return;
          }
        };
        match handle.authenticate_publickey(&cfg.username, Arc::new(key)).await {
          Ok(true) => {}
          Ok(false) => {
            emit_error(&app_handle, &tid, "Authentication failed: invalid key");
            return;
          }
          Err(e) => {
            println!("[russh] key auth error: {:?}", e);
            emit_error(&app_handle, &tid, &format!("Key authentication error: {}", e));
            return;
          }
        }
      } else {
        emit_error(&app_handle, &tid, "No password or key provided");
        return;
      }

      println!("[russh] authenticated, opening channel");

      // 3. Open channel + PTY + shell
      let channel = match handle.channel_open_session().await {
        Ok(ch) => ch,
        Err(e) => {
          emit_error(&app_handle, &tid, &format!("Failed to open channel: {}", e));
          return;
        }
      };

      if let Err(e) = channel.request_pty(false, "xterm-256color", 80, 24, 0, 0, &[]).await {
        emit_error(&app_handle, &tid, &format!("PTY request failed: {}", e));
        return;
      }

      if let Err(e) = channel.request_shell(false).await {
        emit_error(&app_handle, &tid, &format!("Shell request failed: {}", e));
        return;
      }

      println!("[russh] shell started for tab={}", tid);

      // 4. Read/write loop: data_rx → channel, shutdown_rx → exit
      loop {
        tokio::select! {
          Some(data) = data_rx.recv() => {
            // channel.data() requires AsyncRead, &[u8] implements it
            if let Err(e) = channel.data(data.as_slice()).await {
              println!("[russh] write error for tab={}: {:?}", tid, e);
              break;
            }
          }
          _ = &mut shutdown_rx => {
            println!("[russh] shutdown signal for tab={}", tid);
            // Send EOF then disconnect
            let _ = channel.eof().await;
            break;
          }
          else => {
            println!("[russh] data_rx closed for tab={}", tid);
            break;
          }
        }
      }

      println!("[russh] disconnected for tab={}", tid);
    });
  }

  // Save session
  {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    sessions.insert(
      tab_id.clone(),
      SshSession {
        tab_id: tab_id.clone(),
        config: config.clone(),
        data_tx: Some(data_tx),
        shutdown_tx: Some(shutdown_tx),
      },
    );
  }

  println!("[connect] returning connected for tab={}", tab_id);
  Ok(ConnectResult {
    status: "connected".into(),
    tab_id,
  })
}

#[tauri::command]
pub async fn disconnect(
  state: tauri::State<'_, AppState>,
  tab_id: String,
) -> Result<bool, String> {
  let shutdown_tx = {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    if let Some(session) = sessions.get_mut(&tab_id) {
      session.shutdown_tx.take()
    } else {
      None
    }
  };

  if let Some(tx) = shutdown_tx {
    let _ = tx.send(());
  }

  Ok(true)
}

#[tauri::command]
pub async fn send_input(
  state: tauri::State<'_, AppState>,
  tab_id: String,
  data: String,
) -> Result<bool, String> {
  let data_tx = {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    sessions
      .get(&tab_id)
      .and_then(|s| s.data_tx.clone())
      .ok_or("Session not found")?
  };

  data_tx
    .send(data.into_bytes())
    .map_err(|e| format!("Failed to send input: {}", e))?;
  Ok(true)
}

#[tauri::command]
pub async fn resize_terminal(
  _state: tauri::State<'_, AppState>,
  _tab_id: String,
  _cols: u32,
  _rows: u32,
) -> Result<bool, String> {
  // TODO: adjust PTY size via russh channel
  Ok(true)
}

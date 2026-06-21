use super::ssh_session::{AppState, ConnectionConfig, ConnectResult, SshSession};
use russh::client::{self, Handler};
use russh::{Channel, ChannelId};
use russh_keys::load_secret_key;
use std::sync::Arc;
use std::hint::black_box;
use tauri::Manager;

// ==================== Custom Error Type ====================

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
  /// Push data into AppState output buffer (consumed by frontend via poll_output)
  fn emit(&self, data: &str) {
    if let Some(state) = self.app_handle.try_state::<AppState>() {
      if let Ok(mut buffers) = state.output_buffers.lock() {
        buffers
          .entry(self.tab_id.clone())
          .or_default()
          .push(data.to_string());
      }
    }
  }
}

#[async_trait::async_trait]
impl Handler for SshHandler {
  type Error = SshError;

  async fn check_server_key(
    &mut self,
    _server_public_key: &russh_keys::key::PublicKey,
  ) -> Result<bool, Self::Error> {
    Ok(true)
  }

  async fn channel_open_confirmation(
    &mut self,
    _channel: ChannelId,
    max_packet_size: u32,
    window_size: u32,
    _session: &mut russh::client::Session,
  ) -> Result<(), Self::Error> {
    eprintln!("[russh] channel_open_confirmation max_packet={} window={}", max_packet_size, window_size);
    Ok(())
  }

  async fn channel_success(
    &mut self,
    _channel: ChannelId,
    _session: &mut russh::client::Session,
  ) -> Result<(), Self::Error> {
    eprintln!("[russh] channel_success (shell ready)");
    Ok(())
  }

  async fn data(
    &mut self,
    _channel: ChannelId,
    data: &[u8],
    _session: &mut russh::client::Session,
  ) -> Result<(), Self::Error> {
    let text = String::from_utf8_lossy(data);
    eprintln!("[russh data] {} bytes for tab={}: {:?}", data.len(), self.tab_id, &text[..text.len().min(80)]);
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

/// Read/write loop: session as param ensures it is not dropped early by async state machine
async fn run_session_loop(
  channel: Arc<tokio::sync::Mutex<russh::Channel<russh::client::Msg>>>,
  mut data_rx: tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>,
  mut shutdown_rx: tokio::sync::oneshot::Receiver<()>,
  session: russh::client::Handle<SshHandler>,
  tid: &str,
) {
  loop {
    // black_box prevents compiler from dropping session before .await
    black_box(&session);
    tokio::select! {
      Some(data) = data_rx.recv() => {
        black_box(&session);
        let mut ch = channel.lock().await;
        if let Err(e) = ch.data(data.as_slice()).await {
          eprintln!("[russh] write error for tab={}: {:?}", tid, e);
          break;
        }
      }
      _ = &mut shutdown_rx => {
        eprintln!("[russh] shutdown signal for tab={}", tid);
        let mut ch = channel.lock().await;
        let _ = ch.eof().await;
        break;
      }
      else => {
        eprintln!("[russh] data_rx closed for tab={}", tid);
        break;
      }
    }
  }
  drop(session);
}

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

  eprintln!("[connect] tab={} host={}:{} user={}", tab_id, host, port, username);

  // Send connecting message to output buffer (frontend polls via poll_output)
  {
    if let Ok(mut buffers) = state.output_buffers.lock() {
      buffers
        .entry(tab_id.clone())
        .or_default()
        .push(format!("Connecting to {}:{} as {} ...\r\n", host, port, username));
    }
  }

  // If session with same tab_id exists, disconnect old one first
  {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    if let Some(old_session) = sessions.remove(&tab_id) {
      eprintln!("[connect] removing old session for tab={}", tab_id);
      if let Some(tx) = old_session.shutdown_tx {
        let _ = tx.send(());
      }
      // Wait for old task cleanup (drop data_tx to exit old read/write loop)
      drop(old_session.data_tx);
    }
  }

  // Create channels: data_tx for input, shutdown_tx for disconnect
  let (data_tx, mut data_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
  let (shutdown_tx, mut shutdown_rx) = tokio::sync::oneshot::channel::<()>();

  // Background task: establish SSH connection and read/write loop
  {
    let app_handle = app.clone();
    let tid = tab_id.clone();
    let cfg = config.clone();

    tauri::async_runtime::spawn(async move {
      eprintln!("[russh] connecting to {}:{}", cfg.host, cfg.port);

      let emit_error = |app: &tauri::AppHandle, tid: &str, msg: &str| {
        if let Some(state) = app.try_state::<AppState>() {
          if let Ok(mut buffers) = state.output_buffers.lock() {
            buffers
              .entry(tid.to_string())
              .or_default()
              .push(format!("\u{1b}[31m{}\u{1b}[0m\r\n", msg));
          }
        }
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
          eprintln!("[russh] handshake error: {:?}", e);
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
            eprintln!("[russh] auth error: {:?}", e);
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
            eprintln!("[russh] key auth error: {:?}", e);
            emit_error(&app_handle, &tid, &format!("Key authentication error: {}", e));
            return;
          }
        }
      } else {
        emit_error(&app_handle, &tid, "No password or key provided");
        return;
      }

      eprintln!("[russh] authenticated, opening channel");

      // 3. Open channel + PTY + shell
      let channel = match handle.channel_open_session().await {
        Ok(ch) => {
          eprintln!("[russh] channel opened");
          ch
        }
        Err(e) => {
          emit_error(&app_handle, &tid, &format!("Failed to open channel: {}", e));
          return;
        }
      };

      let channel = Arc::new(tokio::sync::Mutex::new(channel));

      eprintln!("[russh] requesting PTY...");
      {
        let ch = channel.lock().await;
        if let Err(e) = ch.request_pty(true, "xterm-256color", 80, 24, 0, 0, &[]).await {
          emit_error(&app_handle, &tid, &format!("PTY request failed: {}", e));
          return;
        }
      }
      eprintln!("[russh] PTY allocated");

      eprintln!("[russh] requesting shell...");
      {
        let ch = channel.lock().await;
        if let Err(e) = ch.request_shell(true).await {
          emit_error(&app_handle, &tid, &format!("Shell request failed: {}", e));
          return;
        }
      }

      eprintln!("[russh] shell started for tab={}", tid);

      // Store channel Arc to session for resize use
      {
        if let Some(app_state) = app_handle.try_state::<AppState>() {
          if let Ok(mut sessions) = app_state.sessions.lock() {
            if let Some(session) = sessions.get_mut(&tid) {
              session.channel_arc = Some(channel.clone());
            }
          }
        }
      }

      // Push test message to output buffer to verify polling pipeline
      if let Some(state) = app_handle.try_state::<AppState>() {
        if let Ok(mut buffers) = state.output_buffers.lock() {
          buffers
            .entry(tid.clone())
            .or_default()
            .push("\r\n\x1b[33m=== SSH session ready ===\x1b[0m\r\n".to_string());
        }
      }
      eprintln!("[russh] test event pushed to buffer for tab={}", tid);

      // 4. Read/write loop (handle passed as param to keep alive until loop ends)
      run_session_loop(channel, data_rx, shutdown_rx, handle, &tid).await;

      eprintln!("[russh] disconnected for tab={}", tid);
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
        channel_arc: None,
      },
    );
  }

  eprintln!("[connect] returning connected for tab={}", tab_id);
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
  state: tauri::State<'_, AppState>,
  tab_id: String,
  cols: u32,
  rows: u32,
) -> Result<bool, String> {
  let channel = {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    sessions
      .get(&tab_id)
      .and_then(|s| s.channel_arc.clone())
      .ok_or("Session not found or channel not available")?
  };

  let mut ch = channel.lock().await;
  ch.window_change(rows, cols, 0, 0)
    .await
    .map_err(|e| format!("PTY resize failed: {}", e))?;

  Ok(true)
}

/// Frontend calls every 100ms to consume data chunks from output buffer
#[tauri::command]
pub async fn poll_output(
  state: tauri::State<'_, AppState>,
  tab_id: String,
) -> Result<Vec<String>, String> {
  let mut buffers = state.output_buffers.lock().map_err(|e| e.to_string())?;
  Ok(buffers.remove(&tab_id).unwrap_or_default())
}

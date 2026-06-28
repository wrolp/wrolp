use super::ssh_session::{
  AppState, ConnectionConfig, ConnectResult, FileEntry, SshError, SshHandler, SshSession,
};
use russh::client::{self, Handler};
use russh::ChannelId;
use russh_keys::load_secret_key;
use std::sync::Arc;
use std::hint::black_box;
use std::path::PathBuf;
use tauri::Manager;

/// Expand ~ to the user's home directory
fn expand_tilde(path: &str) -> PathBuf {
  if path.starts_with("~/") {
    if let Some(home) = dirs::home_dir() {
      home.join(&path[2..])
    } else {
      PathBuf::from(path)
    }
  } else if path == "~" {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("~"))
  } else {
    PathBuf::from(path)
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
    eprintln!("[russh] channel_open_confirmation max_packet={} window_size={}", max_packet_size, window_size);
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
    if !self.is_sftp {
      let text = String::from_utf8_lossy(data);
      eprintln!("[russh data] {} bytes for tab={}: {:?}", data.len(), self.tab_id, &text[..text.len().min(80)]);
      self.emit(&text);
    }
    Ok(())
  }

  async fn extended_data(
    &mut self,
    _channel: ChannelId,
    _code: u32,
    data: &[u8],
    _session: &mut russh::client::Session,
  ) -> Result<(), Self::Error> {
    if !self.is_sftp {
      // stderr → display in yellow
      let text = String::from_utf8_lossy(data);
      self.emit(&format!("\u{1b}[33m{}\u{1b}[0m", text));
    }
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

pub(crate) fn get_window_config_path() -> Option<std::path::PathBuf> {
  get_data_dir().map(|p| p.join("window.json"))
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

/// I/O loop: session passed as parameter to prevent premature drop by async state machine
async fn run_session_loop(
  channel: Arc<tokio::sync::Mutex<russh::Channel<russh::client::Msg>>>,
  mut data_rx: tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>,
  mut shutdown_rx: tokio::sync::oneshot::Receiver<()>,
  session: russh::client::Handle<SshHandler>,
  tid: u32,
) {
  loop {
    black_box(&session);
    tokio::select! {
      Some(data) = data_rx.recv() => {
        black_box(&session);
        let ch = channel.lock().await;
        if let Err(e) = ch.data(data.as_slice()).await {
          eprintln!("[russh] write error for tab={}: {:?}", tid, e);
          break;
        }
      }
      _ = &mut shutdown_rx => {
        eprintln!("[russh] shutdown signal for tab={}", tid);
        let ch = channel.lock().await;
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
  tab_id: u32,
  cols: u32,
  rows: u32,
) -> Result<ConnectResult, String> {
  let host = config.host.clone();
  let port = config.port;
  let username = config.username.clone();

  eprintln!("[connect] tab={} host={}:{} user={}", tab_id, host, port, username);

  // Push "connecting" message to output buffer
  {
    if let Ok(mut buffers) = state.output_buffers.lock() {
      buffers
        .entry(tab_id)
        .or_default()
        .push(format!("Connecting to {}:{} as {} ...\r\n", host, port, username));
    }
  }

  // If an existing session with the same tab_id exists, disconnect it first
  {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    if let Some(old_session) = sessions.get_mut(&tab_id) {
      eprintln!("[connect] removing old session for tab={}", tab_id);
      if let Some(tx) = old_session.shutdown_tx.take() {
        let _ = tx.send(());
      }
      drop(old_session.data_tx.take());
    }
  }

  // Create channels
  let (data_tx, data_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
  let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();

  // Background task: establish SSH connection and run I/O loop
  {
    let app_handle = app.clone();
    let tid = tab_id;
    let cfg = config.clone();

    tauri::async_runtime::spawn(async move {
      eprintln!("[russh] connecting to {}:{}", cfg.host, cfg.port);

      let emit_error = |app: &tauri::AppHandle, tid: u32, msg: &str| {
        if let Some(state) = app.try_state::<AppState>() {
          if let Ok(mut buffers) = state.output_buffers.lock() {
            buffers
              .entry(tid)
              .or_default()
              .push(format!("\u{1b}[31m{}\u{1b}[0m\r\n", msg));
          }
        }
      };

      // 1. Establish SSH connection
      let handler = SshHandler {
        app_handle: app_handle.clone(),
        tab_id: tid,
        is_sftp: false,
      };
      let ssh_config = Arc::new(client::Config::default());

      let mut handle = match client::connect(ssh_config, (cfg.host.as_str(), cfg.port), handler).await {
        Ok(h) => h,
        Err(e) => {
          eprintln!("[russh] handshake error: {:?}", e);
          emit_error(&app_handle, tid, &format!("SSH handshake failed: {}", e));
          return;
        }
      };

      // 2. Authenticate
      if let Some(ref pw) = cfg.password {
        match handle.authenticate_password(&cfg.username, pw).await {
          Ok(true) => {}
          Ok(false) => {
            emit_error(&app_handle, tid, "Authentication failed: wrong password");
            return;
          }
          Err(e) => {
            eprintln!("[russh] auth error: {:?}", e);
            emit_error(&app_handle, tid, &format!("Authentication error: {}", e));
            return;
          }
        }
      } else if let Some(ref key_path) = cfg.key_path {
        let resolved_path = expand_tilde(key_path);
        eprintln!("[russh] loading key: {} (resolved: {:?})", key_path, resolved_path);
        let key = match load_secret_key(&resolved_path, cfg.passphrase.as_deref()) {
          Ok(k) => k,
          Err(e) => {
            emit_error(&app_handle, tid, &format!("Failed to load key '{}': {}", key_path, e));
            return;
          }
        };
        match handle.authenticate_publickey(&cfg.username, Arc::new(key)).await {
          Ok(true) => {}
          Ok(false) => {
            emit_error(&app_handle, tid, "Authentication failed: invalid key");
            return;
          }
          Err(e) => {
            eprintln!("[russh] key auth error: {:?}", e);
            emit_error(&app_handle, tid, &format!("Key authentication error: {}", e));
            return;
          }
        }
      } else {
        emit_error(&app_handle, tid, "No password or key provided");
        return;
      }

      eprintln!("[russh] authenticated, opening channel");

      // 3. Open channel + request PTY + start shell
      let channel = match handle.channel_open_session().await {
        Ok(ch) => {
          eprintln!("[russh] channel opened");
          ch
        }
        Err(e) => {
          emit_error(&app_handle, tid, &format!("Failed to open channel: {}", e));
          return;
        }
      };

      let channel = Arc::new(tokio::sync::Mutex::new(channel));

      eprintln!("[russh] requesting PTY...");
      {
        let ch = channel.lock().await;
        if let Err(e) = ch.request_pty(true, "xterm-256color", cols, rows, 0, 0, &[]).await {
          emit_error(&app_handle, tid, &format!("PTY request failed: {}", e));
          return;
        }
      }
      eprintln!("[russh] PTY allocated");

      eprintln!("[russh] requesting shell...");
      {
        let ch = channel.lock().await;
        if let Err(e) = ch.request_shell(true).await {
          emit_error(&app_handle, tid, &format!("Shell request failed: {}", e));
          return;
        }
      }

      eprintln!("[russh] shell started for tab={}", tid);

      // Store channel Arc in session for later resize
      {
        if let Some(app_state) = app_handle.try_state::<AppState>() {
          if let Ok(mut sessions) = app_state.sessions.lock() {
            if let Some(session) = sessions.get_mut(&tid) {
              session.channel_arc = Some(channel.clone());
            }
          }
        }
      }

      // Push ready message to output buffer
      if let Some(state) = app_handle.try_state::<AppState>() {
        if let Ok(mut buffers) = state.output_buffers.lock() {
          buffers
            .entry(tid)
            .or_default()
            .push("\r\n\x1b[33m=== SSH session ready ===\x1b[0m\r\n".to_string());
        }
      }
      eprintln!("[russh] test event pushed to buffer for tab={}", tid);

      // 4. Run I/O loop
      run_session_loop(channel, data_rx, shutdown_rx, handle, tid).await;

      eprintln!("[russh] disconnected for tab={}", tid);
    });
  }

  // Save session to state — session_handle stored earlier in the spawned task
  // For SFTP, we reconnect/create channels from the handle stored per-session.
  // The handle is cloned before spawning so it stays alive.
  {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    sessions.insert(
      tab_id,
      SshSession {
        tab_id,
        config: config.clone(),
        data_tx: Some(data_tx),
        shutdown_tx: Some(shutdown_tx),
        channel_arc: None,
        session_handle: None, // SFTP reconnects via fresh auth per operation
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
  tab_id: u32,
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
  tab_id: u32,
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
  tab_id: u32,
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

  let ch = channel.lock().await;
  ch.window_change(cols, rows, 0, 0)
    .await
    .map_err(|e| format!("PTY resize failed: {}", e))?;

  Ok(true)
}

/// Called by frontend every 100ms to consume buffered output chunks
#[tauri::command]
pub async fn poll_output(
  state: tauri::State<'_, AppState>,
  tab_id: u32,
) -> Result<Vec<String>, String> {
  let mut buffers = state.output_buffers.lock().map_err(|e| e.to_string())?;
  Ok(buffers.remove(&tab_id).unwrap_or_default())
}

// ==================== SFTP File Operations ====================

/// Helper: clone config stored in session and establish a fresh SFTP connection
async fn open_sftp_session(
  state: &tauri::State<'_, AppState>,
  app: &tauri::AppHandle,
  tab_id: u32,
) -> Result<russh_sftp::client::SftpSession, String> {
  let config = {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    sessions
      .get(&tab_id)
      .ok_or("Session not found")?
      .config
      .clone()
  };

  let ssh_config = Arc::new(client::Config::default());
  let handler = SshHandler {
    app_handle: app.clone(),
    tab_id,
    is_sftp: true,
  };

  let mut handle = client::connect(ssh_config, (config.host.as_str(), config.port), handler)
    .await
    .map_err(|e| format!("SFTP connect failed: {}", e))?;

  // Authenticate
  if let Some(ref pw) = config.password {
    if !handle.authenticate_password(&config.username, pw).await.map_err(|e| format!("Auth error: {}", e))? {
      return Err("Authentication failed".into());
    }
  } else if let Some(ref key_path) = config.key_path {
    let resolved_path = expand_tilde(key_path);
    let key = load_secret_key(&resolved_path, config.passphrase.as_deref())
      .map_err(|e| format!("Failed to load key '{}': {}", key_path, e))?;
    if !handle.authenticate_publickey(&config.username, Arc::new(key)).await.map_err(|e| format!("Key auth error: {}", e))? {
      return Err("Key authentication failed".into());
    }
  } else {
    return Err("No credentials provided".into());
  }

  // Open SFTP channel
  let channel = handle
    .channel_open_session()
    .await
    .map_err(|e| format!("Failed to open SFTP channel: {}", e))?;

  let ch = channel;
  ch.request_subsystem(true, "sftp")
    .await
    .map_err(|e| format!("Failed to request SFTP subsystem: {}", e))?;

  let sftp = russh_sftp::client::SftpSession::new(ch.into_stream())
    .await
    .map_err(|e| format!("Failed to start SFTP session: {}", e))?;

  // Spawn a task to keep `handle` alive
  tauri::async_runtime::spawn(async move {
    let _h = handle;
    std::future::pending::<()>().await;
  });

  Ok(sftp)
}

#[tauri::command]
pub async fn list_files(
  app: tauri::AppHandle,
  state: tauri::State<'_, AppState>,
  tab_id: u32,
  path: String,
) -> Result<Vec<FileEntry>, String> {
  let sftp = open_sftp_session(&state, &app, tab_id).await?;

  let entries = sftp
    .read_dir(&path)
    .await
    .map_err(|e| format!("Failed to list directory: {}", e))?;

  let mut files: Vec<FileEntry> = Vec::new();
  for entry in entries {
    let name = entry.file_name();
    let metadata = entry.metadata();
    let is_dir = metadata.is_dir();
    let full_path = if path.ends_with('/') {
      format!("{}{}", path, name)
    } else {
      format!("{}/{}", path, name)
    };
    let modified = metadata
      .modified()
      .map(|t| {
        t.duration_since(std::time::UNIX_EPOCH)
          .map(|d| d.as_secs().to_string())
          .unwrap_or_default()
      })
      .unwrap_or_default();
    files.push(FileEntry {
      name,
      path: full_path,
      is_dir,
      size: metadata.size.unwrap_or(0),
      mode: format!("{:o}", metadata.permissions.unwrap_or(0)),
      modified,
    });
  }

  // Sort: directories first, then alphabetical
  files.sort_by(|a, b| {
    b.is_dir
      .cmp(&a.is_dir)
      .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
  });

  Ok(files)
}

#[tauri::command]
pub async fn download_file(
  app: tauri::AppHandle,
  state: tauri::State<'_, AppState>,
  tab_id: u32,
  remote_path: String,
  local_path: String,
) -> Result<bool, String> {
  let sftp = open_sftp_session(&state, &app, tab_id).await?;

  // Read entire remote file at once
  let data = sftp
    .read(&remote_path)
    .await
    .map_err(|e| format!("Failed to read remote file: {}", e))?;

  // Write to local file
  if let Some(parent) = std::path::Path::new(&local_path).parent() {
    let _ = tokio::fs::create_dir_all(parent).await;
  }
  tokio::fs::write(&local_path, data)
    .await
    .map_err(|e| format!("Failed to write local file: {}", e))?;

  Ok(true)
}

#[tauri::command]
pub async fn upload_file(
  app: tauri::AppHandle,
  state: tauri::State<'_, AppState>,
  tab_id: u32,
  local_path: String,
  remote_path: String,
) -> Result<bool, String> {
  let sftp = open_sftp_session(&state, &app, tab_id).await?;

  // Resolve relative paths to absolute paths
  let resolved_path = resolve_sftp_path(&sftp, &remote_path).await?;

  // Read local file
  let data = tokio::fs::read(&local_path)
    .await
    .map_err(|e| format!("Failed to read local file: {}", e))?;

  // Ensure parent directory exists on remote (using mkdir -p via SFTP)
  if let Some(parent) = std::path::Path::new(&resolved_path).parent() {
    let parent_str = parent.to_string_lossy().to_string();
    
    if !parent_str.is_empty() && parent_str != "/" {
      // Try to create directory (ignore error if already exists)
      match sftp.metadata(&parent_str).await {
        Err(_) => {
          // Directory doesn't exist, try creating it
          // Use a simple approach: try create with parents
          let _ = sftp.create_dir(&parent_str).await;
          
          // Also try the individual path components
          let parts: Vec<&str> = parent_str.trim_start_matches('/').split('/').collect();
          let mut build = String::new();
          for part in &parts {
            if part.is_empty() { continue; }
            if build.is_empty() { build.push('/'); } else { build.push('/'); }
            build.push_str(part);
            let _ = sftp.create_dir(&build).await;
          }
        }
        Ok(_) => {}
      }
    }
  }

  // Write using open + write (more reliable than direct write)
  let mut file = sftp
    .create(&resolved_path)
    .await
    .map_err(|e| format!("Failed to create remote file '{}': {}", resolved_path, e))?;

  use tokio::io::AsyncWriteExt;
  file
    .write_all(&data)
    .await
    .map_err(|e| format!("Failed to write data to '{}': {}", resolved_path, e))?;

  // File is closed on drop

  Ok(true)
}

/// Resolve SFTP path: convert relative paths (., ~, etc.) to absolute paths
async fn resolve_sftp_path(
  sftp: &russh_sftp::client::SftpSession,
  path: &str,
) -> Result<String, String> {
  // If path starts with /, it's already absolute
  if path.starts_with('/') {
    return Ok(path.to_string());
  }

  // Try to get real path of . (current working directory)
  let cwd = sftp.canonicalize(".").await.unwrap_or_else(|_| "/".to_string());

  // Handle . or empty
  if path == "." || path.is_empty() {
    return Ok(cwd);
  }

  let clean_path = path.trim_start_matches('.').trim_start_matches('/');
  if clean_path.is_empty() {
    return Ok(cwd);
  }
  
  let result = format!("{}/{}", cwd.trim_end_matches('/'), clean_path);
  println!("[resolve_sftp_path] '{}' -> '{}'", path, result);
  
  Ok(result)
}

/// Upload file content as raw bytes (for HTML5 drag-drop where we have File data, not paths)
#[tauri::command]
pub async fn upload_file_bytes(
  app: tauri::AppHandle,
  state: tauri::State<'_, AppState>,
  tab_id: u32,
  remote_path: String,
  file_data: Vec<u8>,
) -> Result<bool, String> {
  let sftp = open_sftp_session(&state, &app, tab_id).await?;

  // Resolve relative paths to absolute paths
  let resolved_path = resolve_sftp_path(&sftp, &remote_path).await?;

  // Ensure parent directory exists on remote
  if let Some(parent) = std::path::Path::new(&resolved_path).parent() {
    let parent_str = parent.to_string_lossy().to_string();
    if !parent_str.is_empty() && parent_str != "/" {
      match sftp.metadata(&parent_str).await {
        Err(_) => {
          let _ = sftp.create_dir(&parent_str).await;
          let parts: Vec<&str> = parent_str.trim_start_matches('/').split('/').collect();
          let mut build = String::new();
          for part in &parts {
            if part.is_empty() { continue; }
            build.push('/');
            build.push_str(part);
            let _ = sftp.create_dir(&build).await;
          }
        }
        Ok(_) => {}
      }
    }
  }

  let mut file = sftp
    .create(&resolved_path)
    .await
    .map_err(|e| format!("Failed to create remote file '{}': {}", resolved_path, e))?;

  use tokio::io::AsyncWriteExt;
  file
    .write_all(&file_data)
    .await
    .map_err(|e| format!("Failed to write data to '{}': {}", resolved_path, e))?;

  Ok(true)
}

#[tauri::command]
pub async fn file_exists(
  app: tauri::AppHandle,
  state: tauri::State<'_, AppState>,
  tab_id: u32,
  path: String,
) -> Result<bool, String> {
  let sftp = open_sftp_session(&state, &app, tab_id).await?;

  match sftp.metadata(&path).await {
    Ok(_) => Ok(true),
    Err(_) => Ok(false),
  }
}

#[tauri::command]
pub async fn create_directory(
  app: tauri::AppHandle,
  state: tauri::State<'_, AppState>,
  tab_id: u32,
  path: String,
) -> Result<bool, String> {
  let sftp = open_sftp_session(&state, &app, tab_id).await?;

  sftp
    .create_dir(&path)
    .await
    .map_err(|e| format!("Failed to create directory: {}", e))?;

  Ok(true)
}

#[tauri::command]
pub async fn rename_file(
  app: tauri::AppHandle,
  state: tauri::State<'_, AppState>,
  tab_id: u32,
  old_path: String,
  new_path: String,
) -> Result<bool, String> {
  let sftp = open_sftp_session(&state, &app, tab_id).await?;

  sftp
    .rename(&old_path, &new_path)
    .await
    .map_err(|e| format!("Failed to rename: {}", e))?;

  Ok(true)
}

#[tauri::command]
pub async fn delete_file(
  app: tauri::AppHandle,
  state: tauri::State<'_, AppState>,
  tab_id: u32,
  path: String,
  is_dir: bool,
) -> Result<bool, String> {
  let sftp = open_sftp_session(&state, &app, tab_id).await?;

  if is_dir {
    sftp
      .remove_dir(&path)
      .await
      .map_err(|e| format!("Failed to delete directory: {}", e))?;
  } else {
    sftp
      .remove_file(&path)
      .await
      .map_err(|e| format!("Failed to delete file: {}", e))?;
  }

  Ok(true)
}

// ==================== Window Config Persistence ====================

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct WindowConfig {
  pub x: i32,
  pub y: i32,
  pub width: u32,
  pub height: u32,
  pub maximized: bool,
  pub opacity: f64,
}

impl Default for WindowConfig {
  fn default() -> Self {
    Self { x: i32::MAX, y: i32::MAX, width: 1100, height: 700, maximized: false, opacity: 1.0 }
  }
}

#[tauri::command]
pub async fn save_window_config(config: WindowConfig) -> Result<(), String> {
  let path = get_window_config_path()
    .ok_or("Cannot determine config directory")?;
  if let Some(parent) = path.parent() {
    let _ = tokio::fs::create_dir_all(parent).await;
  }
  let content = serde_json::to_string_pretty(&config)
    .map_err(|e| e.to_string())?;
  tokio::fs::write(&path, content)
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn load_window_config() -> Result<WindowConfig, String> {
  let path = get_window_config_path()
    .ok_or("Cannot determine config directory")?;
  if !path.exists() {
    return Ok(WindowConfig::default());
  }
  let content = tokio::fs::read_to_string(&path)
    .await
    .map_err(|e| format!("Failed to read window config: {}", e))?;
  serde_json::from_str::<WindowConfig>(&content)
    .map_err(|e| format!("Failed to parse window config: {}", e))
}

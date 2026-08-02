use super::ssh_session::{
  AppState, ConnectionConfig, ConnectResult, ContainerInfo, FileEntry, SshError, SshHandler, SshSession, SwitchedUser,
  TargetRef, TransferControl, ActiveRecording,
};
use crate::db::{self, CommandSetDto, SessionEventDto, SessionSummary};
use crate::remote_fs::build_fs;
use russh::client::{self, Handler};
use russh::ChannelId;
use russh_keys::load_secret_key;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::path::PathBuf;
use tauri::Manager;
use tauri::Emitter;
use tokio::io::AsyncReadExt;
use uuid::Uuid;
use encoding_rs::{Encoding, UTF_8};

/// Wait if the transfer for this tab is paused. Returns immediately if not paused.
async fn check_pause(control: &TransferControl) {
  loop {
    if !control.paused.load(Ordering::SeqCst) {
      return;
    }
    control.notify.notified().await;
  }
}

/// RAII guard to remove transfer control from state on drop
struct TransferGuard {
  state_ptr: *const AppState,
  tab_id: u32,
}
// Safety: AppState is managed by Tauri and lives for the app lifetime
unsafe impl Send for TransferGuard {}

impl Drop for TransferGuard {
  fn drop(&mut self) {
    // Safety: state_ptr is valid because Tauri state outlives commands
    let state = unsafe { &*self.state_ptr };
    if let Ok(mut controls) = state.transfer_controls.lock() {
      controls.remove(&self.tab_id);
    }
  }
}

/// Expand ~ to the user's home directory
pub(crate) fn expand_tilde(path: &str) -> PathBuf {
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
    channel: ChannelId,
    max_packet_size: u32,
    window_size: u32,
    _session: &mut russh::client::Session,
  ) -> Result<(), Self::Error> {
    // The first opened channel is the interactive PTY shell. Remember its id so
    // data/extended_data can suppress output from auxiliary channels (docker
    // exec, ProxyJump) opened later on the same connection. Don't overwrite.
    if self.shell_channel_id.is_none() {
      self.shell_channel_id = Some(channel);
    }
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
    channel: ChannelId,
    data: &[u8],
    _session: &mut russh::client::Session,
  ) -> Result<(), Self::Error> {
    if !self.is_sftp && self.is_shell_channel(channel) {
      let text = String::from_utf8_lossy(data);
      self.emit(&text);
      self.record_event("output", &text);
    }
    Ok(())
  }

  async fn extended_data(
    &mut self,
    channel: ChannelId,
    _code: u32,
    data: &[u8],
    _session: &mut russh::client::Session,
  ) -> Result<(), Self::Error> {
    if !self.is_sftp && self.is_shell_channel(channel) {
      // stderr → display in yellow
      let text = String::from_utf8_lossy(data);
      let formatted = format!("\u{1b}[33m{}\u{1b}[0m", text);
      self.emit(&formatted);
      self.record_event("output", &text);
    }
    Ok(())
  }
}

// ==================== Data Persistence ====================

fn get_data_dir() -> Option<std::path::PathBuf> {
  dirs::config_dir().map(|p| p.join("wrolp-terminal"))
}

fn get_connections_path() -> Option<std::path::PathBuf> {
  get_data_dir().map(|p| p.join("connections.json"))
}

/// Persist the current connections list to disk in the encrypted format.
async fn persist_connections(state: &tauri::State<'_, AppState>) -> Result<(), String> {
  let path = get_connections_path();
  if let Some(ref path) = path {
    let all_conns = state.connections.lock().map_err(|e| e.to_string())?;
    crate::ssh_session::write_encrypted_connections(path, &all_conns)?;
  }
  Ok(())
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

  persist_connections(&state).await?;
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
    persist_connections(&state).await?;
  }

  Ok(deleted)
}

/// Reorder connections by the given ordered list of IDs.
/// Optionally update the `group` field for specific connections
/// (used when dragging a connection into a different group).
#[tauri::command]
pub async fn reorder_connections(
  state: tauri::State<'_, AppState>,
  ordered_ids: Vec<String>,
  group_updates: Option<std::collections::HashMap<String, String>>,
) -> Result<bool, String> {
  {
    let mut connections = state.connections.lock().map_err(|e| e.to_string())?;

    // Apply group overrides (empty string = ungrouped / None)
    if let Some(ref updates) = group_updates {
      for conn in connections.iter_mut() {
        if let Some(new_group) = updates.get(&conn.id) {
          conn.group = if new_group.is_empty() { None } else { Some(new_group.clone()) };
        }
      }
    }

    // Sort by the new order; connections not in ordered_ids stay at the end
    let order_map: std::collections::HashMap<&String, usize> = ordered_ids
      .iter()
      .enumerate()
      .map(|(i, id)| (id, i))
      .collect();
    connections.sort_by_key(|c| order_map.get(&c.id).copied().unwrap_or(usize::MAX));
  }

  // Persist
  persist_connections(&state).await?;

  Ok(true)
}

/// Rename a group: updates the `group` field of every connection in that group.
#[tauri::command]
pub async fn rename_group(
  state: tauri::State<'_, AppState>,
  old_name: String,
  new_name: String,
) -> Result<bool, String> {
  let changed = {
    let mut connections = state.connections.lock().map_err(|e| e.to_string())?;
    let new = new_name.trim().to_string();
    let mut any = false;
    for conn in connections.iter_mut() {
      if conn.group.as_deref() == Some(old_name.as_str()) {
        conn.group = if new.is_empty() { None } else { Some(new.clone()) };
        any = true;
      }
    }
    any
  };

  if changed {
    persist_connections(&state).await?;
  }
  Ok(changed)
}

/// Delete a group: ungroup all connections that belong to it (the connections
/// themselves are kept, just moved out of the group).
#[tauri::command]
pub async fn delete_group(
  state: tauri::State<'_, AppState>,
  group_name: String,
) -> Result<bool, String> {
  let changed = {
    let mut connections = state.connections.lock().map_err(|e| e.to_string())?;
    let mut any = false;
    for conn in connections.iter_mut() {
      if conn.group.as_deref() == Some(group_name.as_str()) {
        conn.group = None;
        any = true;
      }
    }
    any
  };

  if changed {
    persist_connections(&state).await?;
  }
  Ok(changed)
}

// ==================== SSH Connection (russh) ====================

/// I/O loop for the interactive PTY channel. The SSH `Handle` is kept alive in
/// `AppState.sessions[tab].session_handle` (see `connect`), so it is not owned here.
async fn run_session_loop(
  channel: Arc<tokio::sync::Mutex<russh::Channel<russh::client::Msg>>>,
  mut data_rx: tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>,
  mut shutdown_rx: tokio::sync::oneshot::Receiver<()>,
  tid: u32,
) {
  loop {
    tokio::select! {
      Some(data) = data_rx.recv() => {
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

  // Clear stale output for this tab from previous sessions
  {
    if let Ok(mut buffers) = state.output_buffers.lock() {
      buffers.remove(&tab_id);
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

  // Bump session version so stale tasks can detect they've been replaced
  let session_id = state.next_session_id.fetch_add(1, Ordering::SeqCst);

  // Background task: establish SSH connection and run I/O loop
  {
    let app_handle = app.clone();
    let tid = tab_id;
    let cfg = config.clone();

    tauri::async_runtime::spawn(async move {
      eprintln!("[russh] connecting to {}:{}", cfg.host, cfg.port);

      // Push "connecting" message — only if this session is still current
      if let Some(s) = app_handle.try_state::<AppState>() {
        if let Ok(sessions) = s.sessions.lock() {
          if sessions.get(&tid).map_or(false, |s| s.session_id == session_id) {
            if let Ok(mut buf) = s.output_buffers.lock() {
              buf.entry(tid).or_default()
                .push(format!("Connecting to {}:{} as {} ...\r\n", cfg.host, cfg.port, cfg.username));
            }
          }
        }
      }

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
        shell_channel_id: None,
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

      // Store channel Arc (for resize) and the shared session handle (for
      // ProxyJump / docker exec on secondary targets) in the session.
      {
        if let Some(app_state) = app_handle.try_state::<AppState>() {
          if let Ok(mut sessions) = app_state.sessions.lock() {
            if let Some(session) = sessions.get_mut(&tid) {
              session.channel_arc = Some(channel.clone());
              session.session_handle = Some(Arc::new(handle));
            }
          }
        }
      }

      // Push ready message to output buffer — only if this session is still current
      if let Some(state) = app_handle.try_state::<AppState>() {
        if let Ok(sessions) = state.sessions.lock() {
          if sessions.get(&tid).map_or(false, |s| s.session_id == session_id) {
            if let Ok(mut buffers) = state.output_buffers.lock() {
              buffers
                .entry(tid)
                .or_default()
                .push("\r\n\x1b[33m=== SSH session ready ===\x1b[0m\r\n".to_string());
            }
          }
        }
      }
      eprintln!("[russh] test event pushed to buffer for tab={}", tid);

      // 4. Run I/O loop (handle kept alive in AppState.session_handle)
      run_session_loop(channel, data_rx, shutdown_rx, tid).await;

      eprintln!("[russh] disconnected for tab={}", tid);

      // Finalize recording — only if this session hasn't been replaced
      if let Some(app_state) = app_handle.try_state::<AppState>() {
        let rec_to_finalize = {
          if let Ok(mut recordings) = app_state.recordings.lock() {
            let is_ours = recordings
              .get(&tid)
              .map_or(false, |r| r.session_version == session_id);
            if is_ours {
              recordings.remove(&tid)
            } else {
              None
            }
          } else {
            None
          }
        };
        if let Some(rec) = rec_to_finalize {
          if let Ok(conn) = app_state.db.lock() {
            let _ = db::insert_events(&conn, &rec.session_id, &rec.events);
            let ended_at = chrono::Utc::now().to_rfc3339();
            let duration = rec.started_at.elapsed().as_secs() as i64;
            let db_count = db::count_session_events(&conn, &rec.session_id).unwrap_or(0);
            let _ = db::finalize_session(&conn, &rec.session_id, &ended_at, duration, db_count);
          }
        }
      }

      // Notify frontend that connection closed, but only if this session hasn't been replaced
      if let Some(app_state) = app_handle.try_state::<AppState>() {
        if let Ok(sessions) = app_state.sessions.lock() {
          if let Some(s) = sessions.get(&tid) {
            if s.session_id == session_id {
              let _ = app_handle.emit("connection-closed", serde_json::json!({
                "tabId": tid,
              }));
            } else {
              eprintln!("[russh] session_id changed for tab={}, skipping stale event", tid);
            }
          }
        }
      }
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
        switched_sftp_user: None,
        session_id,
      },
    );
  }

  // Create session recording entry
  {
    // Finalize any previous recording for this tab (reconnection case)
    let old_recording = {
      if let Ok(mut recordings) = state.recordings.lock() {
        recordings.remove(&tab_id)
      } else {
        None
      }
    };
    if let Some(old_rec) = old_recording {
      if let Ok(conn) = state.db.lock() {
        let _ = db::insert_events(&conn, &old_rec.session_id, &old_rec.events);
        let ended_at = chrono::Utc::now().to_rfc3339();
        let duration = old_rec.started_at.elapsed().as_secs() as i64;
        let db_count = db::count_session_events(&conn, &old_rec.session_id).unwrap_or(0);
        let _ = db::finalize_session(
          &conn,
          &old_rec.session_id,
          &ended_at,
          duration,
          db_count,
        );
      }
    }

    let session_uuid = Uuid::new_v4().to_string();
    let now = chrono::Utc::now();
    let started_at_iso = now.to_rfc3339();
    let recording_enabled = std::env::var("WROLP_RECORDING")
      .map(|v| v != "0" && v != "false")
      .unwrap_or(true);

    // Insert session record into SQLite
    if let Ok(conn) = state.db.lock() {
      let _ = db::create_session(
        &conn,
        &session_uuid,
        &config.id,
        &config.name,
        tab_id,
        &started_at_iso,
      );
    }

    // Create in-memory recording buffer
    let recording = ActiveRecording {
      session_id: session_uuid,
      session_version: session_id,
      connection_id: config.id.clone(),
      connection_name: config.name.clone(),
      started_at: std::time::Instant::now(),
      started_at_iso,
      seq_counter: 0,
      events: Vec::new(),
      recording_enabled,
    };
    if let Ok(mut recordings) = state.recordings.lock() {
      recordings.insert(tab_id, recording);
    }
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
    .send(data.clone().into_bytes())
    .map_err(|e| format!("Failed to send input: {}", e))?;

  // Record input event
  if let Ok(mut recordings) = state.recordings.lock() {
    if let Some(rec) = recordings.get_mut(&tab_id) {
      if rec.recording_enabled {
        let seq = rec.seq_counter;
        rec.seq_counter += 1;
        let elapsed = rec.started_at.elapsed().as_millis() as u64;
        rec.events.push(db::RecordedEvent {
          seq,
          timestamp_ms: elapsed,
          direction: "input".to_string(),
          content: data,
        });
      }
    }
  }

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

/// Helper: establish a fresh SFTP connection for a tab's main session.
/// Delegates to the shared implementation in `remote_fs`.
async fn open_sftp_session(
  state: &tauri::State<'_, AppState>,
  app: &tauri::AppHandle,
  tab_id: u32,
) -> Result<russh_sftp::client::SftpSession, String> {
  crate::remote_fs::open_session_sftp(state, app, tab_id).await
}

/// Poll the remote working directory via a dedicated exec channel.
///
/// Opens a fresh SSH connection (like SFTP operations do) so it never
/// interferes with the interactive PTY. Used by the SFTP ↔ Shell sync feature
/// to keep the file panel in step with `cd` commands typed in the terminal.
#[tauri::command]
pub async fn poll_working_dir(
  app: tauri::AppHandle,
  state: tauri::State<'_, AppState>,
  tab_id: u32,
) -> Result<Option<String>, String> {
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
    shell_channel_id: None,
  };

  let mut handle = client::connect(ssh_config, (config.host.as_str(), config.port), handler)
    .await
    .map_err(|e| format!("Connect failed: {}", e))?;

  // Authenticate (reuse original config credentials — cwd should reflect the
  // logged-in user, not a switched SFTP user)
  if let Some(ref pw) = config.password {
    if !handle
      .authenticate_password(&config.username, pw)
      .await
      .map_err(|e| format!("Auth error: {}", e))?
    {
      return Err("Authentication failed".into());
    }
  } else if let Some(ref key_path) = config.key_path {
    let resolved = expand_tilde(key_path);
    let key = load_secret_key(&resolved, config.passphrase.as_deref())
      .map_err(|e| format!("Failed to load key: {}", e))?;
    if !handle
      .authenticate_publickey(&config.username, Arc::new(key))
      .await
      .map_err(|e| format!("Key auth error: {}", e))?
    {
      return Err("Key authentication failed".into());
    }
  } else {
    return Err("No credentials provided".into());
  }

  // Open a channel and exec `pwd`
  let mut channel = handle
    .channel_open_session()
    .await
    .map_err(|e| format!("Failed to open channel: {}", e))?;

  channel
    .exec(true, "pwd")
    .await
    .map_err(|e| format!("Failed to exec pwd: {}", e))?;

  let mut output = String::new();
  while let Some(msg) = channel.wait().await {
    match msg {
      russh::ChannelMsg::Data { data } => {
        output.push_str(&String::from_utf8_lossy(&data));
      }
      russh::ChannelMsg::ExitStatus { .. } | russh::ChannelMsg::Eof | russh::ChannelMsg::Close => {
        break;
      }
      _ => {}
    }
  }

  // Let the handle drop gracefully in the background
  tauri::async_runtime::spawn(async move {
    let _h = handle;
  });

  let path = output.trim();
  if path.is_empty() {
    Ok(None)
  } else {
    Ok(Some(path.to_string()))
  }
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

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
  pub path: String,
  pub content: String,
  pub size: u64,
  pub mode: String,
  pub is_binary: bool,
  pub is_too_large: bool,
  /// Charset used to decode the file, e.g. "utf-8" or "gbk".
  pub encoding: String,
  /// True when the file was not valid UTF-8 (e.g. GBK) and must be
  /// re-saved with `encoding` to avoid corrupting it.
  pub needs_encoding: bool,
}

/// Decode raw bytes into a String using the requested encoding, or auto-detect
/// (UTF-8 first, then GBK) when `encoding_name` is `None`.
/// Returns (content, encoding_name, needs_encoding).
fn decode_file_content(data: &[u8], encoding_name: Option<&str>) -> (String, String, bool) {
  if let Some(name) = encoding_name {
    let encoding: &Encoding = Encoding::for_label(name.as_bytes()).unwrap_or(UTF_8);
    let (cow, _, _had_errors) = encoding.decode(data);
    let needs = encoding.name() != "UTF-8";
    return (cow.into_owned(), encoding.name().to_ascii_lowercase(), needs);
  }

  // Auto-detect: prefer UTF-8, fall back to GBK.
  if let Ok(s) = String::from_utf8(data.to_vec()) {
    return (s, "utf-8".to_string(), false);
  }
  if let Some(gbk) = Encoding::for_label(b"gbk") {
    let (cow, _, had_errors) = gbk.decode(data);
    if !had_errors {
      return (cow.into_owned(), "gbk".to_string(), true);
    }
  }
  // Last resort: UTF-8 with replacement characters.
  let (cow, _, _) = UTF_8.decode(data);
  (cow.into_owned(), "utf-8".to_string(), false)
}

const DEFAULT_MAX_EDIT_SIZE: u64 = 5_000_000;

/// Read a remote file's content into memory for editing.
/// `is_binary`/`is_too_large` let the frontend refuse non-text or oversized files.
#[tauri::command]
pub async fn read_file_content(
  app: tauri::AppHandle,
  state: tauri::State<'_, AppState>,
  tab_id: u32,
  path: String,
  max_size: Option<u64>,
  encoding: Option<String>,
) -> Result<FileContent, String> {
  let max_size = max_size.unwrap_or(DEFAULT_MAX_EDIT_SIZE);
  let sftp = open_sftp_session(&state, &app, tab_id).await?;

  let metadata = sftp.metadata(&path).await
    .map_err(|e| format!("Failed to stat remote file: {}", e))?;
  let size = metadata.size.unwrap_or(0);
  let mode = format!("{:04o}", metadata.permissions.unwrap_or(0) & 0o7777);

  if size > max_size {
    return Ok(FileContent {
      path,
      content: String::new(),
      size,
      mode,
      is_binary: false,
      is_too_large: true,
      encoding: encoding.unwrap_or_else(|| "utf-8".to_string()),
      needs_encoding: false,
    });
  }

  let mut handle = sftp.open(&path).await
    .map_err(|e| format!("Failed to open remote file: {}", e))?;
  let mut all_data = Vec::with_capacity(size as usize);
  let mut buf = vec![0u8; 65536];
  loop {
    let n = handle.read(&mut buf).await
      .map_err(|e| format!("Failed to read: {}", e))?;
    if n == 0 {
      break;
    }
    all_data.extend_from_slice(&buf[..n]);
  }

  // NUL byte => treat as binary (not editable as text).
  // Invalid UTF-8 alone is no longer binary (it may be GBK and decodable).
  let is_binary = all_data.contains(&0);
  let (content, used_encoding, needs_encoding) = if is_binary {
    (String::new(), encoding.clone().unwrap_or_else(|| "utf-8".to_string()), false)
  } else {
    decode_file_content(&all_data, encoding.as_deref())
  };

  Ok(FileContent {
    path,
    content,
    size,
    mode,
    is_binary,
    is_too_large: false,
    encoding: used_encoding,
    needs_encoding,
  })
}

/// Write edited text content back to a remote file, overwriting the original.
/// The parent directory is created if it does not exist.
/// `encoding` selects the charset used to serialize the text (defaults to UTF-8).
#[tauri::command]
pub async fn write_file_content(
  app: tauri::AppHandle,
  state: tauri::State<'_, AppState>,
  tab_id: u32,
  path: String,
  content: String,
  encoding: Option<String>,
) -> Result<bool, String> {
  let sftp = open_sftp_session(&state, &app, tab_id).await?;

  // Serialize text using the requested charset (default UTF-8).
  let encoding_ref: &Encoding = Encoding::for_label(encoding.as_deref().unwrap_or("utf-8").as_bytes())
    .unwrap_or(UTF_8);
  let (bytes, _used_encoding, had_errors) = encoding_ref.encode(&content);
  if had_errors {
    return Err(format!("Content cannot be encoded as {}", encoding_ref.name()));
  }
  let bytes = bytes.into_owned();
  let resolved_path = resolve_sftp_path(&sftp, &path).await?;

  // Ensure parent directory exists on remote
  if let Some(parent) = std::path::Path::new(&resolved_path).parent() {
    let parent_str = parent.to_string_lossy().to_string();
    if !parent_str.is_empty() && parent_str != "/" {
      match sftp.metadata(&parent_str).await {
        Err(_) => {
          let parts: Vec<&str> = parent_str.trim_start_matches('/').split('/').collect();
          let mut build = String::new();
          for part in &parts {
            if part.is_empty() {
              continue;
            }
            build.push('/');
            build.push_str(part);
            let _ = sftp.create_dir(&build).await;
          }
        }
        Ok(_) => {}
      }
    }
  }

  let mut file = sftp.create(&resolved_path).await
    .map_err(|e| format!("Failed to create remote file '{}': {}", resolved_path, e))?;
  use tokio::io::AsyncWriteExt;
  file.write_all(&bytes).await
    .map_err(|e| format!("Failed to write data to '{}': {}", resolved_path, e))?;

  Ok(true)
}

#[tauri::command]
pub async fn download_file(
  app: tauri::AppHandle,
  state: tauri::State<'_, AppState>,
  tab_id: u32,
  remote_path: String,
  local_path: String,
) -> Result<bool, String> {
  // Set up pause control
  let control = Arc::new(TransferControl {
    paused: AtomicBool::new(false),
    notify: tokio::sync::Notify::new(),
  });
  {
    let mut controls = state.transfer_controls.lock().map_err(|e| e.to_string())?;
    controls.insert(tab_id, control.clone());
  }
  // Clean up control on exit
  let _cleanup = TransferGuard {
    state_ptr: &*state as *const AppState,
    tab_id,
  };

  let sftp = open_sftp_session(&state, &app, tab_id).await?;

  let filename = std::path::Path::new(&remote_path)
    .file_name()
    .map(|n| n.to_string_lossy().to_string())
    .unwrap_or_else(|| remote_path.clone());

  // Get total file size
  let metadata = sftp.metadata(&remote_path).await
    .map_err(|e| format!("Failed to stat remote file: {}", e))?;
  let total = metadata.size.unwrap_or(0);

  // Open file for chunked streaming read
  let mut file = sftp.open(&remote_path).await
    .map_err(|e| format!("Failed to open remote file: {}", e))?;

  let mut all_data = Vec::with_capacity(total as usize);
  let mut buf = vec![0u8; 65536];
  let start = std::time::Instant::now();
  let mut offset: u64 = 0;

  loop {
    // Check for pause before each chunk
    check_pause(&control).await;

    let n = file.read(&mut buf).await
      .map_err(|e| format!("Failed to read: {}", e))?;
    if n == 0 { break; }
    all_data.extend_from_slice(&buf[..n]);
    offset += n as u64;

    let _ = app.emit("transfer-progress", serde_json::json!({
      "tabId": tab_id,
      "op": "download",
      "filename": &filename,
      "transferred": offset,
      "total": total,
      "elapsed": start.elapsed().as_millis()
    }));
  }

  // Write to local file
  if let Some(parent) = std::path::Path::new(&local_path).parent() {
    let _ = tokio::fs::create_dir_all(parent).await;
  }
  tokio::fs::write(&local_path, &all_data)
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
  // Set up pause control
  let control = Arc::new(TransferControl {
    paused: AtomicBool::new(false),
    notify: tokio::sync::Notify::new(),
  });
  {
    let mut controls = state.transfer_controls.lock().map_err(|e| e.to_string())?;
    controls.insert(tab_id, control.clone());
  }
  let _cleanup = TransferGuard {
    state_ptr: &*state as *const AppState,
    tab_id,
  };

  let sftp = open_sftp_session(&state, &app, tab_id).await?;

  let filename = std::path::Path::new(&remote_path)
    .file_name()
    .map(|n| n.to_string_lossy().to_string())
    .unwrap_or_else(|| remote_path.clone());

  // Resolve relative paths to absolute paths
  let resolved_path = resolve_sftp_path(&sftp, &remote_path).await?;

  // Read local file
  let data = tokio::fs::read(&local_path)
    .await
    .map_err(|e| format!("Failed to read local file: {}", e))?;
  let total = data.len() as u64;

  // Ensure parent directory exists on remote (using mkdir -p via SFTP)
  if let Some(parent) = std::path::Path::new(&resolved_path).parent() {
    let parent_str = parent.to_string_lossy().to_string();
    
    if !parent_str.is_empty() && parent_str != "/" {
      // Try to create directory (ignore error if already exists)
      match sftp.metadata(&parent_str).await {
        Err(_) => {
          // Directory doesn't exist, try creating it
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

  // Write in chunks with progress
  let mut file = sftp
    .create(&resolved_path)
    .await
    .map_err(|e| format!("Failed to create remote file '{}': {}", resolved_path, e))?;

  use tokio::io::AsyncWriteExt;
  let start = std::time::Instant::now();
  let chunk_size: usize = 65536;
  let mut written: u64 = 0;

  for chunk in data.chunks(chunk_size) {
    check_pause(&control).await;
    file.write_all(chunk).await
      .map_err(|e| format!("Failed to write data to '{}': {}", resolved_path, e))?;
    written += chunk.len() as u64;

    let elapsed = start.elapsed().as_millis();
    let _ = app.emit("transfer-progress", serde_json::json!({
      "tabId": tab_id,
      "op": "upload",
      "filename": &filename,
      "transferred": written,
      "total": total,
      "elapsed": elapsed
    }));
  }

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
  // Set up pause control
  let control = Arc::new(TransferControl {
    paused: AtomicBool::new(false),
    notify: tokio::sync::Notify::new(),
  });
  {
    let mut controls = state.transfer_controls.lock().map_err(|e| e.to_string())?;
    controls.insert(tab_id, control.clone());
  }
  let _cleanup = TransferGuard {
    state_ptr: &*state as *const AppState,
    tab_id,
  };

  let sftp = open_sftp_session(&state, &app, tab_id).await?;

  let filename = std::path::Path::new(&remote_path)
    .file_name()
    .map(|n| n.to_string_lossy().to_string())
    .unwrap_or_else(|| remote_path.clone());

  let total = file_data.len() as u64;

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

  // Write in chunks with progress
  let mut file = sftp
    .create(&resolved_path)
    .await
    .map_err(|e| format!("Failed to create remote file '{}': {}", resolved_path, e))?;

  use tokio::io::AsyncWriteExt;
  let start = std::time::Instant::now();
  let chunk_size: usize = 65536;
  let mut written: u64 = 0;

  for chunk in file_data.chunks(chunk_size) {
    check_pause(&control).await;
    file.write_all(chunk).await
      .map_err(|e| format!("Failed to write data to '{}': {}", resolved_path, e))?;
    written += chunk.len() as u64;

    let elapsed = start.elapsed().as_millis();
    let _ = app.emit("transfer-progress", serde_json::json!({
      "tabId": tab_id,
      "op": "upload",
      "filename": &filename,
      "transferred": written,
      "total": total,
      "elapsed": elapsed
    }));
  }

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

// ==================== P6: Target-based file operations ====================
//
// These commands address any `TargetRef` (main session / ProxyJump remote /
// Docker container) and operate directly on that target. The `Session` variant
// reproduces the behaviour of the `tab_id` commands above.

#[tauri::command]
pub async fn target_list_files(
  app: tauri::AppHandle,
  state: tauri::State<'_, AppState>,
  target: TargetRef,
  path: String,
) -> Result<Vec<FileEntry>, String> {
  let fs = build_fs(&app, &state, &target).await?;
  fs.list_dir(&path).await
}

#[tauri::command]
pub async fn target_file_exists(
  app: tauri::AppHandle,
  state: tauri::State<'_, AppState>,
  target: TargetRef,
  path: String,
) -> Result<bool, String> {
  let fs = build_fs(&app, &state, &target).await?;
  Ok(fs.metadata(&path).await.is_ok())
}

#[tauri::command]
pub async fn target_create_directory(
  app: tauri::AppHandle,
  state: tauri::State<'_, AppState>,
  target: TargetRef,
  path: String,
) -> Result<bool, String> {
  let fs = build_fs(&app, &state, &target).await?;
  fs.create_dir(&path).await?;
  Ok(true)
}

#[tauri::command]
pub async fn target_rename_file(
  app: tauri::AppHandle,
  state: tauri::State<'_, AppState>,
  target: TargetRef,
  old_path: String,
  new_path: String,
) -> Result<bool, String> {
  let fs = build_fs(&app, &state, &target).await?;
  fs.rename(&old_path, &new_path).await?;
  Ok(true)
}

#[tauri::command]
pub async fn target_delete_file(
  app: tauri::AppHandle,
  state: tauri::State<'_, AppState>,
  target: TargetRef,
  path: String,
  is_dir: bool,
) -> Result<bool, String> {
  let fs = build_fs(&app, &state, &target).await?;
  if is_dir {
    fs.remove_dir(&path).await?;
  } else {
    fs.remove_file(&path).await?;
  }
  Ok(true)
}

#[tauri::command]
pub async fn target_read_file(
  app: tauri::AppHandle,
  state: tauri::State<'_, AppState>,
  target: TargetRef,
  path: String,
  max_size: Option<u64>,
  encoding: Option<String>,
) -> Result<FileContent, String> {
  let max_size = max_size.unwrap_or(DEFAULT_MAX_EDIT_SIZE);
  let fs = build_fs(&app, &state, &target).await?;

  let meta = fs
    .metadata(&path)
    .await
    .map_err(|e| format!("Failed to stat remote file: {}", e))?;
  let size = meta.size;
  let mode = meta.mode.clone();

  if size > max_size {
    return Ok(FileContent {
      path,
      content: String::new(),
      size,
      mode,
      is_binary: false,
      is_too_large: true,
      encoding: encoding.unwrap_or_else(|| "utf-8".to_string()),
      needs_encoding: false,
    });
  }

  let data = fs
    .read_file(&path)
    .await
    .map_err(|e| format!("Failed to read remote file: {}", e))?;

  let is_binary = data.contains(&0);
  let (content, used_encoding, needs_encoding) = if is_binary {
    (String::new(), encoding.clone().unwrap_or_else(|| "utf-8".to_string()), false)
  } else {
    decode_file_content(&data, encoding.as_deref())
  };

  Ok(FileContent {
    path,
    content,
    size,
    mode,
    is_binary,
    is_too_large: false,
    encoding: used_encoding,
    needs_encoding,
  })
}

#[tauri::command]
pub async fn target_write_file(
  app: tauri::AppHandle,
  state: tauri::State<'_, AppState>,
  target: TargetRef,
  path: String,
  content: String,
  encoding: Option<String>,
) -> Result<bool, String> {
  let fs = build_fs(&app, &state, &target).await?;

  let encoding_ref: &Encoding = Encoding::for_label(encoding.as_deref().unwrap_or("utf-8").as_bytes())
    .unwrap_or(UTF_8);
  let (bytes, _used, had_errors) = encoding_ref.encode(&content);
  if had_errors {
    return Err(format!("Content cannot be encoded as {}", encoding_ref.name()));
  }
  fs.write_file(&path, &bytes).await?;
  Ok(true)
}

#[tauri::command]
pub async fn target_download_file(
  app: tauri::AppHandle,
  state: tauri::State<'_, AppState>,
  target: TargetRef,
  remote_path: String,
  local_path: String,
) -> Result<bool, String> {
  let fs = build_fs(&app, &state, &target).await?;
  let data = fs
    .read_file(&remote_path)
    .await
    .map_err(|e| format!("Failed to read remote file: {}", e))?;
  if let Some(parent) = std::path::Path::new(&local_path).parent() {
    let _ = tokio::fs::create_dir_all(parent).await;
  }
  tokio::fs::write(&local_path, &data)
    .await
    .map_err(|e| format!("Failed to write local file: {}", e))?;
  Ok(true)
}

#[tauri::command]
pub async fn target_upload_file(
  app: tauri::AppHandle,
  state: tauri::State<'_, AppState>,
  target: TargetRef,
  local_path: String,
  remote_path: String,
) -> Result<bool, String> {
  let fs = build_fs(&app, &state, &target).await?;
  let data = tokio::fs::read(&local_path)
    .await
    .map_err(|e| format!("Failed to read local file: {}", e))?;
  fs.write_file(&remote_path, &data).await?;
  Ok(true)
}

#[tauri::command]
pub async fn target_upload_file_bytes(
  app: tauri::AppHandle,
  state: tauri::State<'_, AppState>,
  target: TargetRef,
  remote_path: String,
  file_data: Vec<u8>,
) -> Result<bool, String> {
  let fs = build_fs(&app, &state, &target).await?;
  fs.write_file(&remote_path, &file_data).await?;
  Ok(true)
}

/// List Docker containers reachable from a connected (jump host) tab.
#[tauri::command]
pub async fn list_docker_containers(
  state: tauri::State<'_, AppState>,
  jump_tab_id: u32,
) -> Result<Vec<ContainerInfo>, String> {
  let jump = crate::remote_fs::get_jump_handle(&state, jump_tab_id)?;
  crate::docker_fs::list_docker_containers(jump).await
}

// ==================== SFTP User Switching ====================

#[tauri::command]
pub async fn switch_sftp_user(
  state: tauri::State<'_, AppState>,
  tab_id: u32,
  username: String,
  password: String,
) -> Result<(), String> {
  let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
  let session = sessions.get_mut(&tab_id).ok_or("Session not found")?;
  session.switched_sftp_user = Some(SwitchedUser { username, password });
  Ok(())
}

#[tauri::command]
pub async fn revert_sftp_user(
  state: tauri::State<'_, AppState>,
  tab_id: u32,
) -> Result<(), String> {
  let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
  let session = sessions.get_mut(&tab_id).ok_or("Session not found")?;
  session.switched_sftp_user = None;
  Ok(())
}

#[tauri::command]
pub async fn get_sftp_user(
  state: tauri::State<'_, AppState>,
  tab_id: u32,
) -> Result<Option<String>, String> {
  let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
  let session = sessions.get(&tab_id).ok_or("Session not found")?;
  Ok(session.switched_sftp_user.as_ref().map(|su| su.username.clone()))
}

// ==================== Transfer Pause/Resume ====================

#[tauri::command]
pub async fn pause_transfer(
  state: tauri::State<'_, AppState>,
  tab_id: u32,
) -> Result<(), String> {
  let controls = state.transfer_controls.lock().map_err(|e| e.to_string())?;
  if let Some(ctrl) = controls.get(&tab_id) {
    ctrl.paused.store(true, Ordering::SeqCst);
  }
  Ok(())
}

#[tauri::command]
pub async fn resume_transfer(
  state: tauri::State<'_, AppState>,
  tab_id: u32,
) -> Result<(), String> {
  let controls = state.transfer_controls.lock().map_err(|e| e.to_string())?;
  if let Some(ctrl) = controls.get(&tab_id) {
    ctrl.paused.store(false, Ordering::SeqCst);
    ctrl.notify.notify_one();
  }
  Ok(())
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

// ==================== Workspace Layout ====================

/// Load the persisted workspace layout (Customizable panels).
/// Returns "{}" when no file exists so the frontend can apply its defaults.
#[tauri::command]
pub async fn load_layout(app: tauri::AppHandle) -> Result<String, String> {
  let dir = app
    .path()
    .app_config_dir()
    .map_err(|e| e.to_string())?;
  let path = dir.join("layout.json");
  if !path.exists() {
    return Ok(String::from("{}"));
  }
  tokio::fs::read_to_string(&path)
    .await
    .map_err(|e| e.to_string())
}

/// Persist the workspace layout as JSON to layout.json.
#[tauri::command]
pub async fn save_layout(app: tauri::AppHandle, layout: String) -> Result<(), String> {
  let dir = app
    .path()
    .app_config_dir()
    .map_err(|e| e.to_string())?;
  tokio::fs::create_dir_all(&dir)
    .await
    .map_err(|e| e.to_string())?;
  let path = dir.join("layout.json");
  tokio::fs::write(&path, layout)
    .await
    .map_err(|e| e.to_string())
}

// ==================== Session Recording ====================

/// Flush all in-memory recording buffers to SQLite. Called periodically by a
/// background task and on app shutdown.
pub fn flush_all_recordings(state: &AppState) {
  let mut to_flush: Vec<(String, Vec<db::RecordedEvent>)> = Vec::new();
  {
    if let Ok(mut recordings) = state.recordings.lock() {
      for rec in recordings.values_mut() {
        if rec.events.is_empty() {
          continue;
        }
        let drained = std::mem::take(&mut rec.events);
        to_flush.push((rec.session_id.clone(), drained));
      }
    }
  }
  if to_flush.is_empty() {
    return;
  }
  if let Ok(conn) = state.db.lock() {
    for (session_id, events) in to_flush {
      let _ = db::insert_events(&conn, &session_id, &events);
    }
  }
}

#[tauri::command]
pub async fn list_sessions(
  state: tauri::State<'_, AppState>,
  connection_id: Option<String>,
  limit: Option<u32>,
) -> Result<Vec<SessionSummary>, String> {
  let conn = state.db.lock().map_err(|e| e.to_string())?;
  db::list_sessions(&conn, connection_id.as_deref(), limit.unwrap_or(100))
}

#[tauri::command]
pub async fn get_session_events(
  state: tauri::State<'_, AppState>,
  session_id: String,
) -> Result<Vec<SessionEventDto>, String> {
  let conn = state.db.lock().map_err(|e| e.to_string())?;
  db::get_session_events(&conn, &session_id)
}

#[tauri::command]
pub async fn delete_session(
  state: tauri::State<'_, AppState>,
  session_id: String,
) -> Result<(), String> {
  let conn = state.db.lock().map_err(|e| e.to_string())?;
  db::delete_session(&conn, &session_id)
}

#[tauri::command]
pub async fn delete_all_sessions(
  state: tauri::State<'_, AppState>,
) -> Result<(), String> {
  let conn = state.db.lock().map_err(|e| e.to_string())?;
  db::delete_all_sessions(&conn)
}

#[tauri::command]
pub async fn rename_session(
  state: tauri::State<'_, AppState>,
  session_id: String,
  title: String,
) -> Result<(), String> {
  let conn = state.db.lock().map_err(|e| e.to_string())?;
  db::rename_session(&conn, &session_id, &title)
}

/// Record the full command line as submitted by the user. The text is captured
/// on the frontend from the terminal buffer at the moment Enter is pressed, which
/// preserves tab-completed text that is otherwise lost when only raw keystrokes
/// (`input` events, which contain literal `\t`) are recorded.
#[tauri::command]
pub async fn commit_command(
  state: tauri::State<'_, AppState>,
  tab_id: u32,
  command: String,
) -> Result<bool, String> {
  if let Ok(mut recordings) = state.recordings.lock() {
    if let Some(rec) = recordings.get_mut(&tab_id) {
      if rec.recording_enabled {
        let seq = rec.seq_counter;
        rec.seq_counter += 1;
        let elapsed = rec.started_at.elapsed().as_millis() as u64;
        rec.events.push(db::RecordedEvent {
          seq,
          timestamp_ms: elapsed,
          direction: "command".to_string(),
          content: command,
        });
      }
    }
  }
  Ok(true)
}

#[tauri::command]
pub async fn extract_commands(
  state: tauri::State<'_, AppState>,
  session_id: String,
) -> Result<Vec<String>, String> {
  let conn = state.db.lock().map_err(|e| e.to_string())?;
  let events = db::get_session_events(&conn, &session_id)?;

  // Prefer precise "command" events captured on Enter — they already contain
  // tab-completed text and exact spacing, so they are more faithful than the
  // raw keystroke stream.
  let mut precise_commands: Vec<String> = Vec::new();
  for ev in &events {
    if ev.direction == "command" {
      precise_commands.push(ev.content.clone());
    }
  }
  if !precise_commands.is_empty() {
    let mut seen = std::collections::HashSet::new();
    let mut commands = Vec::new();
    for raw in precise_commands {
      let trimmed = raw.trim();
      if trimmed.is_empty() {
        continue;
      }
      if seen.insert(trimmed.to_string()) {
        commands.push(trimmed.to_string());
      }
    }
    return Ok(commands);
  }

  // Fallback for sessions recorded before precise command capture existed:
  // reconstruct from the raw input stream. NOTE: commands that used tab
  // completion will appear incomplete here (the literal `\t` is recorded but
  // the server-completed text is not).
  let mut all_input = String::new();
  for ev in &events {
    if ev.direction == "input" {
      all_input.push_str(&ev.content);
    }
  }

  // Split by newlines, filter empty, deduplicate preserving order
  let mut seen = std::collections::HashSet::new();
  let mut commands = Vec::new();
  for line in all_input.split(['\n', '\r']) {
    let trimmed = line.trim();
    if trimmed.is_empty() {
      continue;
    }
    if seen.insert(trimmed.to_string()) {
      commands.push(trimmed.to_string());
    }
  }
  Ok(commands)
}

// ==================== Command Sets ====================

#[tauri::command]
pub async fn list_command_sets(
  state: tauri::State<'_, AppState>,
  connection_id: Option<String>,
) -> Result<Vec<CommandSetDto>, String> {
  let conn = state.db.lock().map_err(|e| e.to_string())?;
  db::list_command_sets(&conn, connection_id.as_deref())
}

#[tauri::command]
pub async fn save_command_set(
  state: tauri::State<'_, AppState>,
  cmd_set: CommandSetDto,
) -> Result<String, String> {
  let conn = state.db.lock().map_err(|e| e.to_string())?;
  db::save_command_set(&conn, &cmd_set)
}

#[tauri::command]
pub async fn delete_command_set(
  state: tauri::State<'_, AppState>,
  id: String,
) -> Result<(), String> {
  let conn = state.db.lock().map_err(|e| e.to_string())?;
  db::delete_command_set(&conn, &id)
}

// ==================== Host Analysis ====================

#[tauri::command]
pub async fn analyze_host(
  state: tauri::State<'_, AppState>,
  tab_id: u32,
) -> Result<crate::host_analysis::HostAnalysis, String> {
  let handle = crate::remote_fs::get_jump_handle(&state, tab_id)?;
  crate::host_analysis::analyze_host(&*handle, tab_id).await
}

#[tauri::command]
pub async fn command_help(
  state: tauri::State<'_, AppState>,
  tab_id: u32,
  command: String,
) -> Result<String, String> {
  let handle = crate::remote_fs::get_jump_handle(&state, tab_id)?;
  crate::host_analysis::command_help(&*handle, &command).await
}

#[tauri::command]
pub async fn analyze_docker_container(
  state: tauri::State<'_, AppState>,
  tab_id: u32,
  container_name: String,
) -> Result<crate::docker_analysis::DockerAnalysis, String> {
  let handle = crate::remote_fs::get_jump_handle(&state, tab_id)?;
  crate::docker_analysis::analyze_docker_container(&*handle, &container_name, tab_id).await
}

/// Fetch logs from a Docker container on the jump host.
/// Runs `docker logs --tail <tail_lines> --timestamps <container>` and returns the output.
#[tauri::command]
pub async fn docker_container_logs(
  state: tauri::State<'_, AppState>,
  tab_id: u32,
  container_name: String,
  tail_lines: Option<u32>,
) -> Result<String, String> {
  let handle = crate::remote_fs::get_jump_handle(&state, tab_id)?;
  let tail = tail_lines.unwrap_or(200).to_string();
  let argv = vec![
    "docker".into(),
    "logs".into(),
    "--tail".into(),
    tail,
    container_name.clone(),
  ];
  match crate::docker_fs::exec_on_jump(&*handle, &argv, None).await {
    Ok((out, _err, _status)) => {
      Ok(String::from_utf8_lossy(&out).to_string())
    }
    Err(e) => {
      // docker logs may write to stderr on success on some versions;
      // return the raw error as text rather than failing
      Err(format!("docker logs failed for {}: {}", container_name, e))
    }
  }
}

/// Start streaming `docker logs --tail N -f <container>`.
/// Returns a stream_id for use with `poll_docker_logs` / `stop_docker_logs_stream`.
#[tauri::command]
pub async fn docker_logs_stream_start(
  app: tauri::AppHandle,
  state: tauri::State<'_, AppState>,
  tab_id: u32,
  container_name: String,
  tail_lines: Option<u32>,
) -> Result<String, String> {
  let handle = crate::remote_fs::get_jump_handle(&state, tab_id)?;
  let tail = tail_lines.unwrap_or(200).to_string();

  let stream_id = {
    let id = state
      .next_docker_log_stream_id
      .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("dlog_{}", id)
  };

  // Build argv for `docker logs --tail N -f <container>`
  let argv = vec![
    "docker".to_string(),
    "logs".to_string(),
    "--tail".to_string(),
    tail,
    "-f".to_string(),
    container_name.clone(),
  ];

  // Open the streaming exec channel
  let mut channel =
    crate::docker_fs::exec_streaming_on_jump(&handle, &argv).await?;

  // Create shutdown channel
  let (shutdown_tx, mut shutdown_rx) = tokio::sync::oneshot::channel::<()>();

  // Store the shutdown sender
  {
    let mut streams = state.docker_log_streams.lock().map_err(|e| e.to_string())?;
    streams.insert(stream_id.clone(), shutdown_tx);
  }

  let sid = stream_id.clone();
  let container = container_name.clone();

  // Spawn background task to read channel output
  tauri::async_runtime::spawn(async move {
    use russh::ChannelMsg;
    let (read_tx, mut read_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();

    // Separate task for reading channel messages (channel.wait() is not
    // directly selectable with shutdown_rx, so we use an mpsc bridge)
    let read_handle = tokio::spawn(async move {
      while let Some(msg) = channel.wait().await {
        match msg {
          ChannelMsg::Data { data } => {
            if read_tx.send(data.to_vec()).is_err() {
              break;
            }
          }
          ChannelMsg::Eof | ChannelMsg::Close => break,
          _ => {}
        }
      }
    });

    // Main loop: drain reads, check shutdown
    loop {
      tokio::select! {
        _ = &mut shutdown_rx => {
          eprintln!(
            "[docker-logs-stream] {} ({}) shutdown signaled",
            sid, container
          );
          break;
        }
        data = read_rx.recv() => {
          match data {
            Some(chunk) => {
              if let Some(app_state) = app.try_state::<AppState>() {
                if let Ok(mut buffers) = app_state.docker_log_buffers.lock() {
                  buffers
                    .entry(sid.clone())
                    .or_default()
                    .push(String::from_utf8_lossy(&chunk).to_string());
                }
              }
            }
            None => {
              // mpsc closed → channel ended
              eprintln!(
                "[docker-logs-stream] {} ({}) channel closed",
                sid, container
              );
              break;
            }
          }
        }
      }
    }

    read_handle.abort();

    // Clean up stream entry on exit
    if let Some(app_state) = app.try_state::<AppState>() {
      if let Ok(mut streams) = app_state.docker_log_streams.lock() {
        streams.remove(&sid);
      }
    }
  });

  eprintln!(
    "[docker-logs-stream] started stream_id={} for container={}",
    stream_id, container_name
  );
  Ok(stream_id)
}

/// Poll new output chunks from a running `docker logs -f` stream.
#[tauri::command]
pub async fn poll_docker_logs(
  state: tauri::State<'_, AppState>,
  stream_id: String,
) -> Result<Vec<String>, String> {
  let mut buffers = state.docker_log_buffers.lock().map_err(|e| e.to_string())?;
  let chunks = buffers.remove(&stream_id).unwrap_or_default();
  Ok(chunks)
}

/// Stop a running `docker logs -f` stream.
#[tauri::command]
pub async fn stop_docker_logs_stream(
  state: tauri::State<'_, AppState>,
  stream_id: String,
) -> Result<bool, String> {
  let tx = {
    let mut streams = state.docker_log_streams.lock().map_err(|e| e.to_string())?;
    streams.remove(&stream_id)
  };
  if let Some(tx) = tx {
    let _ = tx.send(());
    // Also clean up any remaining buffer
    if let Ok(mut buffers) = state.docker_log_buffers.lock() {
      buffers.remove(&stream_id);
    }
    eprintln!("[docker-logs-stream] stopped stream_id={}", stream_id);
    Ok(true)
  } else {
    Ok(false)
  }
}

// ==================== App Version Info ====================

/// Version info with git commit hash for CI builds.
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AppVersion {
  /// Package version from Cargo.toml (e.g. "0.0.3")
  pub version: String,
  /// Short git commit hash (e.g. "a1b2c3d")
  pub git_hash: String,
  /// Git branch name (e.g. "main")
  pub git_branch: String,
  /// Build timestamp (e.g. "2026-07-30T12:34:56Z")
  pub build_time: String,
  /// Full git commit hash
  pub git_commit: String,
  /// Whether the working tree was dirty at build time
  pub git_dirty: bool,
  /// GitHub repository URL
  pub repo_url: String,
}

#[tauri::command]
pub fn get_app_version() -> AppVersion {
  AppVersion {
    version: env!("CARGO_PKG_VERSION").to_string(),
    git_hash: option_env!("GIT_HASH").unwrap_or("unknown").to_string(),
    git_branch: option_env!("GIT_BRANCH").unwrap_or("unknown").to_string(),
    build_time: option_env!("BUILD_TIME").unwrap_or("unknown").to_string(),
    git_commit: option_env!("GIT_COMMIT").unwrap_or("unknown").to_string(),
    git_dirty: option_env!("GIT_DIRTY")
      .map(|s| s == "true")
      .unwrap_or(false),
    repo_url: "https://github.com/wrolp/wrolp".to_string(),
  }
}

// ==================== AI Chat ====================

use crate::ai::{self, AiConfig, AiMessage, AiChatState};

/// Load the persistent AI configuration from disk.
#[tauri::command]
pub async fn load_ai_config(state: tauri::State<'_, AppState>) -> Result<AiConfig, String> {
    let config = ai::load_ai_config()?;
    let mut guard = state.ai_config.lock().unwrap();
    *guard = Some(config.clone());
    Ok(config)
}

/// Save the AI configuration to disk. The `api_key_enc` field should already
/// be encrypted (the frontend encrypts the plaintext key before saving).
#[tauri::command]
pub async fn save_ai_config(
    state: tauri::State<'_, AppState>,
    config: AiConfig,
) -> Result<(), String> {
    ai::save_ai_config(&config)?;
    let mut guard = state.ai_config.lock().unwrap();
    *guard = Some(config);
    Ok(())
}

/// Encrypt a plain-text API key. Returns the encrypted blob (or empty for empty input).
#[tauri::command]
pub async fn encrypt_api_key(key: String) -> Result<String, String> {
    if key.is_empty() {
        return Ok(String::new());
    }
    crate::vault::seal_secret(&key)
}

/// Decrypt an encrypted API key blob (for masked display in settings).
#[tauri::command]
pub async fn decrypt_api_key(encrypted: String) -> Result<String, String> {
    if encrypted.is_empty() {
        return Ok(String::new());
    }
    crate::vault::open_secret(&encrypted)
}

/// Fetch the list of model ids available from an AI provider's `/models`
/// endpoint. `api_key_enc` is the encrypted key blob (empty for keyless
/// endpoints). Used by the settings UI to populate the model dropdown.
#[tauri::command]
pub async fn list_ai_models(api_key_enc: String, endpoint: String) -> Result<Vec<String>, String> {
    ai::fetch_models(&api_key_enc, &endpoint).await
}

/// Send a non-streaming AI chat request. Returns the full assistant response.
#[tauri::command]
pub async fn ai_chat(
    state: tauri::State<'_, AppState>,
    messages: Vec<AiMessage>,
) -> Result<String, String> {
    let config = state
        .ai_config
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "AI config not loaded. Please configure AI settings first.".to_string())?;
    let profile = config
        .active_profile()
        .ok_or_else(|| "No AI endpoint configured.".to_string())?;
    ai::ai_chat_sync(profile, &messages).await
}

/// Start a streaming AI chat. Spawns a background task that reads the SSE
/// stream and pushes chunks into AppState. Call `poll_ai_chunks` to retrieve.
#[tauri::command]
pub async fn start_ai_chat_stream(
    app: tauri::AppHandle,
    messages: Vec<AiMessage>,
) -> Result<String, String> {
    let (config, chat_id) = {
        let state = app.state::<AppState>();
        let cfg = state
            .ai_config
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| {
                "AI config not loaded. Please configure AI settings first.".to_string()
            })?;
        let cid = Uuid::new_v4().to_string();
        state.ai_chat_buffers.lock().unwrap().insert(
            cid.clone(),
            AiChatState {
                chat_id: cid.clone(),
                chunks: Vec::new(),
                done: false,
                error: None,
                tool_events: Vec::new(),
            },
        );
        (cfg, cid)
    };

    let profile = config
        .active_profile()
        .ok_or_else(|| "No AI endpoint configured.".to_string())?
        .clone();

    let app_clone = app.clone();
    let cid = chat_id.clone();

    tauri::async_runtime::spawn(async move {
        let result =
            ai::execute_streaming_chat(&profile, &messages, |chunk| {
                let state = app_clone.state::<AppState>();
                let mut guard = state.ai_chat_buffers.lock().unwrap();
                if let Some(cs) = guard.get_mut(&cid) {
                    cs.chunks.push(chunk);
                }
            })
            .await;

        let state = app_clone.state::<AppState>();
        let mut guard = state.ai_chat_buffers.lock().unwrap();
        if let Some(cs) = guard.get_mut(&cid) {
            cs.done = true;
            if let Err(e) = result {
                cs.error = Some(e);
            }
        }
    });

    Ok(chat_id)
}

/// Poll for new streaming chunks from an active AI chat.
/// Returns `(new_text, done, error)`. The entry is removed when done.
#[tauri::command]
pub async fn poll_ai_chunks(
    state: tauri::State<'_, AppState>,
    chat_id: String,
) -> Result<Option<(String, bool, Option<String>, Vec<crate::ai::ToolCallEvent>)>, String> {
    let mut guard = state.ai_chat_buffers.lock().unwrap();
    match guard.get_mut(&chat_id) {
        Some(cs) => {
            if cs.chunks.is_empty() && !cs.done && cs.tool_events.is_empty() {
                return Ok(Some((String::new(), false, None, Vec::new())));
            }
            let new_text: String = cs.chunks.drain(..).collect();
            let done = cs.done;
            let error = cs.error.clone();
            let tool_events = std::mem::take(&mut cs.tool_events);
            if done {
                guard.remove(&chat_id);
            }
            Ok(Some((new_text, done, error, tool_events)))
        }
        None => Ok(None),
    }
}

/// Start an AI chat that may call tools (agent loop). Streams assistant text
/// via the same `ai_chat_buffers` polling mechanism, and emits tool-call events
/// into `AiChatState.tool_events` for the frontend to render tool cards.
///
/// `tab_id` identifies the shell tab this conversation belongs to. It is used to
/// auto-inject the current server context into the system prompt and to power
/// the `get_current_server` tool (so the model never has to guess a tab id).
#[tauri::command]
pub async fn start_ai_agent(
    app: tauri::AppHandle,
    messages: Vec<crate::ai::AiMessage>,
    tab_id: Option<u32>,
) -> Result<String, String> {
    let (config, chat_id) = {
        let state = app.state::<AppState>();
        let cfg = state
            .ai_config
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| "AI config not loaded. Please configure AI settings first.".to_string())?;
        let cid = Uuid::new_v4().to_string();
        state.ai_chat_buffers.lock().unwrap().insert(
            cid.clone(),
            crate::ai::AiChatState {
                chat_id: cid.clone(),
                chunks: Vec::new(),
                done: false,
                error: None,
                tool_events: Vec::new(),
            },
        );
        (cfg, cid)
    };

    let profile = config
        .active_profile()
        .ok_or_else(|| "No AI endpoint configured.".to_string())?
        .clone();

    let app_clone = app.clone();
    let cid = chat_id.clone();
    // Capture the current server context for the active shell tab (if any) so we
    // can inject it into the system prompt and power the `get_current_server` tool.
    let current_tab_id = tab_id;
    let current_server_context = current_tab_id.and_then(|tid| build_current_server_context(&app, tid));

    // Inject the current server context into the system message so the model
    // always knows which server this conversation is bound to.
    let messages_with_context: Vec<crate::ai::AiMessage> = if let Some(ctx) = &current_server_context {
        messages
            .iter()
            .map(|m| {
                if m.role == "system" {
                    let mut m = m.clone();
                    let base = m.content.clone().unwrap_or_default();
                    m.content = Some(format!("{}\n\n{}", base, ctx));
                    m
                } else {
                    m.clone()
                }
            })
            .collect()
    } else {
        messages.clone()
    };

    tauri::async_runtime::spawn(async move {
        let result = crate::ai::run_agent_stream(
            &profile,
            messages_with_context,
            |chunk| {
                let state = app_clone.state::<AppState>();
                let mut guard = state.ai_chat_buffers.lock().unwrap();
                if let Some(cs) = guard.get_mut(&cid) {
                    cs.chunks.push(chunk);
                }
            },
            |event| {
                let state = app_clone.state::<AppState>();
                let mut guard = state.ai_chat_buffers.lock().unwrap();
                if let Some(cs) = guard.get_mut(&cid) {
                    cs.tool_events.push(event);
                }
            },
            |calls| -> futures_util::future::BoxFuture<'static, Vec<crate::ai::ToolResult>> {
                let app = app_clone.clone();
                let tab = current_tab_id;
                Box::pin(async move { execute_ai_tools(&app, calls, tab).await })
            },
        )
        .await;

        let state = app_clone.state::<AppState>();
        let mut guard = state.ai_chat_buffers.lock().unwrap();
        if let Some(cs) = guard.get_mut(&cid) {
            cs.done = true;
            if let Err(e) = result {
                cs.error = Some(e);
            }
        }
    });

    Ok(chat_id)
}

/// Dangerous command substrings rejected outright when executed through tools.
fn is_dangerous_command(cmd: &str) -> bool {
    let lower = cmd.to_lowercase();
    const DANGEROUS: &[&str] = &[
        "rm -rf /",
        "mkfs",
        "dd if=",
        ":(){",
        "shutdown",
        "reboot",
        "init 0",
        "init 6",
        "> /dev/sda",
        "chmod -r 000",
    ];
    DANGEROUS.iter().any(|d| lower.contains(d))
}

/// Dangerous command substrings rejected outright when executed through tools.

/// Execute a batch of tool calls (one agent round) using `AppState`.
/// Returns `(tool_call_id, result_json)` pairs. Each result is a JSON string
/// so the model can parse it; errors are embedded as `{"error": "..."}`.
async fn execute_ai_tools(
    app: &tauri::AppHandle,
    calls: Vec<crate::ai::OpenAiToolCall>,
    current_tab_id: Option<u32>,
) -> Vec<crate::ai::ToolResult> {
    let state = app.state::<AppState>();
    let mut results: Vec<crate::ai::ToolResult> = Vec::new();

    for call in calls {
        let result = execute_one_tool(&state, &call, current_tab_id)
            .await
            .unwrap_or_else(|e| serde_json::json!({ "error": e }).to_string());
        results.push((call.id, result));
    }
    results
}

/// Build a human-readable context block describing the shell tab's connected
/// server (or note that it is not connected). Used to enrich the system prompt.
fn build_current_server_context(app: &tauri::AppHandle, tab_id: u32) -> Option<String> {
    let state = app.state::<AppState>();
    let sessions = state.sessions.lock().ok()?;
    let sess = sessions.get(&tab_id)?;
    let cfg = &sess.config;
    let status = if sess.data_tx.is_some() { "connected" } else { "disconnected" };
    let block = format!(
        "[Current Server Context]\n\
         This conversation is bound to shell tab {tab_id} (connection \"{name}\").\n\
         Host: {host}:{port}\n\
         Username: {username}\n\
         Status: {status}\n\
         Connection id: {cid}",
        tab_id = tab_id,
        name = cfg.name,
        host = cfg.host,
        port = cfg.port,
        username = cfg.username,
        status = status,
        cid = cfg.id,
    );
    Some(block)
}

async fn execute_one_tool(
    state: &tauri::State<'_, AppState>,
    call: &crate::ai::OpenAiToolCall,
    current_tab_id: Option<u32>,
) -> Result<String, String> {
    let args: serde_json::Value = serde_json::from_str(&call.arguments).unwrap_or(serde_json::Value::Null);
    let tool = call.name.as_str();

    let outcome: Result<String, String> = match tool {
        "run_command" => {
            let tab_id = args
                .get("tabId")
                .and_then(|v| v.as_u64())
                .ok_or("Missing 'tabId'")? as u32;
            let command = args
                .get("command")
                .and_then(|v| v.as_str())
                .ok_or("Missing 'command'")?
                .to_string();
            if is_dangerous_command(&command) {
                return Err("Command blocked by safety policy (destructive operation).".into());
            }
            let handle = crate::remote_fs::get_jump_handle(state, tab_id)?;
            let output = crate::host_analysis::exec_on_handle(&*handle, &command).await?;
            Ok(output)
        }
        "analyze_server" => {
            let tab_id = args
                .get("tabId")
                .and_then(|v| v.as_u64())
                .ok_or("Missing 'tabId'")? as u32;
            let handle = crate::remote_fs::get_jump_handle(state, tab_id)?;
            let analysis = crate::host_analysis::analyze_host(&*handle, tab_id).await?;
            Ok(serde_json::to_string(&analysis).map_err(|e| e.to_string())?)
        }
        "list_directory" => {
            let tab_id = args
                .get("tabId")
                .and_then(|v| v.as_u64())
                .ok_or("Missing 'tabId'")? as u32;
            let path = args
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or("Missing 'path'")?
                .to_string();
            let handle = crate::remote_fs::get_jump_handle(state, tab_id)?;
            let output = crate::host_analysis::exec_on_handle(
                &*handle,
                &format!("ls -la --time-style=long-iso {}", shell_quote_arg(&path)),
            )
            .await?;
            Ok(output)
        }
        "read_file" => {
            let tab_id = args
                .get("tabId")
                .and_then(|v| v.as_u64())
                .ok_or("Missing 'tabId'")? as u32;
            let path = args
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or("Missing 'path'")?
                .to_string();
            let handle = crate::remote_fs::get_jump_handle(state, tab_id)?;
            let output = crate::host_analysis::exec_on_handle(
                &*handle,
                // Truncate to 64KB to avoid huge payloads
                &format!("head -c 65536 {}", shell_quote_arg(&path)),
            )
            .await?;
            Ok(output)
        }
        "list_connections" => {
            let connections = state.connections.lock().map_err(|e| e.to_string())?;
            let slim: Vec<serde_json::Value> = connections
                .iter()
                .map(|c| {
                    serde_json::json!({
                        "id": c.id,
                        "name": c.name,
                        "host": c.host,
                        "port": c.port,
                        "username": c.username,
                        "group": c.group,
                    })
                })
                .collect();
            Ok(serde_json::to_string(&slim).map_err(|e| e.to_string())?)
        }
        "search_help" => {
            let tab_id = args
                .get("tabId")
                .and_then(|v| v.as_u64())
                .ok_or("Missing 'tabId'")? as u32;
            let command = args
                .get("command")
                .and_then(|v| v.as_str())
                .ok_or("Missing 'command'")?
                .to_string();
            let handle = crate::remote_fs::get_jump_handle(state, tab_id)?;
            let help = crate::host_analysis::command_help(&*handle, &command).await?;
            Ok(help)
        }
        "get_current_server" => {
            // Returns info about the server this conversation is bound to, without
            // needing the model to supply a tabId.
            let tab_id = current_tab_id.ok_or(
                "No shell tab is bound to this AI conversation. Open the AI chat from a shell tab first.",
            )?;
            let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
            let sess = sessions.get(&tab_id).ok_or("This tab is not connected to any server.")?;
            let cfg = &sess.config;
            let info = serde_json::json!({
                "tabId": tab_id,
                "connectionId": cfg.id,
                "connectionName": cfg.name,
                "host": cfg.host,
                "port": cfg.port,
                "username": cfg.username,
                "status": if sess.data_tx.is_some() { "connected" } else { "disconnected" },
            });
            Ok(serde_json::to_string(&info).map_err(|e| e.to_string())?)
        }
        other => Err(format!("Unknown tool: {}", other)),
    };

    match outcome {
        Ok(text) => {
            let truncated = if text.chars().count() > 16000 {
                let mut s: String = text.chars().take(16000).collect();
                s.push_str("\n... [truncated]");
                s
            } else {
                text
            };
            Ok(serde_json::json!({ "output": truncated }).to_string())
        }
        Err(e) => Ok(serde_json::json!({ "error": e }).to_string()),
    }
}

/// Minimal single-argument shell quoting for safe remote exec.
fn shell_quote_arg(s: &str) -> String {
    let escaped = s.replace('\'', "'\\''");
    format!("'{}'", escaped)
}


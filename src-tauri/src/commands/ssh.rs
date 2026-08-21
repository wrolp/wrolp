use super::*;
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
    eprintln!(
      "[russh] channel_open_confirmation max_packet={} window_size={}",
      max_packet_size, window_size
    );
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
// ==================== SSH Connection (russh) ====================

/// I/O loop for the interactive PTY channel. The SSH `Handle` is kept alive in
/// `AppState.sessions[tab].session_handle` (see `connect`), so it is not owned here.
/// Probe connectivity by opening a fresh (non-PTY) channel, running a no-op
/// command (`true`), and waiting for the channel to close. Returns `Err` if the
/// channel can't be opened, the `exec` fails, or any step doesn't finish within
/// `timeout` — all imply the server is no longer responding.
///
/// A brand-new channel is opened for every probe. This is deliberate: when the
/// network is yanked (e.g. cable pulled), the write inside `exec` can block
/// indefinitely while the OS waits for ACKs from an unreachable peer. Wrapping
/// the whole sequence in a timeout bounds that hang, and using a fresh channel
/// each time means a stalled channel can never hold a shared lock or poison the
/// next probe — so `run_session_loop` always gets a chance to emit the suspect /
/// closed events (and to observe a shutdown signal for a superseded session).
async fn probe_channel_run(
  handle: &russh::client::Handle<SshHandler>,
  timeout: std::time::Duration,
) -> Result<(), ()> {
  let mut ch = match tokio::time::timeout(timeout, handle.channel_open_session()).await {
    Ok(Ok(ch)) => ch,
    _ => return Err(()),
  };
  match tokio::time::timeout(timeout, ch.exec(true, "true")).await {
    Ok(Ok(())) => {}
    _ => return Err(()),
  }
  // Read messages until the channel is closed (None), bounded by the timeout.
  loop {
    match tokio::time::timeout(timeout, ch.wait()).await {
      Ok(Some(_)) => continue,
      Ok(None) => return Ok(()),
      Err(_) => return Err(()),
    }
  }
}

async fn run_session_loop(
  app: tauri::AppHandle,
  channel: Arc<tokio::sync::Mutex<russh::Channel<russh::client::Msg>>>,
  mut data_rx: tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>,
  mut shutdown_rx: tokio::sync::oneshot::Receiver<()>,
  tid: u32,
  _session_id: u64,
) {
  // SSH-level keepalive probe (interval + max retries, configured in Settings).
  // Three states are reported to the frontend:
  //   - first failed probe        -> "connection-suspect"  (yellow dot)
  //   - probe succeeds again      -> "connection-ok"       (back to green)
  //   - max consecutive failures   -> break, connect() emits "connection-closed"
  //                                    (red dot) and tears the session down.
  let (ka_interval, ka_max) = load_keepalive().unwrap_or((std::time::Duration::from_secs(30), 3u64));
  let mut ka_timer = tokio::time::interval(ka_interval);
  ka_timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
  // Eat the immediate first tick so probing starts after one full interval.
  ka_timer.tick().await;
  let mut failed: u64 = 0;
  let mut suspect = false;

  loop {
    tokio::select! {
      Some(data) = data_rx.recv() => {
        let ch = channel.lock().await;
        if let Err(e) = ch.data(data.as_slice()).await {
          eprintln!("[russh] write error for tab={}: {:?}", tid, e);
          break;
        }
      }
      _ = ka_timer.tick() => {
        // Send an SSH-level keepalive and verify the socket still accepts writes.
        // Wrapped in a timeout: a stalled/half-dead connection fails the write
        // (or hangs past the interval), surfacing as a probe failure.
        let probe = {
          // Pull the shared SSH handle out, then drop the sessions lock *before*
          // any await so the spawned future stays `Send`. Each probe opens its
          // own channel via this handle (see `probe_channel_run`).
          let handle = {
            let state = match app.try_state::<AppState>() {
              Some(s) => s,
              None => break,
            };
            let sessions = match state.sessions.lock() {
              Ok(g) => g,
              Err(_) => break,
            };
            sessions.get(&tid).and_then(|s| s.session_handle.clone())
          };
          match handle {
            // Outer timeout bounds the whole probe (open + exec + wait) so a
            // single dead probe returns within one keepalive interval.
            Some(h) => {
              match tokio::time::timeout(ka_interval, probe_channel_run(&h, ka_interval)).await {
                Ok(inner) => inner,
                Err(_) => Err(()),
              }
            }
            None => Ok(()),
          }
        };
        match probe {
          Ok(()) => {
            if suspect {
              suspect = false;
              let _ = app.emit("connection-ok", serde_json::json!({ "tabId": tid }));
            }
            failed = 0;
          }
          Err(_) => {
            failed += 1;
            if !suspect {
              suspect = true;
              let _ = app.emit(
                "connection-suspect",
                serde_json::json!({ "tabId": tid }),
              );
            }
            if failed >= ka_max {
              // Give up — connect()'s cleanup emits "connection-closed".
              eprintln!(
                "[russh] keepalive failed {} times for tab={}, declaring dead",
                failed, tid
              );
              break;
            }
          }
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
  reuse_existing: bool,
) -> Result<ConnectResult, String> {
  let host = config.host.clone();
  let port = config.port;
  let username = config.username.clone();

  eprintln!(
    "[connect] tab={} host={}:{} user={}",
    tab_id, host, port, username
  );

  // Reuse path: if this tab already has a live SSH session (e.g. the terminal
  // was floated/popped out and is now remounting), keep it instead of tearing
  // it down and re-handshaking with the server. The output buffer is preserved
  // so the remounted terminal replays the existing history — same session, same
  // shell state (cwd, env, background jobs), no reconnect.
  if reuse_existing {
    let live = {
      let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
      sessions
        .get(&tab_id)
        .map_or(false, |s| s.shutdown_tx.is_some())
    };
    if live {
      eprintln!(
        "[connect] reusing live session for tab={} (no reconnect)",
        tab_id
      );
      return Ok(ConnectResult {
        status: "connected".into(),
        tab_id,
      });
    }
    eprintln!(
      "[connect] no live session to reuse for tab={}, connecting fresh",
      tab_id
    );
  }

  // Clear stale output for this tab from previous sessions
  {
    if let Ok(mut buffers) = state.output_buffers.lock() {
      buffers.remove(&tab_id);
    }
    // Drop any AI capture sink left behind by a command that was still running
    // when the previous session died — a stale sink would permanently block new
    // AI commands on this tab.
    if let Ok(mut caps) = state.ai_captures.lock() {
      caps.remove(&tab_id);
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
          if sessions
            .get(&tid)
            .map_or(false, |s| s.session_id == session_id)
          {
            if let Ok(mut buf) = s.output_buffers.lock() {
              buf.entry(tid).or_default().push(format!(
                "Connecting to {}:{} as {} ...\r\n",
                cfg.host, cfg.port, cfg.username
              ));
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
      // Keepalive is not configured via russh's built-in mechanism; instead
      // run_session_loop runs its own probe so it can report the intermediate
      // "suspect" (yellow) state before declaring the connection dead.
      let ssh_config = Arc::new(client::Config::default());

      let mut handle =
        match client::connect(ssh_config, (cfg.host.as_str(), cfg.port), handler).await {
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
        eprintln!(
          "[russh] loading key: {} (resolved: {:?})",
          key_path, resolved_path
        );
        let key = match load_secret_key(&resolved_path, cfg.passphrase.as_deref()) {
          Ok(k) => k,
          Err(e) => {
            emit_error(
              &app_handle,
              tid,
              &format!("Failed to load key '{}': {}", key_path, e),
            );
            return;
          }
        };
        match handle
          .authenticate_publickey(&cfg.username, Arc::new(key))
          .await
        {
          Ok(true) => {}
          Ok(false) => {
            emit_error(&app_handle, tid, "Authentication failed: invalid key");
            return;
          }
          Err(e) => {
            eprintln!("[russh] key auth error: {:?}", e);
            emit_error(
              &app_handle,
              tid,
              &format!("Key authentication error: {}", e),
            );
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
        if let Err(e) = ch
          .request_pty(true, "xterm-256color", cols, rows, 0, 0, &[])
          .await
        {
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
      // ProxyJump / docker exec on secondary targets, and the keepalive probe)
      // in the session.
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
          if sessions
            .get(&tid)
            .map_or(false, |s| s.session_id == session_id)
          {
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
      run_session_loop(
        app_handle.clone(),
        channel,
        data_rx,
        shutdown_rx,
        tid,
        session_id,
      )
      .await;

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
            finalize_recording(&conn, &rec);
          }
        }
      }

      // Notify frontend that connection closed, but only if this session hasn't been replaced
      if let Some(app_state) = app_handle.try_state::<AppState>() {
        if let Ok(sessions) = app_state.sessions.lock() {
          if let Some(s) = sessions.get(&tid) {
            if s.session_id == session_id {
              let _ = app_handle.emit(
                "connection-closed",
                serde_json::json!({
                  "tabId": tid,
                }),
              );
              // Any tunnels carried by this SSH session are dead now — abort
              // their accept loops so local listeners close immediately.
              cleanup_tunnels_for_tab(&app_state, tid);
              let _ = app_handle.emit("tunnel-changed", serde_json::json!({}));
            } else {
              eprintln!(
                "[russh] session_id changed for tab={}, skipping stale event",
                tid
              );
            }
          }
        }
        // Mark the session dead so it isn't mistakenly reused (e.g. when the
        // terminal is floated and remounts) before the user explicitly reconnects.
        if let Ok(mut sessions) = app_state.sessions.lock() {
          if let Some(s) = sessions.get_mut(&tid) {
            if s.session_id == session_id {
              s.shutdown_tx.take();
              s.data_tx.take();
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
        finalize_recording(&conn, &old_rec);
      }
    }

    let session_uuid = Uuid::new_v4().to_string();
    let now = chrono::Utc::now();
    let started_at_iso = now.to_rfc3339();
    // Recording is OFF by default. It can be enabled globally via the
    // Settings toggle (persisted in window.json) or forced via the
    // WROLP_RECORDING environment variable (1/true/0/false).
    let recording_enabled = match std::env::var("WROLP_RECORDING") {
      Ok(v) => v != "0" && v != "false",
      Err(_) => load_window_config_auto_record(),
    };

    // Create in-memory recording buffer. Only persist a session row to SQLite
    // when recording is actually enabled — otherwise connections that never
    // started recording would leave empty "sessions" in the list.
    let db_saved = recording_enabled;
    if db_saved {
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
      db_saved,
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
pub async fn disconnect(state: tauri::State<'_, AppState>, tab_id: u32) -> Result<bool, String> {
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
  let mut result = Vec::new();
  // SSH output lives in the shared poll buffer.
  if let Ok(mut buffers) = state.output_buffers.lock() {
    if let Some(chunks) = buffers.remove(&tab_id) {
      result.extend(chunks);
    }
  }
  // Local shell output lives in its own per-tab queue (owned by LocalShell).
  if let Ok(shells) = state.local_shells.lock() {
    if let Some(sh) = shells.get(&tab_id) {
      if let Ok(mut q) = sh.output.lock() {
        result.append(&mut q);
      }
    }
  }
  Ok(result)
}

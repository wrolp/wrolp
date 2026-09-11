use super::*;
// NOTE: russh 0.63 declares `Handler` with native `async fn` (RPITIT,
// `-> impl Future + Send`), not `#[async_trait]`. Adding `#[async_trait::async_trait]`
// here rewrites the methods into boxed futures and no longer matches the trait.
impl Handler for SshHandler {
  type Error = SshError;

  async fn check_server_key(
    &mut self,
    _server_public_key: &PublicKeyOrCertificate,
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

/// Liveness probe for an SSH session: open a fresh (non-PTY) session channel and
/// close it again. Returns `Err` only when the server does not answer within
/// `timeout` (i.e. the peer is unreachable / the socket is dead).
///
/// `channel_open_session()` is a real round trip — it resolves only after the
/// server replies with `CHANNEL_OPEN_CONFIRMATION` — so a successful open
/// already proves the peer is responding. No `exec`/command is needed.
///
/// NOTE (B21): the previous version opened a channel, ran `exec true`, then
/// looped on `Channel::wait()` until the channel closed. Whether `wait()` ever
/// returns `None` depends on the peer actually sending `CHANNEL_CLOSE` *and*
/// russh observing it; when it doesn't, the probe burns the whole `timeout`
/// (30s) on every tick. Because the probe used to be awaited **inline** in
/// `run_session_loop` — whose tick period is the same 30s — a slow probe could
/// run back-to-back and starve the input branch, so the connection looked alive
/// but keystrokes stopped being forwarded ("按一屏就按不了了"). Relying only on
/// the open round trip keeps the probe fast on a live peer; `run_session_loop`
/// also now runs it off the input path so even a slow probe cannot block typing.
///
/// A brand-new channel is opened for every probe so a stalled channel can never
/// hold a shared lock or poison the next probe.
async fn probe_channel_run(
  handle: &russh::client::Handle<SshHandler>,
  timeout: std::time::Duration,
) -> Result<(), ()> {
  match tokio::time::timeout(timeout, handle.channel_open_session()).await {
    Ok(Ok(ch)) => {
      // Best-effort cleanup; the server closes its side too.
      let _ = tokio::time::timeout(timeout, ch.close()).await;
      Ok(())
    }
    // The server answered but refused a new channel (e.g. MaxSessions reached):
    // that still proves the peer is alive — only a timeout means "unreachable".
    Ok(Err(russh::Error::ChannelOpenFailure(_))) => Ok(()),
    _ => Err(()),
  }
}

async fn run_session_loop(
  app: tauri::AppHandle,
  channel: Arc<russh::ChannelWriteHalf<russh::client::Msg>>,
  mut data_rx: tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>,
  mut shutdown_rx: tokio::sync::oneshot::Receiver<()>,
  tid: u32,
  session_id: u64,
) {
  // App-level keepalive probe (interval configured in Settings). Its ONLY job
  // is the intermediate "suspect" UX:
  //   - first failed probe   -> "connection-suspect" (yellow dot)
  //   - probe succeeds again -> "connection-ok"      (back to green)
  // It runs in a SPAWNED task — never awaited on the input path — and does not
  // tear the connection down on failure. Both properties are B21 fixes: a
  // transient probe hiccup must not kill a healthy session, and a slow probe
  // must not starve keystrokes. The "the peer is really dead" decision belongs
  // to russh's built-in keepalive (configured in `connect`), which ends the
  // session after `keepalive_max` unanswered keepalives; the watchdog below
  // notices via `handle.is_closed()` and breaks, so `connect()`'s cleanup emits
  // `connection-closed` (red dot).
  let base_dir = app.try_state::<AppState>().and_then(|s| s.base_dir.clone());
  let (ka_interval, _ka_max) =
    load_keepalive(base_dir.as_deref()).unwrap_or((std::time::Duration::from_secs(30), 3u64));
  let mut ka_timer = tokio::time::interval(ka_interval);
  ka_timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
  // Eat the immediate first tick so probing starts after one full interval.
  ka_timer.tick().await;
  // Status shared with the spawned probe tasks: `suspect` drives the yellow
  // dot, `probing` is an in-flight guard so overlapping ticks don't pile up
  // concurrent probes.
  let suspect = Arc::new(AtomicBool::new(false));
  let probing = Arc::new(AtomicBool::new(false));

  loop {
    tokio::select! {
      Some(data) = data_rx.recv() => {
        // `ChannelWriteHalf::data()` only returns once the packet has been handed
        // to russh's session loop (it awaits the bounded session queue and the
        // peer's flow-control window). A long wait here therefore means the
        // session loop is stalled — exactly the B21 round-3 failure mode. Time it
        // so a regression is visible instead of silent.
        let len = data.len();
        let t0 = std::time::Instant::now();
        if let Err(e) = channel.data(data.as_slice()).await {
          eprintln!("[russh] write error for tab={}: {:?}", tid, e);
          break;
        }
        let waited = t0.elapsed();
        if waited >= std::time::Duration::from_secs(2) {
          eprintln!(
            "[russh] WARN input blocked {}ms for tab={} ({} bytes) - session loop stalled",
            waited.as_millis(),
            tid,
            len
          );
        }
      }
      _ = ka_timer.tick() => {
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
        let handle = match handle {
          Some(h) => h,
          // No handle yet (still connecting, or this session was replaced):
          // skip the tick without counting it as either success or failure.
          None => continue,
        };
        // russh ends the session (its built-in keepalive hitting `keepalive_max`,
        // or a server-side disconnect) by closing the `Handle`'s sender. Surface
        // that as the end of this loop so `connect()`'s cleanup emits
        // `connection-closed`. This check does not await, so it never delays
        // input; it also runs before the probe guard below.
        if handle.is_closed() {
          eprintln!("[russh] session ended (handle closed) for tab={}", tid);
          break;
        }
        // Run the probe OFF the input path (B21): spawning it means a stalled
        // probe can never block `data_rx.recv()`, so keystrokes are always
        // forwarded even while a probe is (or several are) in flight. Skip the
        // tick if the previous probe hasn't finished yet.
        if probing.swap(true, Ordering::SeqCst) {
          continue;
        }
        let app2 = app.clone();
        let suspect2 = Arc::clone(&suspect);
        let probing2 = Arc::clone(&probing);
        tauri::async_runtime::spawn(async move {
          let probe_ok = matches!(
            tokio::time::timeout(ka_interval, probe_channel_run(&handle, ka_interval)).await,
            Ok(Ok(()))
          );
          probing2.store(false, Ordering::SeqCst);
          // Ignore the result if this session has since been replaced by a
          // reconnect (the stale-task guard).
          let current = app2
            .try_state::<AppState>()
            .and_then(|s| {
              s.sessions
                .lock()
                .ok()
                .map(|g| g.get(&tid).map_or(false, |x| x.session_id == session_id))
            })
            .unwrap_or(false);
          if !current {
            return;
          }
          if probe_ok {
            if suspect2.swap(false, Ordering::SeqCst) {
              let _ = app2.emit("connection-ok", serde_json::json!({ "tabId": tid }));
            }
          } else if !suspect2.swap(true, Ordering::SeqCst) {
            let _ = app2.emit("connection-suspect", serde_json::json!({ "tabId": tid }));
          }
        });
      }
      _ = &mut shutdown_rx => {
        eprintln!("[russh] shutdown signal for tab={}", tid);
        let _ = channel.eof().await;
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
      // Two layers of keepalive:
      //  1. russh's built-in keepalive (configured just below). It runs inside
      //     russh's own session loop, so it keeps the connection alive and
      //     detects a dead peer even if the app-level probe (layer 2) can't run
      //     — and it is also the authority that decides the session is dead.
      //     Restoring it is the B21 fix: when the app-level probe was added it
      //     *replaced* russh's native keepalive, leaving idle connections with
      //     no protocol-level liveness traffic at all (the custom probe both
      //     silently no-ops when its `session_handle` is missing and tears the
      //     connection down on a transient probe failure).
      //  2. The app-level probe in `run_session_loop` — kept purely for the
      //     intermediate "suspect" (yellow) UX; it no longer tears the
      //     connection down on its own.
      // Keepalive is always on: fall back to the same 30s / 3 defaults the
      // probe uses, so a missing or minimum-clamped window.json can never leave
      // the session without the liveness authority `run_session_loop` relies on
      // (it now waits for `handle.is_closed()` instead of counting failures).
      let base_dir = app_handle
        .try_state::<AppState>()
        .and_then(|s| s.base_dir.clone());
      let (ka_interval, ka_max) =
        load_keepalive(base_dir.as_deref()).unwrap_or((std::time::Duration::from_secs(30), 3u64));
      let mut ssh_config = client::Config::default();
      ssh_config.keepalive_interval = Some(ka_interval);
      ssh_config.keepalive_max = ka_max as usize;
      let ssh_config = Arc::new(ssh_config);

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
          Ok(res) if res.success() => {}
          Ok(_) => {
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
          .authenticate_publickey(
            &cfg.username,
            PrivateKeyWithHashAlg::new(Arc::new(key), None),
          )
          .await
        {
          Ok(res) if res.success() => {}
          Ok(_) => {
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
      let mut channel = match handle.channel_open_session().await {
        Ok(ch) => {
          eprintln!("[russh] channel opened");
          ch
        }
        Err(e) => {
          emit_error(&app_handle, tid, &format!("Failed to open channel: {}", e));
          return;
        }
      };

      eprintln!("[russh] requesting PTY...");
      if let Err(e) = channel
        .request_pty(true, "xterm-256color", cols, rows, 0, 0, &[])
        .await
      {
        emit_error(&app_handle, tid, &format!("PTY request failed: {}", e));
        return;
      }
      eprintln!("[russh] PTY allocated");

      eprintln!("[russh] requesting shell...");
      if let Err(e) = channel.request_shell(true).await {
        emit_error(&app_handle, tid, &format!("Shell request failed: {}", e));
        return;
      }

      // B21 root cause (russh 0.63 regression): drain the channel's read half.
      //
      // russh 0.63 attaches a *bounded* inbound queue to every channel
      // (`client::Config::channel_buffer_size`, default 100) and its session loop
      // pushes each incoming packet with
      // `chan.send(ChannelMsg::Data { .. }).await` (client/encrypted.rs). The
      // interactive PTY consumes output through the `SshHandler` callback rather
      // than through `Channel::wait()`, so nothing ever drained that queue: once
      // 100 messages had accumulated, the session loop blocked inside
      // `send().await` permanently — no further input writes, window adjustments
      // or keepalives were processed. That is exactly the "type about one screen,
      // then the terminal stops responding" symptom. russh 0.44 had no such
      // bound, which is why the regression only appeared after the upgrade.
      //
      // Splitting the channel lets us keep the write half (`&self` methods, no
      // lock) for input + resize, and hand the read half to a task that drains
      // and discards it — the payload has already been delivered via the handler
      // callbacks.
      let (mut read_half, write_half) = channel.split();
      let channel = Arc::new(write_half);
      tauri::async_runtime::spawn(async move {
        // `wait()` yields None once every `ChannelRef` to this channel is gone.
        while read_half.wait().await.is_some() {}
        log::debug!("[ssh] pty read half closed for tab={}", tid);
      });

      eprintln!(
        "[russh] shell started for tab={} (B21 r3: pty read half draining)",
        tid
      );

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
      Err(_) => load_window_config_auto_record(state.base_dir.as_deref()),
    };

    // Snapshot the workspace name for the events-file folder layout (folder
    // layer 1). Look it up once at connect; later workspace renames do not
    // re-shuffle already-recorded files.
    let workspace_name = {
      let list = state.workspaces.lock();
      match list {
        Ok(ws) => config
          .workspace_id
          .as_deref()
          .and_then(|id| ws.iter().find(|w| w.id == id).map(|w| w.name.clone()))
          .or_else(|| config.workspace_id.clone())
          .unwrap_or_else(|| "default".to_string()),
        Err(_) => config
          .workspace_id
          .clone()
          .unwrap_or_else(|| "default".to_string()),
      }
    };
    // Absolute events-file path snapshot (RF3). Deriving it here, at connect,
    // freezes the workspace/group/connection/start-time layout the whole
    // recording will live under; the file itself is only created lazily on the
    // first non-empty flush.
    let events_file = crate::rec_file::events_file_for(
      state.base_dir.as_deref(),
      Some(&workspace_name),
      config.group.as_deref(),
      &config.name,
      &started_at_iso,
      &session_uuid,
    );

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
          config.workspace_id.as_deref(),
          config.group.as_deref(),
        );
      }
    }

    // Create in-memory recording buffer
    let recording = ActiveRecording {
      session_id: session_uuid,
      session_version: session_id,
      connection_id: config.id.clone(),
      connection_name: config.name.clone(),
      workspace_name: Some(workspace_name),
      group_name: config.group.clone(),
      events_file: Some(events_file),
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
  // SSH sessions
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
    return Ok(true);
  }

  // Serial (COM port) sessions — signal the reader thread to stop.
  {
    let sessions = state.serial_sessions.lock().map_err(|e| e.to_string())?;
    if let Some(s) = sessions.get(&tab_id) {
      s.shutdown.store(true, Ordering::SeqCst);
      return Ok(true);
    }
  }

  // Telnet sessions — signal the reader task to stop.
  {
    // Take the shutdown signal out first and drop the `telnet_sessions` guard
    // before touching `ai_captures`, so the lock order here (telnet → ai_captures)
    // doesn't invert the one in `run_command_on_terminal` (ai_captures → telnet)
    // and risk a deadlock.
    let tx = {
      let mut sessions = state.telnet_sessions.lock().map_err(|e| e.to_string())?;
      sessions.get_mut(&tab_id).and_then(|s| s.shutdown_tx.take())
    };
    if let Some(tx) = tx {
      let _ = tx.send(());
      // Drop any AI capture sink left behind by a command still running when the
      // session died — a stale sink would permanently block new AI commands on
      // this tab (same guard as SSH's connect-time cleanup).
      if let Ok(mut caps) = state.ai_captures.lock() {
        caps.remove(&tab_id);
      }
      return Ok(true);
    }
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
  // Serial ports have no PTY to resize — nothing to do.
  if let Ok(sessions) = state.serial_sessions.lock() {
    if sessions.contains_key(&tab_id) {
      return Ok(true);
    }
  }
  // Telnet has no PTY either — the remote learns the geometry through the NAWS
  // subnegotiation (RFC 1073), which is the only resize channel available.
  {
    let sessions = state.telnet_sessions.lock().map_err(|e| e.to_string())?;
    if let Some(s) = sessions.get(&tab_id) {
      if let Ok(mut size) = s.size.lock() {
        *size = (cols, rows);
      }
      s.write_tx
        .send(crate::commands::telnet::naws_bytes((cols, rows)))
        .map_err(|e| format!("Failed to send NAWS: {}", e))?;
      return Ok(true);
    }
  }
  let channel = {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    sessions
      .get(&tab_id)
      .and_then(|s| s.channel_arc.clone())
      .ok_or("Session not found or channel not available")?
  };

  channel
    .window_change(cols, rows, 0, 0)
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

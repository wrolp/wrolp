use super::*;
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
    Ok((out, _err, _status)) => Ok(String::from_utf8_lossy(&out).to_string()),
    Err(e) => {
      // docker logs may write to stderr on success on some versions;
      // return the raw error as text rather than failing
      Err(format!("docker logs failed for {}: {}", container_name, e))
    }
  }
}

/// Restart a Docker container on the jump host.
/// Runs `docker restart <container>`.
#[tauri::command]
pub async fn restart_docker_container(
  state: tauri::State<'_, AppState>,
  tab_id: u32,
  container_name: String,
) -> Result<(), String> {
  let handle = crate::remote_fs::get_jump_handle(&state, tab_id)?;
  let argv = vec!["docker".into(), "restart".into(), container_name];
  match crate::docker_fs::exec_on_jump(&*handle, &argv, None).await {
    Ok((_out, _err, status)) => {
      if status == 0 {
        Ok(())
      } else {
        Err(format!("docker restart exited with status {}", status))
      }
    }
    Err(e) => Err(e),
  }
}

/// Stop a running Docker container on the jump host.
/// Runs `docker stop <container>`.
#[tauri::command]
pub async fn stop_docker_container(
  state: tauri::State<'_, AppState>,
  tab_id: u32,
  container_name: String,
) -> Result<(), String> {
  let handle = crate::remote_fs::get_jump_handle(&state, tab_id)?;
  let argv = vec!["docker".into(), "stop".into(), container_name];
  match crate::docker_fs::exec_on_jump(&*handle, &argv, None).await {
    Ok((_out, _err, status)) => {
      if status == 0 {
        Ok(())
      } else {
        Err(format!("docker stop exited with status {}", status))
      }
    }
    Err(e) => Err(e),
  }
}

/// Start a stopped Docker container on the jump host.
/// Runs `docker start <container>`.
#[tauri::command]
pub async fn start_docker_container(
  state: tauri::State<'_, AppState>,
  tab_id: u32,
  container_name: String,
) -> Result<(), String> {
  let handle = crate::remote_fs::get_jump_handle(&state, tab_id)?;
  let argv = vec!["docker".into(), "start".into(), container_name];
  match crate::docker_fs::exec_on_jump(&*handle, &argv, None).await {
    Ok((_out, _err, status)) => {
      if status == 0 {
        Ok(())
      } else {
        Err(format!("docker start exited with status {}", status))
      }
    }
    Err(e) => Err(e),
  }
}

/// Remove a stopped Docker container on the jump host.
/// Runs `docker rm <container>` (only valid for stopped containers).
#[tauri::command]
pub async fn remove_docker_container(
  state: tauri::State<'_, AppState>,
  tab_id: u32,
  container_name: String,
) -> Result<(), String> {
  let handle = crate::remote_fs::get_jump_handle(&state, tab_id)?;
  let argv = vec!["docker".into(), "rm".into(), container_name];
  match crate::docker_fs::exec_on_jump(&*handle, &argv, None).await {
    Ok((_out, _err, status)) => {
      if status == 0 {
        Ok(())
      } else {
        Err(format!("docker rm exited with status {}", status))
      }
    }
    Err(e) => Err(e),
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
  let mut channel = crate::docker_fs::exec_streaming_on_jump(&handle, &argv).await?;

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

/// Open the application config directory in the system file manager
/// (e.g. Explorer on Windows). Avoids the frontend shell-plugin `open` scope
/// which only allows URLs by default.
#[tauri::command]
pub fn open_config_dir() -> Result<(), String> {
  let dir = get_data_dir().ok_or_else(|| "Config directory not found".to_string())?;
  if !dir.exists() {
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create config dir: {}", e))?;
  }
  let path = dir.to_string_lossy().to_string();
  eprintln!("[open_config_dir] opening {}", path);
  #[cfg(target_os = "windows")]
  {
    std::process::Command::new("explorer")
      .arg(&path)
      .spawn()
      .map_err(|e| format!("Failed to open config dir: {}", e))?;
  }
  #[cfg(target_os = "macos")]
  {
    std::process::Command::new("open")
      .arg(&path)
      .spawn()
      .map_err(|e| format!("Failed to open config dir: {}", e))?;
  }
  #[cfg(all(unix, not(target_os = "macos")))]
  {
    std::process::Command::new("xdg-open")
      .arg(&path)
      .spawn()
      .map_err(|e| format!("Failed to open config dir: {}", e))?;
  }
  Ok(())
}

// ==================== AI Chat ====================

use crate::ai::{self, AiChatState, AiConfig, AiMessage};

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
  profile: Option<crate::ai::AiEndpointProfile>,
) -> Result<String, String> {
  let profile =
    match profile {
      Some(p) => p,
      None => {
        let config =
          state.ai_config.lock().unwrap().clone().ok_or_else(|| {
            "AI config not loaded. Please configure AI settings first.".to_string()
          })?;
        config
          .active_profile()
          .ok_or_else(|| "No AI endpoint configured.".to_string())?
          .clone()
      }
    };
  ai::ai_chat_sync(&profile, &messages).await
}

/// Start a streaming AI chat. Spawns a background task that reads the SSE
/// stream and pushes chunks into AppState. Call `poll_ai_chunks` to retrieve.
#[tauri::command]
pub async fn start_ai_chat_stream(
  app: tauri::AppHandle,
  messages: Vec<AiMessage>,
  profile: Option<crate::ai::AiEndpointProfile>,
) -> Result<String, String> {
  let chat_id = {
    let state = app.state::<AppState>();
    let cid = Uuid::new_v4().to_string();
    state.ai_chat_buffers.lock().unwrap().insert(
      cid.clone(),
      AiChatState {
        chat_id: cid.clone(),
        chunks: Vec::new(),
        done: false,
        error: None,
        tool_events: Vec::new(),
        cancelled: false,
      },
    );
    cid
  };

  let profile =
    match profile {
      Some(p) => p,
      None => {
        let state = app.state::<AppState>();
        let config =
          state.ai_config.lock().unwrap().clone().ok_or_else(|| {
            "AI config not loaded. Please configure AI settings first.".to_string()
          })?;
        config
          .active_profile()
          .ok_or_else(|| "No AI endpoint configured.".to_string())?
          .clone()
      }
    };

  let app_clone = app.clone();
  let cid = chat_id.clone();

  tauri::async_runtime::spawn(async move {
    let result = ai::execute_streaming_chat(&profile, &messages, |chunk| {
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
      if cs.cancelled && cs.chunks.is_empty() && !cs.done && cs.tool_events.is_empty() {
        // User paused the stream — end polling with whatever text already
        // arrived (there is none left to drain here).
        guard.remove(&chat_id);
        return Ok(Some((String::new(), true, None, Vec::new())));
      }
      if cs.chunks.is_empty() && !cs.done && cs.tool_events.is_empty() {
        return Ok(Some((String::new(), false, None, Vec::new())));
      }
      let new_text: String = cs.chunks.drain(..).collect();
      let done = cs.done || cs.cancelled;
      let error = if cs.cancelled && !cs.done {
        None
      } else {
        cs.error.clone()
      };
      let tool_events = std::mem::take(&mut cs.tool_events);
      if done {
        guard.remove(&chat_id);
      }
      Ok(Some((new_text, done, error, tool_events)))
    }
    None => Ok(None),
  }
}

/// Pause/stop an in-flight AI chat. The stream is marked cancelled; the next
/// `poll_ai_chunks` returns whatever text accumulated so far as done, so the
/// frontend stops polling. The background task aborts on its next chunk.
#[tauri::command]
pub fn cancel_ai_chat(state: tauri::State<'_, AppState>, chat_id: String) -> Result<(), String> {
  let mut guard = state.ai_chat_buffers.lock().map_err(|e| e.to_string())?;
  if let Some(cs) = guard.get_mut(&chat_id) {
    cs.cancelled = true;
  }
  Ok(())
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
  profile: Option<crate::ai::AiEndpointProfile>,
  read_only: bool,
  max_agent_rounds: u32,
  tool_call_format: Option<String>,
) -> Result<String, String> {
  let chat_id = {
    let state = app.state::<AppState>();
    let cid = Uuid::new_v4().to_string();
    state.ai_chat_buffers.lock().unwrap().insert(
      cid.clone(),
      crate::ai::AiChatState {
        chat_id: cid.clone(),
        chunks: Vec::new(),
        done: false,
        error: None,
        tool_events: Vec::new(),
        cancelled: false,
      },
    );
    cid
  };

  // Prefer the profile selected in the UI (passed from the frontend); fall back
  // to the persisted active profile only if none was provided.
  let config =
    match profile {
      Some(p) => p,
      None => {
        let state = app.state::<AppState>();
        let cfg =
          state.ai_config.lock().unwrap().clone().ok_or_else(|| {
            "AI config not loaded. Please configure AI settings first.".to_string()
          })?;
        cfg
          .active_profile()
          .cloned()
          .ok_or_else(|| "No AI endpoint configured.".to_string())?
      }
    };

  let app_clone = app.clone();
  let cid = chat_id.clone();
  // Capture the current server context for the active shell tab (if any) so we
  // can inject it into the system prompt and power the `get_current_server` tool.
  let current_tab_id = tab_id;
  let current_server_context =
    current_tab_id.and_then(|tid| build_current_server_context(&app, tid));

  // Inject the current server context (and, in read-only mode, a mode note)
  // into the system message so the model always knows which server this
  // conversation is bound to and whether it may modify the system.
  let mode_note = if read_only {
    Some(
      "MODE: Read-only mode is ENABLED. You may ONLY run read-only / inspection commands \
             (status, logs, file reads, analysis). Do NOT attempt to modify the system: no writes, \
             no installs, no service changes, no file edits, and no destructive commands."
        .to_string(),
    )
  } else {
    None
  };
  let messages_with_context: Vec<crate::ai::AiMessage> = {
    let mut extra = String::new();
    if let Some(ctx) = &current_server_context {
      extra.push_str(ctx);
      extra.push('\n');
    }
    if let Some(note) = &mode_note {
      extra.push_str(note);
      extra.push('\n');
    }
    if extra.is_empty() {
      messages.clone()
    } else {
      messages
        .iter()
        .map(|m| {
          if m.role == "system" {
            let mut m = m.clone();
            let base = m.content.clone().unwrap_or_default();
            m.content = Some(format!("{}\n\n{}", base, extra));
            m
          } else {
            m.clone()
          }
        })
        .collect()
    }
  };

  // Tool-call wire format for this run: per-conversation choice (from the
  // frontend) wins; falls back to the profile setting, then "nested".
  let tool_call_format = tool_call_format
    .filter(|f| f == "flat" || f == "nested")
    .unwrap_or_else(|| {
      if config.tool_call_format == "flat" {
        "flat"
      } else {
        "nested"
      }
      .to_string()
    });

  let on_confirm = {
    let app2 = app_clone.clone();
    let cid2 = cid.clone();
    let conf2 = config.clone();
    let fmt = tool_call_format.clone();
    let tab = current_tab_id;
    move |msgs: Vec<crate::ai::AiMessage>, calls: Vec<crate::ai::OpenAiToolCall>| {
      save_pending(&app2, &cid2, &conf2, msgs, calls, read_only, &fmt, tab);
    }
  };
  spawn_agent(
    app_clone,
    cid.clone(),
    config,
    tool_call_format,
    messages_with_context,
    current_tab_id,
    read_only,
    on_confirm,
    max_agent_rounds as usize,
  );

  Ok(chat_id)
}

/// Persist an agent-loop pause awaiting user confirmation of a sensitive tool
/// call, and flag the in-flight tool events as `needs-confirmation` so the
/// frontend can render an approval prompt.
fn save_pending(
  app: &tauri::AppHandle,
  chat_id: &str,
  config: &crate::ai::AiEndpointProfile,
  messages: Vec<crate::ai::AiMessage>,
  calls: Vec<crate::ai::OpenAiToolCall>,
  read_only: bool,
  tool_call_format: &str,
  current_tab_id: Option<u32>,
) {
  {
    let st = app.state::<AppState>();
    let guard = st.ai_pending.lock();
    if let Ok(mut g) = guard {
      *g = Some(crate::ssh_session::AiPendingConfirm {
        chat_id: chat_id.to_string(),
        config: config.clone(),
        messages,
        calls,
        read_only,
        tool_call_format: tool_call_format.to_string(),
        current_tab_id,
      });
    }
  }
  {
    let st = app.state::<AppState>();
    let guard = st.ai_chat_buffers.lock();
    if let Ok(mut g) = guard {
      if let Some(cs) = g.get_mut(chat_id) {
        for ev in &mut cs.tool_events {
          if ev.status == "executing" {
            ev.status = "needs-confirmation".to_string();
          }
        }
      }
    }
  }
}

/// Spawn the agent loop for a chat, wiring streaming chunks / tool events to the
/// shared `AiChatState` buffer. Used by both `start_ai_agent` and `confirm_ai_tool`.
fn spawn_agent(
  app: tauri::AppHandle,
  chat_id: String,
  config: crate::ai::AiEndpointProfile,
  tool_call_format: String,
  messages: Vec<crate::ai::AiMessage>,
  current_tab_id: Option<u32>,
  read_only: bool,
  on_confirm: impl Fn(Vec<crate::ai::AiMessage>, Vec<crate::ai::OpenAiToolCall>) + Send + 'static,
  max_rounds: usize,
) {
  tauri::async_runtime::spawn(async move {
    let result = crate::ai::run_agent_stream(
      &config,
      &tool_call_format,
      messages,
      |chunk| {
        let state = app.state::<AppState>();
        let mut guard = state.ai_chat_buffers.lock().unwrap();
        if let Some(cs) = guard.get_mut(&chat_id) {
          cs.chunks.push(chunk);
        }
      },
      |event| {
        let state = app.state::<AppState>();
        let mut guard = state.ai_chat_buffers.lock().unwrap();
        if let Some(cs) = guard.get_mut(&chat_id) {
          cs.tool_events.push(event);
        }
      },
      |calls| -> futures_util::future::BoxFuture<'static, Vec<crate::ai::ToolResult>> {
        let app = app.clone();
        let tab = current_tab_id;
        Box::pin(async move { execute_ai_tools(&app, calls, tab, read_only).await })
      },
      on_confirm,
      max_rounds,
    )
    .await;

    let state = app.state::<AppState>();
    let mut guard = state.ai_chat_buffers.lock().unwrap();
    if let Some(cs) = guard.get_mut(&chat_id) {
      cs.done = true;
      if let Err(e) = result {
        // A confirmation pause is expected — don't surface it as an error.
        if e != "__confirmation__" {
          cs.error = Some(e);
        }
      }
    }
  });
}

/// Resolve a paused agent tool call. When `approved`, the pending tool calls
/// are executed (sensitive commands are force-run); when declined, a rejection
/// result is fed back to the model. The agent loop then resumes from the
/// saved message context.
#[tauri::command]
pub async fn confirm_ai_tool(
  app: tauri::AppHandle,
  chat_id: String,
  approved: bool,
  read_only: bool,
  max_agent_rounds: u32,
) -> Result<(), String> {
  let state = app.state::<AppState>();
  let pending = {
    let mut guard = state.ai_pending.lock().map_err(|e| e.to_string())?;
    guard.take().ok_or("No pending tool confirmation.")?
  };
  if pending.chat_id != chat_id {
    return Err("Chat id mismatch for pending confirmation.".into());
  }

  // Resolve each pending call: execute if approved (force), else reject.
  // Note: read-only mode still blocks modifying commands even when approved —
  // the guard in `execute_one_tool` is independent of `force`.
  let mut results: Vec<crate::ai::ToolResult> = Vec::new();
  for call in &pending.calls {
    let result = if approved {
      // Pass the conversation's bound tab so `run_command` can type into the
      // terminal (and show the status badge) instead of silently executing.
      execute_one_tool(&app, &state, call, pending.current_tab_id, true, read_only)
        .await
        .unwrap_or_else(|e| serde_json::json!({ "error": e }).to_string())
    } else {
      serde_json::json!({ "error": "User declined to execute this command." }).to_string()
    };
    results.push((call.id.clone(), result));
  }

  // Append tool-result messages (mirrors run_agent_stream) and resume.
  let mut messages = pending.messages;
  for call in &pending.calls {
    let result = results
      .iter()
      .find(|(id, _)| id == &call.id)
      .map(|(_, r)| r.clone())
      .unwrap_or_else(|| "{\"error\":\"no result\"}".into());
    messages.push(crate::ai::AiMessage {
      role: "tool".into(),
      content: Some(result),
      tool_calls: None,
      tool_call_id: Some(call.id.clone()),
      name: Some(call.name.clone()),
      images: None,
    });
  }

  // Reset the chat buffer so the resumed loop can append cleanly.
  {
    let mut guard = state.ai_chat_buffers.lock().map_err(|e| e.to_string())?;
    if let Some(cs) = guard.get_mut(&chat_id) {
      cs.done = false;
      cs.error = None;
    }
  }

  // Reuse the same pause handler so chained sensitive calls keep asking.
  let pending_tab = pending.current_tab_id;
  let on_confirm = {
    let app2 = app.clone();
    let cid2 = chat_id.clone();
    let conf2 = pending.config.clone();
    let ro = read_only;
    let fmt = pending.tool_call_format.clone();
    move |msgs: Vec<crate::ai::AiMessage>, calls: Vec<crate::ai::OpenAiToolCall>| {
      save_pending(&app2, &cid2, &conf2, msgs, calls, ro, &fmt, pending_tab);
    }
  };
  spawn_agent(
    app,
    chat_id,
    pending.config,
    pending.tool_call_format,
    messages,
    None,
    read_only,
    on_confirm,
    max_agent_rounds as usize,
  );
  Ok(())
}


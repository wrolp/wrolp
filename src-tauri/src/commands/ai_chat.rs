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

// The Docker container commands — analyse, logs (one-shot and streaming), start / stop /
// restart / remove — live in `commands/docker.rs`, where they take a `DockerHostRef`
// instead of a jump-host `tab_id` and so can reach a container on this machine too.

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

/// Open the application data directory (the effective data root, honoring a
/// relocated data directory) in the system file manager (e.g. Explorer on
/// Windows). Avoids the frontend shell-plugin `open` scope which only allows
/// URLs by default.
#[tauri::command]
pub fn open_config_dir(state: tauri::State<'_, AppState>) -> Result<(), String> {
  let dir = data_dir_for(state.base_dir.as_deref())
    .ok_or_else(|| "Config directory not found".to_string())?;
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
    state
      .ai_chat_buffers
      .lock()
      .unwrap()
      .insert(cid.clone(), AiChatState::new(cid.clone()));
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
      if let Some(cs) = guard.get_mut(&cid).filter(|cs| cs.is_active()) {
        cs.chunks.push(chunk);
      }
    })
    .await;

    let state = app_clone.state::<AppState>();
    let mut guard = state.ai_chat_buffers.lock().unwrap();
    // Legacy text-only streaming keeps an empty flow and its original result.
    if let Some(cs) = guard.get_mut(&cid).filter(|cs| cs.is_active()) {
      cs.done = true;
      if let Err(e) = result {
        cs.error = Some(e);
      }
    }
  });

  Ok(chat_id)
}

/// Returns `(new_text, done, error, tool_events, flow_events)`; only terminal
/// entries are removed. A confirmation pause stays alive across empty polls.
#[tauri::command]
pub async fn poll_ai_chunks(
  state: tauri::State<'_, AppState>,
  chat_id: String,
) -> Result<Option<ai::AiChatPoll>, String> {
  let mut guard = state.ai_chat_buffers.lock().unwrap();
  let result = guard.get_mut(&chat_id).map(AiChatState::drain_poll);
  if result.as_ref().is_some_and(|r| r.1) {
    guard.remove(&chat_id);
  }
  Ok(result)
}

/// Stop future requests/tools and publish one terminal event. A system command
/// that is already executing is not killed or rolled back.
#[tauri::command]
pub fn cancel_ai_chat(state: tauri::State<'_, AppState>, chat_id: String) -> Result<(), String> {
  // All paths that need both locks use buffers -> pending, including save/resume.
  let mut guard = state.ai_chat_buffers.lock().map_err(|e| e.to_string())?;
  let mut pending = state.ai_pending.lock().map_err(|e| e.to_string())?;
  if let Some(cs) = guard.get_mut(&chat_id) {
    cs.record_phase(ai::AiFlowPhase::Cancelled);
  }
  if pending.as_ref().is_some_and(|p| p.chat_id == chat_id) {
    *pending = None;
  }
  Ok(())
}

fn agent_is_running(app: &tauri::AppHandle, chat_id: &str) -> bool {
  app
    .state::<AppState>()
    .ai_chat_buffers
    .lock()
    .map(|g| g.get(chat_id).is_some_and(AiChatState::is_active))
    .unwrap_or(false)
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
  ai_mode: String,
  max_agent_rounds: u32,
  tool_call_format: Option<String>,
) -> Result<String, String> {
  // Parse the mode string: only "chat" disables tools; everything else keeps tools enabled.
  let tools_enabled = ai_mode != "chat";
  // Normalize ai_mode for downstream use
  let ai_mode = match ai_mode.as_str() {
    "chat" => "chat".to_string(),
    "read_only" => "read_only".to_string(),
    _ => "command".to_string(),
  };
  let chat_id = {
    let state = app.state::<AppState>();
    let cid = Uuid::new_v4().to_string();
    state
      .ai_chat_buffers
      .lock()
      .unwrap()
      .insert(cid.clone(), AiChatState::new(cid.clone()));
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
  let shell_bound = current_tab_id.is_some();
  let current_server_context =
    current_tab_id.and_then(|tid| build_current_server_context(&app, tid));

  // Inject the current server context (and, depending on mode, a mode note)
  // into the system message so the model always knows which server this
  // conversation is bound to and whether it may run tools / modify the system.
  let mode_note = match ai_mode.as_str() {
    "chat" => Some(
      "MODE: Chat-only mode is ENABLED. Tool execution is DISABLED. You MUST respond with \
             plain text only — do NOT attempt to call any tools or run any commands. \
             If the user asks you to run a command, explain that you cannot in this mode."
        .to_string(),
    ),
    "read_only" => Some(
      "MODE: Read-only mode is ENABLED. You may ONLY run read-only / inspection commands \
             (status, logs, file reads, analysis). Do NOT attempt to modify the system: no writes, \
             no installs, no service changes, no file edits, and no destructive commands."
        .to_string(),
    ),
    _ => None,
  };
  // An unbound conversation (the global chat) has no shell to act on, so it is
  // told so explicitly — otherwise the model invents a tabId and every call
  // resolves to nothing.
  let binding_note = if shell_bound {
    None
  } else {
    Some(
      "BINDING: this conversation is NOT bound to any terminal or server. Shell tools \
             (run_command, analyze_server, list_directory, read_file, search_help, \
             get_current_server) are NOT available to it and will be refused — never call \
             them and never guess a tabId. Answer from general knowledge and from the tools \
             you do have (list_connections, the app settings tools). When the user needs a \
             command actually run, tell them to open the AI pane docked inside a terminal."
        .to_string(),
    )
  };
  let messages_with_context: Vec<crate::ai::AiMessage> = {
    let mut extra = String::new();
    if let Some(ctx) = &current_server_context {
      extra.push_str(ctx);
      extra.push('\n');
    }
    if let Some(note) = &binding_note {
      extra.push_str(note);
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
    let mode = ai_mode.clone();
    move |msgs: Vec<crate::ai::AiMessage>, calls: Vec<crate::ai::OpenAiToolCall>| {
      save_pending(&app2, &cid2, &conf2, msgs, calls, mode.clone(), &fmt, tab)
    }
  };
  spawn_agent(
    app_clone,
    cid.clone(),
    config,
    tool_call_format,
    messages_with_context,
    current_tab_id,
    ai_mode,
    on_confirm,
    max_agent_rounds as usize,
    agent_tools(tools_enabled, shell_bound),
  );

  Ok(chat_id)
}

/// The tool list for one agent run. `None` means tools are off entirely (chat
/// mode) — different from "tools on, but no shell access", which is the unbound
/// registry. Both the start and the confirm/resume path go through here so a
/// conversation cannot regain shell tools by pausing on a confirmation.
fn agent_tools(tools_enabled: bool, shell_bound: bool) -> Option<Vec<crate::ai::OpenAiTool>> {
  if !tools_enabled {
    return None;
  }
  Some(if shell_bound {
    crate::ai::tool_definitions()
  } else {
    crate::ai::tool_definitions_unbound()
  })
}

/// Atomically persist a pause and enqueue fresh `needs-confirmation` events,
/// even if the earlier executing events have already been polled.
fn save_pending(
  app: &tauri::AppHandle,
  chat_id: &str,
  config: &crate::ai::AiEndpointProfile,
  messages: Vec<crate::ai::AiMessage>,
  calls: Vec<crate::ai::OpenAiToolCall>,
  ai_mode: String,
  tool_call_format: &str,
  current_tab_id: Option<u32>,
) -> Result<(), String> {
  let st = app.state::<AppState>();
  let mut buffers = st.ai_chat_buffers.lock().map_err(|e| e.to_string())?;
  let cs = buffers
    .get_mut(chat_id)
    .filter(|cs| cs.is_active())
    .ok_or("__cancelled__")?;
  let mut pending = st.ai_pending.lock().map_err(|e| e.to_string())?;
  if pending.as_ref().is_some_and(|p| p.chat_id != chat_id) {
    return Err("Another chat is awaiting tool confirmation.".into());
  }
  cs.pause_for_confirmation(&calls);
  *pending = Some(crate::ssh_session::AiPendingConfirm {
    chat_id: chat_id.to_string(),
    config: config.clone(),
    messages,
    calls,
    ai_mode,
    tool_call_format: tool_call_format.to_string(),
    current_tab_id,
  });
  Ok(())
}

fn take_pending_for_chat(
  pending: &mut Option<crate::ssh_session::AiPendingConfirm>,
  chat_id: &str,
) -> Result<crate::ssh_session::AiPendingConfirm, String> {
  match pending.as_ref() {
    None => Err("No pending tool confirmation.".into()),
    Some(p) if p.chat_id != chat_id => Err("Chat id mismatch for pending confirmation.".into()),
    Some(_) => Ok(pending.take().unwrap()),
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
  ai_mode: String,
  on_confirm: impl Fn(Vec<crate::ai::AiMessage>, Vec<crate::ai::OpenAiToolCall>) -> Result<(), String>
    + Send
    + 'static,
  max_rounds: usize,
  tools: Option<Vec<crate::ai::OpenAiTool>>,
) {
  // Parse mode → read_only flag for tool execution.
  let read_only = ai_mode == "read_only";
  tauri::async_runtime::spawn(async move {
    let result = crate::ai::run_agent_stream(
      &config,
      &tool_call_format,
      messages,
      |chunk| {
        let state = app.state::<AppState>();
        let mut guard = state.ai_chat_buffers.lock().unwrap();
        if let Some(cs) = guard.get_mut(&chat_id).filter(|cs| cs.is_active()) {
          cs.chunks.push(chunk);
        }
      },
      |event| {
        let state = app.state::<AppState>();
        let mut guard = state.ai_chat_buffers.lock().unwrap();
        if let Some(cs) = guard.get_mut(&chat_id).filter(|cs| cs.is_active()) {
          cs.tool_events.push(event);
        }
      },
      |calls| -> futures_util::future::BoxFuture<'static, Vec<crate::ai::ToolResult>> {
        let app = app.clone();
        let cid = chat_id.clone();
        let tab = current_tab_id;
        Box::pin(async move {
          // run_agent_stream supplies one call at a time; recheck on async entry.
          if !agent_is_running(&app, &cid) {
            return Vec::new();
          }
          execute_ai_tools(&app, calls, tab, read_only).await
        })
      },
      on_confirm,
      |phase, detail| {
        let state = app.state::<AppState>();
        if let Some(cs) = state.ai_chat_buffers.lock().unwrap().get_mut(&chat_id) {
          cs.record_phase_with_detail(phase, detail);
        };
      },
      || agent_is_running(&app, &chat_id),
      max_rounds,
      tools,
    )
    .await;

    let state = app.state::<AppState>();
    let mut guard = state.ai_chat_buffers.lock().unwrap();
    if let Some(cs) = guard.get_mut(&chat_id) {
      cs.finish_agent(result);
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
  ai_mode: String,
  max_agent_rounds: u32,
) -> Result<(), String> {
  let state = app.state::<AppState>();
  let pending = {
    let mut buffers = state.ai_chat_buffers.lock().map_err(|e| e.to_string())?;
    let cs = buffers
      .get_mut(&chat_id)
      .filter(|cs| cs.is_active())
      .ok_or("Chat is no longer active.")?;
    let mut guard = state.ai_pending.lock().map_err(|e| e.to_string())?;
    let pending = take_pending_for_chat(&mut guard, &chat_id)?;
    cs.record_phase_with_detail(
      ai::AiFlowPhase::Resume,
      Some(serde_json::json!({ "approved": approved })),
    );
    pending
  };

  // A mode change may restrict execution but cannot lift the saved run's guard.
  let ai_mode = if ai_mode == "chat" || pending.ai_mode == "chat" {
    "chat".to_string()
  } else if ai_mode == "read_only" || pending.ai_mode == "read_only" {
    "read_only".to_string()
  } else {
    "command".to_string()
  };
  let read_only = ai_mode == "read_only";
  let tools_enabled = ai_mode != "chat";
  let mut messages = pending.messages;
  let mut still_pending = Vec::new();
  for call in &pending.calls {
    if !agent_is_running(&app, &chat_id) {
      return Ok(());
    }
    let result = if !approved {
      serde_json::json!({ "error": "User declined to execute this command." }).to_string()
    } else if !tools_enabled {
      serde_json::json!({ "error": "Tool execution is disabled in chat mode." }).to_string()
    } else {
      // No lock spans tool IO. The unbound/read-only gates remain in execute_one_tool.
      execute_one_tool(&app, &state, call, pending.current_tab_id, true, read_only)
        .await
        .unwrap_or_else(|e| serde_json::json!({ "error": e }).to_string())
    };
    if !agent_is_running(&app, &chat_id) {
      return Ok(());
    }
    if ai::tool_needs_confirmation(&result) {
      still_pending.push(call.clone());
      continue;
    }
    ai::append_tool_result(&mut messages, call, result.clone());
    let mut buffers = state.ai_chat_buffers.lock().map_err(|e| e.to_string())?;
    if let Some(cs) = buffers.get_mut(&chat_id).filter(|cs| cs.is_active()) {
      cs.tool_events
        .push(ai::tool_result_event(call, result, !approved));
    }
  }
  if !still_pending.is_empty() {
    let result = save_pending(
      &app,
      &chat_id,
      &pending.config,
      messages,
      still_pending,
      ai_mode,
      &pending.tool_call_format,
      pending.current_tab_id,
    );
    if let Err(e) = &result {
      if let Some(cs) = state.ai_chat_buffers.lock().unwrap().get_mut(&chat_id) {
        cs.finish_agent(Err(e.clone()));
      }
    }
    return result;
  }
  if !agent_is_running(&app, &chat_id) {
    return Ok(());
  }

  // Reuse the same pause handler so chained sensitive calls keep asking.
  let pending_tab = pending.current_tab_id;
  let on_confirm = {
    let app2 = app.clone();
    let cid2 = chat_id.clone();
    let conf2 = pending.config.clone();
    let mode = ai_mode.clone();
    let fmt = pending.tool_call_format.clone();
    move |msgs: Vec<crate::ai::AiMessage>, calls: Vec<crate::ai::OpenAiToolCall>| {
      save_pending(
        &app2,
        &cid2,
        &conf2,
        msgs,
        calls,
        mode.clone(),
        &fmt,
        pending_tab,
      )
    }
  };
  spawn_agent(
    app,
    chat_id,
    pending.config,
    pending.tool_call_format,
    messages,
    // Keep the conversation's shell binding across the pause: dropping it here
    // would leave the resumed rounds without a terminal to type into.
    pending_tab,
    ai_mode,
    on_confirm,
    max_agent_rounds as usize,
    agent_tools(tools_enabled, pending_tab.is_some()),
  );
  Ok(())
}

#[cfg(test)]
mod ai_flow_tests {
  use super::*;

  #[test]
  fn ai_flow_mismatched_confirm_keeps_other_chat_pending() {
    let mut pending = Some(crate::ssh_session::AiPendingConfirm {
      chat_id: "owner".into(),
      config: ai::AiEndpointProfile::new("test".into(), "http://127.0.0.1".into()),
      messages: Vec::new(),
      calls: Vec::new(),
      ai_mode: "command".into(),
      tool_call_format: "nested".into(),
      current_tab_id: None,
    });
    assert!(take_pending_for_chat(&mut pending, "other").is_err());
    assert_eq!(pending.as_ref().unwrap().chat_id, "owner");
    assert!(take_pending_for_chat(&mut pending, "owner").is_ok());
    assert!(pending.is_none());
    assert!(take_pending_for_chat(&mut pending, "owner").is_err());
  }

  #[test]
  fn ai_flow_chat_and_unbound_registries_stay_restricted() {
    assert!(agent_tools(false, true).is_none());
    assert!(agent_tools(false, false).is_none());
    assert!(agent_tools(true, false)
      .unwrap()
      .iter()
      .all(|tool| !ai::is_shell_tool(&tool.function.name)));
  }
}

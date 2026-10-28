//! OpenAI-compatible AI chat integration.
//!
//! Supports any API that follows the OpenAI chat completions format, including
//! OpenAI, Anthropic (via compatible proxies), local LLMs (Ollama/vLLM), etc.
//!
//! Configuration is persisted to `ai_config.json` in the app data directory.
//! The API key is encrypted using the same AES-256-GCM vault as connections.

use futures_util::StreamExt;
use serde::{Deserialize, Deserializer, Serialize};
use std::path::PathBuf;

// ---- AI Config ----

/// A single AI provider endpoint configuration (a "profile").
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiEndpointProfile {
  /// Stable unique id (UUID) used to reference / activate this profile.
  pub id: String,
  /// User-facing label shown in the settings profile list.
  pub name: String,
  /// API endpoint base URL (e.g. "https://api.openai.com/v1")
  pub endpoint: String,
  /// AES-GCM encrypted API key blob (base64 nonce || ciphertext), or empty if
  /// the key was cleared / never set.
  pub api_key_enc: String,
  /// Model name (e.g. "gpt-4o", "claude-sonnet-4-20250514")
  pub model: String,
  /// Tool call response format expected from this endpoint: "nested" (standard
  /// OpenAI `tool_calls[].function.{name,arguments}`) or "flat" (`tool_calls[]`
  /// items carrying `name`/`arguments` directly). Defaults to "nested".
  #[serde(default = "default_tool_call_format")]
  pub tool_call_format: String,
  /// System prompt for the AI assistant
  #[serde(default = "default_system_prompt")]
  pub system_prompt: String,
}

fn default_system_prompt() -> String {
  "You are a helpful AI assistant integrated into Wrolp Terminal, a remote \
     server management tool. You help users with system administration, \
     command-line operations, debugging, and understanding server \
     configurations. Be concise and practical."
    .to_string()
}

fn default_tool_call_format() -> String {
  "nested".to_string()
}

impl AiEndpointProfile {
  pub fn new(name: String, endpoint: String) -> Self {
    Self {
      id: uuid::Uuid::new_v4().to_string(),
      name,
      endpoint,
      api_key_enc: String::new(),
      model: "gpt-4o".to_string(),
      tool_call_format: default_tool_call_format(),
      system_prompt: default_system_prompt(),
    }
  }
}

/// Container holding all saved endpoint profiles plus which one is active.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConfig {
  pub profiles: Vec<AiEndpointProfile>,
  /// Id of the active profile. If empty/invalid, the first profile is used.
  #[serde(default)]
  pub active_id: String,
  /// Default AI chat mode when a chat is opened. "chat" (plain text only, no
  /// tools), "command" (full access, all commands allowed), or "read_only"
  /// (inspection commands only). Configurable in the global AI settings; the
  /// per-chat panel can change it. Defaults to "command" so a fresh install
  /// starts with full access. Accepts the legacy `readOnly` bool field for
  /// backward compatibility: `true` → "read_only", `false` → "command".
  #[serde(
    default = "default_mode_command",
    deserialize_with = "deserialize_mode_compat"
  )]
  pub default_mode: String,
  /// When true, `run_command` types the command into the tab's live terminal
  /// (visible on screen + captured in the session recording) instead of running
  /// it silently on a separate exec channel. Falls back to the silent path
  /// automatically when the tab has no live shell.
  #[serde(default = "default_true")]
  pub run_in_terminal: bool,
  /// Maximum number of agent-loop rounds (one assistant turn plus its tool
  /// calls) for a single AI run. Guards against runaway loops. Defaults to 200.
  #[serde(default = "default_max_agent_rounds")]
  pub max_agent_rounds: u32,
}

/// Serde default for boolean `AiConfig` flags that are on by default.
fn default_true() -> bool {
  true
}

/// Serde default for the `default_mode` field.
fn default_mode_command() -> String {
  "command".to_string()
}

/// Custom deserializer for `default_mode` that accepts both the new string
/// values ("chat", "command", "read_only") and the legacy boolean `readOnly`
/// field: `true` maps to "read_only", `false` maps to "command". This lets
/// existing config files deserialize correctly after the rename.
fn deserialize_mode_compat<'de, D>(deserializer: D) -> Result<String, D::Error>
where
  D: Deserializer<'de>,
{
  let val = serde_json::Value::deserialize(deserializer)?;
  match val {
    serde_json::Value::String(s) => Ok(s),
    serde_json::Value::Bool(b) => Ok(if b {
      "read_only".to_string()
    } else {
      "command".to_string()
    }),
    _ => Err(serde::de::Error::custom(format!(
      "default_mode: expected string or bool, got {:?}",
      val
    ))),
  }
}

/// Serde default for `max_agent_rounds`.
fn default_max_agent_rounds() -> u32 {
  200
}

impl AiConfig {
  /// The profile currently selected for use, or `None` if there are no
  /// profiles at all.
  pub fn active_profile(&self) -> Option<&AiEndpointProfile> {
    if self.profiles.is_empty() {
      return None;
    }
    if !self.active_id.is_empty() {
      if let Some(p) = self.profiles.iter().find(|p| p.id == self.active_id) {
        return Some(p);
      }
    }
    self.profiles.first()
  }

  pub fn default_config() -> Self {
    let profile = AiEndpointProfile {
      id: uuid::Uuid::new_v4().to_string(),
      name: "Default".to_string(),
      endpoint: "https://api.openai.com/v1".to_string(),
      api_key_enc: String::new(),
      model: "gpt-4o".to_string(),
      tool_call_format: default_tool_call_format(),
      system_prompt: default_system_prompt(),
    };
    let active_id = profile.id.clone();
    Self {
      profiles: vec![profile],
      active_id,
      default_mode: "command".to_string(),
      run_in_terminal: true,
      max_agent_rounds: default_max_agent_rounds(),
    }
  }
}

// ---- AI Messages (public DTO) ----

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiMessage {
  pub role: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub content: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub tool_calls: Option<Vec<OpenAiToolCall>>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub tool_call_id: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub name: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub images: Option<Vec<String>>,
}

// ---- Per-chat streaming state (stored in AppState) ----

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiFlowEvent {
  pub seq: u32,
  pub round: u32,
  pub phase: String,
  pub elapsed_ms: u64,
  /// Optional Phase-specific payload (request params, tool calls, ...).
  /// Must never contain credentials, the system prompt, or message bodies.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub detail: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AiFlowPhase {
  Request,
  Response,
  Tools,
  Confirmation,
  Resume,
  Completed,
  Error,
  Cancelled,
}

impl AiFlowPhase {
  fn as_str(self) -> &'static str {
    match self {
      Self::Request => "request",
      Self::Response => "response",
      Self::Tools => "tools",
      Self::Confirmation => "confirmation",
      Self::Resume => "resume",
      Self::Completed => "completed",
      Self::Error => "error",
      Self::Cancelled => "cancelled",
    }
  }

  fn is_terminal(self) -> bool {
    matches!(self, Self::Completed | Self::Error | Self::Cancelled)
  }
}

/// Flow detail payload for tool batches: names + raw JSON arguments only.
/// Deliberately omits call ids so the graph stays readable.
fn tool_calls_detail(calls: &[OpenAiToolCall]) -> serde_json::Value {
  serde_json::json!({
    "calls": calls
      .iter()
      .map(|call| serde_json::json!({
        "name": call.name,
        "arguments": call.arguments,
      }))
      .collect::<Vec<_>>(),
  })
}

/// Runtime-only trace: draining events must not reset the clock or counters.
#[derive(Debug, Clone)]
pub struct AiFlowTrace {
  started: std::time::Instant,
  seq: u32,
  round: u32,
  terminal: bool,
  events: Vec<AiFlowEvent>,
}

impl Default for AiFlowTrace {
  fn default() -> Self {
    Self {
      started: std::time::Instant::now(),
      seq: 0,
      round: 0,
      terminal: false,
      events: Vec::new(),
    }
  }
}

pub type AiChatPoll = (
  String,
  bool,
  Option<String>,
  Vec<ToolCallEvent>,
  Vec<AiFlowEvent>,
);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatState {
  pub chat_id: String,
  /// Accumulated text chunks received from the streaming response.
  pub chunks: Vec<String>,
  /// True when the stream has completed (either normally or with an error).
  pub done: bool,
  /// Error message if the stream ended with an error.
  pub error: Option<String>,
  /// Tool-call events emitted during the agent loop (for UI display).
  #[serde(default)]
  pub tool_events: Vec<ToolCallEvent>,
  /// Cancellation prevents further requests/tools, but cannot undo a running command.
  #[serde(default)]
  pub cancelled: bool,
  #[serde(skip)]
  pub flow: AiFlowTrace,
}

impl AiChatState {
  pub fn new(chat_id: String) -> Self {
    Self {
      chat_id,
      chunks: Vec::new(),
      done: false,
      error: None,
      tool_events: Vec::new(),
      cancelled: false,
      flow: AiFlowTrace::default(),
    }
  }

  pub fn is_active(&self) -> bool {
    !self.done && !self.cancelled
  }

  pub fn record_phase(&mut self, phase: AiFlowPhase) {
    self.record_phase_with_detail(phase, None);
  }

  pub fn record_phase_with_detail(
    &mut self,
    phase: AiFlowPhase,
    detail: Option<serde_json::Value>,
  ) {
    if !self.is_active() || self.flow.terminal {
      return;
    }
    if phase == AiFlowPhase::Request {
      self.flow.round = self.flow.round.saturating_add(1);
    }
    self.flow.seq = self.flow.seq.saturating_add(1);
    self.flow.events.push(AiFlowEvent {
      seq: self.flow.seq,
      round: self.flow.round,
      phase: phase.as_str().into(),
      elapsed_ms: self
        .flow
        .started
        .elapsed()
        .as_millis()
        .min(u64::MAX as u128) as u64,
      detail,
    });
    if phase.is_terminal() {
      self.flow.terminal = true;
      self.done = true;
      self.cancelled = phase == AiFlowPhase::Cancelled;
    }
  }

  pub fn pause_for_confirmation(&mut self, calls: &[OpenAiToolCall]) {
    if !self.is_active() {
      return;
    }
    // Executing events may already have been polled; always enqueue new events.
    for call in calls {
      self.tool_events.push(ToolCallEvent {
        id: call.id.clone(),
        name: call.name.clone(),
        arguments: call.arguments.clone(),
        status: "needs-confirmation".into(),
        result: None,
        error: None,
      });
    }
    self.record_phase_with_detail(AiFlowPhase::Confirmation, Some(tool_calls_detail(calls)));
  }

  pub fn finish_agent(&mut self, result: Result<AiMessage, String>) {
    if !self.is_active() {
      return;
    }
    match result {
      Ok(_) => self.record_phase(AiFlowPhase::Completed),
      Err(e) if e == "__confirmation__" => {}
      Err(e) if e == "__cancelled__" => self.record_phase(AiFlowPhase::Cancelled),
      Err(e) => {
        self.error = Some(e);
        self.record_phase(AiFlowPhase::Error);
      }
    }
  }

  pub fn drain_poll(&mut self) -> AiChatPoll {
    (
      self.chunks.drain(..).collect(),
      self.done || self.cancelled,
      self.error.clone(),
      std::mem::take(&mut self.tool_events),
      std::mem::take(&mut self.flow.events),
    )
  }
}

// ---- Path helpers ----

fn data_dir() -> Option<PathBuf> {
  dirs::config_dir().map(|p| p.join("wrolp-terminal"))
}

fn ai_config_path() -> Option<PathBuf> {
  data_dir().map(|p| p.join("ai_config.json"))
}

fn ai_config_path_in(base_dir: &std::path::Path) -> PathBuf {
  base_dir.join("ai_config.json")
}

// ---- Config persistence ----

pub fn load_ai_config() -> Result<AiConfig, String> {
  load_ai_config_in(None)
}

/// Load the AI config, optionally resolving it under an explicit base dir
/// (test override — see `AppState::new_with_base`).
pub fn load_ai_config_in(base_dir: Option<&std::path::Path>) -> Result<AiConfig, String> {
  let path = base_dir.map(ai_config_path_in).or_else(ai_config_path);
  let path = path.ok_or_else(|| "cannot resolve config dir".to_string())?;
  if path.exists() {
    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    // Try the new multi-profile format first.
    match serde_json::from_str::<AiConfig>(&content) {
      Ok(config) => {
        if config.profiles.is_empty() {
          return Ok(AiConfig::default_config());
        }
        Ok(config)
      }
      // Migrate legacy single-endpoint format ({ endpoint, apiKeyEnc, model, systemPrompt }).
      Err(_) => match serde_json::from_str::<LegacyAiConfig>(&content) {
        Ok(legacy) => {
          let profile = AiEndpointProfile {
            id: uuid::Uuid::new_v4().to_string(),
            name: "Default".to_string(),
            endpoint: legacy.endpoint,
            api_key_enc: legacy.api_key_enc,
            model: legacy.model,
            tool_call_format: default_tool_call_format(),
            system_prompt: legacy.system_prompt,
          };
          let active_id = profile.id.clone();
          Ok(AiConfig {
            profiles: vec![profile],
            active_id,
            default_mode: "command".to_string(),
            run_in_terminal: true,
            max_agent_rounds: default_max_agent_rounds(),
          })
        }
        Err(e) => Err(format!("Failed to parse AI config: {}", e)),
      },
    }
  } else {
    Ok(AiConfig::default_config())
  }
}

/// Legacy (pre multi-profile) single-endpoint config shape, used only for
/// one-time migration of existing `ai_config.json` files.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyAiConfig {
  endpoint: String,
  #[serde(default)]
  api_key_enc: String,
  #[serde(default)]
  model: String,
  #[serde(default = "default_system_prompt")]
  system_prompt: String,
}

pub fn save_ai_config(config: &AiConfig) -> Result<(), String> {
  let path = ai_config_path().ok_or_else(|| "cannot resolve config dir".to_string())?;
  if let Some(parent) = path.parent() {
    let _ = std::fs::create_dir_all(parent);
  }
  let content = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
  std::fs::write(&path, content).map_err(|e| e.to_string())
}

// ---- Internal OpenAI API types ----

#[derive(Serialize)]
struct OpenAiRequest {
  model: String,
  messages: Vec<OpenAiMessage>,
  stream: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  max_tokens: Option<u32>,
  #[serde(skip_serializing_if = "Option::is_none")]
  temperature: Option<f64>,
  #[serde(skip_serializing_if = "Option::is_none")]
  tools: Option<Vec<OpenAiTool>>,
}

#[derive(Serialize)]
struct OpenAiMessage {
  role: String,
  // NOTE: must NOT skip when None. Models like gpt-oss reject a missing
  // `content` field and require it to be an explicit string or `null`
  // (an assistant message carrying tool_calls uses `null`). When the message
  // carries images the content is a multimodal array:
  //   [{"type":"text","text":"..."},{"type":"image_url","image_url":{"url":"data:..."}}]
  content: Option<serde_json::Value>,
  // Serialized according to the endpoint's `tool_call_format`: `nested`
  // (standard OpenAI `{id, type, function:{name,arguments}}`) or `flat`
  // (`{id, type, name, arguments}`). Kept as raw JSON because the shape
  // depends on the format chosen per conversation.
  #[serde(skip_serializing_if = "Option::is_none")]
  tool_calls: Option<Vec<serde_json::Value>>,
  #[serde(skip_serializing_if = "Option::is_none")]
  tool_call_id: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  name: Option<String>,
}

// `pub` because the agent spawner in `commands::ai_chat` threads a chosen
// registry through `spawn_agent`, which names this type in its signature.
#[derive(Serialize, Clone)]
pub struct OpenAiTool {
  #[serde(rename = "type")]
  pub tool_type: String,
  pub function: OpenAiFunction,
}

#[derive(Serialize, Clone)]
pub struct OpenAiFunction {
  pub name: String,
  pub description: String,
  pub parameters: serde_json::Value,
}

// Streaming response chunks (also used for tool-call deltas)
#[derive(Deserialize)]
struct OpenAiStreamChunk {
  choices: Option<Vec<OpenAiStreamChoice>>,
}

#[derive(Deserialize, Clone)]
struct OpenAiStreamChoice {
  delta: Option<OpenAiStreamDelta>,
  #[serde(default)]
  finish_reason: Option<String>,
}

#[derive(Deserialize, Clone)]
struct OpenAiStreamDelta {
  #[serde(default)]
  role: Option<String>,
  #[serde(default)]
  content: Option<String>,
  #[serde(default)]
  tool_calls: Option<Vec<OpenAiStreamToolCallDelta>>,
}

#[derive(Deserialize, Clone)]
struct OpenAiStreamToolCallDelta {
  #[serde(default)]
  index: usize,
  #[serde(default)]
  id: Option<String>,
  #[serde(default)]
  #[serde(rename = "type")]
  tool_type: Option<String>,
  #[serde(default)]
  function: Option<OpenAiStreamFunctionDelta>,
  // Flat format: `name`/`arguments` at the top level instead of nested in
  // `function`.
  #[serde(default)]
  name: Option<String>,
  #[serde(default)]
  arguments: Option<String>,
}

#[derive(Deserialize, Clone)]
struct OpenAiStreamFunctionDelta {
  #[serde(default)]
  name: Option<String>,
  #[serde(default)]
  arguments: Option<String>,
}

// Aggregated tool call (after reassembly from streaming deltas)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenAiToolCall {
  #[serde(default)]
  pub id: String,
  #[serde(default)]
  pub name: String,
  #[serde(default)]
  pub arguments: String,
}

// Non-streaming tool call (from tool_calls field on a message)
#[derive(Deserialize, Clone)]
struct OpenAiResponseToolCall {
  id: String,
  #[serde(rename = "type")]
  _type: Option<String>,
  function: OpenAiResponseFunction,
}

#[derive(Deserialize, Clone)]
struct OpenAiResponseFunction {
  name: String,
  arguments: String,
}

// ---- Tool calling ----

/// A tool-call event surfaced to the frontend during streaming.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallEvent {
  pub id: String,
  pub name: String,
  pub arguments: String,
  /// "pending" | "approved" | "executing" | "done" | "error" | "denied"
  pub status: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub result: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
}

/// Registry of tools the agent can call, dispatched by the frontend-facing loop.
///
/// Each entry maps a tool name to a description + JSON-schema parameters and is
/// executed by [`execute_tool`] which is implemented in `commands.rs` (it needs
/// `AppState` access). We keep the registry here so `ai.rs` owns the tool
/// definitions while `commands.rs` owns the execution side-effects.
pub fn tool_definitions() -> Vec<OpenAiTool> {
  vec![
    OpenAiTool {
      tool_type: "function".into(),
      function: OpenAiFunction {
        name: "run_command".into(),
        description:
          "Execute a shell command and return its output. The command is TYPED INTO THE \
                     TERMINAL BOUND TO THIS CONVERSATION: the user watches it run, it is saved in \
                     the session recording, and it inherits that shell's working directory, \
                     environment and sudo state. Pass the conversation's tabId from the server \
                     context (a bogus/0 tabId falls back to the bound terminal, or to silent local \
                     execution only when this conversation is not attached to any terminal). In \
                     terminal mode the result has `ranOnTerminal: true` and NO exit code (output \
                     is captured from the terminal stream); check `timedOut` to see whether the \
                     capture window closed early. Send ONE single-line command per call \
                     (multi-line scripts are rejected). Use for read-only or non-destructive \
                     operations (status, logs, inspections). Avoid destructive commands, and avoid \
                     long-running/interactive ones (top, tail -f, vim) — they will block the \
                     terminal. NOTE: when the assistant is in read-only mode, only inspection \
                     commands are permitted — modifying commands are blocked."
            .into(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "tabId": { "type": "integer", "description": "Tab id of the connected server from the current server context (0 falls back to the conversation's bound terminal)" },
                "command": { "type": "string", "description": "Shell command to execute" }
            },
            "required": ["tabId", "command"]
        }),
      },
    },
    OpenAiTool {
      tool_type: "function".into(),
      function: OpenAiFunction {
        name: "analyze_server".into(),
        description: "Run a comprehensive read-only analysis of a connected server (OS, kernel, \
                     arch, packages, installed tools). Returns structured analysis."
          .into(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "tabId": { "type": "integer", "description": "Tab id of the connected server" }
            },
            "required": ["tabId"]
        }),
      },
    },
    OpenAiTool {
      tool_type: "function".into(),
      function: OpenAiFunction {
        name: "list_directory".into(),
        description: "List files and directories at a remote path on a connected server.".into(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "tabId": { "type": "integer", "description": "Tab id of the connected server" },
                "path": { "type": "string", "description": "Remote directory path" }
            },
            "required": ["tabId", "path"]
        }),
      },
    },
    OpenAiTool {
      tool_type: "function".into(),
      function: OpenAiFunction {
        name: "read_file".into(),
        description: "Read the contents of a text file on a connected server (truncated to 64KB)."
          .into(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "tabId": { "type": "integer", "description": "Tab id of the connected server" },
                "path": { "type": "string", "description": "Remote file path" }
            },
            "required": ["tabId", "path"]
        }),
      },
    },
    OpenAiTool {
      tool_type: "function".into(),
      function: OpenAiFunction {
        name: "list_connections".into(),
        description: "List all saved connection profiles in the app (id, name, host, user, group)."
          .into(),
        parameters: serde_json::json!({ "type": "object", "properties": {} }),
      },
    },
    OpenAiTool {
      tool_type: "function".into(),
      function: OpenAiFunction {
        name: "search_help".into(),
        description: "Look up the man-page / help text for a command available on a connected \
                     server (e.g. to learn the right flags before running it)."
          .into(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "tabId": { "type": "integer", "description": "Tab id of the connected server" },
                "command": { "type": "string", "description": "Command whose help to fetch" }
            },
            "required": ["tabId", "command"]
        }),
      },
    },
    OpenAiTool {
      tool_type: "function".into(),
      function: OpenAiFunction {
        name: "get_current_server".into(),
        description: "Get information about the server this AI conversation is currently bound to \
                     (the shell tab it was opened from) — host, port, username, connection status, \
                     and the current working directory. Use this to confirm which server you are \
                     operating on; no tabId argument is needed."
          .into(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {},
            "required": []
        }),
      },
    },
    OpenAiTool {
      tool_type: "function".into(),
      function: OpenAiFunction {
        name: "get_ui_settings".into(),
        description: "Read the app's current display/appearance settings (theme mode, terminal \
                     colour palette, terminal font & cursor, terminal output highlight scheme and \
                     per-category colours, UI language). ALWAYS call this before set_ui_settings so \
                     you use valid keys and values — the returned list is the ONLY set of keys you \
                     may change. Read-only; safe to call anytime."
          .into(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "keys": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Optional subset of setting keys; omit to get everything."
                }
            },
            "required": []
        }),
      },
    },
    OpenAiTool {
      tool_type: "function".into(),
      function: OpenAiFunction {
        name: "set_ui_settings".into(),
        description: "Change the app's display/appearance settings — theme mode (dark/light/system), \
                     terminal colour palette, terminal font size/family/line-height, terminal cursor, \
                     terminal output highlight scheme or per-category colours, UI language. Changes \
                     apply LIVE to all open terminals/editors. Only keys returned by get_ui_settings \
                     are accepted; values are validated (hex colours, enums, numeric ranges). Prefer \
                     small, coherent changes and briefly tell the user what you changed."
          .into(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "changes": {
                    "type": "object",
                    "description": "Map of setting key → new value, e.g. {\"theme.mode\":\"light\",\"terminal.fontSize\":16}"
                },
                "reason": {
                    "type": "string",
                    "description": "One short sentence for the user explaining why (shown in the tool card)."
                }
            },
            "required": ["changes"]
        }),
      },
    },
    OpenAiTool {
      tool_type: "function".into(),
      function: OpenAiFunction {
        name: "reset_ui_settings".into(),
        description: "Reset display/appearance settings to their defaults. Pass `keys` to reset only \
                     those, or omit to reset every setting. Requires user confirmation. Returns the \
                     applied/previous values and an undoId."
          .into(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "keys": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Optional subset of setting keys to reset; omit to reset everything."
                }
            },
            "required": []
        }),
      },
    },
  ]
}

/// Tools that act on a live shell — they run commands or read from a session,
/// so they only make sense for a conversation bound to a terminal tab.
pub const SHELL_TOOL_NAMES: &[&str] = &[
  "run_command",
  "analyze_server",
  "list_directory",
  "read_file",
  "search_help",
  "get_current_server",
];

pub fn is_shell_tool(name: &str) -> bool {
  SHELL_TOOL_NAMES.contains(&name)
}

/// The tool registry for a conversation with no shell binding (the global chat).
/// Hiding these is advisory — `execute_one_tool` refuses them regardless — but a
/// model that never sees the schema is far less likely to invent a tab id.
pub fn tool_definitions_unbound() -> Vec<OpenAiTool> {
  tool_definitions()
    .into_iter()
    .filter(|t| !is_shell_tool(&t.function.name))
    .collect()
}

// Non-streaming response
#[derive(Deserialize)]
struct OpenAiResponse {
  choices: Vec<OpenAiChoice>,
}

#[derive(Deserialize)]
struct OpenAiChoice {
  message: OpenAiMessageResponse,
}

#[derive(Deserialize)]
struct OpenAiMessageResponse {
  content: String,
}

// Error response
#[derive(Deserialize)]
struct OpenAiErrorResponse {
  error: OpenAiErrorDetail,
}

#[derive(Deserialize)]
struct OpenAiErrorDetail {
  message: String,
}

/// Build the chat-completions URL from the configured endpoint.
fn chat_url(endpoint: &str) -> String {
  format!("{}/chat/completions", endpoint.trim_end_matches('/'))
}

// ---- AI request logging ----
//
// The backend has no `log`/`tracing` framework (see CODEBUDDY.md), so AI
// requests are logged via `eprintln!` to stderr, which surfaces in the
// `yarn tauri dev` terminal. Requests are printed as pretty-printed JSON with
// the full original message content; keys / strings / numbers are colorized
// with ANSI escapes. Set the `NO_COLOR` env var to disable colors.

const C_RESET: &str = "\x1b[0m";
const C_KEY: &str = "\x1b[36m"; // JSON keys
const C_STR: &str = "\x1b[32m"; // JSON string values
const C_NUM: &str = "\x1b[33m"; // JSON numbers / booleans
const C_NULL: &str = "\x1b[35m"; // JSON null
const C_PUNCT: &str = "\x1b[90m"; // JSON punctuation
const C_HEAD: &str = "\x1b[36m"; // log header lines
const C_OK: &str = "\x1b[32m"; // successful result
const C_ERR: &str = "\x1b[31m"; // error result
const C_WARN: &str = "\x1b[33m"; // warnings / tool names

/// ANSI colors are only emitted when not disabled via the `NO_COLOR` env var.
fn colors_enabled() -> bool {
  std::env::var("NO_COLOR").is_err()
}

/// Wrap `s` in the given ANSI color (no-op when colors are disabled).
fn paint(color: &str, s: &str) -> String {
  if colors_enabled() {
    format!("{color}{s}{C_RESET}")
  } else {
    s.to_string()
  }
}

/// Syntax-highlight a pretty-printed JSON document.
fn colorize_json(json: &str) -> String {
  if !colors_enabled() {
    return json.to_string();
  }
  use std::fmt::Write as _;
  let mut out = String::new();
  let mut it = json.chars().peekable();
  while let Some(c) = it.next() {
    match c {
      '"' => {
        let mut s = String::from("\"");
        let mut escaped = false;
        for ch in it.by_ref() {
          s.push(ch);
          if escaped {
            escaped = false;
          } else if ch == '\\' {
            escaped = true;
          } else if ch == '"' {
            break;
          }
        }
        // A string followed by `:` (after whitespace) is a key, not a value.
        let mut probe = it.clone();
        let mut is_key = false;
        for pc in probe.by_ref() {
          if pc.is_whitespace() {
            continue;
          }
          is_key = pc == ':';
          break;
        }
        let _ = write!(
          out,
          "{}{}{}",
          if is_key { C_KEY } else { C_STR },
          s,
          C_RESET
        );
      }
      '0'..='9' | '-' => {
        let mut num = String::new();
        num.push(c);
        while let Some(&nc) = it.peek() {
          if nc.is_ascii_digit() || matches!(nc, '.' | 'e' | 'E' | '+' | '-') {
            num.push(nc);
            it.next();
          } else {
            break;
          }
        }
        let _ = write!(out, "{C_NUM}{num}{C_RESET}");
      }
      't' | 'f' | 'n' => {
        let mut word = String::new();
        word.push(c);
        while let Some(&nc) = it.peek() {
          if nc.is_ascii_alphabetic() {
            word.push(nc);
            it.next();
          } else {
            break;
          }
        }
        let color = if word == "null" { C_NULL } else { C_NUM };
        let _ = write!(out, "{color}{word}{C_RESET}");
      }
      ':' => {
        let _ = write!(out, "{C_PUNCT}:{C_RESET}");
      }
      ',' => {
        let _ = write!(out, "{C_PUNCT},{C_RESET}");
      }
      _ => out.push(c),
    }
  }
  out
}

/// Max characters of a string value kept in AI request logs; longer strings
/// are truncated with a marker so huge contents (e.g. pasted terminal output)
/// don't flood the log.
const AI_LOG_MAX_STR: usize = 400;

/// Recursively truncate string values in a JSON document intended for logging.
/// The original JSON is never modified — this only affects the log copy.
fn truncate_json_for_log(v: &mut serde_json::Value) {
  match v {
    serde_json::Value::String(s) => {
      let len = s.chars().count();
      if len > AI_LOG_MAX_STR {
        let head: String = s.chars().take(AI_LOG_MAX_STR).collect();
        *s = format!("{head}…[+{} chars truncated]", len - AI_LOG_MAX_STR);
      }
    }
    serde_json::Value::Array(a) => {
      for item in a.iter_mut() {
        truncate_json_for_log(item);
      }
    }
    serde_json::Value::Object(o) => {
      for val in o.values_mut() {
        truncate_json_for_log(val);
      }
    }
    _ => {}
  }
}

/// Log the EXACT HTTP request body that is about to be sent to the API
/// (the serialized `OpenAiRequest` — messages already converted to the wire
/// format by `to_openai_messages`/`openai_content`, plus the tool list),
/// pretty-printed and colorized. String values longer than [`AI_LOG_MAX_STR`]
/// chars are truncated (the body passed here is only read, never modified).
fn log_ai_request(tag: &str, config: &AiEndpointProfile, body: &OpenAiRequest) {
  eprintln!(
    "{}",
    paint(
      C_HEAD,
      &format!(
        "[ai] {tag} REQUEST → model={} endpoint={} stream={} toolFormat={}",
        config.model, config.endpoint, body.stream, config.tool_call_format,
      ),
    )
  );
  if let Ok(mut value) = serde_json::to_value(body) {
    truncate_json_for_log(&mut value);
    if let Ok(pretty) = serde_json::to_string_pretty(&value) {
      eprintln!("{}", colorize_json(&pretty));
    }
  }
}

/// Log an AI request outcome (status, elapsed, output size, tool calls).
fn log_ai_result(tag: &str, status: &str, elapsed_ms: u128, out_chars: usize, tool_calls: usize) {
  let (color, arrow) = if status.starts_with("ok") {
    (C_OK, "←")
  } else if status.starts_with("error") {
    (C_ERR, "✖")
  } else if let Some(code) = status.strip_prefix("HTTP ") {
    if code.starts_with('4') || code.starts_with('5') {
      (C_ERR, "✖")
    } else {
      (C_OK, "←")
    }
  } else {
    (C_WARN, "←")
  };
  eprintln!(
    "{}",
    paint(
      color,
      &format!(
        "[ai] {tag} {arrow} {status} in {elapsed_ms}ms outChars={out_chars} toolCalls={tool_calls}"
      ),
    )
  );
}

/// Normalize an endpoint base URL and append `/models` (handling a trailing
/// `/v1`, `/` or full path gracefully).
fn models_url(endpoint: &str) -> String {
  let base = endpoint.trim_end_matches('/');
  format!("{}/models", base)
}

/// Query a provider's `/v1/models` (or `/models`) endpoint and return the list
/// of available model ids. The API key is decrypted from `api_key_enc`.
pub async fn fetch_models(api_key_enc: &str, endpoint: &str) -> Result<Vec<String>, String> {
  let api_key = if api_key_enc.is_empty() {
    String::new()
  } else {
    crate::vault::open_secret(api_key_enc)
      .map_err(|e| format!("Failed to decrypt API key: {}", e))?
  };
  let url = models_url(endpoint);
  let client = reqwest::Client::new();
  let mut builder = client.get(&url).header("Content-Type", "application/json");
  if !api_key.is_empty() {
    builder = builder.header("Authorization", format!("Bearer {}", api_key));
  }
  let response = builder
    .send()
    .await
    .map_err(|e| format!("Models request failed: {}", e))?;
  if !response.status().is_success() {
    let status = response.status().as_u16();
    let body = response.text().await.unwrap_or_default();
    return Err(format!("Models endpoint returned {}: {}", status, body));
  }
  let body: serde_json::Value = response
    .json()
    .await
    .map_err(|e| format!("Failed to parse models response: {}", e))?;
  let mut models: Vec<String> = Vec::new();
  if let Some(arr) = body.get("data").and_then(|v| v.as_array()) {
    for m in arr {
      if let Some(id) = m.get("id").and_then(|v| v.as_str()) {
        models.push(id.to_string());
      }
    }
  }
  if models.is_empty() {
    // Some providers return a bare array instead of { data: [...] }.
    if let Some(arr) = body.as_array() {
      for m in arr {
        if let Some(id) = m.get("id").and_then(|v| v.as_str()) {
          models.push(id.to_string());
        }
      }
    }
  }
  Ok(models)
}

// ---- Non-streaming chat ----

/// Send a non-streaming chat request. Returns the full assistant response text.
pub async fn ai_chat_sync(
  config: &AiEndpointProfile,
  messages: &[AiMessage],
) -> Result<String, String> {
  let api_key = crate::vault::open_secret(&config.api_key_enc)
    .map_err(|e| format!("Failed to decrypt API key: {}", e))?;

  let client = reqwest::Client::new();
  let request_body = OpenAiRequest {
    model: config.model.clone(),
    messages: messages
      .iter()
      .map(|m| OpenAiMessage {
        role: m.role.clone(),
        content: openai_content(m),
        tool_calls: None,
        tool_call_id: None,
        name: None,
      })
      .collect(),
    stream: false,
    max_tokens: Some(4096),
    temperature: Some(0.7),
    tools: None,
  };

  let started = std::time::Instant::now();
  log_ai_request("chat_sync", config, &request_body);

  let response = client
    .post(&chat_url(&config.endpoint))
    .header("Authorization", format!("Bearer {}", api_key))
    .header("Content-Type", "application/json")
    .json(&request_body)
    .send()
    .await
    .map_err(|e| {
      log_ai_result("chat_sync", "error", started.elapsed().as_millis(), 0, 0);
      format!("HTTP request failed: {}", e)
    })?;

  let status = response.status();
  let body_text = response.text().await.unwrap_or_default();

  if !status.is_success() {
    let msg = if let Ok(err) = serde_json::from_str::<OpenAiErrorResponse>(&body_text) {
      format!("API error ({}): {}", status, err.error.message)
    } else {
      format!("API error ({}): {}", status, body_text)
    };
    log_ai_result(
      "chat_sync",
      &format!("HTTP {}", status),
      started.elapsed().as_millis(),
      0,
      0,
    );
    return Err(msg);
  }

  let body: OpenAiResponse =
    serde_json::from_str(&body_text).map_err(|e| format!("Failed to parse response: {}", e))?;

  let content = body
    .choices
    .first()
    .map(|c| c.message.content.clone())
    .unwrap_or_default();

  log_ai_result(
    "chat_sync",
    "ok",
    started.elapsed().as_millis(),
    content.len(),
    0,
  );

  Ok(content)
}

// ---- Streaming chat ----

/// Execute a streaming chat request, calling `on_chunk` for each text delta
/// received from the SSE stream. Returns an error if the HTTP request or
/// stream fails.
pub async fn execute_streaming_chat(
  config: &AiEndpointProfile,
  messages: &[AiMessage],
  mut on_chunk: impl FnMut(String),
) -> Result<(), String> {
  let api_key = crate::vault::open_secret(&config.api_key_enc)
    .map_err(|e| format!("Failed to decrypt API key: {}", e))?;

  let client = reqwest::ClientBuilder::new()
    .timeout(std::time::Duration::from_secs(120))
    .build()
    .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

  let request_body = OpenAiRequest {
    model: config.model.clone(),
    messages: messages
      .iter()
      .map(|m| OpenAiMessage {
        role: m.role.clone(),
        content: openai_content(m),
        tool_calls: None,
        tool_call_id: None,
        name: None,
      })
      .collect(),
    stream: true,
    max_tokens: Some(4096),
    temperature: Some(0.7),
    tools: None,
  };

  let started = std::time::Instant::now();
  log_ai_request("stream_chat", config, &request_body);

  let response = client
    .post(&chat_url(&config.endpoint))
    .header("Authorization", format!("Bearer {}", api_key))
    .header("Content-Type", "application/json")
    .json(&request_body)
    .send()
    .await
    .map_err(|e| {
      log_ai_result("stream_chat", "error", started.elapsed().as_millis(), 0, 0);
      format!("HTTP request failed: {}", e)
    })?;

  let status = response.status();
  if !status.is_success() {
    let body_text = response.text().await.unwrap_or_default();
    let msg = if let Ok(err) = serde_json::from_str::<OpenAiErrorResponse>(&body_text) {
      format!("API error ({}): {}", status, err.error.message)
    } else {
      format!("API error ({}): {}", status, body_text)
    };
    log_ai_result(
      "stream_chat",
      &format!("HTTP {}", status),
      started.elapsed().as_millis(),
      0,
      0,
    );
    return Err(msg);
  }

  // Read response body as a byte stream and parse SSE events.
  let mut byte_stream = response.bytes_stream();
  let mut line_buf = String::new();
  let mut out_chars: usize = 0;

  while let Some(chunk_result) = byte_stream.next().await {
    let chunk = chunk_result.map_err(|e| format!("Stream read error: {}", e))?;
    let text = String::from_utf8_lossy(&chunk);
    line_buf.push_str(&text);

    while let Some(nl) = line_buf.find('\n') {
      let line = line_buf[..nl].trim().to_string();
      line_buf = line_buf[nl + 1..].to_string();

      if let Some(data) = line.strip_prefix("data: ") {
        let data = data.trim();
        if data == "[DONE]" {
          log_ai_result(
            "stream_chat",
            "ok",
            started.elapsed().as_millis(),
            out_chars,
            0,
          );
          return Ok(());
        }
        if let Ok(chunk) = serde_json::from_str::<OpenAiStreamChunk>(data) {
          if let Some(content) = chunk
            .choices
            .and_then(|cs| cs.first().cloned())
            .and_then(|c| c.delta)
            .and_then(|d| d.content)
          {
            if !content.is_empty() {
              out_chars += content.chars().count();
              on_chunk(content);
            }
          }
        }
      }
    }
  }

  // Stream ended without explicit [DONE] — treat as success
  log_ai_result(
    "stream_chat",
    "ok",
    started.elapsed().as_millis(),
    out_chars,
    0,
  );
  Ok(())
}

// ---- Agent loop (streaming chat with tool calling) ----

/// Result returned by the tool executor: `(tool_call_id, result_text)`.
pub type ToolResult = (String, String);

pub fn tool_needs_confirmation(result: &str) -> bool {
  serde_json::from_str::<serde_json::Value>(result)
    .ok()
    .and_then(|v| v.get("needsConfirmation").and_then(|b| b.as_bool()))
    == Some(true)
}

pub fn tool_result_event(call: &OpenAiToolCall, result: String, denied: bool) -> ToolCallEvent {
  let error = serde_json::from_str::<serde_json::Value>(&result)
    .ok()
    .and_then(|v| v.get("error").filter(|e| !e.is_null()).cloned())
    .map(|e| {
      e.as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| e.to_string())
    });
  ToolCallEvent {
    id: call.id.clone(),
    name: call.name.clone(),
    arguments: call.arguments.clone(),
    status: if denied {
      "denied"
    } else if error.is_some() {
      "error"
    } else {
      "done"
    }
    .into(),
    result: Some(result),
    error,
  }
}

pub fn append_tool_result(messages: &mut Vec<AiMessage>, call: &OpenAiToolCall, result: String) {
  messages.push(AiMessage {
    role: "tool".into(),
    content: Some(result),
    tool_calls: None,
    tool_call_id: Some(call.id.clone()),
    name: Some(call.name.clone()),
    images: None,
  });
}

fn ensure_agent_running(is_running: &impl Fn() -> bool) -> Result<(), String> {
  if is_running() {
    Ok(())
  } else {
    Err("__cancelled__".into())
  }
}

/// Convert a public `AiMessage` into the OpenAI wire format, preserving
/// assistant tool-calls and tool-result messages.
/// Build the OpenAI `content` value for a message. Plain text messages use a
/// string; messages carrying images use a multimodal content array
/// (`text` + `image_url` parts). (A message that *only* carries tool calls is
/// handled separately in `to_openai_messages`, where its `content` becomes an
/// empty string instead of `null`.)
fn openai_content(m: &AiMessage) -> Option<serde_json::Value> {
  let has_images = m.images.as_ref().map(|v| !v.is_empty()).unwrap_or(false);
  if !has_images {
    return m.content.clone().map(serde_json::Value::String);
  }
  let mut parts: Vec<serde_json::Value> = Vec::new();
  if let Some(text) = m.content.as_ref() {
    if !text.is_empty() {
      parts.push(serde_json::json!({ "type": "text", "text": text }));
    }
  }
  for img in m.images.iter().flatten() {
    parts.push(serde_json::json!({
        "type": "image_url",
        "image_url": { "url": img }
    }));
  }
  if parts.is_empty() {
    None
  } else {
    Some(serde_json::Value::Array(parts))
  }
}

/// Build the wire-format `tool_calls` for one assistant message according to
/// the endpoint's `tool_call_format`:
///   - `nested` (default): standard OpenAI — `{id, type:"function",
///     function:{name, arguments}}`
///   - `flat`: fields at the top level — `{id, type:"function", name, arguments}`
fn wire_tool_calls(tcs: &[OpenAiToolCall], tool_call_format: &str) -> Vec<serde_json::Value> {
  tcs
    .iter()
    .map(|tc| {
      let mut obj = serde_json::json!({
        "id": tc.id,
        "type": "function",
      });
      if tool_call_format == "flat" {
        obj["name"] = serde_json::Value::String(tc.name.clone());
        obj["arguments"] = serde_json::Value::String(tc.arguments.clone());
      } else {
        obj["function"] = serde_json::json!({
          "name": tc.name,
          "arguments": tc.arguments,
        });
      }
      obj
    })
    .collect()
}

fn to_openai_messages(messages: &[AiMessage], tool_call_format: &str) -> Vec<OpenAiMessage> {
  messages
    .iter()
    .map(|m| {
      let tool_calls = m
        .tool_calls
        .as_ref()
        .map(|tcs| wire_tool_calls(tcs, tool_call_format));
      let has_tool_calls = tool_calls.as_ref().map(|v| !v.is_empty()).unwrap_or(false);
      OpenAiMessage {
        role: m.role.clone(),
        // When an assistant message carries tool_calls, `content` is sent as an
        // empty string rather than `null`. Some OpenAI-style endpoints (incl.
        // certain gpt-oss / open-weight proxies) reject `null` content on
        // tool-call messages, so we default to `""`. Regular text messages keep
        // their content string; messages with images get a multimodal array.
        content: if has_tool_calls {
          Some(serde_json::Value::String(String::new()))
        } else {
          openai_content(m)
        },
        tool_calls: if has_tool_calls { tool_calls } else { None },
        tool_call_id: m.tool_call_id.clone(),
        // `role: "tool"` messages must not carry `name` (that field is only
        // for the legacy `role: "function"` format); some endpoints reject it.
        name: if m.role == "tool" {
          None
        } else {
          m.name.clone()
        },
      }
    })
    .collect()
}

/// Run a streaming chat that may call tools, executing a full agent loop.
///
/// * `on_chunk` receives assistant text deltas (for live display).
/// * `on_tool` receives tool-call lifecycle events (`pending` → `executing` →
///   `done`/`error`) so the UI can render tool cards.
/// * `execute_tool` receives one call at a time so cancellation is checked
///   before each execution. It returns `(tool_call_id, result_text)` pairs.
/// * `on_phase` marks actual HTTP requests, first response deltas, and tool batches.
/// * `on_confirm_required` atomically saves only unresolved calls and publishes
///   the confirmation phase; completed tool results are already in the messages.
/// * `is_running` also returns false when the caller's buffer no longer exists.
///
/// Returns the final assistant message (with any tool_calls cleared) so the
/// caller can persist it to history.
///
/// `max_rounds` caps the number of agent-loop iterations (one assistant turn
/// plus its tool calls) for a single run, guarding against runaway loops. It is
/// sourced from `AiConfig::max_agent_rounds`.
pub async fn run_agent_stream(
  config: &AiEndpointProfile,
  tool_call_format: &str,
  initial_messages: Vec<AiMessage>,
  mut on_chunk: impl FnMut(String),
  mut on_tool: impl FnMut(ToolCallEvent),
  mut execute_tool: impl FnMut(
    Vec<OpenAiToolCall>,
  ) -> futures_util::future::BoxFuture<'static, Vec<ToolResult>>,
  mut on_confirm_required: impl FnMut(Vec<AiMessage>, Vec<OpenAiToolCall>) -> Result<(), String>,
  mut on_phase: impl FnMut(AiFlowPhase, Option<serde_json::Value>),
  is_running: impl Fn() -> bool,
  max_rounds: usize,
  tools: Option<Vec<OpenAiTool>>,
) -> Result<AiMessage, String> {
  ensure_agent_running(&is_running)?;
  // Keyless endpoints must not load/create a vault key (also keeps mock tests isolated).
  let api_key = if config.api_key_enc.is_empty() {
    String::new()
  } else {
    crate::vault::open_secret(&config.api_key_enc)
      .map_err(|e| format!("Failed to decrypt API key: {}", e))?
  };

  let client = reqwest::ClientBuilder::new()
    .timeout(std::time::Duration::from_secs(180))
    .build()
    .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

  // Working message list carries the full conversation (incl. tool calls).
  let mut messages: Vec<AiMessage> = initial_messages;

  // `max_rounds == 0` means unlimited — the loop terminates on the model's
  // final answer (a turn with no tool calls), so it cannot run forever under
  // normal operation.
  let round_limit = if max_rounds == 0 {
    usize::MAX
  } else {
    max_rounds
  };

  for round in 0..round_limit {
    let wire = to_openai_messages(&messages, tool_call_format);
    let request_body = OpenAiRequest {
      model: config.model.clone(),
      messages: wire,
      stream: true,
      max_tokens: Some(4096),
      temperature: Some(0.7),
      tools: tools.clone(),
    };

    let started = std::time::Instant::now();
    log_ai_request(&format!("agent_round{}", round + 1), config, &request_body);

    // Mirror the actual request body so the UI graph never drifts from the wire.
    let request_detail = serde_json::json!({
      "model": request_body.model,
      "messages": request_body.messages.len(),
      "tools": request_body
        .tools
        .as_ref()
        .map(|tools| tools.iter().map(|tool| tool.function.name.clone()).collect::<Vec<_>>())
        .unwrap_or_default(),
      "format": tool_call_format,
      "maxTokens": request_body.max_tokens,
      "temperature": request_body.temperature,
    });

    ensure_agent_running(&is_running)?;
    on_phase(AiFlowPhase::Request, Some(request_detail));
    ensure_agent_running(&is_running)?;
    let response = client
      .post(&chat_url(&config.endpoint))
      .header("Authorization", format!("Bearer {}", api_key))
      .header("Content-Type", "application/json")
      .json(&request_body)
      .send()
      .await
      .map_err(|e| {
        log_ai_result(
          &format!("agent_round{}", round + 1),
          "error",
          started.elapsed().as_millis(),
          0,
          0,
        );
        format!("HTTP request failed: {}", e)
      })?;

    let status = response.status();
    if !status.is_success() {
      let body_text = response.text().await.unwrap_or_default();
      let msg = if let Ok(err) = serde_json::from_str::<OpenAiErrorResponse>(&body_text) {
        format!("API error ({}): {}", status, err.error.message)
      } else {
        format!("API error ({}): {}", status, body_text)
      };
      log_ai_result(
        &format!("agent_round{}", round + 1),
        &format!("HTTP {}", status),
        started.elapsed().as_millis(),
        0,
        0,
      );
      return Err(msg);
    }

    // Reassemble streaming deltas into a single assistant message + tool calls.
    let mut assistant_content = String::new();
    // index -> (id, name, arguments)
    let mut tool_acc: std::collections::BTreeMap<usize, (Option<String>, Option<String>, String)> =
      std::collections::BTreeMap::new();
    let mut saw_tool_call = false;
    let mut saw_response = false;

    let mut byte_stream = response.bytes_stream();
    // Decode complete lines, not network chunks: a UTF-8 character can span chunks.
    let mut line_buf = Vec::new();
    let mut saw_normal_end = false;

    'read_stream: loop {
      ensure_agent_running(&is_running)?;
      let eof = match byte_stream.next().await {
        Some(chunk_result) => {
          let chunk = chunk_result.map_err(|e| format!("Stream read error: {}", e))?;
          line_buf.extend_from_slice(&chunk);
          false
        }
        None => true,
      };

      loop {
        ensure_agent_running(&is_running)?;
        let line_end = match line_buf.iter().position(|&b| b == b'\n') {
          Some(nl) => nl + 1,
          None => {
            // Accept an unterminated final line at EOF. The exact [DONE] sentinel
            // is self-delimiting, so it need not wait for a newline or EOF.
            let done = std::str::from_utf8(&line_buf)
              .ok()
              .and_then(|line| line.trim().strip_prefix("data:"))
              .is_some_and(|data| data.trim() == "[DONE]");
            if line_buf.is_empty() || (!eof && !done) {
              break;
            }
            line_buf.len()
          }
        };
        let line = String::from_utf8(line_buf.drain(..line_end).collect())
          .map_err(|e| format!("Invalid UTF-8 in SSE stream: {}", e))?;

        if let Some(data) = line.trim().strip_prefix("data:") {
          let data = data.trim();
          if data == "[DONE]" {
            saw_normal_end = true;
            // All preceding deltas are already accumulated; do not wait for EOF.
            break 'read_stream;
          }
          if data.is_empty() {
            continue;
          }
          let value: serde_json::Value =
            serde_json::from_str(data).map_err(|e| format!("Invalid SSE data: {}", e))?;
          if let Some(error) = value.get("error").filter(|e| !e.is_null()) {
            let message = error
              .get("message")
              .and_then(|m| m.as_str())
              .or_else(|| error.as_str())
              .map(str::to_owned)
              .unwrap_or_else(|| error.to_string());
            return Err(format!("API stream error: {}", message));
          }
          let parsed: OpenAiStreamChunk =
            serde_json::from_value(value).map_err(|e| format!("Invalid SSE chunk: {}", e))?;
          if let Some(choice) = parsed.choices.and_then(|cs| cs.into_iter().next()) {
            // `stop` is also used for tool responses by some compatible services.
            // Keep reading after a finish reason to catch subsequent SSE errors.
            match choice.finish_reason.as_deref() {
              Some("stop" | "tool_calls" | "function_call") => saw_normal_end = true,
              None | Some("") => {}
              Some(reason) => {
                return Err(format!("AI stream ended with finish_reason: {}", reason));
              }
            }
            // The final chunk can carry both a finish reason and the last delta.
            if let Some(delta) = choice.delta {
              let meaningful = delta.content.as_ref().is_some_and(|c| !c.is_empty())
                || delta
                  .tool_calls
                  .as_ref()
                  .is_some_and(|calls| !calls.is_empty());
              if meaningful && !saw_response {
                saw_response = true;
                on_phase(AiFlowPhase::Response, None);
              }
              if let Some(content) = delta.content {
                if !content.is_empty() {
                  assistant_content.push_str(&content);
                  on_chunk(content);
                }
              }
              if let Some(tool_deltas) = delta.tool_calls {
                saw_tool_call |= !tool_deltas.is_empty();
                for td in tool_deltas {
                  let entry = tool_acc
                    .entry(td.index)
                    .or_insert((None, None, String::new()));
                  if let Some(id) = td.id {
                    entry.0 = Some(id);
                  }
                  // `flat` format carries name/arguments at the top level;
                  // `nested` nests them under `function`. Accept whichever is
                  // present so a mismatched format still parses.
                  if let Some(name) = td
                    .function
                    .as_ref()
                    .and_then(|f| f.name.clone())
                    .or_else(|| td.name.clone())
                  {
                    entry.1 = Some(name);
                  }
                  if let Some(args) = td
                    .function
                    .as_ref()
                    .and_then(|f| f.arguments.clone())
                    .or_else(|| td.arguments.clone())
                  {
                    entry.2.push_str(&args);
                  }
                }
              }
            }
          }
        }
      }
      if eof {
        break;
      }
    }
    if !saw_normal_end {
      return Err(
        "AI stream ended without [DONE] or a normal finish_reason (truncated response).".into(),
      );
    }

    // Build the assistant message for this round.
    let mut assistant_msg = AiMessage {
      role: "assistant".into(),
      content: if assistant_content.is_empty() {
        None
      } else {
        Some(assistant_content)
      },
      tool_calls: None,
      tool_call_id: None,
      name: None,
      images: None,
    };

    // Validate the entire batch before executing any call, even with a terminator.
    let mut calls: Vec<OpenAiToolCall> = Vec::new();
    for (_idx, (id, name, args)) in &tool_acc {
      if id.as_deref().is_none_or(str::is_empty)
        || name.as_deref().is_none_or(str::is_empty)
        || !serde_json::from_str::<serde_json::Value>(args).is_ok_and(|v| v.is_object())
      {
        return Err(
          "Incomplete tool call in AI stream (missing id/name or invalid JSON arguments).".into(),
        );
      }
      calls.push(OpenAiToolCall {
        id: id.clone().unwrap_or_default(),
        name: name.clone().unwrap_or_default(),
        arguments: args.clone(),
      });
    }
    assistant_msg.tool_calls = Some(calls.clone());

    log_ai_result(
      &format!("agent_round{}", round + 1),
      if saw_tool_call {
        "ok(tools)"
      } else {
        "ok(done)"
      },
      started.elapsed().as_millis(),
      assistant_msg
        .content
        .as_ref()
        .map(|c| c.chars().count())
        .unwrap_or(0),
      calls.len(),
    );

    ensure_agent_running(&is_running)?;
    if !saw_tool_call {
      // No tool calls → conversation finished.
      assistant_msg.tool_calls = None;
      return Ok(assistant_msg);
    }
    // Omitting the registry from HTTP is not a security boundary: refuse an
    // unexpected tool response in chat mode before invoking any executor.
    if tools.is_none() {
      return Err("Tool execution is disabled in chat mode.".into());
    }

    messages.push(assistant_msg);
    ensure_agent_running(&is_running)?;
    on_phase(AiFlowPhase::Tools, Some(tool_calls_detail(&calls)));
    let mut pending_calls = Vec::new();
    for call in &calls {
      ensure_agent_running(&is_running)?;
      on_tool(ToolCallEvent {
        id: call.id.clone(),
        name: call.name.clone(),
        arguments: call.arguments.clone(),
        status: "executing".into(),
        result: None,
        error: None,
      });
      // One call at a time gives cancellation a boundary before every tool.
      ensure_agent_running(&is_running)?;
      let results = execute_tool(vec![call.clone()]).await;
      ensure_agent_running(&is_running)?;
      let result = results
        .into_iter()
        .find(|(id, _)| id == &call.id)
        .map(|(_, r)| r)
        .unwrap_or_else(|| "{\"error\":\"no result\"}".into());
      if tool_needs_confirmation(&result) {
        pending_calls.push(call.clone());
      } else {
        // Retain completed results before pausing; never run these calls twice.
        append_tool_result(&mut messages, call, result.clone());
        on_tool(tool_result_event(call, result, false));
      }
    }
    if !pending_calls.is_empty() {
      ensure_agent_running(&is_running)?;
      // The caller atomically saves pending calls and publishes confirmation.
      on_confirm_required(messages, pending_calls)?;
      return Err("__confirmation__".into());
    }

    // Log the executed tool calls: names + their original JSON arguments
    // (pretty-printed and colorized).
    eprintln!(
      "{}",
      paint(
        C_HEAD,
        &format!(
          "[ai] agent_round{} executed {} tool call(s):",
          round + 1,
          calls.len()
        ),
      )
    );
    for call in &calls {
      eprintln!(
        "  {} {}",
        paint(C_WARN, &call.name),
        paint(C_PUNCT, &format!("(id={})", call.id)),
      );
      let mut args_value = serde_json::from_str::<serde_json::Value>(&call.arguments)
        .unwrap_or_else(|_| serde_json::Value::String(call.arguments.clone()));
      truncate_json_for_log(&mut args_value);
      let args_pretty = serde_json::to_string_pretty(&args_value).unwrap_or_default();
      eprintln!("{}", colorize_json(&args_pretty));
    }

    // Continue the loop for the next round.
  }

  Err(format!(
    "Reached maximum tool-call rounds ({max_rounds}); aborting agent loop."
  ))
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::sync::{Arc, Mutex};

  fn flow_phases(events: &[AiFlowEvent]) -> Vec<&str> {
    events.iter().map(|e| e.phase.as_str()).collect()
  }

  fn test_call(id: &str) -> OpenAiToolCall {
    OpenAiToolCall {
      id: id.into(),
      name: "list_connections".into(),
      arguments: "{}".into(),
    }
  }

  #[test]
  fn ai_flow_round_and_clock_survive_drain_and_confirmation() {
    let mut cs = AiChatState::new("test".into());
    cs.record_phase(AiFlowPhase::Request);
    cs.record_phase(AiFlowPhase::Response);
    cs.record_phase(AiFlowPhase::Tools);
    let first = cs.drain_poll();
    assert_eq!(flow_phases(&first.4), ["request", "response", "tools"]);
    let started = cs.flow.started;
    cs.pause_for_confirmation(&[test_call("sensitive")]);
    cs.finish_agent(Err("__confirmation__".into()));
    let pause = cs.drain_poll();
    assert!(!pause.1);
    assert_eq!(pause.3[0].status, "needs-confirmation");
    assert_eq!(flow_phases(&pause.4), ["confirmation"]);
    assert_eq!(pause.4[0].seq, 4);
    let confirmation_detail = pause.4[0].detail.as_ref().unwrap();
    assert_eq!(confirmation_detail["calls"][0]["name"], "list_connections");
    assert_eq!(confirmation_detail["calls"][0]["arguments"], "{}");
    assert!(confirmation_detail["calls"][0].get("id").is_none());
    assert!(!cs.drain_poll().1);
    cs.record_phase(AiFlowPhase::Resume);
    cs.record_phase(AiFlowPhase::Request);
    cs.record_phase(AiFlowPhase::Response);
    cs.record_phase(AiFlowPhase::Completed);
    let end = cs.drain_poll();
    assert!(end.1);
    assert_eq!(cs.flow.started, started);
    assert_eq!(
      flow_phases(&end.4),
      ["resume", "request", "response", "completed"]
    );
    assert_eq!(
      end.4.iter().map(|e| (e.seq, e.round)).collect::<Vec<_>>(),
      [(5, 1), (6, 2), (7, 2), (8, 2)]
    );
    assert!(end.4[0].elapsed_ms >= first.4[2].elapsed_ms);
    let value = serde_json::to_value(&end.4[0]).unwrap();
    assert_eq!(value.as_object().unwrap().len(), 4);
    assert!(value.get("elapsedMs").is_some());
  }

  #[test]
  fn ai_flow_terminal_emitted_only_once_even_after_drain() {
    for phase in [
      AiFlowPhase::Completed,
      AiFlowPhase::Error,
      AiFlowPhase::Cancelled,
    ] {
      let mut cs = AiChatState::new("test".into());
      cs.record_phase(phase);
      assert_eq!(cs.drain_poll().4.len(), 1);
      cs.record_phase(AiFlowPhase::Cancelled);
      cs.record_phase(AiFlowPhase::Request);
      cs.finish_agent(Err("late error".into()));
      cs.pause_for_confirmation(&[test_call("late")]);
      let poll = cs.drain_poll();
      assert!(poll.1);
      assert!(poll.3.is_empty() && poll.4.is_empty());
      assert!(poll.2.is_none());
    }
  }

  #[test]
  fn ai_flow_tool_errors_are_not_done() {
    let call = test_call("one");
    assert_eq!(
      tool_result_event(&call, "{\"error\":\"failed\"}".into(), false).status,
      "error"
    );
    assert_eq!(
      tool_result_event(&call, "{\"error\":{\"code\":1}}".into(), false)
        .error
        .as_deref(),
      Some("{\"code\":1}")
    );
    assert_eq!(
      tool_result_event(&call, "{\"error\":\"declined\"}".into(), true).status,
      "denied"
    );
    assert_eq!(
      tool_result_event(&call, "{\"output\":\"error text\"}".into(), false).status,
      "done"
    );
    assert!(!tool_needs_confirmation(
      "{\"output\":{\"needsConfirmation\":true}}"
    ));
  }

  struct MockAi {
    profile: AiEndpointProfile,
    requests: Arc<Mutex<Vec<serde_json::Value>>>,
    server: tokio::task::JoinHandle<()>,
  }

  impl Drop for MockAi {
    fn drop(&mut self) {
      self.server.abort();
    }
  }

  impl MockAi {
    async fn start(responses: Vec<(axum::http::StatusCode, String)>) -> Self {
      Self::start_streams(
        responses
          .into_iter()
          .map(|(status, body)| (status, axum::body::Body::from(body)))
          .collect(),
      )
      .await
    }

    async fn start_streams(responses: Vec<(axum::http::StatusCode, axum::body::Body)>) -> Self {
      let requests = Arc::new(Mutex::new(Vec::new()));
      let captured = requests.clone();
      let responses = Arc::new(Mutex::new(std::collections::VecDeque::from(responses)));
      let router = axum::Router::new().route(
        "/v1/chat/completions",
        axum::routing::post(move |axum::Json(body): axum::Json<serde_json::Value>| {
          let captured = captured.clone();
          let responses = responses.clone();
          async move {
            captured.lock().unwrap().push(body);
            let (status, body) = responses.lock().unwrap().pop_front().unwrap_or((
              axum::http::StatusCode::INTERNAL_SERVER_ERROR,
              "unexpected request".into(),
            ));
            (status, [("content-type", "text/event-stream")], body)
          }
        }),
      );
      let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
      let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
      let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
      });
      Self {
        profile: AiEndpointProfile::new("mock".into(), endpoint),
        requests,
        server,
      }
    }
  }

  fn sse(delta: serde_json::Value) -> (axum::http::StatusCode, String) {
    let reason = if delta.get("tool_calls").is_some() {
      "tool_calls"
    } else {
      "stop"
    };
    (axum::http::StatusCode::OK, format!(
      "data: {{\"choices\":[{{\"delta\":{{\"role\":\"assistant\"}}}}]}}\n\ndata: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
      serde_json::json!({ "choices": [{ "delta": delta }] }),
      serde_json::json!({ "choices": [{ "delta": {}, "finish_reason": reason }] })
    ))
  }

  fn tool_sse(ids: &[&str]) -> (axum::http::StatusCode, String) {
    sse(
      serde_json::json!({ "tool_calls": ids.iter().enumerate().map(|(i, id)| {
      serde_json::json!({ "index": i, "id": id, "function": { "name": "list_connections", "arguments": "{}" } })
    }).collect::<Vec<_>>() }),
    )
  }

  type TestPending = Mutex<Option<(Vec<AiMessage>, Vec<OpenAiToolCall>)>>;

  async fn mock_run(
    mock: &MockAi,
    cs: &Mutex<AiChatState>,
    pending: &TestPending,
    messages: Vec<AiMessage>,
    execute: impl FnMut(
      Vec<OpenAiToolCall>,
    ) -> futures_util::future::BoxFuture<'static, Vec<ToolResult>>,
    tools: Option<Vec<OpenAiTool>>,
  ) -> Result<AiMessage, String> {
    run_agent_stream(
      &mock.profile,
      "nested",
      messages,
      |chunk| cs.lock().unwrap().chunks.push(chunk),
      |event| cs.lock().unwrap().tool_events.push(event),
      execute,
      |messages, calls| {
        cs.lock().unwrap().pause_for_confirmation(&calls);
        *pending.lock().unwrap() = Some((messages, calls));
        Ok(())
      },
      |phase, detail| cs.lock().unwrap().record_phase_with_detail(phase, detail),
      || cs.lock().unwrap().is_active(),
      10,
      tools,
    )
    .await
  }

  fn sse_frame(value: serde_json::Value) -> String {
    format!("data:{}\n\n", value)
  }

  async fn assert_ai_flow_stream_error(body: String, error: &str, text: &str) {
    let mock = MockAi::start(vec![(axum::http::StatusCode::OK, body)]).await;
    let cs = Mutex::new(AiChatState::new("test".into()));
    let pending = Mutex::new(None);
    let mut executions = 0;
    let result = mock_run(
      &mock,
      &cs,
      &pending,
      vec![],
      |_| {
        executions += 1;
        Box::pin(async { vec![] })
      },
      Some(tool_definitions_unbound()),
    )
    .await;
    assert_eq!(
      executions, 0,
      "incomplete/error responses must not execute tools"
    );
    assert!(result.as_ref().unwrap_err().contains(error), "{:?}", result);
    let expected_error = result.as_ref().unwrap_err().clone();
    cs.lock().unwrap().finish_agent(result);
    let poll = cs.lock().unwrap().drain_poll();
    assert_eq!(poll.0, text);
    assert!(poll.1);
    assert_eq!(poll.2.as_deref(), Some(expected_error.as_str()));
    assert!(poll.3.is_empty());
    assert_eq!(poll.4.first().unwrap().phase, "request");
    assert_eq!(poll.4.last().unwrap().phase, "error");
    assert!(!poll
      .4
      .iter()
      .any(|e| matches!(e.phase.as_str(), "completed" | "tools" | "confirmation")));
    assert!(pending.lock().unwrap().is_none());
    assert_eq!(mock.requests.lock().unwrap().len(), 1);
  }

  #[tokio::test]
  async fn ai_flow_http_sse_errors_are_not_completed() {
    let prefix = sse_frame(serde_json::json!({"choices":[{"delta":{
      "content":"partial", "tool_calls":[{"index":0,"id":"blocked",
        "function":{"name":"list_connections","arguments":"{"}}]
    }}]}));
    for error in [
      serde_json::json!({"message":"provider failed","type":"server_error"}),
      serde_json::json!("provider failed"),
      serde_json::json!({"code":"provider failed"}),
    ] {
      for finish in ["", "data:{\"choices\":[{\"finish_reason\":\"stop\"}]}\n\n"] {
        let body = format!(
          "{}{}{}data:[DONE]\n\n",
          prefix,
          finish,
          sse_frame(serde_json::json!({"error":error}))
        );
        assert_ai_flow_stream_error(body, "provider failed", "partial").await;
      }
    }
    // An error in the final, unterminated line is still an error.
    assert_ai_flow_stream_error(
      "data:{\"error\":{\"message\":\"no newline\"}}".into(),
      "no newline",
      "",
    )
    .await;
  }

  #[tokio::test]
  async fn ai_flow_http_truncated_text_is_not_completed() {
    assert_ai_flow_stream_error(String::new(), "truncated response", "").await;
    for reason in [serde_json::Value::Null, serde_json::json!("")] {
      let body = sse_frame(serde_json::json!({"choices":[{
        "delta":{"content":"partial"}, "finish_reason":reason
      }]}));
      for body in [body.clone(), body.trim_end().to_string()] {
        assert_ai_flow_stream_error(body, "truncated response", "partial").await;
      }
    }
    let prefix = sse_frame(serde_json::json!({"choices":[{"delta":{"content":"partial"}}]}));
    assert_ai_flow_stream_error(
      format!("{}data:{{\"choices\":[", prefix),
      "Invalid SSE data",
      "partial",
    )
    .await;
  }

  #[tokio::test]
  async fn ai_flow_http_truncated_tools_never_execute() {
    // Even fully parseable arguments are unsafe without a normal turn boundary.
    for arguments in ["{", "{}"] {
      let body = sse_frame(serde_json::json!({"choices":[{"delta":{"tool_calls":[
        {"index":0,"id":"complete","function":{"name":"list_connections","arguments":"{}"}},
        {"index":1,"id":"blocked","function":{"name":"list_connections","arguments":arguments}}
      ]}}]}));
      assert_ai_flow_stream_error(body, "truncated response", "").await;
    }
    // Validate the whole batch before executing its first, otherwise valid call.
    let body = sse_frame(serde_json::json!({"choices":[{"delta":{"tool_calls":[
      {"index":0,"id":"complete","function":{"name":"list_connections","arguments":"{}"}},
      {"index":1,"id":"blocked","function":{"name":"list_connections","arguments":"{"}}
    ]},"finish_reason":"tool_calls"}]}));
    assert_ai_flow_stream_error(
      format!("{}data:[DONE]\n\n", body),
      "Incomplete tool call",
      "",
    )
    .await;
  }

  #[tokio::test]
  async fn ai_flow_http_abnormal_finish_reasons_never_complete_or_execute() {
    for reason in ["length", "content_filter", "unknown_reason"] {
      for delta in [
        serde_json::json!({"content":"partial"}),
        serde_json::json!({"content":"partial","tool_calls":[{"index":0,"id":"blocked",
          "function":{"name":"list_connections","arguments":"{"}}]}),
      ] {
        let prefix = sse_frame(serde_json::json!({"choices":[{"delta":delta}]}));
        let finish =
          sse_frame(serde_json::json!({"choices":[{"delta":{},"finish_reason":reason}]}));
        for ending in ["", "data:[DONE]\n\n"] {
          assert_ai_flow_stream_error(format!("{}{}{}", prefix, finish, ending), reason, "partial")
            .await;
        }
      }
    }
  }

  #[tokio::test]
  async fn ai_flow_http_normal_text_endings_preserve_final_delta() {
    let first = sse_frame(serde_json::json!({"choices":[{"delta":{"content":"你好"}}]}));
    let final_delta = sse_frame(serde_json::json!({"choices":[{
      "delta":{"content":"世界"},"finish_reason":"stop"
    }]}));
    for ending in [
      final_delta.clone(),
      final_delta.trim_end().to_string(),
      format!("{}data:[DONE]\n\n", final_delta),
      format!("{}data:[DONE]", final_delta),
    ] {
      let mock = MockAi::start(vec![(
        axum::http::StatusCode::OK,
        format!("{}{}", first, ending),
      )])
      .await;
      let cs = Mutex::new(AiChatState::new("test".into()));
      let result = mock_run(
        &mock,
        &cs,
        &Mutex::new(None),
        vec![],
        |_| panic!("text response must not execute tools"),
        None,
      )
      .await;
      assert_eq!(
        result.as_ref().unwrap().content.as_deref(),
        Some("你好世界")
      );
      cs.lock().unwrap().finish_agent(result);
      let poll = cs.lock().unwrap().drain_poll();
      assert_eq!(poll.0, "你好世界");
      assert!(poll.1 && poll.2.is_none());
      assert!(poll.3.is_empty());
      assert_eq!(flow_phases(&poll.4), ["request", "response", "completed"]);
      assert_eq!(mock.requests.lock().unwrap().len(), 1);
    }
  }

  #[tokio::test]
  async fn ai_flow_http_normal_tool_endings_preserve_final_arguments() {
    for reason in [
      None,
      Some("stop"),
      Some("tool_calls"),
      Some("function_call"),
    ] {
      let first = sse_frame(serde_json::json!({"choices":[{"delta":{"tool_calls":[{
        "index":0,"id":"one","function":{"name":"list_connections","arguments":"{\"label\":\"中"}
      }]}}]}));
      let last = sse_frame(serde_json::json!({"choices":[{"delta":{"tool_calls":[{
        "index":0,"function":{"arguments":"文\"}"}
      }]},"finish_reason":reason}]}));
      let ending = if reason.is_none() { "data:[DONE]" } else { "" };
      let mock = MockAi::start(vec![
        (
          axum::http::StatusCode::OK,
          format!("{}{}{}", first, last, ending),
        ),
        sse(serde_json::json!({"content":"answer"})),
      ])
      .await;
      let cs = Mutex::new(AiChatState::new("test".into()));
      let mut executions = 0;
      let result = mock_run(
        &mock,
        &cs,
        &Mutex::new(None),
        vec![],
        |calls| {
          executions += 1;
          assert_eq!(calls.len(), 1);
          assert_eq!(calls[0].id, "one");
          assert_eq!(calls[0].name, "list_connections");
          assert_eq!(calls[0].arguments, "{\"label\":\"中文\"}");
          Box::pin(async { vec![("one".into(), "{\"ok\":true}".into())] })
        },
        Some(tool_definitions_unbound()),
      )
      .await;
      assert_eq!(executions, 1);
      assert_eq!(result.as_ref().unwrap().content.as_deref(), Some("answer"));
      cs.lock().unwrap().finish_agent(result);
      let poll = cs.lock().unwrap().drain_poll();
      assert!(poll.1 && poll.2.is_none());
      assert_eq!(
        flow_phases(&poll.4),
        [
          "request",
          "response",
          "tools",
          "request",
          "response",
          "completed"
        ]
      );
      assert_eq!(
        poll.3.iter().map(|e| e.status.as_str()).collect::<Vec<_>>(),
        ["executing", "done"]
      );
      let requests = mock.requests.lock().unwrap();
      assert_eq!(requests.len(), 2);
      assert_eq!(
        requests[1]["messages"][0]["tool_calls"][0]["function"]["arguments"],
        "{\"label\":\"中文\"}"
      );
    }
  }

  #[tokio::test]
  async fn ai_flow_http_done_does_not_wait_for_connection_close() {
    for ending in ["data:[DONE]\n\n", "data: [DONE]\r\n\r\n", "data:[DONE]"] {
      let body = format!(
        "{}{}",
        sse_frame(serde_json::json!({"choices":[{"delta":{"content":"answer"}}]})),
        ending,
      );
      let stream = futures_util::stream::iter(vec![Ok::<_, std::io::Error>(body)])
        .chain(futures_util::stream::pending());
      let mock = MockAi::start_streams(vec![(
        axum::http::StatusCode::OK,
        axum::body::Body::from_stream(stream),
      )])
      .await;
      let cs = Mutex::new(AiChatState::new("test".into()));
      let pending = Mutex::new(None);
      let result = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        mock_run(
          &mock,
          &cs,
          &pending,
          vec![],
          |_| panic!("text response must not execute tools"),
          None,
        ),
      )
      .await
      .expect("[DONE] must finish without waiting for the open response body");
      assert_eq!(result.as_ref().unwrap().content.as_deref(), Some("answer"));
      cs.lock().unwrap().finish_agent(result);
      let poll = cs.lock().unwrap().drain_poll();
      assert_eq!(poll.0, "answer");
      assert!(poll.1 && poll.2.is_none());
      assert_eq!(flow_phases(&poll.4), ["request", "response", "completed"]);
    }
  }

  #[tokio::test]
  async fn ai_flow_http_utf8_chunk_boundary_and_final_frame_without_newline() {
    let ready = Arc::new(tokio::sync::Notify::new());
    let first = sse_frame(serde_json::json!({"choices":[{"delta":{"content":"prefix"}}]}));
    let last = format!(
      "data:{}",
      serde_json::json!({"choices":[{
        "delta":{"content":"中文"},"finish_reason":"stop"
      }]})
    );
    let split = last.find('中').unwrap() + 1;
    let mut first_bytes = first.into_bytes();
    first_bytes.extend_from_slice(&last.as_bytes()[..split]);
    let pieces = std::collections::VecDeque::from([first_bytes, last.as_bytes()[split..].to_vec()]);
    let signal = ready.clone();
    let stream = futures_util::stream::unfold((pieces, false), move |(mut pieces, wait)| {
      let signal = signal.clone();
      async move {
        let bytes = pieces.pop_front()?;
        if wait {
          // Do not send the continuation until the client has consumed chunk one.
          signal.notified().await;
        }
        Some((Ok::<_, std::io::Error>(bytes), (pieces, true)))
      }
    });
    let mock = MockAi::start_streams(vec![(
      axum::http::StatusCode::OK,
      axum::body::Body::from_stream(stream),
    )])
    .await;
    let cs = Mutex::new(AiChatState::new("test".into()));
    let result = tokio::time::timeout(
      std::time::Duration::from_secs(2),
      run_agent_stream(
        &mock.profile,
        "nested",
        vec![],
        |chunk| {
          if chunk == "prefix" {
            ready.notify_one();
          }
          cs.lock().unwrap().chunks.push(chunk);
        },
        |_| panic!("text response must not emit tool events"),
        |_| panic!("text response must not execute tools"),
        |_, _| panic!("text response must not request confirmation"),
        |phase, detail| cs.lock().unwrap().record_phase_with_detail(phase, detail),
        || cs.lock().unwrap().is_active(),
        10,
        None,
      ),
    )
    .await
    .expect("split UTF-8 response must finish");
    assert_eq!(
      result.as_ref().unwrap().content.as_deref(),
      Some("prefix中文")
    );
    cs.lock().unwrap().finish_agent(result);
    let poll = cs.lock().unwrap().drain_poll();
    assert_eq!(poll.0, "prefix中文");
    assert!(poll.1 && poll.2.is_none());
    assert_eq!(flow_phases(&poll.4), ["request", "response", "completed"]);
  }

  #[tokio::test]
  async fn ai_flow_http_tools_then_response_and_error_status() {
    let mock = MockAi::start(vec![
      tool_sse(&["ok", "bad"]),
      sse(serde_json::json!({"content":"answer"})),
    ])
    .await;
    let cs = Mutex::new(AiChatState::new("test".into()));
    let pending = Mutex::new(None);
    let result = mock_run(
      &mock,
      &cs,
      &pending,
      vec![],
      |calls| {
        Box::pin(async move {
          calls
            .into_iter()
            .map(|c| {
              let result = if c.id == "bad" {
                "{\"error\":\"failed\"}"
              } else {
                "{\"ok\":true}"
              };
              (c.id, result.into())
            })
            .collect()
        })
      },
      Some(tool_definitions_unbound()),
    )
    .await;
    cs.lock().unwrap().finish_agent(result);
    let poll = cs.lock().unwrap().drain_poll();
    assert_eq!(poll.0, "answer");
    assert!(poll.1 && poll.2.is_none());
    assert_eq!(
      flow_phases(&poll.4),
      [
        "request",
        "response",
        "tools",
        "request",
        "response",
        "completed"
      ]
    );
    assert_eq!(
      poll.3.iter().map(|e| e.status.as_str()).collect::<Vec<_>>(),
      ["executing", "done", "executing", "error"]
    );
    let requests = mock.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[1]["messages"].as_array().unwrap().len(), 3);
    // Request detail mirrors the wire request, without messages or credentials.
    let request_detail = poll.4[0].detail.as_ref().unwrap();
    assert_eq!(request_detail["model"], requests[0]["model"]);
    assert_eq!(
      request_detail["messages"],
      requests[0]["messages"].as_array().unwrap().len()
    );
    assert_eq!(
      request_detail["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect::<Vec<_>>(),
      requests[0]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["function"]["name"].as_str().unwrap())
        .collect::<Vec<_>>()
    );
    assert_eq!(request_detail["format"], "nested");
    assert_eq!(request_detail["maxTokens"], requests[0]["max_tokens"]);
    assert_eq!(request_detail["temperature"], requests[0]["temperature"]);
    assert!(request_detail.get("messages").is_some());
    // Tools detail carries names + arguments of this round, never call ids.
    let tools_detail = poll.4[2].detail.as_ref().unwrap();
    assert_eq!(tools_detail["calls"].as_array().unwrap().len(), 2);
    assert_eq!(tools_detail["calls"][0]["name"], "list_connections");
    assert_eq!(tools_detail["calls"][0]["arguments"], "{}");
    assert!(tools_detail["calls"][0].get("id").is_none());
    // Response / Completed stay detail-free (index 3 is the second request).
    assert!(poll.4[1].detail.is_none());
    assert!(poll.4[4].detail.is_none());
    assert!(poll.4[5].detail.is_none());
    let encoded = serde_json::to_string(&poll.4).unwrap();
    for forbidden in ["apiKey", "Authorization", "Bearer", "system"] {
      assert!(
        !encoded.contains(forbidden),
        "flow detail leaked {forbidden}: {encoded}"
      );
    }
  }

  #[tokio::test]
  async fn ai_flow_http_confirmation_resume_never_reexecutes_completed_tools() {
    let mock = MockAi::start(vec![
      tool_sse(&["safe", "sensitive"]),
      tool_sse(&["sensitive2"]),
      sse(serde_json::json!({"content":"done"})),
    ])
    .await;
    let cs = Mutex::new(AiChatState::new("test".into()));
    let pending = Mutex::new(None);
    let executed = Arc::new(Mutex::new(Vec::new()));
    let mut messages = vec![];
    for _ in 0..2 {
      let executed = executed.clone();
      let result = mock_run(
        &mock,
        &cs,
        &pending,
        messages,
        move |calls| {
          let executed = executed.clone();
          Box::pin(async move {
            calls
              .into_iter()
              .map(|c| {
                executed.lock().unwrap().push(c.id.clone());
                let result = if c.id == "safe" {
                  "{\"ok\":true}"
                } else {
                  "{\"needsConfirmation\":true}"
                };
                (c.id, result.into())
              })
              .collect()
          })
        },
        Some(tool_definitions_unbound()),
      )
      .await;
      assert_eq!(result.as_ref().unwrap_err(), "__confirmation__");
      cs.lock().unwrap().finish_agent(result);
      let pause = cs.lock().unwrap().drain_poll();
      assert!(!pause.1);
      assert_eq!(pause.4.last().unwrap().phase, "confirmation");
      let confirmation_detail = pause.4.last().unwrap().detail.as_ref().unwrap();
      assert_eq!(confirmation_detail["calls"][0]["name"], "list_connections");
      assert!(confirmation_detail["calls"][0].get("id").is_none());
      assert!(!cs.lock().unwrap().drain_poll().1);
      let (saved, calls) = pending.lock().unwrap().take().unwrap();
      messages = saved;
      assert_eq!(calls.len(), 1);
      assert_ne!(calls[0].id, "safe");
      cs.lock().unwrap().record_phase_with_detail(
        AiFlowPhase::Resume,
        Some(serde_json::json!({ "approved": true })),
      );
      append_tool_result(&mut messages, &calls[0], "{\"ok\":true}".into());
    }
    let result = mock_run(
      &mock,
      &cs,
      &pending,
      messages,
      |_| panic!("no tool expected"),
      Some(tool_definitions_unbound()),
    )
    .await;
    cs.lock().unwrap().finish_agent(result);
    let poll = cs.lock().unwrap().drain_poll();
    assert_eq!(
      flow_phases(&poll.4),
      ["resume", "request", "response", "completed"]
    );
    assert_eq!(poll.4.last().unwrap().round, 3);
    assert_eq!(
      poll.4[0].detail.as_ref().unwrap(),
      &serde_json::json!({ "approved": true })
    );
    assert_eq!(
      *executed.lock().unwrap(),
      ["safe", "sensitive", "sensitive2"]
    );
    let requests = mock.requests.lock().unwrap();
    assert_eq!(requests.len(), 3);
    assert_eq!(
      requests[2]["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| m["tool_call_id"] == "safe")
        .count(),
      1
    );
  }

  #[tokio::test]
  async fn ai_flow_http_chat_mode_refuses_unexpected_tools_and_http_error() {
    for response in [
      tool_sse(&["unexpected"]),
      (axum::http::StatusCode::BAD_GATEWAY, "mock failure".into()),
    ] {
      let mock = MockAi::start(vec![response]).await;
      let cs = Mutex::new(AiChatState::new("test".into()));
      let result = mock_run(
        &mock,
        &cs,
        &Mutex::new(None),
        vec![],
        |_| panic!("tools are disabled"),
        None,
      )
      .await;
      assert!(result.is_err());
      cs.lock().unwrap().finish_agent(result);
      let poll = cs.lock().unwrap().drain_poll();
      assert!(poll.1 && poll.2.is_some());
      assert_eq!(poll.4.last().unwrap().phase, "error");
      assert!(!poll.4.iter().any(|e| e.phase == "tools"));
      assert_eq!(mock.requests.lock().unwrap().len(), 1);
    }
  }

  #[tokio::test]
  async fn ai_flow_response_once_and_cancel_at_stream_or_tool_boundary() {
    let (status, tools) = tool_sse(&["blocked"]);
    let content = serde_json::json!({"choices":[{"delta":{"content":"first"}}]});
    let content2 = serde_json::json!({"choices":[{"delta":{"content":"second"}}]});
    let body = format!("data: {}\n\ndata: {}\n\n{}", content, content2, tools);
    for cancel_at in [AiFlowPhase::Response, AiFlowPhase::Tools] {
      let mock = MockAi::start(vec![(status, body.clone())]).await;
      let cs = Mutex::new(AiChatState::new("test".into()));
      let result = run_agent_stream(
        &mock.profile,
        "nested",
        vec![],
        |_| {},
        |_| {},
        |_| panic!("cancelled tool must not execute"),
        |_, _| panic!("cancelled flow must not pause"),
        |phase, detail| {
          let mut cs = cs.lock().unwrap();
          cs.record_phase_with_detail(phase, detail);
          if phase == cancel_at {
            cs.record_phase(AiFlowPhase::Cancelled);
          }
        },
        || cs.lock().unwrap().is_active(),
        10,
        Some(tool_definitions_unbound()),
      )
      .await;
      assert_eq!(result.unwrap_err(), "__cancelled__");
      let poll = cs.lock().unwrap().drain_poll();
      assert_eq!(poll.4.iter().filter(|e| e.phase == "response").count(), 1);
      assert_eq!(poll.4.last().unwrap().phase, "cancelled");
      assert!(poll.4.last().unwrap().detail.is_none());
      assert_eq!(mock.requests.lock().unwrap().len(), 1);
    }
  }

  #[tokio::test]
  async fn ai_flow_cancel_blocks_later_tools_and_requests() {
    let mock = MockAi::start(vec![tool_sse(&["first", "must-not-run"])]).await;
    let cs = Arc::new(Mutex::new(AiChatState::new("test".into())));
    let cancel = cs.clone();
    let result = mock_run(
      &mock,
      &cs,
      &Mutex::new(None),
      vec![],
      move |calls| {
        assert_eq!(calls[0].id, "first");
        cancel.lock().unwrap().record_phase(AiFlowPhase::Cancelled);
        Box::pin(async { vec![] })
      },
      Some(tool_definitions_unbound()),
    )
    .await;
    assert_eq!(result.as_ref().unwrap_err(), "__cancelled__");
    cs.lock().unwrap().finish_agent(result);
    let poll = cs.lock().unwrap().drain_poll();
    assert_eq!(
      flow_phases(&poll.4),
      ["request", "response", "tools", "cancelled"]
    );
    assert!(poll.1 && poll.2.is_none());
    let result = mock_run(
      &mock,
      &cs,
      &Mutex::new(None),
      vec![],
      |_| panic!("cancelled"),
      Some(tool_definitions_unbound()),
    )
    .await;
    assert_eq!(result.unwrap_err(), "__cancelled__");
    assert_eq!(mock.requests.lock().unwrap().len(), 1);
  }

  #[test]
  fn unbound_registry_exposes_no_shell_tool() {
    let unbound = tool_definitions_unbound();
    for name in SHELL_TOOL_NAMES {
      assert!(
        !unbound.iter().any(|t| t.function.name == *name),
        "shell tool {} leaked into the unbound registry",
        name
      );
    }
    // The app-level tools stay: an unbound chat may still read and change
    // settings, and list the saved connections.
    for name in [
      "list_connections",
      "get_ui_settings",
      "set_ui_settings",
      "reset_ui_settings",
    ] {
      assert!(
        unbound.iter().any(|t| t.function.name == name),
        "{} missing from the unbound registry",
        name
      );
    }
    assert_eq!(
      unbound.len() + SHELL_TOOL_NAMES.len(),
      tool_definitions().len(),
      "the two registries must partition the tool list"
    );
  }

  #[test]
  fn shell_tool_names_match_real_tools() {
    let all: Vec<String> = tool_definitions()
      .into_iter()
      .map(|t| t.function.name)
      .collect();
    for name in SHELL_TOOL_NAMES {
      assert!(all.iter().any(|t| t == name), "unknown shell tool {}", name);
    }
  }
}

//! OpenAI-compatible AI chat integration.
//!
//! Supports any API that follows the OpenAI chat completions format, including
//! OpenAI, Anthropic (via compatible proxies), local LLMs (Ollama/vLLM), etc.
//!
//! Configuration is persisted to `ai_config.json` in the app data directory.
//! The API key is encrypted using the same AES-256-GCM vault as connections.

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
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
  /// Default AI mode when a chat is opened. When true, the agent starts in
  /// read-only mode and may only run inspection commands (configurable in the
  /// global AI settings; the per-chat panel can toggle it). Defaults to false
  /// so a fresh install starts with full access (can run modifying commands).
  #[serde(default = "default_false", alias = "aiReadOnly")]
  pub read_only: bool,
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

/// Serde default for boolean `AiConfig` flags that are off by default.
fn default_false() -> bool {
  false
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
      read_only: false,
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
  /// Set when the user pauses/stops the stream; the frontend stops polling and
  /// the background task aborts early.
  #[serde(default)]
  pub cancelled: bool,
}

// ---- Path helpers ----

fn data_dir() -> Option<PathBuf> {
  dirs::config_dir().map(|p| p.join("wrolp-terminal"))
}

fn ai_config_path() -> Option<PathBuf> {
  data_dir().map(|p| p.join("ai_config.json"))
}

// ---- Config persistence ----

pub fn load_ai_config() -> Result<AiConfig, String> {
  let path = ai_config_path().ok_or_else(|| "cannot resolve config dir".to_string())?;
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
            read_only: false,
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
  temperature: Option<f32>,
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

#[derive(Serialize, Clone)]
struct OpenAiTool {
  #[serde(rename = "type")]
  tool_type: String,
  function: OpenAiFunction,
}

#[derive(Serialize, Clone)]
struct OpenAiFunction {
  name: String,
  description: String,
  parameters: serde_json::Value,
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
  ]
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
const C_KEY: &str = "\x1b[36m";   // JSON keys
const C_STR: &str = "\x1b[32m";   // JSON string values
const C_NUM: &str = "\x1b[33m";   // JSON numbers / booleans
const C_NULL: &str = "\x1b[35m";  // JSON null
const C_PUNCT: &str = "\x1b[90m"; // JSON punctuation
const C_HEAD: &str = "\x1b[36m";  // log header lines
const C_OK: &str = "\x1b[32m";    // successful result
const C_ERR: &str = "\x1b[31m";   // error result
const C_WARN: &str = "\x1b[33m";  // warnings / tool names

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
        let _ = write!(out, "{}{}{}", if is_key { C_KEY } else { C_STR }, s, C_RESET);
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
fn log_ai_result(
  tag: &str,
  status: &str,
  elapsed_ms: u128,
  out_chars: usize,
  tool_calls: usize,
) {
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
    log_ai_result("chat_sync", &format!("HTTP {}", status), started.elapsed().as_millis(), 0, 0);
    return Err(msg);
  }

  let body: OpenAiResponse =
    serde_json::from_str(&body_text).map_err(|e| format!("Failed to parse response: {}", e))?;

  let content = body
    .choices
    .first()
    .map(|c| c.message.content.clone())
    .unwrap_or_default();

  log_ai_result("chat_sync", "ok", started.elapsed().as_millis(), content.len(), 0);

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
    log_ai_result("stream_chat", &format!("HTTP {}", status), started.elapsed().as_millis(), 0, 0);
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
          log_ai_result("stream_chat", "ok", started.elapsed().as_millis(), out_chars, 0);
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
  log_ai_result("stream_chat", "ok", started.elapsed().as_millis(), out_chars, 0);
  Ok(())
}

// ---- Agent loop (streaming chat with tool calling) ----

/// Result returned by the tool executor: `(tool_call_id, result_text)`.
pub type ToolResult = (String, String);

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
fn wire_tool_calls(
  tcs: &[OpenAiToolCall],
  tool_call_format: &str,
) -> Vec<serde_json::Value> {
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
/// * `execute_tool` is invoked with the aggregated tool calls for one round and
///   must return `(tool_call_id, result_text)` pairs. It is implemented in
///   `commands.rs` because it needs `AppState`. It is async (tools do remote IO).
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
  mut on_confirm_required: impl FnMut(Vec<AiMessage>, Vec<OpenAiToolCall>),
  max_rounds: usize,
) -> Result<AiMessage, String> {
  let api_key = crate::vault::open_secret(&config.api_key_enc)
    .map_err(|e| format!("Failed to decrypt API key: {}", e))?;

  let client = reqwest::ClientBuilder::new()
    .timeout(std::time::Duration::from_secs(180))
    .build()
    .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

  let tools = tool_definitions();

  // Working message list carries the full conversation (incl. tool calls).
  let mut messages: Vec<AiMessage> = initial_messages;

  for round in 0..max_rounds {
    let wire = to_openai_messages(&messages, tool_call_format);
    let request_body = OpenAiRequest {
      model: config.model.clone(),
      messages: wire,
      stream: true,
      max_tokens: Some(4096),
      temperature: Some(0.7),
      tools: Some(tools.clone()),
    };

    let started = std::time::Instant::now();
    log_ai_request(&format!("agent_round{}", round + 1), config, &request_body);

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

    let mut byte_stream = response.bytes_stream();
    let mut line_buf = String::new();

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
            continue;
          }
          if let Ok(parsed) = serde_json::from_str::<OpenAiStreamChunk>(data) {
            if let Some(delta) = parsed
              .choices
              .and_then(|cs| cs.first().cloned())
              .and_then(|c| c.delta)
            {
              if let Some(content) = delta.content {
                if !content.is_empty() {
                  assistant_content.push_str(&content);
                  on_chunk(content);
                }
              }
              if let Some(tool_deltas) = delta.tool_calls {
                saw_tool_call = true;
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

    // Assemble aggregated tool calls.
    let mut calls: Vec<OpenAiToolCall> = Vec::new();
    for (_idx, (id, name, args)) in &tool_acc {
      calls.push(OpenAiToolCall {
        id: id.clone().unwrap_or_default(),
        name: name.clone().unwrap_or_default(),
        arguments: args.clone(),
      });
    }
    assistant_msg.tool_calls = Some(calls.clone());

    log_ai_result(
      &format!("agent_round{}", round + 1),
      if saw_tool_call { "ok(tools)" } else { "ok(done)" },
      started.elapsed().as_millis(),
      assistant_msg.content.as_ref().map(|c| c.chars().count()).unwrap_or(0),
      calls.len(),
    );

    if !saw_tool_call {
      // No tool calls → conversation finished.
      return Ok(assistant_msg);
    }

    // Append assistant message (with tool_calls) to history.
    messages.push(assistant_msg);

    // Emit pending events, execute tools.
    for call in &calls {
      on_tool(ToolCallEvent {
        id: call.id.clone(),
        name: call.name.clone(),
        arguments: call.arguments.clone(),
        status: "executing".into(),
        result: None,
        error: None,
      });
    }

    let results = execute_tool(calls.clone()).await;

    // If any tool result asks for user confirmation (e.g. a sensitive
    // command), pause the agent loop: hand the current context to the
    // caller so it can persist the pending call and ask the user. We do
    // NOT yet append tool results in this case — `confirm_ai_tool` will
    // resume the loop with the resolved results.
    for (_, r) in &results {
      if let Ok(v) = serde_json::from_str::<serde_json::Value>(r) {
        if v.get("needsConfirmation").and_then(|b| b.as_bool()) == Some(true) {
          on_confirm_required(messages.clone(), calls.clone());
          return Err("__confirmation__".to_string());
        }
      }
    }

    // Log the executed tool calls: names + their original JSON arguments
    // (pretty-printed and colorized).
    eprintln!(
      "{}",
      paint(
        C_HEAD,
        &format!("[ai] agent_round{} executed {} tool call(s):", round + 1, calls.len()),
      )
    );
    for call in &calls {
      eprintln!(
        "  {} {}",
        paint(C_WARN, &call.name),
        paint(C_PUNCT, &format!("(id={})", call.id)),
      );
      let mut args_value =
        serde_json::from_str::<serde_json::Value>(&call.arguments).unwrap_or_else(|_| {
          serde_json::Value::String(call.arguments.clone())
        });
      truncate_json_for_log(&mut args_value);
      let args_pretty = serde_json::to_string_pretty(&args_value).unwrap_or_default();
      eprintln!("{}", colorize_json(&args_pretty));
    }

    // Append tool-result messages and emit done events.
    for call in &calls {
      let result = results
        .iter()
        .find(|(id, _)| id == &call.id)
        .map(|(_, r)| r.clone())
        .unwrap_or_else(|| "{\"error\":\"no result\"}".into());
      messages.push(AiMessage {
        role: "tool".into(),
        content: Some(result.clone()),
        tool_calls: None,
        tool_call_id: Some(call.id.clone()),
        name: Some(call.name.clone()),
        images: None,
      });
      on_tool(ToolCallEvent {
        id: call.id.clone(),
        name: call.name.clone(),
        arguments: call.arguments.clone(),
        status: "done".into(),
        result: Some(result),
        error: None,
      });
    }
    // Continue the loop for the next round.
  }

  Err(format!(
    "Reached maximum tool-call rounds ({max_rounds}); aborting agent loop."
  ))
}

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
    /// System prompt for the AI assistant
    #[serde(default = "default_system_prompt")]
    pub system_prompt: String,
}

fn default_system_prompt() -> String {
    "You are a helpful AI assistant integrated into Wrolp Terminal, a remote \
     server management tool. You help users with system administration, \
     command-line operations, debugging, and understanding server \
     configurations. Be concise and practical.".to_string()
}

impl AiEndpointProfile {
    pub fn new(name: String, endpoint: String) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            name,
            endpoint,
            api_key_enc: String::new(),
            model: "gpt-4o".to_string(),
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
}

impl AiConfig {
    /// The profile currently selected for use, or `None` if there are no
    /// profiles at all.
    pub fn active_profile(&self) -> Option<&AiEndpointProfile> {
        if self.profiles.is_empty() {
            return None
        }
        if !self.active_id.is_empty() {
            if let Some(p) = self.profiles.iter().find(|p| p.id == self.active_id) {
                return Some(p)
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
            system_prompt: default_system_prompt(),
        };
        let active_id = profile.id.clone();
        Self {
            profiles: vec![profile],
            active_id,
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
                    return Ok(AiConfig::default_config())
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
                        system_prompt: legacy.system_prompt,
                    };
                    let active_id = profile.id.clone();
                    Ok(AiConfig {
                        profiles: vec![profile],
                        active_id,
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
    // (an assistant message carrying tool_calls uses `null`).
    content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_calls: Option<Vec<OpenAiToolCall>>,
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
                    "Execute a shell command on a connected remote server and return its output. \
                     Use for read-only or non-destructive operations (status, logs, inspections). \
                     Avoid destructive commands."
                        .into(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "tabId": { "type": "integer", "description": "Tab id of the connected server" },
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
                description:
                    "Run a comprehensive read-only analysis of a connected server (OS, kernel, \
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
                description:
                    "List files and directories at a remote path on a connected server."
                        .into(),
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
                description:
                    "Read the contents of a text file on a connected server (truncated to 64KB)."
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
                description:
                    "List all saved connection profiles in the app (id, name, host, user, group)."
                        .into(),
                parameters: serde_json::json!({ "type": "object", "properties": {} }),
            },
        },
        OpenAiTool {
            tool_type: "function".into(),
            function: OpenAiFunction {
                name: "search_help".into(),
                description:
                    "Look up the man-page / help text for a command available on a connected \
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
                description:
                    "Get information about the server this AI conversation is currently bound to \
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

/// Maximum number of agent (tool-call) rounds before bailing out to avoid loops.
const MAX_AGENT_ROUNDS: usize = 10;

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
    let response = builder.send().await.map_err(|e| format!("Models request failed: {}", e))?;
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
pub async fn ai_chat_sync(config: &AiEndpointProfile, messages: &[AiMessage]) -> Result<String, String> {
    let api_key = crate::vault::open_secret(&config.api_key_enc)
        .map_err(|e| format!("Failed to decrypt API key: {}", e))?;

    let client = reqwest::Client::new();
    let request_body = OpenAiRequest {
        model: config.model.clone(),
        messages: messages
            .iter()
            .map(|m| OpenAiMessage {
                role: m.role.clone(),
                content: m.content.clone(),
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

    let response = client
        .post(&chat_url(&config.endpoint))
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&request_body)
        .send()
        .await
        .map_err(|e| format!("HTTP request failed: {}", e))?;

    let status = response.status();
    let body_text = response.text().await.unwrap_or_default();

    if !status.is_success() {
        if let Ok(err) = serde_json::from_str::<OpenAiErrorResponse>(&body_text) {
            return Err(format!("API error ({}): {}", status, err.error.message));
        }
        return Err(format!("API error ({}): {}", status, body_text));
    }

    let body: OpenAiResponse =
        serde_json::from_str(&body_text).map_err(|e| format!("Failed to parse response: {}", e))?;

    let content = body
        .choices
        .first()
        .map(|c| c.message.content.clone())
        .unwrap_or_default();

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
                content: m.content.clone(),
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

    let response = client
        .post(&chat_url(&config.endpoint))
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&request_body)
        .send()
        .await
        .map_err(|e| format!("HTTP request failed: {}", e))?;

    let status = response.status();
    if !status.is_success() {
        let body_text = response.text().await.unwrap_or_default();
        if let Ok(err) = serde_json::from_str::<OpenAiErrorResponse>(&body_text) {
            return Err(format!("API error ({}): {}", status, err.error.message));
        }
        return Err(format!("API error ({}): {}", status, body_text));
    }

    // Read response body as a byte stream and parse SSE events.
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
                            on_chunk(content);
                        }
                    }
                }
            }
        }
    }

    // Stream ended without explicit [DONE] — treat as success
    Ok(())
}

// ---- Agent loop (streaming chat with tool calling) ----

/// Result returned by the tool executor: `(tool_call_id, result_text)`.
pub type ToolResult = (String, String);

/// Convert a public `AiMessage` into the OpenAI wire format, preserving
/// assistant tool-calls and tool-result messages.
fn to_openai_messages(messages: &[AiMessage]) -> Vec<OpenAiMessage> {
    messages
        .iter()
        .map(|m| {
            let tool_calls = m.tool_calls.as_ref().map(|tcs| {
                tcs
                    .iter()
                    .map(|tc| OpenAiToolCall {
                        id: tc.id.clone(),
                        name: tc.name.clone(),
                        arguments: tc.arguments.clone(),
                    })
                    .collect::<Vec<_>>()
            });
            let has_tool_calls = tool_calls.as_ref().map(|v| !v.is_empty()).unwrap_or(false);
            OpenAiMessage {
                role: m.role.clone(),
                // When an assistant message carries tool_calls, `content` is None
                // and will be serialized as the explicit `null` that OpenAI-style
                // models (incl. gpt-oss) require. Regular text messages keep their
                // content string.
                content: m.content.clone(),
                tool_calls: if has_tool_calls { tool_calls } else { None },
                tool_call_id: m.tool_call_id.clone(),
                // `role: "tool"` messages must not carry `name` (that field is only
                // for the legacy `role: "function"` format); some endpoints reject it.
                name: if m.role == "tool" { None } else { m.name.clone() },
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
pub async fn run_agent_stream(
    config: &AiEndpointProfile,
    initial_messages: Vec<AiMessage>,
    mut on_chunk: impl FnMut(String),
    mut on_tool: impl FnMut(ToolCallEvent),
    mut execute_tool: impl FnMut(Vec<OpenAiToolCall>) -> futures_util::future::BoxFuture<'static, Vec<ToolResult>>,
    mut on_confirm_required: impl FnMut(Vec<AiMessage>, Vec<OpenAiToolCall>),
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

    for _round in 0..MAX_AGENT_ROUNDS {
        let wire = to_openai_messages(&messages);
        let request_body = OpenAiRequest {
            model: config.model.clone(),
            messages: wire,
            stream: true,
            max_tokens: Some(4096),
            temperature: Some(0.7),
            tools: Some(tools.clone()),
        };

        let response = client
            .post(&chat_url(&config.endpoint))
            .header("Authorization", format!("Bearer {}", api_key))
            .header("Content-Type", "application/json")
            .json(&request_body)
            .send()
            .await
            .map_err(|e| format!("HTTP request failed: {}", e))?;

        let status = response.status();
        if !status.is_success() {
            let body_text = response.text().await.unwrap_or_default();
            if let Ok(err) = serde_json::from_str::<OpenAiErrorResponse>(&body_text) {
                return Err(format!("API error ({}): {}", status, err.error.message));
            }
            return Err(format!("API error ({}): {}", status, body_text));
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
                                    let entry = tool_acc.entry(td.index).or_insert((None, None, String::new()));
                                    if let Some(id) = td.id {
                                        entry.0 = Some(id);
                                    }
                                    if let Some(name) = td.function.as_ref().and_then(|f| f.name.clone()) {
                                        entry.1 = Some(name);
                                    }
                                    if let Some(args) = td.function.as_ref().and_then(|f| f.arguments.clone()) {
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
            content: if assistant_content.is_empty() { None } else { Some(assistant_content) },
            tool_calls: None,
            tool_call_id: None,
            name: None,
        };

        if !saw_tool_call {
            // No tool calls → conversation finished.
            return Ok(assistant_msg);
        }

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
        "Reached maximum tool-call rounds ({MAX_AGENT_ROUNDS}); aborting agent loop."
    ))
}

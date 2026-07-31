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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConfig {
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

impl AiConfig {
    pub fn default_config() -> Self {
        Self {
            endpoint: "https://api.openai.com/v1".to_string(),
            api_key_enc: String::new(),
            model: "gpt-4o".to_string(),
            system_prompt: default_system_prompt(),
        }
    }
}

// ---- AI Messages (public DTO) ----

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiMessage {
    pub role: String,
    pub content: String,
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
        let config: AiConfig = serde_json::from_str(&content).map_err(|e| e.to_string())?;
        Ok(config)
    } else {
        Ok(AiConfig::default_config())
    }
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
}

#[derive(Serialize)]
struct OpenAiMessage {
    role: String,
    content: String,
}

// Streaming response chunks
#[derive(Deserialize)]
struct OpenAiStreamChunk {
    choices: Option<Vec<OpenAiStreamChoice>>,
}

#[derive(Deserialize, Clone)]
struct OpenAiStreamChoice {
    delta: Option<OpenAiStreamDelta>,
}

#[derive(Deserialize, Clone)]
struct OpenAiStreamDelta {
    content: Option<String>,
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

// ---- Non-streaming chat ----

/// Send a non-streaming chat request. Returns the full assistant response text.
pub async fn ai_chat_sync(config: &AiConfig, messages: &[AiMessage]) -> Result<String, String> {
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
            })
            .collect(),
        stream: false,
        max_tokens: Some(4096),
        temperature: Some(0.7),
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
    config: &AiConfig,
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
            })
            .collect(),
        stream: true,
        max_tokens: Some(4096),
        temperature: Some(0.7),
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

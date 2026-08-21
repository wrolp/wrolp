use super::*;
// ==================== Window Config Persistence ====================

/// Synchronously read the `auto_record_sessions` flag from window.json.
/// Used inside `connect()` (which is async but runs on the main thread), so we
/// read the file directly instead of awaiting a command.
pub(crate) fn load_window_config_auto_record() -> bool {
  get_window_config_path()
    .and_then(|p| std::fs::read_to_string(p).ok())
    .and_then(|content| serde_json::from_str::<WindowConfig>(&content).ok())
    .map(|c| c.auto_record_sessions)
    .unwrap_or(false)
}

/// Read the current auto-record Sessions setting (Settings page).
#[tauri::command]
pub async fn get_auto_record() -> bool {
  load_window_config_auto_record()
}

/// Persist the auto-record Sessions setting (Settings page).
#[tauri::command]
pub async fn set_auto_record(enabled: bool) -> Result<(), String> {
  let path = get_window_config_path().ok_or("Cannot determine config directory")?;
  let mut config = match std::fs::read_to_string(&path)
    .ok()
    .and_then(|c| serde_json::from_str::<WindowConfig>(&c).ok())
  {
    Some(c) => c,
    None => WindowConfig::default(),
  };
  config.auto_record_sessions = enabled;
  let content = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
  std::fs::write(&path, content).map_err(|e| e.to_string())
}

/// Synchronously read the SSH keepalive settings from window.json.
/// Used inside `connect()`. Enforces the minimums (interval >= 10s, count >= 2);
/// values below the minimum are filtered out so a misconfigured file can't
/// disable keepalive entirely.
pub(crate) fn load_keepalive() -> Option<(std::time::Duration, u64)> {
  get_window_config_path()
    .and_then(|p| std::fs::read_to_string(p).ok())
    .and_then(|content| serde_json::from_str::<WindowConfig>(&content).ok())
    .filter(|c| c.keepalive_interval >= 10 && c.keepalive_max >= 2)
    .map(|c| (std::time::Duration::from_secs(c.keepalive_interval), c.keepalive_max))
}

/// SSH keepalive settings returned to the Settings page.
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeepaliveConfig {
  pub interval: u64,
  pub max: u64,
}

/// Read the current SSH keepalive settings (Settings page).
#[tauri::command]
pub async fn get_keepalive() -> KeepaliveConfig {
  let config = get_window_config_path()
    .and_then(|p| std::fs::read_to_string(p).ok())
    .and_then(|content| serde_json::from_str::<WindowConfig>(&content).ok())
    .unwrap_or_else(WindowConfig::default);
  KeepaliveConfig {
    interval: config.keepalive_interval,
    max: config.keepalive_max,
  }
}

/// Persist SSH keepalive settings (Settings page). Values below the minimums
/// (interval < 10s, count < 2) are clamped up to the minimum.
#[tauri::command]
pub async fn set_keepalive(interval: u64, max: u64) -> Result<(), String> {
  let path = get_window_config_path().ok_or("Cannot determine config directory")?;
  let mut config = std::fs::read_to_string(&path)
    .ok()
    .and_then(|c| serde_json::from_str::<WindowConfig>(&c).ok())
    .unwrap_or_else(WindowConfig::default);
  config.keepalive_interval = interval.max(10);
  config.keepalive_max = max.max(2);
  let content = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
  std::fs::write(&path, content).map_err(|e| e.to_string())
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WindowConfig {
  pub x: i32,
  pub y: i32,
  pub width: u32,
  pub height: u32,
  pub maximized: bool,
  pub opacity: f64,
  pub ai_input_height: f64,
  #[serde(default)]
  pub collapsed_groups: Vec<String>,
  #[serde(default)]
  pub auto_record_sessions: bool,
  /// SSH keepalive interval in seconds. Sent as an SSH-level keepalive so the
  /// app can detect silently-dropped connections. Minimum 10 (enforced on save).
  #[serde(default = "default_keepalive_interval")]
  pub keepalive_interval: u64,
  /// Number of unanswered keepalives before the connection is declared dead
  /// and torn down. Minimum 2 (enforced on save).
  #[serde(default = "default_keepalive_max")]
  pub keepalive_max: u64,
}

impl Default for WindowConfig {
  fn default() -> Self {
    Self {
      x: i32::MAX,
      y: i32::MAX,
      width: 1100,
      height: 700,
      maximized: false,
      opacity: 1.0,
      ai_input_height: 120.0,
      collapsed_groups: Vec::new(),
      auto_record_sessions: false,
      keepalive_interval: 30,
      keepalive_max: 3,
    }
  }
}

/// Default SSH keepalive interval (seconds) when not configured.
fn default_keepalive_interval() -> u64 { 30 }

/// Default SSH keepalive retry count when not configured.
fn default_keepalive_max() -> u64 { 3 }

#[tauri::command]
pub async fn save_window_config(config: WindowConfig) -> Result<(), String> {
  let path = get_window_config_path().ok_or("Cannot determine config directory")?;
  if let Some(parent) = path.parent() {
    let _ = tokio::fs::create_dir_all(parent).await;
  }
  let content = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
  tokio::fs::write(&path, content)
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn load_window_config() -> Result<WindowConfig, String> {
  let path = get_window_config_path().ok_or("Cannot determine config directory")?;
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
  let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
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
  let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
  tokio::fs::create_dir_all(&dir)
    .await
    .map_err(|e| e.to_string())?;
  let path = dir.join("layout.json");
  tokio::fs::write(&path, layout)
    .await
    .map_err(|e| e.to_string())
}

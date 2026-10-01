use super::*;
// ==================== Device command index (plan §2.B) ====================
//
// One device's available commands, keyed by its host fingerprint, collected by
// `crate::host_commands`. The frontend reads it once per device and keeps it in
// memory — the ghost pool is consulted on every keystroke, so it must never hit
// SQLite — and it re-reads when `host-commands-updated` arrives.

/// (Re)collect the command index for one tab's device. Manual entry point: the
/// settings card's "refresh" button, which ignores the age gate because a user who
/// just installed a package wants it now, not after the next week passes.
///
/// `fingerprint` comes from the caller because it is the caller's own knowledge —
/// the `host-identified` event it already received — and no security decision keys
/// off it. Returns the number of commands indexed.
#[tauri::command]
pub async fn collect_host_commands(
  app: tauri::AppHandle,
  tab_id: u32,
  fingerprint: String,
  kind: String,
  distro: Option<String>,
) -> Result<i64, String> {
  if fingerprint.trim().is_empty() {
    return Err("This terminal has not identified its device yet".into());
  }
  let stored = crate::host_commands::collect_for_tab(
    &app,
    tab_id,
    fingerprint.trim(),
    &kind,
    distro.as_deref(),
  )
  .await?;
  Ok(stored as i64)
}

/// A device's indexed commands. Empty means never collected (or nothing could be
/// enumerated), which the UI shows as "no index yet" rather than as an error.
#[tauri::command]
pub async fn list_host_commands(
  state: tauri::State<'_, AppState>,
  fingerprint: String,
) -> Result<Vec<crate::host_commands::HostCommandDto>, String> {
  let conn = state.db.lock().map_err(|e| e.to_string())?;
  db::list_host_commands(&conn, &fingerprint)
}

/// Forget what a device can run (plan §4's privacy exit). The device itself stays
/// recorded — its fingerprint is what the connection list and the status chip read,
/// and the command names are the only part that could ever be sensitive.
///
/// Automatic collection is held off afterwards, so reconnecting does not silently
/// relearn it; the refresh button above is what resumes that. Returns the number of
/// rows removed.
#[tauri::command]
pub async fn clear_host_commands(
  app: tauri::AppHandle,
  fingerprint: String,
) -> Result<i64, String> {
  let fingerprint = fingerprint.trim().to_string();
  if fingerprint.is_empty() {
    return Ok(0);
  }
  let Some(state) = app.try_state::<AppState>() else {
    return Err("no application state".into());
  };
  let db = state.db.clone();
  let now_ms = chrono::Utc::now().timestamp_millis();
  let fp_for_emit = fingerprint.clone();
  let removed = tokio::task::spawn_blocking(move || {
    let conn = db.lock().map_err(|e| e.to_string())?;
    Ok::<i64, String>(db::clear_host_commands(&conn, &fingerprint, now_ms)? as i64)
  })
  .await
  .map_err(|e| e.to_string())??;

  // Every tab on this device must drop its in-memory copy, or completion keeps
  // offering names the user just asked us to forget.
  let _ = app.emit(
    "host-commands-updated",
    serde_json::json!({ "fingerprint": fp_for_emit, "count": 0 }),
  );
  Ok(removed)
}

use super::*;
// ==================== Command history (the terminal pane's 历史 dropdown) ====================
//
// The per-terminal list lives in the frontend (it is session state); this is the
// cross-tab, cross-restart one. Both are fed from the same place: the terminal's
// Enter handler, which is the only point that knows what was actually submitted
// (tab completion included).

/// Remember a submitted command. Blank input is ignored; re-running a command
/// moves it to the top of the list rather than duplicating it.
#[tauri::command]
pub async fn record_command_history(
  state: tauri::State<'_, AppState>,
  command: String,
  tab_type: Option<String>,
  host: Option<String>,
) -> Result<(), String> {
  let command = command.trim().to_string();
  if command.is_empty() {
    return Ok(());
  }
  let conn = state.db.clone();
  // The write takes the shared database mutex, so it goes off the async runtime —
  // otherwise it would stall every other command, `poll_output` included.
  tokio::task::spawn_blocking(move || {
    let conn = conn.lock().map_err(|e| e.to_string())?;
    db::record_command(
      &conn,
      &command,
      &tab_type.unwrap_or_default(),
      &host.unwrap_or_default(),
      now_ms() as i64,
    )
  })
  .await
  .map_err(|e| e.to_string())?
}

/// The persisted history, newest first. `limit` defaults to the whole table.
#[tauri::command]
pub async fn list_command_history(
  state: tauri::State<'_, AppState>,
  limit: Option<i64>,
) -> Result<Vec<db::CommandHistoryDto>, String> {
  let conn = state.db.lock().map_err(|e| e.to_string())?;
  db::list_commands(&conn, limit.unwrap_or(db::COMMAND_HISTORY_KEEP))
}

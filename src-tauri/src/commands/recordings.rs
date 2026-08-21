use super::*;
// ==================== Session Recording ====================

/// Flush all in-memory recording buffers to SQLite. Called periodically by a
/// background task and on app shutdown.
pub fn flush_all_recordings(state: &AppState) {
  let mut to_flush: Vec<(String, Vec<db::RecordedEvent>)> = Vec::new();
  {
    if let Ok(mut recordings) = state.recordings.lock() {
      for rec in recordings.values_mut() {
        if rec.events.is_empty() {
          continue;
        }
        let drained = std::mem::take(&mut rec.events);
        to_flush.push((rec.session_id.clone(), drained));
      }
    }
  }
  if to_flush.is_empty() {
    return;
  }
  if let Ok(conn) = state.db.lock() {
    for (session_id, events) in to_flush {
      let _ = db::insert_events(&conn, &session_id, &events);
    }
  }
}

/// Finalize a single in-memory recording: flush its events, then either
/// finalize the session row or (if nothing was ever recorded) drop it. Sessions
/// that were never persisted (`db_saved` is false, i.e. recording was off the
/// whole time) are skipped entirely so they never appear in the list.
pub fn finalize_recording(conn: &rusqlite::Connection, rec: &ActiveRecording) {
  if !rec.db_saved {
    return;
  }
  let _ = db::insert_events(conn, &rec.session_id, &rec.events);
  let event_count = db::count_session_events(conn, &rec.session_id).unwrap_or(0);
  if event_count == 0 {
    // Started but produced no events — discard the empty session row.
    let _ = db::delete_session(conn, &rec.session_id);
    return;
  }
  let ended_at = chrono::Utc::now().to_rfc3339();
  let duration = rec.started_at.elapsed().as_secs() as i64;
  let _ = db::finalize_session(conn, &rec.session_id, &ended_at, duration, event_count);
}

#[tauri::command]
pub async fn list_sessions(
  state: tauri::State<'_, AppState>,
  connection_id: Option<String>,
  limit: Option<u32>,
) -> Result<Vec<SessionSummary>, String> {
  let conn = state.db.lock().map_err(|e| e.to_string())?;
  db::list_sessions(&conn, connection_id.as_deref(), limit.unwrap_or(100))
}

#[tauri::command]
pub async fn get_session_events(
  state: tauri::State<'_, AppState>,
  session_id: String,
) -> Result<Vec<SessionEventDto>, String> {
  let conn = state.db.lock().map_err(|e| e.to_string())?;
  db::get_session_events(&conn, &session_id)
}

#[tauri::command]
pub async fn delete_session(
  state: tauri::State<'_, AppState>,
  session_id: String,
) -> Result<(), String> {
  let conn = state.db.lock().map_err(|e| e.to_string())?;
  db::delete_session(&conn, &session_id)
}

#[tauri::command]
pub async fn delete_all_sessions(state: tauri::State<'_, AppState>) -> Result<(), String> {
  let conn = state.db.lock().map_err(|e| e.to_string())?;
  db::delete_all_sessions(&conn)
}

/// Toggle session recording for a specific tab (the per-pane record button).
/// `enabled` is the desired state. Returns the current state after the change.
#[tauri::command]
pub async fn set_recording_enabled(
  state: tauri::State<'_, AppState>,
  tab_id: u32,
  enabled: bool,
) -> Result<bool, String> {
  let mut recordings = state.recordings.lock().map_err(|e| e.to_string())?;
  if let Some(rec) = recordings.get_mut(&tab_id) {
    rec.recording_enabled = enabled;
    // Lazily persist the session row the moment recording is switched on (it
    // was intentionally not created at connect time when recording was off).
    if enabled && !rec.db_saved {
      let started_at_iso = chrono::Utc::now().to_rfc3339();
      rec.started_at_iso = started_at_iso.clone();
      rec.started_at = std::time::Instant::now();
      if let Ok(conn) = state.db.lock() {
        let _ = db::create_session(
          &conn,
          &rec.session_id,
          &rec.connection_id,
          &rec.connection_name,
          tab_id,
          &started_at_iso,
        );
      }
      rec.db_saved = true;
    }
    Ok(rec.recording_enabled)
  } else {
    // No in-memory recording entry (e.g. local shell) — nothing to toggle.
    Ok(enabled)
  }
}

/// Query whether recording is currently enabled for a tab.
#[tauri::command]
pub async fn get_recording_enabled(
  state: tauri::State<'_, AppState>,
  tab_id: u32,
) -> Result<bool, String> {
  let recordings = state.recordings.lock().map_err(|e| e.to_string())?;
  Ok(
    recordings
      .get(&tab_id)
      .map(|r| r.recording_enabled)
      .unwrap_or(false),
  )
}

#[tauri::command]
pub async fn rename_session(
  state: tauri::State<'_, AppState>,
  session_id: String,
  title: String,
) -> Result<(), String> {
  let conn = state.db.lock().map_err(|e| e.to_string())?;
  db::rename_session(&conn, &session_id, &title)
}

/// Record the full command line as submitted by the user. The text is captured
/// on the frontend from the terminal buffer at the moment Enter is pressed, which
/// preserves tab-completed text that is otherwise lost when only raw keystrokes
/// (`input` events, which contain literal `\t`) are recorded.
#[tauri::command]
pub async fn commit_command(
  state: tauri::State<'_, AppState>,
  tab_id: u32,
  command: String,
) -> Result<bool, String> {
  if let Ok(mut recordings) = state.recordings.lock() {
    if let Some(rec) = recordings.get_mut(&tab_id) {
      if rec.recording_enabled {
        let seq = rec.seq_counter;
        rec.seq_counter += 1;
        let elapsed = rec.started_at.elapsed().as_millis() as u64;
        rec.events.push(db::RecordedEvent {
          seq,
          timestamp_ms: elapsed,
          direction: "command".to_string(),
          content: command,
        });
      }
    }
  }
  Ok(true)
}

#[tauri::command]
pub async fn extract_commands(
  state: tauri::State<'_, AppState>,
  session_id: String,
) -> Result<Vec<String>, String> {
  let conn = state.db.lock().map_err(|e| e.to_string())?;
  let events = db::get_session_events(&conn, &session_id)?;

  // Prefer precise "command" events captured on Enter — they already contain
  // tab-completed text and exact spacing, so they are more faithful than the
  // raw keystroke stream.
  let mut precise_commands: Vec<String> = Vec::new();
  for ev in &events {
    if ev.direction == "command" {
      precise_commands.push(ev.content.clone());
    }
  }
  if !precise_commands.is_empty() {
    let mut seen = std::collections::HashSet::new();
    let mut commands = Vec::new();
    for raw in precise_commands {
      // AI-issued commands are stored with an `[AI] ` marker so playback can
      // show who ran them; strip it here so the extracted list stays runnable.
      let trimmed = raw
        .trim()
        .strip_prefix(AI_COMMAND_PREFIX.trim_end())
        .unwrap_or(raw.trim())
        .trim();
      if trimmed.is_empty() {
        continue;
      }
      if seen.insert(trimmed.to_string()) {
        commands.push(trimmed.to_string());
      }
    }
    return Ok(commands);
  }

  // Fallback for sessions recorded before precise command capture existed:
  // reconstruct from the raw input stream. NOTE: commands that used tab
  // completion will appear incomplete here (the literal `\t` is recorded but
  // the server-completed text is not).
  let mut all_input = String::new();
  for ev in &events {
    if ev.direction == "input" {
      all_input.push_str(&ev.content);
    }
  }

  // Split by newlines, filter empty, deduplicate preserving order
  let mut seen = std::collections::HashSet::new();
  let mut commands = Vec::new();
  for line in all_input.split(['\n', '\r']) {
    let trimmed = line.trim();
    if trimmed.is_empty() {
      continue;
    }
    if seen.insert(trimmed.to_string()) {
      commands.push(trimmed.to_string());
    }
  }
  Ok(commands)
}

// ==================== Command Sets ====================

#[tauri::command]
pub async fn list_command_sets(
  state: tauri::State<'_, AppState>,
  connection_id: Option<String>,
) -> Result<Vec<CommandSetDto>, String> {
  let conn = state.db.lock().map_err(|e| e.to_string())?;
  db::list_command_sets(&conn, connection_id.as_deref())
}

#[tauri::command]
pub async fn save_command_set(
  state: tauri::State<'_, AppState>,
  cmd_set: CommandSetDto,
) -> Result<String, String> {
  let conn = state.db.lock().map_err(|e| e.to_string())?;
  db::save_command_set(&conn, &cmd_set)
}

#[tauri::command]
pub async fn delete_command_set(
  state: tauri::State<'_, AppState>,
  id: String,
) -> Result<(), String> {
  let conn = state.db.lock().map_err(|e| e.to_string())?;
  db::delete_command_set(&conn, &id)
}

// ==================== Command Snippets (floating command list) ====================

#[tauri::command]
pub async fn list_command_snippets(
  state: tauri::State<'_, AppState>,
) -> Result<Vec<db::CommandSnippetDto>, String> {
  eprintln!("[command_snippets] list called");
  let conn = state.db.lock().map_err(|e| e.to_string())?;
  let result = db::list_command_snippets(&conn);
  eprintln!("[command_snippets] list result: {:?}", result.as_ref().map(|v| v.len()));
  result
}

#[tauri::command]
pub async fn save_command_snippet(
  state: tauri::State<'_, AppState>,
  snippet: db::CommandSnippetDto,
) -> Result<String, String> {
  let conn = state.db.lock().map_err(|e| e.to_string())?;
  db::save_command_snippet(&conn, &snippet)
}

#[tauri::command]
pub async fn delete_command_snippet(
  state: tauri::State<'_, AppState>,
  id: String,
) -> Result<(), String> {
  let conn = state.db.lock().map_err(|e| e.to_string())?;
  db::delete_command_snippet(&conn, &id)
}

// ==================== Global Variables (shared by command snippets) ====================

#[tauri::command]
pub async fn list_global_variables(
  state: tauri::State<'_, AppState>,
) -> Result<Vec<db::GlobalVariable>, String> {
  let conn = state.db.lock().map_err(|e| e.to_string())?;
  db::list_global_variables(&conn)
}

#[tauri::command]
pub async fn save_global_variable(
  state: tauri::State<'_, AppState>,
  var: db::GlobalVariable,
) -> Result<String, String> {
  let conn = state.db.lock().map_err(|e| e.to_string())?;
  db::save_global_variable(&conn, &var)
}

#[tauri::command]
pub async fn delete_global_variable(
  state: tauri::State<'_, AppState>,
  name: String,
) -> Result<(), String> {
  let conn = state.db.lock().map_err(|e| e.to_string())?;
  db::delete_global_variable(&conn, &name)
}

// ==================== AI Prompt Templates ====================

#[tauri::command]
pub async fn list_ai_prompt_templates(
  state: tauri::State<'_, AppState>,
) -> Result<Vec<AiPromptTemplate>, String> {
  let conn = state.db.lock().map_err(|e| e.to_string())?;
  db::list_ai_prompt_templates(&conn)
}

#[tauri::command]
pub async fn save_ai_prompt_template(
  state: tauri::State<'_, AppState>,
  template: AiPromptTemplate,
) -> Result<String, String> {
  let conn = state.db.lock().map_err(|e| e.to_string())?;
  db::save_ai_prompt_template(&conn, &template)
}

#[tauri::command]
pub async fn delete_ai_prompt_template(
  state: tauri::State<'_, AppState>,
  id: String,
) -> Result<(), String> {
  let conn = state.db.lock().map_err(|e| e.to_string())?;
  db::delete_ai_prompt_template(&conn, &id)
}

#[tauri::command]
pub async fn list_hidden_builtin_templates(
  state: tauri::State<'_, AppState>,
) -> Result<Vec<String>, String> {
  let conn = state.db.lock().map_err(|e| e.to_string())?;
  db::list_hidden_builtin_templates(&conn)
}

#[tauri::command]
pub async fn hide_builtin_template(
  state: tauri::State<'_, AppState>,
  key: String,
) -> Result<(), String> {
  let conn = state.db.lock().map_err(|e| e.to_string())?;
  db::hide_builtin_template(&conn, &key)
}

#[tauri::command]
pub async fn restore_builtin_template(
  state: tauri::State<'_, AppState>,
  key: String,
) -> Result<(), String> {
  let conn = state.db.lock().map_err(|e| e.to_string())?;
  db::restore_builtin_template(&conn, &key)
}


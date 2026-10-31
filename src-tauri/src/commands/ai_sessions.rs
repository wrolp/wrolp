use super::*;
// ==================== AI conversation storage ====================
//
// The message stream lives in an append-only NDJSON file (see
// `ai_session_file.rs`); the `ai_sessions` table is only the index/search
// layer. All six commands carry the `ai_` prefix so they never collide with
// the recording commands (`list_sessions` / `delete_session` / …).

fn messages_array(save: &db::AiSessionSave) -> Vec<serde_json::Value> {
  save.messages.as_array().cloned().unwrap_or_default()
}

/// Resolve (or derive) the message-file path for a session. The index row's
/// `session_file` wins when present (the path never moves, even after a rename);
/// otherwise the path is derived from the workspace / connection / created time.
fn session_file_path(state: &AppState, save: &db::AiSessionSave) -> std::path::PathBuf {
  let existing = {
    let conn = state.db.lock().ok();
    conn
      .and_then(|c| db::get_ai_session(&c, &save.id).ok())
      .flatten()
      .and_then(|s| s.session_file)
  };
  if let Some(p) = existing {
    return std::path::PathBuf::from(p);
  }
  let root = crate::ai_session_file::ai_sessions_root(state.base_dir.as_deref());
  let local = save
    .created_at
    .as_deref()
    .map(crate::rec_file::started_local)
    .unwrap_or_else(chrono::Local::now);
  crate::ai_session_file::derive_session_file(
    &root,
    save.workspace_id.as_deref().unwrap_or(crate::rec_file::DEFAULT_WORKSPACE),
    save.connection_name.as_deref().unwrap_or(""),
    &local,
    &save.id,
  )
}

/// Build a summary from an index row + the live visible message count (so the
/// returned `messageCount` reflects what was just written, not a stale column).
fn summary_from_row(row: db::AiSessionSummary, message_count: i64) -> db::AiSessionSummary {
  db::AiSessionSummary {
    message_count,
    ..row
  }
}

/// List AI sessions (index only), pinned first then newest-updated. Each row's
/// `session_file` is checked so a manually-deleted file surfaces as "missing"
/// rather than crashing the UI.
#[tauri::command]
pub async fn list_ai_sessions(
  state: tauri::State<'_, AppState>,
  connection_id: Option<String>,
  limit: Option<u32>,
) -> Result<Vec<db::AiSessionSummary>, String> {
  let mut rows = {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::list_ai_sessions(&conn, connection_id.as_deref(), limit.unwrap_or(200))?
  };
  for s in rows.iter_mut() {
    let file = match &s.session_file {
      Some(f) => std::path::PathBuf::from(f),
      None => continue,
    };
    if !file.is_file() {
      s.session_file = None;
    }
  }
  Ok(rows)
}

/// Load one session: index row + the visible messages read from its file.
/// `None` for an unknown id.
#[tauri::command]
pub async fn load_ai_session(
  state: tauri::State<'_, AppState>,
  id: String,
) -> Result<Option<db::AiSession>, String> {
  let row = {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::get_ai_session(&conn, &id)?
  };
  let Some(row) = row else { return Ok(None) };
  let messages = match &row.session_file {
    Some(f) => {
      let path = std::path::Path::new(f);
      if path.is_file() {
        let records = crate::ai_session_file::read_records(path)?;
        serde_json::Value::Array(crate::ai_session_file::visible_messages(&records))
      } else {
        // File deleted out from under us: return the row with empty messages so
        // the UI can show "file missing" instead of a load error.
        serde_json::Value::Array(Vec::new())
      }
    }
    None => serde_json::Value::Array(Vec::new()),
  };
  Ok(Some(db::AiSession {
    id: row.id,
    title: row.title,
    connection_id: row.connection_id,
    connection_name: row.connection_name,
    workspace_id: row.workspace_id,
    profile_id: row.profile_id,
    model: row.model,
    mode: row.mode,
    tool_call_format: row.tool_call_format,
    pinned: row.pinned,
    message_count: row.message_count,
    created_at: row.created_at,
    updated_at: row.updated_at,
    messages,
  }))
}

/// Save a conversation: align the file's visible messages to the incoming list
/// (append-only, reset on shrink/edit-resend), then update the index. Returns
/// the fresh summary so the frontend can reconcile without another read.
#[tauri::command]
pub async fn save_ai_session(
  state: tauri::State<'_, AppState>,
  session: db::AiSessionSave,
) -> Result<db::AiSessionSummary, String> {
  // Serialize file appends so two concurrent saves of one session can't
  // interleave (read-modify-write of the same .jsonl).
  let _guard = state.ai_sessions_write.lock().map_err(|e| e.to_string())?;
  let path = session_file_path(&state, &session);
  let incoming = messages_array(&session);

  // First save → write the immutable session header, then the messages.
  let records = if !path.exists() {
    let header = crate::ai_session_file::header_line(
      &session.id,
      session.workspace_id.as_deref(),
      session.connection_id.as_deref(),
      session.connection_name.as_deref(),
      session.profile_id.as_deref(),
      session.model.as_deref(),
      &session.mode,
      &session.tool_call_format,
    );
    crate::ai_session_file::append_lines(&path, &[header])?;
    Vec::new()
  } else {
    crate::ai_session_file::read_records(&path)?
  };

  let lines = crate::ai_session_file::align_lines(&records, &session.id, &incoming);
  crate::ai_session_file::append_lines(&path, &lines)?;

  // Visible count = incoming's length (the file now matches it by construction).
  let visible_count = incoming.len() as i64;
  let now = chrono::Utc::now().to_rfc3339();
  let conn = state.db.lock().map_err(|e| e.to_string())?;
  db::upsert_ai_session(&conn, &session, &path.to_string_lossy(), visible_count, &now)?;

  // Retention: past the cap, the oldest non-pinned sessions are *moved* to the
  // archive directory (never deleted) and their index rows dropped.
  enforce_ai_session_retention(&conn, state.base_dir.as_deref())?;

  let row = db::get_ai_session(&conn, &session.id)?.ok_or_else(|| "session row vanished".to_string())?;
  Ok(summary_from_row(row, visible_count))
}

/// Keep at most `MAX_AI_SESSIONS` index rows; archive the overflow (oldest
/// non-pinned, since `list_ai_sessions` returns pinned-first / newest-first).
fn enforce_ai_session_retention(
  conn: &rusqlite::Connection,
  data_dir: Option<&std::path::Path>,
) -> Result<u32, String> {
  const MAX_AI_SESSIONS: usize = 500;
  if (db::count_ai_sessions(conn)? as usize) <= MAX_AI_SESSIONS {
    return Ok(0);
  }
  let all = db::list_ai_sessions(conn, None, u32::MAX)?;
  let archive_root = crate::ai_session_file::ai_sessions_archive_root(data_dir);
  let mut archived = 0u32;
  for s in all.iter().skip(MAX_AI_SESSIONS) {
    let Some(f) = &s.session_file else { continue };
    let file = std::path::PathBuf::from(f);
    if !file.is_file() {
      continue;
    }
    if crate::ai_session_file::archive_session_file(&file, &archive_root).is_ok() {
      db::delete_ai_session(conn, &s.id)?;
      archived += 1;
    }
  }
  Ok(archived)
}

/// Delete a session: drop the index row, remove the file, prune empty folders.
#[tauri::command]
pub async fn delete_ai_session(
  state: tauri::State<'_, AppState>,
  id: String,
) -> Result<bool, String> {
  let file = {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::delete_ai_session(&conn, &id)?
  };
  let Some(f) = file else { return Ok(false) };
  let path = std::path::PathBuf::from(f);
  crate::ai_session_file::remove_file(&path);
  crate::ai_session_file::prune_ai_session_dirs(&path);
  Ok(true)
}

/// Rename a session (index only; the file keeps its original location).
#[tauri::command]
pub async fn rename_ai_session(
  state: tauri::State<'_, AppState>,
  id: String,
  title: String,
) -> Result<bool, String> {
  let conn = state.db.lock().map_err(|e| e.to_string())?;
  db::rename_ai_session(&conn, &id, &title)?;
  Ok(true)
}

/// Pin / unpin a session (index only).
#[tauri::command]
pub async fn pin_ai_session(
  state: tauri::State<'_, AppState>,
  id: String,
  pinned: bool,
) -> Result<bool, String> {
  let conn = state.db.lock().map_err(|e| e.to_string())?;
  db::pin_ai_session(&conn, &id, pinned)?;
  Ok(true)
}

/// Write a plain-text export (Markdown / JSON) to a user-chosen path. The
/// frontend owns the serialization; this is the thinnest possible sink, mirroring
/// how `export_session_cast` writes to a dialog-picked path.
#[tauri::command]
pub async fn write_text_file(path: String, content: String) -> Result<(), String> {
  std::fs::write(&path, content).map_err(|e| e.to_string())
}

/// Result of a `rebuild_ai_sessions` scan.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSessionRebuildSummary {
  /// Index rows created for files the table had lost.
  pub restored: u32,
  /// Index rows refreshed (message count / meta) from the file.
  pub updated: u32,
  /// Files that could not be read or lacked a session header.
  pub failed: u32,
}

/// Rebuild `ai_sessions` index rows by scanning `<ai-sessions>/**/*.jsonl`.
/// A manually-deleted index (or a lost DB) is recovered from the files; rows
/// that still exist are refreshed without clobbering the user's rename / pin.
#[tauri::command]
pub async fn rebuild_ai_sessions(
  state: tauri::State<'_, AppState>,
) -> Result<AiSessionRebuildSummary, String> {
  let root = crate::ai_session_file::ai_sessions_root(state.base_dir.as_deref());
  let files = crate::ai_session_file::scan_session_files(&root);
  let mut restored = 0u32;
  let mut updated = 0u32;
  let mut failed = 0u32;
  let conn = state.db.lock().map_err(|e| e.to_string())?;

  for file in files {
    let path_str = file.to_string_lossy().to_string();
    let records = match crate::ai_session_file::read_records(&file) {
      Ok(r) => r,
      Err(_) => {
        failed += 1;
        continue;
      }
    };
    let Some(id) = crate::ai_session_file::header_string(&records, "id").map(str::to_string) else {
      failed += 1;
      continue;
    };
    let visible = crate::ai_session_file::visible_messages(&records);
    let existed = db::get_ai_session(&conn, &id)?.is_some();
    let save = db::AiSessionSave {
      id,
      // Derived title only matters for a *fresh* row; an existing row's title
      // (and pin) is preserved by `rebuild_ai_session`'s ON CONFLICT.
      title: crate::ai_session_file::first_user_text(&visible),
      tab_id: None,
      connection_id: crate::ai_session_file::header_string(&records, "connectionId")
        .map(str::to_string),
      connection_name: crate::ai_session_file::header_string(&records, "connectionName")
        .map(str::to_string),
      workspace_id: crate::ai_session_file::header_string(&records, "workspaceId").map(str::to_string),
      profile_id: crate::ai_session_file::header_string(&records, "profileId").map(str::to_string),
      model: crate::ai_session_file::header_string(&records, "model").map(str::to_string),
      mode: crate::ai_session_file::header_string(&records, "mode")
        .unwrap_or("chat")
        .to_string(),
      tool_call_format: crate::ai_session_file::header_string(&records, "toolCallFormat")
        .unwrap_or("nested")
        .to_string(),
      pinned: false,
      messages: serde_json::Value::Null,
      created_at: None,
    };
    let created_at = crate::ai_session_file::header_ts_ms(&records)
      .map(crate::ai_session_file::ms_to_rfc3339)
      .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());
    let updated_at = std::fs::metadata(&file)
      .map(|m| crate::ai_session_file::mtime_rfc3339(&m))
      .unwrap_or_else(|_| chrono::Utc::now().to_rfc3339());
    db::rebuild_ai_session(
      &conn,
      &save,
      &path_str,
      visible.len() as i64,
      &created_at,
      &updated_at,
    )?;
    if existed {
      updated += 1;
    } else {
      restored += 1;
    }
  }

  Ok(AiSessionRebuildSummary {
    restored,
    updated,
    failed,
  })
}

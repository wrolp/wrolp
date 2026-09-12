use super::*;
// ==================== Session Recording ====================

/// Flush all in-memory recording buffers to their NDJSON event files. Called
/// periodically by a background task and on app shutdown.
///
/// File appends happen *while holding the `recordings` lock*: multiple O_APPEND
/// writers on Windows must never interleave, and this serializes the 5s flush
/// task against the disconnect-time `finalize_recording`. SQLite index updates
/// (incremental `event_count`) run afterwards under the db lock.
pub fn flush_all_recordings(state: &AppState) {
  // (session_id, event_count_delta, absolute events file)
  let mut to_bump: Vec<(String, i64, String)> = Vec::new();
  {
    if let Ok(mut recordings) = state.recordings.lock() {
      for rec in recordings.values_mut() {
        if rec.events.is_empty() {
          continue;
        }
        let drained = std::mem::take(&mut rec.events);
        let Some(path) = rec.events_file.clone() else {
          eprintln!(
            "[recording] {} has no events_file; dropping {} events",
            rec.session_id,
            drained.len()
          );
          continue;
        };
        if let Err(e) = crate::rec_file::append_events(&path, &drained) {
          // A failed batch is dropped (not retried against a newer snapshot)
          // and the session index is left untouched — no phantom counts.
          eprintln!("[recording] flush failed for {}: {}", path.display(), e);
          continue;
        }
        to_bump.push((
          rec.session_id.clone(),
          drained.len() as i64,
          path.to_string_lossy().into_owned(),
        ));
      }
    }
  }
  if to_bump.is_empty() {
    return;
  }
  if let Ok(conn) = state.db.lock() {
    for (session_id, delta, file) in to_bump {
      let _ = db::update_event_count_delta(&conn, &session_id, delta, &file);
    }
  }
}

/// Finalize a single in-memory recording: append any remaining events to its
/// file, then either finalize the session row or (if nothing was ever recorded)
/// drop the row. Sessions that were never persisted (`db_saved` is false, i.e.
/// recording was off the whole time) are skipped entirely so they never appear
/// in the list.
pub fn finalize_recording(conn: &rusqlite::Connection, rec: &ActiveRecording) {
  if !rec.db_saved {
    return;
  }
  let path = rec.events_file.clone();
  if let Some(p) = &path {
    if !rec.events.is_empty() {
      match crate::rec_file::append_events(p, &rec.events) {
        Ok(()) => {
          let _ = db::update_event_count_delta(
            conn,
            &rec.session_id,
            rec.events.len() as i64,
            &p.to_string_lossy(),
          );
        }
        Err(e) => eprintln!(
          "[recording] finalize flush failed for {}: {}",
          p.display(),
          e
        ),
      }
    }
  } else {
    // No events-file snapshot (defensive, legacy path) — keep the old
    // SQLite insert so events aren't silently dropped.
    let _ = db::insert_events(conn, &rec.session_id, &rec.events);
  }
  let event_count = db::session_event_count(conn, &rec.session_id).unwrap_or(0);
  if event_count == 0 {
    // Started but produced no events — discard the empty session row and any
    // events file that might exist despite the zero count.
    let _ = db::delete_session(conn, &rec.session_id);
    if let Some(p) = &path {
      crate::rec_file::remove_events_file(p);
      crate::rec_file::prune_empty_dirs(p);
    }
    return;
  }
  let ended_at = chrono::Utc::now().to_rfc3339();
  let duration = rec.started_at.elapsed().as_secs() as i64;
  let _ = db::finalize_session(conn, &rec.session_id, &ended_at, duration, event_count);
}

/// Load events for a session: file-first for the new layout (the
/// `sessions.events_file` column is set once the first batch flushed), falling
/// back to the legacy `session_events` table when the column is NULL or the
/// events file is missing. Shared by `get_session_events` (playback UI) and
/// `extract_commands` (command replay).
fn load_session_events(state: &AppState, session_id: &str) -> Result<Vec<SessionEventDto>, String> {
  let file = {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::session_events_file(&conn, session_id)?
  };
  if let Some(f) = file {
    let path = std::path::Path::new(&f);
    if path.exists() {
      return crate::rec_file::read_events(path);
    }
    eprintln!("[recording] events file missing for {}: {}", session_id, f);
  }
  let conn = state.db.lock().map_err(|e| e.to_string())?;
  db::get_session_events(&conn, session_id)
}

#[tauri::command]
pub async fn list_sessions(
  state: tauri::State<'_, AppState>,
  connection_id: Option<String>,
  limit: Option<u32>,
) -> Result<Vec<SessionSummary>, String> {
  let mut rows = {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::list_sessions(&conn, connection_id.as_deref(), limit.unwrap_or(100))?
  };
  // Enrich each row with the breadcrumb resolved from the events file's actual
  // location (`<data-root>/recordings/<workspace>/<group>/…`). A stale index
  // (file gone, e.g. manually deleted) keeps the row but drops the file handle
  // so the UI does not offer "reveal in folder" for a missing file.
  let root = crate::rec_file::recordings_root(state.base_dir.as_deref());
  for s in rows.iter_mut() {
    let file = match &s.events_file {
      Some(f) => std::path::PathBuf::from(f),
      None => continue,
    };
    if !file.is_file() {
      s.events_file = None;
      continue;
    }
    if let Some((ws, grp)) = crate::rec_file::folder_segments(&file, &root) {
      s.workspace_name = Some(ws);
      s.group_name = Some(grp);
    }
  }
  Ok(rows)
}

/// Ask the OS to show/select the session's events file in the file manager
/// (Windows: Explorer; macOS: Finder; other: open the parent folder).
#[tauri::command]
pub async fn reveal_session_file(
  state: tauri::State<'_, AppState>,
  session_id: String,
) -> Result<(), String> {
  let file = {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::session_events_file(&conn, &session_id)?
  };
  let Some(f) = file else {
    return Err(
      "This session predates file storage (legacy DB rows); it has no events file to reveal."
        .to_string(),
    );
  };
  let path = std::path::PathBuf::from(f);
  if !path.is_file() {
    return Err(format!("Recording file not found: {}", path.display()));
  }
  reveal_in_file_manager(&path);
  Ok(())
}

/// Non-blocking, best-effort "show this file in the OS file manager".
///
/// On Windows we drive the Shell Automation object (`Shell.Application`) via
/// PowerShell instead of `explorer /select,"<path>"`. Two reasons:
///  1. `explorer /select,"<path>"` is unreliable for deep/long paths (the
///     recordings live under AppData). When explorer.exe is already the
///     running shell the path is forwarded over DDE and the parse can fail,
///     making Explorer fall back to opening the user's Documents library.
///  2. `Shell.Application.Open(<file>)` would *launch* the file (opening the
///     "choose an app" dialog for a .jsonl), not reveal it.
/// So we open the file's *parent folder* through the COM object (handles long
/// paths, no DDE fallback) and then best-effort select the file in that window.
fn reveal_in_file_manager(path: &std::path::Path) {
  #[cfg(target_os = "windows")]
  {
    let p = path.to_string_lossy().into_owned();
    // Escape single quotes for a PowerShell single-quoted string literal
    // (inside a single-quoted PS string only `'` is special; double it).
    let escaped = p.replace('\'', "''");
    // Built by concatenation (not format!) so PowerShell's own `{`/`}` are
    // left untouched.
    let ps = [
      "$f='".to_string(),
      escaped,
      "'; $sh=New-Object -ComObject Shell.Application; \
        $sh.Open((Split-Path $f)) | Out-Null; \
        $fi=$sh.NameSpace((Split-Path $f)).ParseName((Split-Path $f -Leaf)); \
        if($fi){ try { $fi.InvokeVerb('select') } catch {} }".to_string(),
    ]
    .concat();
    let _ = std::process::Command::new("powershell")
      .args(["-NoProfile", "-NonInteractive", "-Command", &ps])
      .spawn();
  }
  #[cfg(target_os = "macos")]
  {
    let _ = std::process::Command::new("open")
      .arg("-R")
      .arg(path)
      .spawn();
  }
  #[cfg(not(any(target_os = "windows", target_os = "macos")))]
  {
    if let Some(parent) = path.parent() {
      let _ = std::process::Command::new("xdg-open").arg(parent).spawn();
    }
  }
}

#[tauri::command]
pub async fn get_session_events(
  state: tauri::State<'_, AppState>,
  session_id: String,
) -> Result<Vec<SessionEventDto>, String> {
  load_session_events(state.inner(), &session_id)
}

#[tauri::command]
pub async fn delete_session(
  state: tauri::State<'_, AppState>,
  session_id: String,
) -> Result<(), String> {
  // Remove the DB index row first (it returns the recorded events-file path),
  // then delete the file and prune now-empty workspace/group/connection dirs.
  let file = {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::delete_session(&conn, &session_id)?
  };
  if let Some(f) = file {
    let path = std::path::PathBuf::from(f);
    crate::rec_file::remove_events_file(&path);
    crate::rec_file::prune_empty_dirs(&path);
  }
  Ok(())
}

#[tauri::command]
pub async fn delete_all_sessions(state: tauri::State<'_, AppState>) -> Result<(), String> {
  let files = {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::delete_all_sessions(&conn)?
  };
  for f in files {
    let path = std::path::PathBuf::from(f);
    crate::rec_file::remove_events_file(&path);
    crate::rec_file::prune_empty_dirs(&path);
  }
  Ok(())
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
      // The events-file snapshot was derived at connect from the connect-time
      // start; re-derive it so the file name reflects the actual recording
      // start once recording is switched on mid-session.
      rec.events_file = Some(crate::rec_file::events_file_for(
        state.base_dir.as_deref(),
        rec.workspace_name.as_deref(),
        rec.group_name.as_deref(),
        &rec.connection_name,
        &started_at_iso,
        &rec.session_id,
      ));
      if let Ok(conn) = state.db.lock() {
        let _ = db::create_session(
          &conn,
          &rec.session_id,
          &rec.connection_id,
          &rec.connection_name,
          tab_id,
          &started_at_iso,
          rec.workspace_name.as_deref(),
          rec.group_name.as_deref(),
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
  let events = load_session_events(state.inner(), &session_id)?;

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
  eprintln!(
    "[command_snippets] list result: {:?}",
    result.as_ref().map(|v| v.len())
  );
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

// ==================== Recording Maintenance ====================

/// Summary of the one-click legacy → file export migration (FUT1).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyExportSummary {
  pub migrated: u32,
  pub events: u64,
  pub failed: Vec<String>,
}

/// One-click migration: write every session whose events still live in
/// `session_events` into the file layout (`recordings/<ws>/<group>/<conn>/…`),
/// point the index at the new file and drop the migrated DB rows (the file
/// becomes the single source of truth). Old sessions predate the workspace
/// snapshot columns, so their folder falls back to `default` unless the row
/// carries a `workspace_id`/`group_name` snapshot from a later era.
#[tauri::command]
pub async fn export_legacy_sessions(
  state: tauri::State<'_, AppState>,
) -> Result<LegacyExportSummary, String> {
  let mut summary = LegacyExportSummary {
    migrated: 0,
    events: 0,
    failed: Vec::new(),
  };
  // Workspace id → current name, for best-effort folder placement.
  let ws_names: std::collections::HashMap<String, String> = state
    .workspaces
    .lock()
    .map(|ws| ws.iter().map(|w| (w.id.clone(), w.name.clone())).collect())
    .unwrap_or_default();
  let candidates = {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::list_legacy_sessions(&conn)?
  };
  for sess in candidates {
    // Read the legacy events without holding the db lock during file I/O.
    let (events, started_at, group_name) = {
      let conn = state.db.lock().map_err(|e| e.to_string())?;
      let ev = db::get_session_events(&conn, &sess.id)?;
      (ev, sess.started_at.clone(), sess.group_name.clone())
    };
    if events.is_empty() {
      continue; // stale event_count; nothing to migrate
    }
    let ws = sess
      .workspace_id
      .as_deref()
      .and_then(|id| ws_names.get(id))
      .map(String::as_str)
      .unwrap_or(crate::rec_file::DEFAULT_WORKSPACE);
    let path = crate::rec_file::events_file_for(
      state.base_dir.as_deref(),
      Some(ws),
      group_name.as_deref(),
      sess.connection_name.as_deref().unwrap_or(""),
      &started_at,
      &sess.id,
    );
    if let Err(e) = crate::rec_file::append_dto_lines(&path, &events) {
      summary
        .failed
        .push(format!("{}: write failed ({})", sess.id, e));
      continue;
    }
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    match db::migrate_session_to_file(
      &conn,
      &sess.id,
      &path.to_string_lossy(),
      events.len() as i64,
    ) {
      Ok(()) => {
        summary.migrated += 1;
        summary.events += events.len() as u64;
      }
      Err(e) => {
        // DB update failed after the file was written — the file stays behind
        // as an orphan that the recordings rescan can re-attach later.
        summary
          .failed
          .push(format!("{}: db update failed ({})", sess.id, e));
      }
    }
  }
  // The migration deletes the legacy `session_events` rows: hand their pages
  // back instead of leaving the database at its old size.
  if summary.migrated > 0 {
    if let Ok(conn) = state.db.lock() {
      db::reclaim_freed_pages(&conn);
    }
  }
  Ok(summary)
}

/// Summary of the recordings rescan / index rebuild (FUT2).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RescanSummary {
  pub restored: u32,
  pub removed_empty: u32,
  pub skipped: u32,
  pub failed: Vec<String>,
}

/// Self-heal: scan `recordings/` for `.jsonl` files not referenced by
/// `sessions.events_file` and rebuild their session rows. Folder segments give
/// the workspace/group/connection names back; the connection is matched
/// best-effort against the current config (sanitized-name compare), and rows
/// whose connection was deleted get a stable placeholder id so they still show
/// up in "All connections". Empty orphan files (0 parseable events) are removed.
#[tauri::command]
pub async fn rescan_recording_files(
  state: tauri::State<'_, AppState>,
) -> Result<RescanSummary, String> {
  let mut summary = RescanSummary {
    restored: 0,
    removed_empty: 0,
    skipped: 0,
    failed: Vec::new(),
  };
  let root = crate::rec_file::recordings_root(state.base_dir.as_deref());

  // Paths already referenced by the index (case-folded on Windows where the
  // filesystem is case-insensitive).
  let indexed: std::collections::HashSet<String> = {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::all_events_files(&conn)?
      .into_iter()
      .map(|f| path_key(&std::path::PathBuf::from(f)))
      .collect()
  };

  // Snapshot current workspaces + connections for name/id matching.
  let ws_rows: Vec<(String, String)> = state
    .workspaces
    .lock()
    .map(|ws| {
      ws.iter()
        .map(|w| (w.id.clone(), crate::rec_file::sanitize_segment(&w.name)))
        .collect()
    })
    .unwrap_or_default();
  let conn_rows: Vec<(String, String, Option<String>)> = state
    .connections
    .lock()
    .map(|conns| {
      conns
        .iter()
        .map(|c| {
          (
            c.id.clone(),
            crate::rec_file::sanitize_segment(&c.name),
            c.workspace_id.clone(),
          )
        })
        .collect()
    })
    .unwrap_or_default();

  for entry in walkdir::WalkDir::new(&root)
    .into_iter()
    .filter_map(Result::ok)
    .filter(|e| e.file_type().is_file())
  {
    let path = entry.path();
    if !path.to_string_lossy().ends_with(".jsonl") {
      continue;
    }
    if indexed.contains(&path_key(path)) {
      continue;
    }
    // Expect the full `recordings/<ws>/<group>/<conn>/<file>` layout.
    let Some(rel_comps) = rel_components(path, &root) else {
      summary.skipped += 1;
      continue;
    };
    if rel_comps.len() < 4 {
      summary.skipped += 1;
      continue;
    }
    let file_name = rel_comps[3].clone();
    let Some(stamp) = crate::rec_file::parse_events_file_stamp(&file_name) else {
      summary.skipped += 1;
      continue;
    };
    let count = match crate::rec_file::count_events_in_file(path) {
      Ok(n) => n,
      Err(e) => {
        summary.failed.push(format!("{}: {} ", path.display(), e));
        continue;
      }
    };
    if count == 0 {
      // Interrupted delete leftover — remove the file, prune empty parents.
      crate::rec_file::remove_events_file(path);
      crate::rec_file::prune_empty_dirs(path);
      summary.removed_empty += 1;
      continue;
    }

    let ws_seg = rel_comps[0].clone();
    let grp_seg = rel_comps[1].clone();
    let conn_seg = rel_comps[2].clone();
    // Workspace folder matches a workspace whose current sanitized name equals
    // the segment (a renamed workspace can't be recovered — keep id `None`).
    let ws_id = ws_rows
      .iter()
      .find(|(_, seg)| *seg == ws_seg)
      .map(|(id, _)| id.clone());
    // Match the connection folder among current connections (optionally
    // constrained to the workspace the file lives under).
    let mut matched = conn_rows.iter().filter(|(_, seg, _)| *seg == conn_seg);
    let (conn_id, conn_name): (String, String) = if let Some((id, _, _)) =
      matched.clone().find(|(_, _, cws)| match (&ws_id, cws) {
        (Some(wid), Some(cw)) => wid == cw,
        (None, _) => true,
        (Some(_), None) => true, // connection predates workspaces — accept by name
      }) {
      (id.clone(), conn_seg.clone())
    } else if let Some((id, _, _)) = matched.next() {
      (id.clone(), conn_seg.clone())
    } else {
      // Deleted connection — keep the folder name for display and use a stable
      // placeholder that never collides with a real connection id.
      (format!("__orphan__"), conn_seg.clone())
    };

    // The file timestamp is local wall time; store it as UTC for consistency
    // with live sessions (assumes the machine timezone is unchanged).
    let started_local = stamp
      .and_local_timezone(chrono::Local)
      .earliest()
      .unwrap_or_else(|| stamp.and_utc().with_timezone(&chrono::Local));
    let started_at = started_local.with_timezone(&chrono::Utc).to_rfc3339();

    let id = uuid::Uuid::new_v4().to_string();
    let scanned = db::ScannedSession {
      id: &id,
      connection_id: &conn_id,
      connection_name: Some(&conn_name),
      workspace_id: ws_id.as_deref(),
      group_name: Some(&grp_seg),
      started_at: &started_at,
      event_count: count as i64,
      events_file: &path.to_string_lossy(),
    };
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    match db::insert_scanned_session(&conn, &scanned) {
      Ok(()) => summary.restored += 1,
      Err(e) => summary.failed.push(format!("{}: {}", path.display(), e)),
    }
  }
  Ok(summary)
}

/// Windows-style filesystems are case-insensitive — normalize a recorded path
/// so index lookups survive case differences between scan and storage.
fn path_key(path: &std::path::Path) -> String {
  let s = path.to_string_lossy();
  if cfg!(windows) {
    s.to_lowercase()
  } else {
    s.to_string()
  }
}

/// Normal segments of `path` below `root` (`None` when not under it).
fn rel_components(path: &std::path::Path, root: &std::path::Path) -> Option<Vec<String>> {
  let rel = path.strip_prefix(root).ok()?;
  Some(
    rel
      .components()
      .filter_map(|c| match c {
        std::path::Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
        _ => None,
      })
      .collect(),
  )
}

/// Summary of an asciinema v2 export.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CastExportSummary {
  pub path: String,
  pub lines: usize,
}

/// Export a session as an asciinema v2 `.cast` file (FUT3). Every recorded
/// `input`/`output` frame becomes `[<secs>, "i"|"o", "<payload>"]` timed from
/// the session start; the header carries the wall-clock start epoch. "command"
/// convenience events are skipped so the cast plays like a real terminal.
#[tauri::command]
pub async fn export_session_cast(
  state: tauri::State<'_, AppState>,
  session_id: String,
  target_path: String,
) -> Result<CastExportSummary, String> {
  let events = load_session_events(state.inner(), &session_id)?;
  if events.is_empty() {
    return Err("This session has no recorded events to export.".to_string());
  }
  let started_at = {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::session_started_at(&conn, &session_id)?
  };
  let start_epoch = chrono::DateTime::parse_from_rfc3339(&started_at)
    .map(|d| d.timestamp())
    .unwrap_or_else(|_| chrono::Utc::now().timestamp());

  let mut out = String::new();
  out.push_str(&format!(
    "{{\"version\": 2, \"width\": 80, \"height\": 24, \"timestamp\": {}, \"env\": {{}}}}\n",
    start_epoch
  ));
  let mut lines = 0usize;
  for ev in &events {
    if ev.direction == "command" {
      continue;
    }
    let chan = if ev.direction == "output" { "o" } else { "i" };
    let t = start_epoch as f64 + (ev.timestamp_ms.max(0) as f64) / 1000.0;
    let payload = serde_json::to_string(&ev.content).map_err(|e| e.to_string())?;
    out.push_str(&format!("[{:.3}, \"{}\", {}]\n", t, chan, payload));
    lines += 1;
  }
  std::fs::write(&target_path, out).map_err(|e| e.to_string())?;
  Ok(CastExportSummary {
    path: target_path,
    lines,
  })
}

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

use super::*;
// ==================== Recently used connections (the welcome page's card) ====================
//
// Which saved hosts were opened, and when, so the welcome page can offer "where I
// was" instead of "whatever the sidebar order happens to be". Rows carry neither a
// name nor a workspace: the caller resolves both against the live connection list,
// so a renamed connection shows its new name for free and a deleted or moved one
// drops out of the list on its own.

/// Remember that a connection was just opened, for the welcome page's recency
/// card. Returns whether a row was written.
///
/// A connection that is no longer saved is not recorded and reported as `false`:
/// there is nothing left to reconnect to, and the row would only be dead weight —
/// a tab can outlive the connection it was opened from.
#[tauri::command]
pub async fn record_connection_used(
  state: tauri::State<'_, AppState>,
  connection_id: String,
) -> Result<bool, String> {
  let known = {
    let connections = state.connections.lock().map_err(|e| e.to_string())?;
    connections.iter().any(|c| c.id == connection_id)
  };
  if !known {
    return Ok(false);
  }
  let db = state.db.clone();
  // The write takes the shared database mutex, so it goes off the async runtime —
  // otherwise it would stall every other command, `poll_output` included.
  tokio::task::spawn_blocking(move || {
    let conn = db.lock().map_err(|e| e.to_string())?;
    db::record_connection_used(&conn, &connection_id, now_ms() as i64)
  })
  .await
  .map_err(|e| e.to_string())?;
  Ok(true)
}

/// Remember that a LOCAL terminal was just opened, for the welcome page's recency
/// card. Returns whether a row was written.
///
/// Local shells are not saved connections, but they are still somewhere the user
/// goes, so the card offers them next to the hosts. They live in the same table
/// under [`db::local_recent_id`]; `entry_id` is the saved `LocalTerminalEntry` id,
/// or [`db::DEFAULT_LOCAL_ENTRY_ID`] for the built-in shortcut — which is always
/// openable and therefore always recordable. An entry that is no longer saved is
/// refused, exactly like a deleted connection: nothing could reopen it.
#[tauri::command]
pub async fn record_local_terminal_used(
  state: tauri::State<'_, AppState>,
  entry_id: String,
) -> Result<bool, String> {
  let known = {
    let terminals = state.local_terminals.lock().map_err(|e| e.to_string())?;
    entry_id == db::DEFAULT_LOCAL_ENTRY_ID || terminals.iter().any(|t| t.id == entry_id)
  };
  if !known {
    return Ok(false);
  }
  let id = db::local_recent_id(&entry_id);
  let db_conn = state.db.clone();
  // Off the async runtime for the same reason as the connection write above.
  tokio::task::spawn_blocking(move || {
    let conn = db_conn.lock().map_err(|e| e.to_string())?;
    db::record_connection_used(&conn, &id, now_ms() as i64)
  })
  .await
  .map_err(|e| e.to_string())??;
  Ok(true)
}

/// The active workspace's recently used connections, newest first.
///
/// The workspace comes from `state.active_workspace_id` — the same source
/// `list_connections` filters by — and each row is then checked against the live
/// connection list rather than a workspace stored on the row. That is what makes a
/// deleted or moved connection disappear without any cleanup step.
///
/// `limit` caps the returned rows; it defaults to the whole (already trimmed) table.
#[tauri::command]
pub async fn list_recent_connections(
  state: tauri::State<'_, AppState>,
  limit: Option<i64>,
) -> Result<Vec<db::RecentConnectionDto>, String> {
  // Snapshot which connections the active workspace has, then release the locks:
  // the workspace list and the database are independent and nothing here needs
  // both at once, so the two mutexes are never held together. Saved local
  // terminals are global (one list, no workspace), so they are snapshotted in a
  // second, separate borrow.
  let live: std::collections::HashSet<String> = {
    let active_id = state
      .active_workspace_id
      .lock()
      .map_err(|e| e.to_string())?;
    let connections = state.connections.lock().map_err(|e| e.to_string())?;
    connections
      .iter()
      .filter(|c| c.workspace_id.as_deref() == Some(active_id.as_str()))
      .map(|c| c.id.clone())
      .collect()
  };
  let live_local: std::collections::HashSet<String> = {
    let terminals = state.local_terminals.lock().map_err(|e| e.to_string())?;
    terminals.iter().map(|t| t.id.clone()).collect()
  };
  // A pure read, so the lock is held inline (as `list_command_history` does).
  let conn = state.db.lock().map_err(|e| e.to_string())?;
  Ok(
    db::list_recent(&conn)?
      .into_iter()
      // A local row resolves against the saved local terminals; every other row
      // against this workspace's connections. Anything that resolves to nothing —
      // deleted, moved, or a local entry since removed — drops out here.
      .filter(|r| match db::local_recent_entry_id(&r.connection_id) {
        Some(entry_id) => {
          entry_id == db::DEFAULT_LOCAL_ENTRY_ID || live_local.contains(entry_id)
        }
        None => live.contains(&r.connection_id),
      })
      .take(limit.unwrap_or(db::RECENT_CONNECTIONS_KEEP).max(0) as usize)
      .collect(),
  )
}

/// Drop a deleted connection's recency row. Best effort, and never fails the
/// caller's delete: `list_recent_connections` filters orphans out anyway, so a
/// missed row costs a few bytes until the next write trims it.
pub(crate) async fn forget_recent(state: &AppState, connection_id: &str) {
  let db = state.db.clone();
  let id = connection_id.to_string();
  let result = tokio::task::spawn_blocking(move || {
    let conn = db.lock().map_err(|e| e.to_string())?;
    db::forget_connection(&conn, &id)
  })
  .await;
  match result {
    Ok(Ok(removed)) => {
      if removed > 0 {
        eprintln!("[connection_recents] forgot {} row(s) for {}", removed, connection_id);
      }
    }
    Ok(Err(e)) => eprintln!("[connection_recents] forget failed: {}", e),
    Err(e) => eprintln!("[connection_recents] forget task panicked: {}", e),
  }
}

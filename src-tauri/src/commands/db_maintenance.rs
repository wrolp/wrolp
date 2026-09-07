use super::*;
// ==================== Database Maintenance (Settings page) ====================
// `wrolp.db` keeps freed pages for reuse, so deleting sessions used to leave the
// file at its old size. The Settings page shows the current footprint and offers
// a manual "shrink now" (`VACUUM`); bulk deletions reclaim on their own via
// `db::reclaim_freed_pages` once the freed space is worth a rewrite.

/// Resolve `wrolp.db`, honoring the state's base-dir override.
fn db_path_for(state: &tauri::State<'_, AppState>) -> Result<PathBuf, String> {
  data_dir_for(state.base_dir.as_deref())
    .map(|p| p.join("wrolp.db"))
    .ok_or_else(|| "Cannot determine data directory".to_string())
}

/// Result of a manual `VACUUM`, reported on the Settings page.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VacuumResult {
  pub before_bytes: u64,
  pub after_bytes: u64,
  pub freed_bytes: u64,
}

/// Size / free-space figures for `wrolp.db` (Settings → Database).
#[tauri::command]
pub async fn get_db_stats(state: tauri::State<'_, AppState>) -> Result<db::DbStats, String> {
  let path = db_path_for(&state)?;
  let conn = state.db.lock().map_err(|e| e.to_string())?;
  db::db_stats(&conn, &path)
}

/// Rewrite `wrolp.db` to release every free page (`VACUUM`) and report the size
/// before/after. Runs on a blocking thread because it rewrites the whole file
/// and holds the database lock while doing so.
#[tauri::command]
pub async fn vacuum_database(state: tauri::State<'_, AppState>) -> Result<VacuumResult, String> {
  let path = db_path_for(&state)?;
  let conn = state.db.clone();
  let result = tokio::task::spawn_blocking(move || {
    let conn = conn.lock().map_err(|e| e.to_string())?;
    let (before, after) = db::vacuum(&conn, &path)?;
    Ok(VacuumResult {
      before_bytes: before,
      after_bytes: after,
      freed_bytes: before.saturating_sub(after),
    })
  })
  .await
  .map_err(|e| format!("Vacuum task failed: {}", e))?;
  result
}

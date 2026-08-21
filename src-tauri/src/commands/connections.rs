use super::*;
#[tauri::command]
pub async fn list_connections(state: tauri::State<'_, AppState>) -> Result<String, String> {
  let connections = state.connections.lock().map_err(|e| e.to_string())?;
  let active_id = state.active_workspace_id.lock().map_err(|e| e.to_string())?;
  let filtered: Vec<&ConnectionConfig> = connections
    .iter()
    .filter(|c| c.workspace_id.as_deref() == Some(&active_id))
    .collect();
  Ok(serde_json::to_string(&filtered).map_err(|e| e.to_string())?)
}

#[tauri::command]
pub async fn save_connection(
  state: tauri::State<'_, AppState>,
  mut config: ConnectionConfig,
) -> Result<String, String> {
  {
    let mut connections = state.connections.lock().map_err(|e| e.to_string())?;
    let active_id = state.active_workspace_id.lock().map_err(|e| e.to_string())?;
    // Auto-assign to the active workspace on save (both create and update).
    config.workspace_id = Some(active_id.clone());
    let found = connections.iter_mut().find(|c| c.id == config.id);
    if let Some(existing) = found {
      *existing = config.clone();
    } else {
      connections.push(config.clone());
    }
  }

  persist_connections(&state).await?;
  Ok(serde_json::to_string(&config).map_err(|e| e.to_string())?)
}

#[tauri::command]
pub async fn delete_connection(
  state: tauri::State<'_, AppState>,
  id: String,
) -> Result<bool, String> {
  let deleted = {
    let mut connections = state.connections.lock().map_err(|e| e.to_string())?;
    let len_before = connections.len();
    connections.retain(|c| c.id != id);
    connections.len() < len_before
  };

  if deleted {
    persist_connections(&state).await?;
  }

  Ok(deleted)
}

/// Reorder connections by the given ordered list of IDs.
/// Optionally update the `group` field for specific connections
/// (used when dragging a connection into a different group).
#[tauri::command]
pub async fn reorder_connections(
  state: tauri::State<'_, AppState>,
  ordered_ids: Vec<String>,
  group_updates: Option<std::collections::HashMap<String, String>>,
) -> Result<bool, String> {
  {
    let mut connections = state.connections.lock().map_err(|e| e.to_string())?;

    // Apply group overrides (empty string = ungrouped / None)
    if let Some(ref updates) = group_updates {
      for conn in connections.iter_mut() {
        if let Some(new_group) = updates.get(&conn.id) {
          conn.group = if new_group.is_empty() {
            None
          } else {
            Some(new_group.clone())
          };
        }
      }
    }

    // Sort by the new order; connections not in ordered_ids stay at the end
    let order_map: std::collections::HashMap<&String, usize> = ordered_ids
      .iter()
      .enumerate()
      .map(|(i, id)| (id, i))
      .collect();
    connections.sort_by_key(|c| order_map.get(&c.id).copied().unwrap_or(usize::MAX));
  }

  // Persist
  persist_connections(&state).await?;

  Ok(true)
}

// ==================== Workspace management ====================

#[tauri::command]
pub async fn list_workspaces(
  state: tauri::State<'_, AppState>,
) -> Result<String, String> {
  let workspaces = state.workspaces.lock().map_err(|e| e.to_string())?;
  let active_id = state.active_workspace_id.lock().map_err(|e| e.to_string())?;
  serde_json::to_string(&serde_json::json!({
    "workspaces": &*workspaces,
    "activeWorkspaceId": &*active_id,
  }))
  .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_workspace(
  state: tauri::State<'_, AppState>,
  name: String,
) -> Result<String, String> {
  let id = uuid::Uuid::new_v4().to_string();
  let ws = crate::ssh_session::WorkspaceInfo {
    id: id.clone(),
    name: name.clone(),
    created_at: chrono::Utc::now().to_rfc3339(),
  };
  {
    let mut workspaces = state.workspaces.lock().map_err(|e| e.to_string())?;
    workspaces.push(ws);
  }
  persist_connections(&state).await?;
  Ok(id)
}

#[tauri::command]
pub async fn delete_workspace(
  state: tauri::State<'_, AppState>,
  workspace_id: String,
) -> Result<bool, String> {
  if workspace_id == "default" {
    return Err("Cannot delete the default workspace".to_string());
  }
  {
    // Remove the workspace and its connections.
    let mut workspaces = state.workspaces.lock().map_err(|e| e.to_string())?;
    workspaces.retain(|w| w.id != workspace_id);
    let mut connections = state.connections.lock().map_err(|e| e.to_string())?;
    connections.retain(|c| c.workspace_id.as_deref() != Some(&workspace_id));
    // If we deleted the active workspace, switch to default.
    let mut active_id = state.active_workspace_id.lock().map_err(|e| e.to_string())?;
    if *active_id == workspace_id {
      *active_id = "default".to_string();
    }
  }
  persist_connections(&state).await?;
  Ok(true)
}

#[tauri::command]
pub async fn rename_workspace(
  state: tauri::State<'_, AppState>,
  workspace_id: String,
  name: String,
) -> Result<bool, String> {
  {
    let mut workspaces = state.workspaces.lock().map_err(|e| e.to_string())?;
    if let Some(w) = workspaces.iter_mut().find(|w| w.id == workspace_id) {
      w.name = name;
    }
  }
  persist_connections(&state).await?;
  Ok(true)
}

#[tauri::command]
pub async fn switch_workspace(
  state: tauri::State<'_, AppState>,
  workspace_id: String,
) -> Result<bool, String> {
  {
    let mut active_id = state.active_workspace_id.lock().map_err(|e| e.to_string())?;
    *active_id = workspace_id;
  }
  persist_connections(&state).await?;
  Ok(true)
}

/// Get the list of saved local terminal entries.
#[tauri::command]
pub async fn get_local_terminals(
  state: tauri::State<'_, AppState>,
) -> Result<Vec<LocalTerminalEntry>, String> {
  let entries = state.local_terminals.lock().map_err(|e| e.to_string())?;
  Ok(entries.clone())
}

/// Replace the saved local terminal entries with the given list.
#[tauri::command]
pub async fn save_local_terminals(
  state: tauri::State<'_, AppState>,
  entries: Vec<LocalTerminalEntry>,
) -> Result<bool, String> {
  {
    let mut store = state.local_terminals.lock().map_err(|e| e.to_string())?;
    *store = entries.clone();
  }
  if let Some(ref path) = crate::ssh_session::get_local_terminals_path() {
    if let Some(parent) = path.parent() {
      let _ = std::fs::create_dir_all(parent);
    }
    let json = serde_json::to_string_pretty(&entries).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())?;
  }
  Ok(true)
}

/// Rename a group: updates the `group` field of every connection in that group.
#[tauri::command]
pub async fn rename_group(
  state: tauri::State<'_, AppState>,
  old_name: String,
  new_name: String,
) -> Result<bool, String> {
  let changed = {
    let mut connections = state.connections.lock().map_err(|e| e.to_string())?;
    let new = new_name.trim().to_string();
    let mut any = false;
    for conn in connections.iter_mut() {
      if conn.group.as_deref() == Some(old_name.as_str()) {
        conn.group = if new.is_empty() {
          None
        } else {
          Some(new.clone())
        };
        any = true;
      }
    }
    any
  };

  if changed {
    persist_connections(&state).await?;
  }
  Ok(changed)
}

/// Delete a group: ungroup all connections that belong to it (the connections
/// themselves are kept, just moved out of the group).
#[tauri::command]
pub async fn delete_group(
  state: tauri::State<'_, AppState>,
  group_name: String,
) -> Result<bool, String> {
  let changed = {
    let mut connections = state.connections.lock().map_err(|e| e.to_string())?;
    let mut any = false;
    for conn in connections.iter_mut() {
      if conn.group.as_deref() == Some(group_name.as_str()) {
        conn.group = None;
        any = true;
      }
    }
    any
  };

  if changed {
    persist_connections(&state).await?;
  }
  Ok(changed)
}


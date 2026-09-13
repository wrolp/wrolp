use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::{Arc, Mutex as StdMutex};

const SCHEMA: &str = include_str!("schema.sql");

// ==================== DTO Types ====================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
  pub id: String,
  pub connection_id: String,
  pub connection_name: Option<String>,
  pub started_at: String,
  pub ended_at: Option<String>,
  pub duration_seconds: Option<i64>,
  pub title: Option<String>,
  pub event_count: i64,
  /// Workspace/group folder segments (from the events-file path layout),
  /// filled in by `list_sessions`; `None` for legacy rows still stored in
  /// `session_events`.
  pub workspace_name: Option<String>,
  pub group_name: Option<String>,
  /// Absolute events-file path when the file exists (enables "reveal in
  /// folder" / breadcrumb); `None` for legacy or stale-index rows.
  pub events_file: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEventDto {
  pub seq: i64,
  pub timestamp_ms: i64,
  pub direction: String,
  pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandSetDto {
  pub id: String,
  pub name: String,
  pub connection_id: Option<String>,
  pub commands: Vec<String>,
  pub created_at: String,
  pub updated_at: String,
}

/// A per-command parameter definition. `name` maps to `${name}` in the
/// snippet's command text; the user fills the value before sending.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CommandParam {
  pub name: String,
  /// "text" | "select". `type` is a Rust keyword, so the field is renamed.
  #[serde(rename = "type")]
  pub param_type: String,
  #[serde(default)]
  pub default_value: String,
  #[serde(default)]
  pub options: Vec<String>,
  #[serde(default)]
  pub description: Option<String>,
  #[serde(default = "default_true")]
  pub default_enabled: bool,
  /// Non-empty group name: options/params sharing it are mutually exclusive.
  #[serde(default)]
  pub exclusive_group: Option<String>,
}

/// Value configuration for an option that carries a value.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CommandOptionValue {
  #[serde(rename = "type")]
  pub param_type: String,
  #[serde(default)]
  pub options: Vec<String>,
  #[serde(default)]
  pub default_value: String,
}

/// A toggleable literal fragment of a command (`-it`, `--rm`,
/// `--env=${env}`, `-p 8080:80`). When checked it stays in the command; when
/// unchecked the whole fragment is removed. A fragment embedding exactly one
/// `${name}` carries a value the user can fill in.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CommandOption {
  pub id: String,
  pub text: String,
  #[serde(default)]
  pub label: Option<String>,
  #[serde(default)]
  pub description: Option<String>,
  #[serde(default)]
  pub value: Option<CommandOptionValue>,
  #[serde(default = "default_true")]
  pub default_enabled: bool,
  /// Non-empty group name: options/params sharing it are mutually exclusive.
  #[serde(default)]
  pub exclusive_group: Option<String>,
}

fn default_true() -> bool {
  true
}

/// A single command snippet for the floating command list. Clicking it sends
/// the command text to the terminal WITHOUT executing it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandSnippetDto {
  pub id: String,
  pub command: String,
  pub alias: Option<String>,
  pub favorite: bool,
  pub hidden: bool,
  pub sort_order: i64,
  /// Connection scope; `None` = general (visible for every connection).
  #[serde(default)]
  pub connection_id: Option<String>,
  /// Per-command parameters. Empty falls back to the global-variable flow.
  #[serde(default)]
  pub params: Vec<CommandParam>,
  /// Toggleable literal fragments of the command.
  #[serde(default)]
  pub options: Vec<CommandOption>,
  pub created_at: String,
  pub updated_at: String,
}

/// A single global variable shared by all command-list snippets. Commands
/// reference it as `${name}`. A non-empty `default_value` is substituted
/// directly at send time; an empty one prompts the user to fill it in.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalVariable {
  pub name: String,
  pub default_value: String,
  pub description: Option<String>,
  pub created_at: String,
  pub updated_at: String,
}

// ==================== In-memory recording event ====================

#[derive(Debug, Clone)]
pub struct RecordedEvent {
  pub seq: u64,
  pub timestamp_ms: u64,
  pub direction: String,
  pub content: String,
}

// ==================== DB Initialization ====================

pub type DbConn = Arc<StdMutex<Connection>>;

pub fn init_db(data_dir: &std::path::Path) -> Result<DbConn, String> {
  std::fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;
  let db_path = data_dir.join("wrolp.db");
  let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
  // Enable WAL for better concurrent read performance
  conn
    .execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")
    .map_err(|e| e.to_string())?;
  conn
    .execute_batch(SCHEMA)
    .map_err(|e| format!("Schema init failed: {}", e))?;
  // Migration: older DBs lack the `category` column on ai_prompt_templates.
  if !has_column(&conn, "ai_prompt_templates", "category")? {
    conn
      .execute_batch("ALTER TABLE ai_prompt_templates ADD COLUMN category TEXT NOT NULL DEFAULT ''")
      .map_err(|e| format!("Migration failed (category column): {}", e))?;
  }
  // Migration (recording → files): older DBs lack the snapshot / events-file
  // columns on `sessions`. `events_file` stays NULL for legacy recordings,
  // which keeps reading from `session_events` (backward compatible).
  for (column, ddl) in [
    ("workspace_id", "TEXT"),
    ("group_name", "TEXT"),
    ("events_file", "TEXT"),
  ] {
    if !has_column(&conn, "sessions", column)? {
      let sql = format!("ALTER TABLE sessions ADD COLUMN {} {}", column, ddl);
      conn
        .execute_batch(&sql)
        .map_err(|e| format!("Migration failed (sessions.{}): {}", column, e))?;
    }
  }
  // Migration (command snippets): older DBs lack connection scoping and the
  // per-command parameter / option definitions (stored as JSON arrays). NULL
  // keeps legacy behaviour: general scope, no params/options -> the global
  // variable flow applies at send time.
  for (column, ddl) in [
    ("connection_id", "TEXT"),
    ("params", "TEXT"),
    ("options", "TEXT"),
  ] {
    if !has_column(&conn, "command_snippets", column)? {
      let sql = format!("ALTER TABLE command_snippets ADD COLUMN {} {}", column, ddl);
      conn
        .execute_batch(&sql)
        .map_err(|e| format!("Migration failed (command_snippets.{}): {}", column, e))?;
    }
  }
  Ok(Arc::new(StdMutex::new(conn)))
}

/// Whether `column` exists on `table` (via `PRAGMA table_info`). Table/column
/// names come from fixed internal constants, never from user input.
fn has_column(conn: &Connection, table: &str, column: &str) -> Result<bool, String> {
  let mut stmt = conn
    .prepare(&format!("PRAGMA table_info({})", table))
    .map_err(|e| e.to_string())?;
  let names = stmt
    .query_map([], |row| row.get::<_, String>(1))
    .map_err(|e| e.to_string())?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|e| e.to_string())?;
  Ok(names.iter().any(|name| name == column))
}

// ==================== Session Queries ====================

/// Insert a session index row. `workspace_id`/`group_name` are the connection's
/// snapshot at record time (folder layers 1-2); `events_file` starts NULL and
/// is back-filled on the first non-empty flush (see `update_event_count_delta`).
pub fn create_session(
  conn: &Connection,
  id: &str,
  connection_id: &str,
  connection_name: &str,
  tab_id: u32,
  started_at: &str,
  workspace_id: Option<&str>,
  group_name: Option<&str>,
) -> Result<(), String> {
  conn
    .execute(
      "INSERT INTO sessions (id, connection_id, connection_name, tab_id, started_at, workspace_id, group_name) \
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
      params![id, connection_id, connection_name, tab_id, started_at, workspace_id, group_name],
    )
    .map_err(|e| e.to_string())?;
  Ok(())
}

/// Increment `event_count` by `delta` after events were appended to the events
/// file, and back-fill `events_file` on its first write (`COALESCE` keeps an
/// already-stored path untouched). `events_file` is an absolute path.
pub fn update_event_count_delta(
  conn: &Connection,
  session_id: &str,
  delta: i64,
  events_file: &str,
) -> Result<(), String> {
  conn
    .execute(
      "UPDATE sessions SET event_count = event_count + ?1, events_file = COALESCE(events_file, ?2) \
       WHERE id = ?3",
      params![delta, events_file, session_id],
    )
    .map_err(|e| e.to_string())?;
  Ok(())
}

/// Read the session's current `event_count` (incrementally maintained column).
pub fn session_event_count(conn: &Connection, session_id: &str) -> Result<i64, String> {
  conn
    .query_row(
      "SELECT event_count FROM sessions WHERE id = ?1",
      params![session_id],
      |row| row.get(0),
    )
    .map_err(|e| e.to_string())
}

/// The session's events-file absolute path (column may be NULL for legacy
/// recordings still stored in `session_events`).
pub fn session_events_file(conn: &Connection, session_id: &str) -> Result<Option<String>, String> {
  let mut stmt = conn
    .prepare("SELECT events_file FROM sessions WHERE id = ?1")
    .map_err(|e| e.to_string())?;
  let file = stmt
    .query_map(params![session_id], |row| row.get::<_, Option<String>>(0))
    .map_err(|e| e.to_string())?
    .next()
    .transpose()
    .map_err(|e| e.to_string())?
    .flatten();
  Ok(file)
}

pub fn finalize_session(
  conn: &Connection,
  id: &str,
  ended_at: &str,
  duration_seconds: i64,
  event_count: i64,
) -> Result<(), String> {
  conn
    .execute(
      "UPDATE sessions SET ended_at = ?1, duration_seconds = ?2, event_count = ?3 WHERE id = ?4",
      params![ended_at, duration_seconds, event_count, id],
    )
    .map_err(|e| e.to_string())?;
  Ok(())
}

pub fn insert_events(
  conn: &Connection,
  session_id: &str,
  events: &[RecordedEvent],
) -> Result<(), String> {
  let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
  {
    let mut stmt = tx
      .prepare("INSERT INTO session_events (session_id, seq, timestamp_ms, direction, content) VALUES (?1, ?2, ?3, ?4, ?5)")
      .map_err(|e| e.to_string())?;
    for ev in events {
      stmt
        .execute(params![
          session_id,
          ev.seq as i64,
          ev.timestamp_ms as i64,
          ev.direction,
          ev.content
        ])
        .map_err(|e| e.to_string())?;
    }
  }
  tx.commit().map_err(|e| e.to_string())?;
  Ok(())
}

pub fn list_sessions(
  conn: &Connection,
  connection_id: Option<&str>,
  limit: u32,
) -> Result<Vec<SessionSummary>, String> {
  let mut sql = String::from("SELECT id, connection_id, connection_name, started_at, ended_at, duration_seconds, title, event_count, events_file FROM sessions");
  let mut filters: Vec<String> = Vec::new();
  if connection_id.is_some() {
    filters.push("connection_id = ?1".to_string());
  }
  // Never show sessions that recorded nothing (e.g. a connection where the
  // user never started recording).
  filters.push("event_count > 0".to_string());
  if !filters.is_empty() {
    sql.push_str(" WHERE ");
    sql.push_str(&filters.join(" AND "));
  }
  sql.push_str(" ORDER BY started_at DESC LIMIT ?");
  let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
  let rows = if let Some(cid) = connection_id {
    stmt
      .query_map(params![cid, limit as i64], map_session_row)
      .map_err(|e| e.to_string())?
      .collect::<Result<Vec<_>, _>>()
      .map_err(|e| e.to_string())?
  } else {
    stmt
      .query_map(params![limit as i64], map_session_row)
      .map_err(|e| e.to_string())?
      .collect::<Result<Vec<_>, _>>()
      .map_err(|e| e.to_string())?
  };
  Ok(rows)
}

fn map_session_row(row: &rusqlite::Row) -> rusqlite::Result<SessionSummary> {
  Ok(SessionSummary {
    id: row.get(0)?,
    connection_id: row.get(1)?,
    connection_name: row.get(2)?,
    started_at: row.get(3)?,
    ended_at: row.get(4)?,
    duration_seconds: row.get(5)?,
    title: row.get(6)?,
    event_count: row.get(7)?,
    // Breadcrumb segments are derived by the caller from the events-file path
    // (the DB only stores the raw snapshot columns); events_file comes straight
    // from the row so the caller can check existence and resolve folders.
    workspace_name: None,
    group_name: None,
    events_file: row.get(8)?,
  })
}

pub fn get_session_events(
  conn: &Connection,
  session_id: &str,
) -> Result<Vec<SessionEventDto>, String> {
  let mut stmt = conn
    .prepare(
      "SELECT seq, timestamp_ms, direction, content FROM session_events WHERE session_id = ?1 ORDER BY seq",
    )
    .map_err(|e| e.to_string())?;
  let rows = stmt
    .query_map(params![session_id], |row| {
      Ok(SessionEventDto {
        seq: row.get(0)?,
        timestamp_ms: row.get(1)?,
        direction: row.get(2)?,
        content: row.get(3)?,
      })
    })
    .map_err(|e| e.to_string())?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|e| e.to_string())?;
  Ok(rows)
}

/// Delete a session row (and any legacy `session_events` rows) and return the
/// events-file path that was recorded on it, so the caller can remove the file.
pub fn delete_session(conn: &Connection, session_id: &str) -> Result<Option<String>, String> {
  let events_file = session_events_file(conn, session_id)?;
  conn
    .execute(
      "DELETE FROM session_events WHERE session_id = ?1",
      params![session_id],
    )
    .map_err(|e| e.to_string())?;
  conn
    .execute("DELETE FROM sessions WHERE id = ?1", params![session_id])
    .map_err(|e| e.to_string())?;
  reclaim_freed_pages(conn);
  Ok(events_file)
}

/// Delete every session row (and legacy events) and return the events-file
/// paths of all deleted sessions, so the caller can remove those files.
pub fn delete_all_sessions(conn: &Connection) -> Result<Vec<String>, String> {
  let mut stmt = conn
    .prepare("SELECT events_file FROM sessions WHERE events_file IS NOT NULL")
    .map_err(|e| e.to_string())?;
  let files = stmt
    .query_map([], |row| row.get::<_, String>(0))
    .map_err(|e| e.to_string())?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|e| e.to_string())?;
  conn
    .execute("DELETE FROM session_events", [])
    .map_err(|e| e.to_string())?;
  conn
    .execute("DELETE FROM sessions", [])
    .map_err(|e| e.to_string())?;
  reclaim_freed_pages(conn);
  Ok(files)
}

pub fn rename_session(conn: &Connection, session_id: &str, title: &str) -> Result<(), String> {
  conn
    .execute(
      "UPDATE sessions SET title = ?1 WHERE id = ?2",
      params![title, session_id],
    )
    .map_err(|e| e.to_string())?;
  Ok(())
}

pub fn count_session_events(conn: &Connection, session_id: &str) -> Result<i64, String> {
  conn
    .query_row(
      "SELECT COUNT(*) FROM session_events WHERE session_id = ?1",
      params![session_id],
      |row| row.get(0),
    )
    .map_err(|e| e.to_string())
}

// ==================== Recording Maintenance (export / rescan) ====================

/// One session whose event stream is still in the legacy `session_events`
/// table (`events_file` IS NULL). A candidate for the one-click export
/// migration to the file layout.
#[derive(Debug, Clone)]
pub struct LegacySessionRow {
  pub id: String,
  pub connection_name: Option<String>,
  pub started_at: String,
  pub workspace_id: Option<String>,
  pub group_name: Option<String>,
  pub event_count: i64,
}

/// Sessions still backed by `session_events` (no events file yet), oldest first.
pub fn list_legacy_sessions(conn: &Connection) -> Result<Vec<LegacySessionRow>, String> {
  let mut stmt = conn
    .prepare(
      "SELECT id, connection_name, started_at, workspace_id, group_name, event_count \
       FROM sessions WHERE events_file IS NULL AND event_count > 0 ORDER BY started_at",
    )
    .map_err(|e| e.to_string())?;
  let rows = stmt
    .query_map([], |row| {
      Ok(LegacySessionRow {
        id: row.get(0)?,
        connection_name: row.get(1)?,
        started_at: row.get(2)?,
        workspace_id: row.get(3)?,
        group_name: row.get(4)?,
        event_count: row.get(5)?,
      })
    })
    .map_err(|e| e.to_string())?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|e| e.to_string())?;
  Ok(rows)
}

/// Atomically point a session at its new events file and drop the migrated
/// legacy rows (one-way: the file becomes the single source of truth).
pub fn migrate_session_to_file(
  conn: &Connection,
  session_id: &str,
  events_file: &str,
  event_count: i64,
) -> Result<(), String> {
  let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
  tx.execute(
    "UPDATE sessions SET events_file = ?1, event_count = ?2 WHERE id = ?3",
    params![events_file, event_count, session_id],
  )
  .map_err(|e| e.to_string())?;
  tx.execute(
    "DELETE FROM session_events WHERE session_id = ?1",
    params![session_id],
  )
  .map_err(|e| e.to_string())?;
  tx.commit().map_err(|e| e.to_string())
}

/// Absolute events-file paths currently referenced by the sessions index (the
/// recordings rescan uses this set to distinguish orphan files from indexed).
pub fn all_events_files(conn: &Connection) -> Result<Vec<String>, String> {
  let mut stmt = conn
    .prepare("SELECT events_file FROM sessions WHERE events_file IS NOT NULL")
    .map_err(|e| e.to_string())?;
  let files = stmt
    .query_map([], |row| row.get::<_, String>(0))
    .map_err(|e| e.to_string())?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|e| e.to_string())?;
  Ok(files)
}

/// A sessions row reconstructed by the recordings rescan from an orphan
/// events file. `connection_id` is the matched connection when one exists,
/// otherwise a best-effort placeholder; snapshot columns may be `None`.
pub struct ScannedSession<'a> {
  pub id: &'a str,
  pub connection_id: &'a str,
  pub connection_name: Option<&'a str>,
  pub workspace_id: Option<&'a str>,
  pub group_name: Option<&'a str>,
  pub started_at: &'a str,
  pub event_count: i64,
  pub events_file: &'a str,
}

pub fn insert_scanned_session(conn: &Connection, s: &ScannedSession) -> Result<(), String> {
  conn
    .execute(
      "INSERT INTO sessions (id, connection_id, connection_name, tab_id, started_at, \
       event_count, workspace_id, group_name, events_file) \
       VALUES (?1, ?2, ?3, 0, ?4, ?5, ?6, ?7, ?8)",
      params![
        s.id,
        s.connection_id,
        s.connection_name,
        s.started_at,
        s.event_count,
        s.workspace_id,
        s.group_name,
        s.events_file
      ],
    )
    .map_err(|e| e.to_string())?;
  Ok(())
}

/// A session's `started_at` RFC3339 timestamp (the row may be gone — caller
/// filters first).
pub fn session_started_at(conn: &Connection, session_id: &str) -> Result<String, String> {
  conn
    .query_row(
      "SELECT started_at FROM sessions WHERE id = ?1",
      params![session_id],
      |row| row.get(0),
    )
    .map_err(|e| e.to_string())
}

// ==================== Command Set Queries ====================

pub fn list_command_sets(
  conn: &Connection,
  connection_id: Option<&str>,
) -> Result<Vec<CommandSetDto>, String> {
  let mut sql = String::from(
    "SELECT id, name, connection_id, commands, created_at, updated_at FROM command_sets",
  );
  let mut params_vec: Vec<String> = Vec::new();
  if let Some(cid) = connection_id {
    sql.push_str(" WHERE connection_id = ?1 OR connection_id IS NULL");
    params_vec.push(cid.to_string());
  }
  sql.push_str(" ORDER BY updated_at DESC");
  let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
  let rows = if params_vec.is_empty() {
    stmt
      .query_map([], map_cmd_set_row)
      .map_err(|e| e.to_string())?
      .collect::<Result<Vec<_>, _>>()
      .map_err(|e| e.to_string())?
  } else {
    stmt
      .query_map(params![params_vec[0]], map_cmd_set_row)
      .map_err(|e| e.to_string())?
      .collect::<Result<Vec<_>, _>>()
      .map_err(|e| e.to_string())?
  };
  Ok(rows)
}

fn map_cmd_set_row(row: &rusqlite::Row) -> rusqlite::Result<CommandSetDto> {
  let commands_json: String = row.get(3)?;
  let commands: Vec<String> = serde_json::from_str(&commands_json).unwrap_or_default();
  Ok(CommandSetDto {
    id: row.get(0)?,
    name: row.get(1)?,
    connection_id: row.get(2)?,
    commands,
    created_at: row.get(4)?,
    updated_at: row.get(5)?,
  })
}

pub fn save_command_set(conn: &Connection, cmd_set: &CommandSetDto) -> Result<String, String> {
  let commands_json = serde_json::to_string(&cmd_set.commands).map_err(|e| e.to_string())?;
  // Try update first, if 0 rows affected, insert
  let updated = conn
    .execute(
      "UPDATE command_sets SET name = ?1, connection_id = ?2, commands = ?3, updated_at = ?4 WHERE id = ?5",
      params![cmd_set.name, cmd_set.connection_id, commands_json, cmd_set.updated_at, cmd_set.id],
    )
    .map_err(|e| e.to_string())?;
  if updated == 0 {
    conn
      .execute(
        "INSERT INTO command_sets (id, name, connection_id, commands, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
          cmd_set.id,
          cmd_set.name,
          cmd_set.connection_id,
          commands_json,
          cmd_set.created_at,
          cmd_set.updated_at
        ],
      )
      .map_err(|e| e.to_string())?;
  }
  Ok(cmd_set.id.clone())
}

pub fn delete_command_set(conn: &Connection, id: &str) -> Result<(), String> {
  conn
    .execute("DELETE FROM command_sets WHERE id = ?1", params![id])
    .map_err(|e| e.to_string())?;
  Ok(())
}

// ==================== Command Snippet Queries ====================

/// Parse a nullable JSON column, tolerating NULL / malformed values (legacy
/// rows) by yielding an empty vec.
fn parse_json_column<T: serde::de::DeserializeOwned>(raw: Option<String>) -> Vec<T> {
  raw
    .as_deref()
    .and_then(|s| serde_json::from_str(s).ok())
    .unwrap_or_default()
}

fn map_snippet_row(row: &rusqlite::Row) -> rusqlite::Result<CommandSnippetDto> {
  Ok(CommandSnippetDto {
    id: row.get(0)?,
    command: row.get(1)?,
    alias: row.get(2)?,
    favorite: row.get::<_, i64>(3)? != 0,
    hidden: row.get::<_, i64>(4)? != 0,
    sort_order: row.get(5)?,
    connection_id: row.get(8)?,
    params: parse_json_column(row.get::<_, Option<String>>(9)?),
    options: parse_json_column(row.get::<_, Option<String>>(10)?),
    created_at: row.get(6)?,
    updated_at: row.get(7)?,
  })
}

pub fn list_command_snippets(conn: &Connection) -> Result<Vec<CommandSnippetDto>, String> {
  let mut stmt = conn
    .prepare(
      "SELECT id, command, alias, favorite, hidden, sort_order, created_at, updated_at, \
       connection_id, params, options \
       FROM command_snippets ORDER BY favorite DESC, sort_order ASC, updated_at DESC",
    )
    .map_err(|e| e.to_string())?;
  let rows = stmt
    .query_map([], map_snippet_row)
    .map_err(|e| e.to_string())?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|e| e.to_string())?;
  Ok(rows)
}

pub fn save_command_snippet(conn: &Connection, snip: &CommandSnippetDto) -> Result<String, String> {
  let params_json = serde_json::to_string(&snip.params).map_err(|e| e.to_string())?;
  let options_json = serde_json::to_string(&snip.options).map_err(|e| e.to_string())?;
  let updated = conn
    .execute(
      "UPDATE command_snippets SET command = ?1, alias = ?2, favorite = ?3, hidden = ?4, \
       sort_order = ?5, updated_at = ?6, connection_id = ?7, params = ?8, options = ?9 \
       WHERE id = ?10",
      params![
        snip.command,
        snip.alias,
        snip.favorite as i64,
        snip.hidden as i64,
        snip.sort_order,
        snip.updated_at,
        snip.connection_id,
        params_json,
        options_json,
        snip.id
      ],
    )
    .map_err(|e| e.to_string())?;
  if updated == 0 {
    conn
      .execute(
        "INSERT INTO command_snippets \
         (id, command, alias, favorite, hidden, sort_order, created_at, updated_at, connection_id, params, options) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
          snip.id,
          snip.command,
          snip.alias,
          snip.favorite as i64,
          snip.hidden as i64,
          snip.sort_order,
          snip.created_at,
          snip.updated_at,
          snip.connection_id,
          params_json,
          options_json
        ],
      )
      .map_err(|e| e.to_string())?;
  }
  Ok(snip.id.clone())
}

pub fn delete_command_snippet(conn: &Connection, id: &str) -> Result<(), String> {
  conn
    .execute("DELETE FROM command_snippets WHERE id = ?1", params![id])
    .map_err(|e| e.to_string())?;
  Ok(())
}

// ==================== Global Variable Queries ====================

fn map_global_var_row(row: &rusqlite::Row) -> rusqlite::Result<GlobalVariable> {
  Ok(GlobalVariable {
    name: row.get(0)?,
    default_value: row.get(1)?,
    description: row.get(2)?,
    created_at: row.get(3)?,
    updated_at: row.get(4)?,
  })
}

pub fn list_global_variables(conn: &Connection) -> Result<Vec<GlobalVariable>, String> {
  let mut stmt = conn
    .prepare(
      "SELECT name, default_value, description, created_at, updated_at \
       FROM global_variables ORDER BY name COLLATE NOCASE",
    )
    .map_err(|e| e.to_string())?;
  let rows = stmt
    .query_map([], map_global_var_row)
    .map_err(|e| e.to_string())?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|e| e.to_string())?;
  Ok(rows)
}

pub fn save_global_variable(conn: &Connection, var: &GlobalVariable) -> Result<String, String> {
  let updated = conn
    .execute(
      "UPDATE global_variables SET default_value = ?1, description = ?2, updated_at = ?3 WHERE name = ?4",
      params![var.default_value, var.description, var.updated_at, var.name],
    )
    .map_err(|e| e.to_string())?;
  if updated == 0 {
    conn
      .execute(
        "INSERT INTO global_variables (name, default_value, description, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
          var.name,
          var.default_value,
          var.description,
          var.created_at,
          var.updated_at
        ],
      )
      .map_err(|e| e.to_string())?;
  }
  Ok(var.name.clone())
}

pub fn delete_global_variable(conn: &Connection, name: &str) -> Result<(), String> {
  conn
    .execute(
      "DELETE FROM global_variables WHERE name = ?1",
      params![name],
    )
    .map_err(|e| e.to_string())?;
  Ok(())
}

// ==================== AI Prompt Templates ====================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiPromptTemplate {
  pub id: String,
  pub name: String,
  pub prompt: String,
  pub category: String,
  pub created_at: String,
  pub updated_at: String,
}

pub fn list_ai_prompt_templates(conn: &Connection) -> Result<Vec<AiPromptTemplate>, String> {
  let mut stmt = conn
    .prepare("SELECT id, name, prompt, category, created_at, updated_at FROM ai_prompt_templates ORDER BY updated_at DESC")
    .map_err(|e| e.to_string())?;
  let rows = stmt
    .query_map([], |row| {
      Ok(AiPromptTemplate {
        id: row.get(0)?,
        name: row.get(1)?,
        prompt: row.get(2)?,
        category: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
      })
    })
    .map_err(|e| e.to_string())?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|e| e.to_string())?;
  Ok(rows)
}

pub fn save_ai_prompt_template(
  conn: &Connection,
  tpl: &AiPromptTemplate,
) -> Result<String, String> {
  let updated = conn
    .execute(
      "UPDATE ai_prompt_templates SET name = ?1, prompt = ?2, category = ?3, updated_at = ?4 WHERE id = ?5",
      params![tpl.name, tpl.prompt, tpl.category, tpl.updated_at, tpl.id],
    )
    .map_err(|e| e.to_string())?;
  if updated == 0 {
    conn
      .execute(
        "INSERT INTO ai_prompt_templates (id, name, prompt, category, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![tpl.id, tpl.name, tpl.prompt, tpl.category, tpl.created_at, tpl.updated_at],
      )
      .map_err(|e| e.to_string())?;
  }
  Ok(tpl.id.clone())
}

pub fn list_hidden_builtin_templates(conn: &Connection) -> Result<Vec<String>, String> {
  let mut stmt = conn
    .prepare("SELECT key FROM ai_hidden_builtin_templates")
    .map_err(|e| e.to_string())?;
  let rows = stmt
    .query_map([], |row| row.get::<_, String>(0))
    .map_err(|e| e.to_string())?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|e| e.to_string())?;
  Ok(rows)
}

pub fn hide_builtin_template(conn: &Connection, key: &str) -> Result<(), String> {
  conn
    .execute(
      "INSERT OR REPLACE INTO ai_hidden_builtin_templates (key) VALUES (?1)",
      params![key],
    )
    .map_err(|e| e.to_string())?;
  Ok(())
}

pub fn restore_builtin_template(conn: &Connection, key: &str) -> Result<(), String> {
  conn
    .execute(
      "DELETE FROM ai_hidden_builtin_templates WHERE key = ?1",
      params![key],
    )
    .map_err(|e| e.to_string())?;
  Ok(())
}

pub fn delete_ai_prompt_template(conn: &Connection, id: &str) -> Result<(), String> {
  conn
    .execute("DELETE FROM ai_prompt_templates WHERE id = ?1", params![id])
    .map_err(|e| e.to_string())?;
  Ok(())
}

// ==================== Database Maintenance ====================
// SQLite keeps freed pages for reuse, so `wrolp.db` stayed at its old size
// after sessions were deleted — 300 MB of free pages for an otherwise empty
// database was the result. Two mechanisms fix that:
//   * `reclaim_freed_pages`, run after bulk deletions, which rewrites the file
//     when the freed space is worth it (automatic, see the threshold below);
//   * `VACUUM` via the "shrink now" action on the Settings page, which always
//     rewrites and defragments the whole file.
//
// `PRAGMA incremental_vacuum` is deliberately NOT used: it can only drop free
// pages located after the last page still in use, so after deleting sessions it
// typically releases a single page and leaves the rest behind.

/// Size / free-space figures of `wrolp.db`, shown on the Settings page.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbStats {
  /// Absolute path of the database file.
  pub path: String,
  /// Main database file size in bytes.
  pub db_bytes: u64,
  /// Write-ahead-log size in bytes (0 when checkpointed).
  pub wal_bytes: u64,
  pub page_size: u64,
  pub page_count: u64,
  /// Pages on the freelist, i.e. pages held by deleted rows.
  pub free_pages: u64,
  /// Bytes a `VACUUM` would release right now (`free_pages * page_size`).
  pub reclaimable_bytes: u64,
  /// Number of indexed session rows.
  pub sessions: i64,
  /// Rows still in the legacy `session_events` table (not yet exported to files).
  pub legacy_events: i64,
  /// `PRAGMA auto_vacuum`: 0 none, 1 full, 2 incremental.
  pub auto_vacuum: i64,
}

/// Read a single integer PRAGMA; 0 when the pragma is unavailable.
fn pragma_i64(conn: &Connection, name: &str) -> i64 {
  conn
    .query_row(&format!("PRAGMA {}", name), [], |row| row.get::<_, i64>(0))
    .unwrap_or(0)
}

/// Size of `path` on disk; 0 when the file does not exist.
fn file_len(path: &Path) -> u64 {
  std::fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

/// Path of the write-ahead log that belongs to `db_path`.
fn wal_path(db_path: &Path) -> std::path::PathBuf {
  std::path::PathBuf::from(format!("{}-wal", db_path.display()))
}

/// Rewrite the database when recent DELETEs left a worthwhile amount of free
/// space behind, so `wrolp.db` shrinks on its own after "delete all sessions"
/// instead of holding on to hundreds of megabytes.
///
/// `VACUUM` rewrites the whole file, so it only runs when the freed space is
/// large in absolute terms (>= 8 MiB) or dominates the file (>= 75% and at
/// least 512 KiB). Single-session deletes stay cheap; failures are logged and
/// never surface (reclaiming is an optimization, not a correctness concern).
pub fn reclaim_freed_pages(conn: &Connection) {
  let page_size = pragma_i64(conn, "page_size") as u64;
  let total = pragma_i64(conn, "page_count") as u64 * page_size;
  let free = pragma_i64(conn, "freelist_count") as u64 * page_size;
  const MIN_FREE: u64 = 8 * 1024 * 1024;
  const MIN_FREE_SMALL_DB: u64 = 512 * 1024;
  let worth_it = free >= MIN_FREE || (free >= MIN_FREE_SMALL_DB && free * 4 >= total * 3);
  if !worth_it {
    return;
  }
  eprintln!(
    "[db] reclaiming {} bytes of free pages (db {} bytes)",
    free, total
  );
  // In WAL mode `VACUUM` writes into the log, so the main file only shrinks
  // once the checkpoint folds it back and truncates it — order matters.
  if let Err(e) = conn.execute_batch("VACUUM") {
    eprintln!("[db] reclaim failed: {}", e);
    return;
  }
  if let Err(e) = conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(())) {
    eprintln!("[db] checkpoint after reclaim failed: {}", e);
  }
}

/// Collect the figures shown on the Settings page (Settings → Database).
pub fn db_stats(conn: &Connection, db_path: &Path) -> Result<DbStats, String> {
  let page_size = pragma_i64(conn, "page_size") as u64;
  let free_pages = pragma_i64(conn, "freelist_count") as u64;
  let sessions = conn
    .query_row("SELECT COUNT(*) FROM sessions", [], |row| {
      row.get::<_, i64>(0)
    })
    .map_err(|e| e.to_string())?;
  let legacy_events = conn
    .query_row("SELECT COUNT(*) FROM session_events", [], |row| {
      row.get::<_, i64>(0)
    })
    .map_err(|e| e.to_string())?;
  Ok(DbStats {
    path: db_path.to_string_lossy().to_string(),
    db_bytes: file_len(db_path),
    wal_bytes: file_len(&wal_path(db_path)),
    page_size,
    page_count: pragma_i64(conn, "page_count") as u64,
    free_pages,
    reclaimable_bytes: free_pages * page_size,
    sessions,
    legacy_events,
    auto_vacuum: pragma_i64(conn, "auto_vacuum"),
  })
}

/// Rewrite the database file to reclaim every free page (`VACUUM`). Returns the
/// total on-disk size (db + wal) before and after so the UI can report how much
/// space was released.
pub fn vacuum(conn: &Connection, db_path: &Path) -> Result<(u64, u64), String> {
  let before = file_len(db_path) + file_len(&wal_path(db_path));
  conn.execute_batch("VACUUM").map_err(|e| e.to_string())?;
  // Best effort: fold the WAL back into the main file so the reported size
  // matches what the user sees on disk.
  let _ = conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()));
  let after = file_len(db_path) + file_len(&wal_path(db_path));
  Ok((before, after))
}

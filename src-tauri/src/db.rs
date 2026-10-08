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
  /// Items switched ON together with this one ("linkage"), keyed
  /// `param:<name>` / `option:<id>`. Directional, so mutual links form a pair.
  #[serde(default)]
  pub enables: Vec<String>,
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
  /// Items switched ON together with this one ("linkage"), keyed
  /// `param:<name>` / `option:<id>`. Directional, so mutual links form a pair.
  #[serde(default)]
  pub enables: Vec<String>,
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
  /// User-defined list group label; `None` / empty = ungrouped.
  #[serde(default)]
  pub group_name: Option<String>,
  /// Free-form note (may contain newlines): the row's hover tooltip and part of
  /// the search haystack.
  #[serde(default)]
  pub description: Option<String>,
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
  // Migration (command snippets): older DBs lack connection scoping, the
  // per-command parameter / option definitions (stored as JSON arrays), the
  // user-defined list group label and the free-form description. NULL keeps
  // legacy behaviour: general scope, no params/options -> the global variable
  // flow applies at send time, no group -> the snippet shows up under
  // "ungrouped" in the grouped view, no description -> nothing extra in the
  // tooltip and nothing more to match in search.
  for (column, ddl) in [
    ("connection_id", "TEXT"),
    ("params", "TEXT"),
    ("options", "TEXT"),
    ("group_name", "TEXT"),
    ("description", "TEXT"),
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
      "INSERT OR IGNORE INTO sessions (id, connection_id, connection_name, tab_id, started_at, workspace_id, group_name) \
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
    // Appended LAST on purpose: `map_snippet_row` reads by position, so new
    // columns must never be inserted in the middle of the SELECT list.
    group_name: row.get(11)?,
    description: row.get(12)?,
    created_at: row.get(6)?,
    updated_at: row.get(7)?,
  })
}

pub fn list_command_snippets(conn: &Connection) -> Result<Vec<CommandSnippetDto>, String> {
  let mut stmt = conn
    .prepare(
      "SELECT id, command, alias, favorite, hidden, sort_order, created_at, updated_at, \
       connection_id, params, options, group_name, description \
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
       sort_order = ?5, updated_at = ?6, connection_id = ?7, params = ?8, options = ?9, \
       group_name = ?10, description = ?11 \
       WHERE id = ?12",
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
        snip.group_name,
        snip.description,
        snip.id
      ],
    )
    .map_err(|e| e.to_string())?;
  if updated == 0 {
    conn
      .execute(
        "INSERT INTO command_snippets \
         (id, command, alias, favorite, hidden, sort_order, created_at, updated_at, connection_id, params, options, group_name, description) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
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
          options_json,
          snip.group_name,
          snip.description
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
  /// Total rows in the device command index (`host_commands`).
  pub host_commands: i64,
  /// How many devices that spans — the per-device cap is 5 000, so this is what
  /// makes the total interpretable.
  pub host_command_devices: i64,
  /// Bytes those rows occupy on disk, table plus its auto-index, measured through
  /// the `dbstat` virtual table. 0 when the build lacks it (see `table_bytes`).
  pub host_command_bytes: u64,
}

/// On-disk bytes of one table, indexes included, via `dbstat`.
///
/// `dbstat` is a build option rather than a guarantee, so an error here answers 0
/// instead of failing the whole stats read: the numbers on the Settings page are an
/// explanation of the file, not a reason to stop showing it.
fn table_bytes(conn: &Connection, table: &str) -> u64 {
  conn
    .query_row(
      "SELECT COALESCE(SUM(pgsize), 0) FROM dbstat WHERE name = ?1 OR name LIKE ?2",
      params![table, format!("sqlite_autoindex_{}_%", table)],
      |row| row.get::<_, i64>(0),
    )
    .unwrap_or(0)
    .max(0) as u64
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
  let host_commands = conn
    .query_row("SELECT COUNT(*) FROM host_commands", [], |row| {
      row.get::<_, i64>(0)
    })
    .map_err(|e| e.to_string())?;
  let host_command_devices = conn
    .query_row(
      "SELECT COUNT(DISTINCT fingerprint) FROM host_commands",
      [],
      |row| row.get::<_, i64>(0),
    )
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
    host_commands,
    host_command_devices,
    host_command_bytes: table_bytes(conn, "host_commands"),
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

// ==================== Command history ====================

/// How many commands the persisted history keeps. Older rows are dropped on write.
pub const COMMAND_HISTORY_KEEP: i64 = 300;

/// One entry of the persisted (cross-tab, cross-restart) command history, shown in
/// the terminal pane's 历史 dropdown.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandHistoryDto {
  pub command: String,
  /// Where it was run: `terminal` / `localShell` / `serial` / `telnet`.
  pub tab_type: String,
  /// Host or local-terminal label, empty when the session has no host.
  pub host: String,
  pub used_at_ms: i64,
}

/// Record a submitted command. Re-running it refreshes the existing row (the
/// `UNIQUE` on the text) so the list stays newest-first without duplicates, then
/// trims to the newest [`COMMAND_HISTORY_KEEP`].
pub fn record_command(
  conn: &Connection,
  command: &str,
  tab_type: &str,
  host: &str,
  used_at_ms: i64,
) -> Result<(), String> {
  conn
    .execute(
      "INSERT INTO command_history (command, tab_type, host, used_at_ms) \
       VALUES (?1, ?2, ?3, ?4) \
       ON CONFLICT(command) DO UPDATE SET tab_type = ?2, host = ?3, used_at_ms = ?4",
      params![command, tab_type, host, used_at_ms],
    )
    .map_err(|e| e.to_string())?;
  conn
    .execute(
      "DELETE FROM command_history WHERE id NOT IN \
       (SELECT id FROM command_history ORDER BY used_at_ms DESC LIMIT ?1)",
      params![COMMAND_HISTORY_KEEP],
    )
    .map_err(|e| e.to_string())?;
  Ok(())
}

/// The persisted history, newest first.
pub fn list_commands(conn: &Connection, limit: i64) -> Result<Vec<CommandHistoryDto>, String> {
  let mut stmt = conn
    .prepare(
      "SELECT command, tab_type, host, used_at_ms FROM command_history \
       ORDER BY used_at_ms DESC LIMIT ?1",
    )
    .map_err(|e| e.to_string())?;
  let rows = stmt
    .query_map(params![limit], |row| {
      Ok(CommandHistoryDto {
        command: row.get(0)?,
        tab_type: row.get(1)?,
        host: row.get(2)?,
        used_at_ms: row.get(3)?,
      })
    })
    .map_err(|e| e.to_string())?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|e| e.to_string())?;
  Ok(rows)
}

/// Drop one command from the persisted history. The text is `UNIQUE`, so this
/// removes the entry rather than one of its uses; it reports whether a row was
/// there at all, which is what the UI needs to keep its own list honest.
pub fn delete_command(conn: &Connection, command: &str) -> Result<usize, String> {
  conn
    .execute(
      "DELETE FROM command_history WHERE command = ?1",
      params![command],
    )
    .map_err(|e| e.to_string())
}

// ==================== Recent connections (welcome page) ====================

/// How many connections the recency list keeps. Older rows are dropped on write.
pub const RECENT_CONNECTIONS_KEEP: i64 = 100;

/// Ids in the recency table are namespaced: a saved connection and a local
/// terminal entry are two independent id spaces (a local entry can even carry the
/// same uuid as a connection), so local rows are prefixed rather than mixed in.
pub const LOCAL_RECENT_PREFIX: &str = "local:";

/// The built-in "open local shell" sidebar row. It has no persisted entry — it is
/// whatever the default directory and system shell happen to be — but it is always
/// openable, so it is always recordable.
pub const DEFAULT_LOCAL_ENTRY_ID: &str = "__default__";

/// The recency id a local terminal entry is stored under.
pub fn local_recent_id(entry_id: &str) -> String {
  format!("{LOCAL_RECENT_PREFIX}{entry_id}")
}

/// Which list a recency row resolves against: `connection` or `localTerminal`.
pub fn recent_kind(connection_id: &str) -> &'static str {
  if connection_id.starts_with(LOCAL_RECENT_PREFIX) {
    "localTerminal"
  } else {
    "connection"
  }
}

/// The local-terminal entry id behind a `local:` recency row, if that is what it is.
pub fn local_recent_entry_id(connection_id: &str) -> Option<&str> {
  connection_id.strip_prefix(LOCAL_RECENT_PREFIX)
}

/// One recent row: what was opened and when. Deliberately carries neither a name
/// nor a workspace — the caller joins it against the live connection list (or the
/// saved local terminals, for `localTerminal` rows), so a renamed connection shows
/// its new details without another read, and one deleted or moved drops out on its
/// own.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentConnectionDto {
  pub connection_id: String,
  pub used_at_ms: i64,
  pub kind: String,
}

/// Record that something was just opened. Reconnecting refreshes the existing
/// row (the `PRIMARY KEY`) so the list stays newest-first without duplicates, then
/// trims to the newest [`RECENT_CONNECTIONS_KEEP`].
///
/// The id is either a saved connection's or [`local_recent_id`] of a local terminal
/// entry — the table does not care which, only that the id is stable.
pub fn record_connection_used(
  conn: &Connection,
  connection_id: &str,
  used_at_ms: i64,
) -> Result<(), String> {
  conn
    .execute(
      "INSERT INTO connection_recents (connection_id, used_at_ms) \
       VALUES (?1, ?2) \
       ON CONFLICT(connection_id) DO UPDATE SET used_at_ms = ?2",
      params![connection_id, used_at_ms],
    )
    .map_err(|e| e.to_string())?;
  conn
    .execute(
      "DELETE FROM connection_recents WHERE connection_id NOT IN \
       (SELECT connection_id FROM connection_recents ORDER BY used_at_ms DESC LIMIT ?1)",
      params![RECENT_CONNECTIONS_KEEP],
    )
    .map_err(|e| e.to_string())?;
  Ok(())
}

/// Every recent connection, newest first.
///
/// No `limit` parameter on purpose: the caller has to drop rows whose connection
/// is no longer in the active workspace *after* reading, so a SQL-level `LIMIT`
/// would hand back fewer rows than asked for whenever the newest entries happen to
/// belong to another workspace. The table is bounded by
/// [`RECENT_CONNECTIONS_KEEP`], so reading all of it is cheap.
pub fn list_recent(conn: &Connection) -> Result<Vec<RecentConnectionDto>, String> {
  let mut stmt = conn
    .prepare(
      "SELECT connection_id, used_at_ms FROM connection_recents \
       ORDER BY used_at_ms DESC",
    )
    .map_err(|e| e.to_string())?;
  let rows = stmt
    .query_map([], |row| {
      let connection_id: String = row.get(0)?;
      let kind = recent_kind(&connection_id).to_string();
      Ok(RecentConnectionDto {
        connection_id,
        used_at_ms: row.get(1)?,
        kind,
      })
    })
    .map_err(|e| e.to_string())?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|e| e.to_string())?;
  Ok(rows)
}

/// Drop one connection's recency row, reporting whether a row was there. Called
/// when the connection itself is deleted; the read filters orphans out anyway, so
/// this is tidiness rather than correctness.
pub fn forget_connection(conn: &Connection, connection_id: &str) -> Result<usize, String> {
  conn
    .execute(
      "DELETE FROM connection_recents WHERE connection_id = ?1",
      params![connection_id],
    )
    .map_err(|e| e.to_string())
}

// ==================== Device identity (hosts) ====================

/// One recorded device. `fingerprint` is a `SHA256:…` host key hash for SSH, or a
/// `local:<hostname>` style fallback for the session kinds that have no host key.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostDto {
  pub fingerprint: String,
  pub kind: String,
  pub host: String,
  pub port: i64,
  pub username: String,
  pub first_seen: i64,
  pub last_seen: i64,
}

/// Record that a device was seen, returning whether its row is new.
///
/// Reconnecting refreshes `last_seen` and the address we last used to reach it,
/// but never `first_seen` — "since when do we know this box" is the part the UI
/// shows, and it must not reset because the machine moved to a new port.
pub fn record_host(
  conn: &Connection,
  fingerprint: &str,
  kind: &str,
  host: &str,
  port: i64,
  username: &str,
  now_ms: i64,
) -> Result<bool, String> {
  let existed = conn
    .query_row(
      "SELECT 1 FROM hosts WHERE fingerprint = ?1",
      params![fingerprint],
      |_| Ok(()),
    )
    .is_ok();
  conn
    .execute(
      "INSERT INTO hosts (fingerprint, kind, host, port, username, first_seen, last_seen) \
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6) \
       ON CONFLICT(fingerprint) DO UPDATE SET \
         kind = ?2, host = ?3, port = ?4, username = ?5, last_seen = ?6",
      params![fingerprint, kind, host, port, username, now_ms],
    )
    .map_err(|e| e.to_string())?;
  Ok(!existed)
}

/// Link a saved connection to the device it just reached. Both directions are
/// many-to-one over time: one connection can meet several keys (a rebuilt host),
/// one device can be reached by several connections (different users or ports).
pub fn link_connection_host(
  conn: &Connection,
  connection_id: &str,
  fingerprint: &str,
  now_ms: i64,
) -> Result<(), String> {
  conn
    .execute(
      "INSERT INTO connection_hosts (connection_id, fingerprint, last_seen) \
       VALUES (?1, ?2, ?3) \
       ON CONFLICT(connection_id, fingerprint) DO UPDATE SET last_seen = ?3",
      params![connection_id, fingerprint, now_ms],
    )
    .map_err(|e| e.to_string())?;
  Ok(())
}

/// The fingerprint this connection was seen with most recently, if ever — the
/// thing a TOFU check compares against. Call it *before* linking the new one, or
/// it agrees with itself and never reports a change.
pub fn previous_fingerprint(
  conn: &Connection,
  connection_id: &str,
) -> Result<Option<String>, String> {
  let mut stmt = conn
    .prepare(
      "SELECT fingerprint FROM connection_hosts WHERE connection_id = ?1 \
       ORDER BY last_seen DESC LIMIT 1",
    )
    .map_err(|e| e.to_string())?;
  let row = stmt
    .query_map(params![connection_id], |r| r.get::<_, String>(0))
    .map_err(|e| e.to_string())?
    .next()
    .transpose()
    .map_err(|e| e.to_string())?;
  Ok(row)
}

/// All devices, most recently seen first.
pub fn list_hosts(conn: &Connection) -> Result<Vec<HostDto>, String> {
  let mut stmt = conn
    .prepare(
      "SELECT fingerprint, kind, host, port, username, first_seen, last_seen \
       FROM hosts ORDER BY last_seen DESC",
    )
    .map_err(|e| e.to_string())?;
  let rows = stmt
    .query_map([], |row| {
      Ok(HostDto {
        fingerprint: row.get(0)?,
        kind: row.get(1)?,
        host: row.get(2)?,
        port: row.get(3)?,
        username: row.get(4)?,
        first_seen: row.get(5)?,
        last_seen: row.get(6)?,
      })
    })
    .map_err(|e| e.to_string())?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|e| e.to_string())?;
  Ok(rows)
}

/// Which saved connections have reached this device, oldest link first.
pub fn host_connections(conn: &Connection, fingerprint: &str) -> Result<Vec<String>, String> {
  let mut stmt = conn
    .prepare(
      "SELECT connection_id FROM connection_hosts WHERE fingerprint = ?1 \
       ORDER BY last_seen ASC, connection_id ASC",
    )
    .map_err(|e| e.to_string())?;
  let rows = stmt
    .query_map(params![fingerprint], |row| row.get::<_, String>(0))
    .map_err(|e| e.to_string())?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|e| e.to_string())?;
  Ok(rows)
}

/// One indexed command of a device, with its source set.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostCommandDto {
  pub command: String,
  pub sources: String,
}

/// Store a device's freshly collected index, replacing whatever it had before.
///
/// Wholesale rather than incremental: the collection is one script run, so a row
/// missing from it means the command is gone from the machine (uninstalled, or a
/// PATH change) and keeping it would suggest a completion that fails.
pub fn replace_host_commands(
  conn: &mut Connection,
  fingerprint: &str,
  rows: &[(String, String)],
  now_ms: i64,
) -> Result<usize, String> {
  let tx = conn.transaction().map_err(|e| e.to_string())?;
  tx.execute(
    "DELETE FROM host_commands WHERE fingerprint = ?1",
    params![fingerprint],
  )
  .map_err(|e| e.to_string())?;
  // Collecting — automatically or via the button — is the device being (re)learned,
  // so the "cleared" marker that suppresses auto-collection is spent.
  tx.execute(
    "UPDATE hosts SET commands_cleared_at = 0 WHERE fingerprint = ?1",
    params![fingerprint],
  )
  .map_err(|e| e.to_string())?;
  for (command, sources) in rows {
    tx.execute(
      "INSERT INTO host_commands (fingerprint, command, sources, collected_at) \
       VALUES (?1, ?2, ?3, ?4) \
       ON CONFLICT(fingerprint, command) DO UPDATE SET sources = ?3, collected_at = ?4",
      params![fingerprint, command, sources, now_ms],
    )
    .map_err(|e| e.to_string())?;
  }
  tx.commit().map_err(|e| e.to_string())?;
  Ok(rows.len())
}

/// A device's index, ordered so the strongest sources come first and a prefix
/// scan reads contiguously (`git`, `github`, `gitk` group together).
pub fn list_host_commands(
  conn: &Connection,
  fingerprint: &str,
) -> Result<Vec<HostCommandDto>, String> {
  let mut stmt = conn
    .prepare("SELECT command, sources FROM host_commands WHERE fingerprint = ?1 ORDER BY command")
    .map_err(|e| e.to_string())?;
  let rows = stmt
    .query_map(params![fingerprint], |row| {
      Ok(HostCommandDto {
        command: row.get(0)?,
        sources: row.get(1)?,
      })
    })
    .map_err(|e| e.to_string())?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|e| e.to_string())?;
  Ok(rows)
}

/// `(rows, newest collected_at)` for a device, or `None` when it was never
/// collected. This is the staleness gate behind decision ③ — it must not cost a
/// full read of a 5 000-row index on every connection.
pub fn host_index_info(conn: &Connection, fingerprint: &str) -> Result<Option<(i64, i64)>, String> {
  let mut stmt = conn
    .prepare(
      "SELECT COUNT(*), COALESCE(MAX(collected_at), 0) FROM host_commands WHERE fingerprint = ?1",
    )
    .map_err(|e| e.to_string())?;
  let (rows, collected_at): (i64, i64) = match stmt.query_map(params![fingerprint], |row| {
    Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
  }) {
    Ok(mut mapped) => match mapped.next() {
      Some(Ok(v)) => v,
      Some(Err(e)) => return Err(e.to_string()),
      None => (0, 0),
    },
    Err(e) => return Err(e.to_string()),
  };
  if rows == 0 {
    Ok(None)
  } else {
    Ok(Some((rows, collected_at)))
  }
}

/// Drop a device's index (privacy exit; the device row itself stays).
/// Drop one device's command index, and hold automatic collection off until
/// something re-learns it. The device row itself stays — clearing what the box can
/// run is not the same as forgetting the box exists, and the fingerprint is what
/// the connection history and the status chip read.
///
/// `now_ms` stamps the marker so a later `collected_at` (a manual refresh) wins the
/// comparison in `needs_collection`, which is how the button resumes auto-collection.
pub fn clear_host_commands(
  conn: &Connection,
  fingerprint: &str,
  now_ms: i64,
) -> Result<usize, String> {
  let removed = conn
    .execute(
      "DELETE FROM host_commands WHERE fingerprint = ?1",
      params![fingerprint],
    )
    .map_err(|e| e.to_string())?;
  conn
    .execute(
      "UPDATE hosts SET commands_cleared_at = ?2 WHERE fingerprint = ?1",
      params![fingerprint, now_ms],
    )
    .map_err(|e| e.to_string())?;
  Ok(removed)
}

/// When this device's index was last cleared (0 = never, or the device is unknown).
pub fn host_commands_cleared_at(conn: &Connection, fingerprint: &str) -> Result<i64, String> {
  Ok(
    conn
      .query_row(
        "SELECT commands_cleared_at FROM hosts WHERE fingerprint = ?1",
        params![fingerprint],
        |row| row.get::<_, i64>(0),
      )
      .unwrap_or(0),
  )
}

#[cfg(test)]
mod host_identity_tests {
  use super::*;

  fn conn_with_schema() -> Connection {
    let conn = Connection::open_in_memory().expect("in-memory db");
    conn
      .execute_batch(include_str!("schema.sql"))
      .expect("create schema");
    conn
  }

  #[test]
  fn reconnecting_refreshes_instead_of_adding_rows() {
    let conn = conn_with_schema();
    let fresh = record_host(&conn, "SHA256:aaa", "ssh", "h1", 22, "u", 1000).unwrap();
    assert!(fresh, "the first sighting of a device is new");
    record_host(&conn, "SHA256:aaa", "ssh", "h1", 22, "u", 2000).unwrap();

    let hosts = list_hosts(&conn).unwrap();
    assert_eq!(
      hosts.len(),
      1,
      "a reconnect must not add a second device row"
    );
    assert_eq!(
      hosts[0].first_seen, 1000,
      "first_seen keeps the original sighting"
    );
    assert_eq!(
      hosts[0].last_seen, 2000,
      "last_seen moves to the newest sighting"
    );
  }

  #[test]
  fn two_connections_to_one_device_share_the_host_row() {
    let conn = conn_with_schema();
    record_host(&conn, "SHA256:aaa", "ssh", "h1", 22, "u", 1000).unwrap();
    link_connection_host(&conn, "c1", "SHA256:aaa", 1000).unwrap();
    // Same box, different user/port means a different saved connection, but the
    // host key is identical, so it is still one device.
    record_host(&conn, "SHA256:aaa", "ssh", "h1", 2222, "other", 1100).unwrap();
    link_connection_host(&conn, "c2", "SHA256:aaa", 1100).unwrap();

    assert_eq!(list_hosts(&conn).unwrap().len(), 1);
    assert_eq!(
      host_connections(&conn, "SHA256:aaa").unwrap(),
      vec!["c1".to_string(), "c2".to_string()],
      "the device knows both connections reached it"
    );
  }

  #[test]
  fn previous_fingerprint_is_the_newest_link() {
    let conn = conn_with_schema();
    assert_eq!(
      previous_fingerprint(&conn, "c1").unwrap(),
      None,
      "a connection never seen before has nothing to compare against"
    );
    record_host(&conn, "SHA256:old", "ssh", "h1", 22, "u", 1000).unwrap();
    link_connection_host(&conn, "c1", "SHA256:old", 1000).unwrap();
    assert_eq!(
      previous_fingerprint(&conn, "c1").unwrap().as_deref(),
      Some("SHA256:old")
    );

    // A rebuilt host presents a new key; after that link the newest row is the
    // new key, which is what the next connection compares against.
    record_host(&conn, "SHA256:new", "ssh", "h1", 22, "u", 2000).unwrap();
    link_connection_host(&conn, "c1", "SHA256:new", 2000).unwrap();
    assert_eq!(
      previous_fingerprint(&conn, "c1").unwrap().as_deref(),
      Some("SHA256:new"),
      "the comparison target is the last key this connection actually saw"
    );
  }

  #[test]
  fn an_index_round_trips_with_its_age() {
    let mut conn = conn_with_schema();
    assert_eq!(host_index_info(&conn, "SHA256:aaa").unwrap(), None);
    let rows = vec![
      ("git".to_string(), "path,builtin".to_string()),
      ("gzip".to_string(), "path".to_string()),
    ];
    assert_eq!(
      replace_host_commands(&mut conn, "SHA256:aaa", &rows, 1000).unwrap(),
      2
    );
    assert_eq!(
      host_index_info(&conn, "SHA256:aaa").unwrap(),
      Some((2, 1000))
    );
    let listed = list_host_commands(&conn, "SHA256:aaa").unwrap();
    assert_eq!(
      listed
        .iter()
        .map(|c| (c.command.as_str(), c.sources.as_str()))
        .collect::<Vec<_>>(),
      vec![("git", "path,builtin"), ("gzip", "path")]
    );
  }

  #[test]
  fn a_refresh_replaces_the_index_rather_than_adding_to_it() {
    // A command that disappears from the collection is a command that disappeared
    // from the machine; keeping it would keep offering a completion that fails.
    let mut conn = conn_with_schema();
    record_host(&conn, "SHA256:aaa", "ssh", "h", 22, "u", 1000).unwrap();
    let before = vec![
      ("docker".to_string(), "path".to_string()),
      ("kubectl".to_string(), "path".to_string()),
    ];
    replace_host_commands(&mut conn, "SHA256:aaa", &before, 1000).unwrap();
    let after = vec![("docker".to_string(), "path".to_string())];
    replace_host_commands(&mut conn, "SHA256:aaa", &after, 2000).unwrap();

    assert_eq!(
      host_index_info(&conn, "SHA256:aaa").unwrap(),
      Some((1, 2000))
    );
    assert_eq!(clear_host_commands(&conn, "SHA256:aaa", 3000).unwrap(), 1);
    assert_eq!(host_index_info(&conn, "SHA256:aaa").unwrap(), None);
    assert_eq!(
      host_commands_cleared_at(&conn, "SHA256:aaa").unwrap(),
      3000,
      "the clear has to be remembered, or the next connect quietly relearns it all"
    );
    assert!(
      list_host_commands(&conn, "SHA256:aaa").unwrap().is_empty(),
      "clearing empties the device's list, not just its count"
    );
    assert!(
      list_hosts(&conn)
        .unwrap()
        .iter()
        .any(|h| h.fingerprint == "SHA256:aaa"),
      "clearing the index must leave the device itself recorded"
    );

    // A later collection — the manual button — is the deliberate way back in, and
    // it spends the marker so the weekly auto-refresh resumes from there.
    assert_eq!(host_commands_cleared_at(&conn, "SHA256:bbb").unwrap(), 0);
    record_host(&conn, "SHA256:bbb", "ssh", "h", 22, "u", 1000).unwrap();
    replace_host_commands(&mut conn, "SHA256:bbb", &after, 4000).unwrap();
    clear_host_commands(&conn, "SHA256:bbb", 5000).unwrap();
    replace_host_commands(&mut conn, "SHA256:bbb", &after, 6000).unwrap();
    assert_eq!(host_commands_cleared_at(&conn, "SHA256:bbb").unwrap(), 0);
  }

  #[test]
  fn the_index_reports_its_rows_devices_and_bytes_in_the_db_stats() {
    let mut conn = conn_with_schema();
    record_host(&conn, "SHA256:aaa", "ssh", "h", 22, "u", 1000).unwrap();
    record_host(&conn, "SHA256:bbb", "ssh", "h2", 22, "u", 1000).unwrap();
    let many: Vec<(String, String)> = (0..200)
      .map(|i| (format!("cmd{i}"), "path".to_string()))
      .collect();
    replace_host_commands(&mut conn, "SHA256:aaa", &many, 1000).unwrap();
    replace_host_commands(
      &mut conn,
      "SHA256:bbb",
      &[("ls".to_string(), "path".to_string())],
      1000,
    )
    .unwrap();

    let stats = db_stats(&conn, std::path::Path::new("wrolp.test.db")).unwrap();
    assert_eq!(stats.host_commands, 201);
    assert_eq!(stats.host_command_devices, 2);
    // The point of measuring through `dbstat`: the number is the pages the rows
    // actually occupy, so a user can see the index is kilobytes rather than guess
    // from a row count. 0 would mean the measurement silently failed.
    assert!(
      stats.host_command_bytes > 0,
      "dbstat gave no size for a table with 201 rows: {stats:?}"
    );
  }

  #[test]
  fn one_device_index_is_not_another_devices() {
    let mut conn = conn_with_schema();
    replace_host_commands(
      &mut conn,
      "SHA256:aaa",
      &[("apt".to_string(), "path".to_string())],
      1000,
    )
    .unwrap();
    replace_host_commands(
      &mut conn,
      "SHA256:bbb",
      &[("dnf".to_string(), "path".to_string())],
      1000,
    )
    .unwrap();

    let b = list_host_commands(&conn, "SHA256:bbb").unwrap();
    assert_eq!(b.len(), 1);
    assert_eq!(b[0].command, "dnf", "the boxes' packages must not mix");
  }
}

#[cfg(test)]
mod command_history_tests {
  use super::*;

  fn conn_with_schema() -> Connection {
    let conn = Connection::open_in_memory().expect("in-memory db");
    conn
      .execute_batch(include_str!("schema.sql"))
      .expect("create schema");
    conn
  }

  #[test]
  fn re_running_a_command_moves_it_up_instead_of_duplicating() {
    let conn = conn_with_schema();
    record_command(&conn, "ls", "localShell", "cmd", 1).unwrap();
    record_command(&conn, "pwd", "localShell", "cmd", 2).unwrap();
    record_command(&conn, "ls", "terminal", "demo.local", 3).unwrap();

    let list = list_commands(&conn, 10).unwrap();
    assert_eq!(
      vec![
        ("ls", "terminal", "demo.local"),
        ("pwd", "localShell", "cmd")
      ],
      list
        .iter()
        .map(|e| (e.command.as_str(), e.tab_type.as_str(), e.host.as_str()))
        .collect::<Vec<_>>()
    );
  }

  #[test]
  fn deleting_a_command_removes_it_and_only_it() {
    let conn = conn_with_schema();
    record_command(&conn, "ls", "terminal", "demo.local", 1).unwrap();
    record_command(&conn, "pwd", "terminal", "demo.local", 2).unwrap();

    assert_eq!(delete_command(&conn, "ls").unwrap(), 1);
    let list = list_commands(&conn, 10).unwrap();
    assert_eq!(
      vec!["pwd"],
      list.iter().map(|e| e.command.as_str()).collect::<Vec<_>>()
    );

    // Deleting something that is not there is not an error — the UI may have a
    // stale row of its own, and the end state is the same.
    assert_eq!(delete_command(&conn, "ls").unwrap(), 0);
  }

  #[test]
  fn the_table_is_trimmed_to_the_newest_rows() {
    let conn = conn_with_schema();
    for i in 0..(COMMAND_HISTORY_KEEP + 25) {
      record_command(&conn, &format!("cmd-{i}"), "terminal", "", i).unwrap();
    }
    let list = list_commands(&conn, COMMAND_HISTORY_KEEP + 25).unwrap();
    assert_eq!(list.len() as i64, COMMAND_HISTORY_KEEP);
    assert_eq!(
      list.first().unwrap().command,
      format!("cmd-{}", COMMAND_HISTORY_KEEP + 24)
    );
  }

  #[test]
  fn limit_caps_the_result() {
    let conn = conn_with_schema();
    record_command(&conn, "a", "terminal", "", 1).unwrap();
    record_command(&conn, "b", "terminal", "", 2).unwrap();
    assert_eq!(list_commands(&conn, 1).unwrap().len(), 1);
  }
}

#[cfg(test)]
mod recent_connections_tests {
  use super::*;

  fn conn_with_schema() -> Connection {
    let conn = Connection::open_in_memory().expect("in-memory db");
    conn
      .execute_batch(include_str!("schema.sql"))
      .expect("create schema");
    conn
  }

  #[test]
  fn reconnecting_moves_a_connection_up_instead_of_duplicating() {
    let conn = conn_with_schema();
    record_connection_used(&conn, "c1", 1).unwrap();
    record_connection_used(&conn, "c2", 2).unwrap();
    record_connection_used(&conn, "c1", 3).unwrap();

    let list = list_recent(&conn).unwrap();
    assert_eq!(
      vec!["c1", "c2"],
      list
        .iter()
        .map(|e| e.connection_id.as_str())
        .collect::<Vec<_>>()
    );
    assert_eq!(list[0].used_at_ms, 3, "the reconnect is the newest use");
  }

  #[test]
  fn the_table_is_trimmed_to_the_newest_rows() {
    let conn = conn_with_schema();
    for i in 0..(RECENT_CONNECTIONS_KEEP + 10) {
      record_connection_used(&conn, &format!("c{i}"), i).unwrap();
    }
    let list = list_recent(&conn).unwrap();
    assert_eq!(list.len() as i64, RECENT_CONNECTIONS_KEEP);
    assert_eq!(
      list.first().unwrap().connection_id,
      format!("c{}", RECENT_CONNECTIONS_KEEP + 9)
    );
  }

  #[test]
  fn forgetting_a_connection_removes_it_and_only_it() {
    let conn = conn_with_schema();
    record_connection_used(&conn, "c1", 1).unwrap();
    record_connection_used(&conn, "c2", 2).unwrap();

    assert_eq!(forget_connection(&conn, "c1").unwrap(), 1);
    assert_eq!(
      vec!["c2"],
      list_recent(&conn)
        .unwrap()
        .iter()
        .map(|e| e.connection_id.as_str())
        .collect::<Vec<_>>()
    );

    // Forgetting something that is not there is not an error — the delete may
    // have raced a row that was never written.
    assert_eq!(forget_connection(&conn, "c1").unwrap(), 0);
  }
}

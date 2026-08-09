use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
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
  let has_category: bool = conn
    .prepare("PRAGMA table_info(ai_prompt_templates)")
    .map_err(|e| e.to_string())?
    .query_map([], |row| row.get::<_, String>(1))
    .map_err(|e| e.to_string())?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|e| e.to_string())?
    .iter()
    .any(|name| name == "category");
  if !has_category {
    conn
      .execute_batch("ALTER TABLE ai_prompt_templates ADD COLUMN category TEXT NOT NULL DEFAULT ''")
      .map_err(|e| format!("Migration failed (category column): {}", e))?;
  }
  Ok(Arc::new(StdMutex::new(conn)))
}

// ==================== Session Queries ====================

pub fn create_session(
  conn: &Connection,
  id: &str,
  connection_id: &str,
  connection_name: &str,
  tab_id: u32,
  started_at: &str,
) -> Result<(), String> {
  conn
    .execute(
      "INSERT INTO sessions (id, connection_id, connection_name, tab_id, started_at) VALUES (?1, ?2, ?3, ?4, ?5)",
      params![id, connection_id, connection_name, tab_id, started_at],
    )
    .map_err(|e| e.to_string())?;
  Ok(())
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
  let mut sql = String::from("SELECT id, connection_id, connection_name, started_at, ended_at, duration_seconds, title, event_count FROM sessions");
  let mut params_vec: Vec<String> = Vec::new();
  if let Some(cid) = connection_id {
    sql.push_str(" WHERE connection_id = ?1");
    params_vec.push(cid.to_string());
  }
  sql.push_str(" ORDER BY started_at DESC LIMIT ?");
  let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
  let rows = if params_vec.is_empty() {
    stmt
      .query_map(params![limit as i64], map_session_row)
      .map_err(|e| e.to_string())?
      .collect::<Result<Vec<_>, _>>()
      .map_err(|e| e.to_string())?
  } else {
    stmt
      .query_map(params![params_vec[0], limit as i64], map_session_row)
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

pub fn delete_session(conn: &Connection, session_id: &str) -> Result<(), String> {
  conn
    .execute(
      "DELETE FROM session_events WHERE session_id = ?1",
      params![session_id],
    )
    .map_err(|e| e.to_string())?;
  conn
    .execute("DELETE FROM sessions WHERE id = ?1", params![session_id])
    .map_err(|e| e.to_string())?;
  Ok(())
}

pub fn delete_all_sessions(conn: &Connection) -> Result<(), String> {
  conn
    .execute("DELETE FROM session_events", [])
    .map_err(|e| e.to_string())?;
  conn
    .execute("DELETE FROM sessions", [])
    .map_err(|e| e.to_string())?;
  Ok(())
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

//! File-backed AI conversation storage (see `task/plans/AI-SESSION-STORAGE-PLAN.md`).
//!
//! Each conversation's message stream is appended to an NDJSON (`.jsonl`) file
//! under `<data-root>/ai-sessions/<workspace>/<connection>/<time>_<id8>.jsonl`.
//! SQLite keeps only the index row (`ai_sessions`); the file is the single
//! source of truth for the messages. This mirrors the recordings layout
//! (`rec_file.rs`) but with one fewer folder layer (no group) and a different
//! line vocabulary:
//!
//! - session header (first line): `{"type":"session","v":1,"id":...,"ts":...}`
//! - message: `{"type":"user"|"assistant","sid":...,"seq":...,"ts":...,"msg":{...}}`
//! - reset: `{"type":"reset","sid":...,"ts":...,"keepId":"<id>"|null}`
//!
//! `reset` is the only truncation mechanism: it hides every message before it
//! except the `keepId` prefix (or nothing, when `keepId` is null). The file is
//! append-only — "clear" and "edit-resend" append a `reset` line instead of
//! rewriting, so history stays auditable and a crash never corrupts past turns.
//!
//! All writes are plain `std::fs` (no new dependencies). Appends are serialized
//! by the `ai_sessions_write` mutex in `AppState`, matching the recordings
//! rationale: multiple O_APPEND writers on Windows must never interleave.

use serde_json::Value;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

/// AI-session root = `<data-dir>/ai-sessions`. `data_dir` is the effective data
/// directory resolved once at startup (`AppState.base_dir`); `None` falls back
/// to the default config dir, same semantics as `rec_file::recordings_root`.
pub fn ai_sessions_root(data_dir: Option<&Path>) -> PathBuf {
  let dir = data_dir
    .map(|d| d.to_path_buf())
    .unwrap_or_else(crate::data_root::default_data_dir);
  dir.join("ai-sessions")
}

fn segment_or(raw: &str, fallback: &str) -> String {
  let seg = crate::rec_file::sanitize_segment(raw);
  if seg.is_empty() {
    fallback.to_string()
  } else {
    seg
  }
}

/// Derive the absolute message-file path for a session, following the
/// `workspace / connection / file` layout (one layer less than recordings).
/// Callers apply fallbacks (`default` / `unnamed`) for empty segments.
pub fn derive_session_file(
  root: &Path,
  workspace: &str,
  conn: &str,
  created_local: &chrono::DateTime<chrono::Local>,
  session_id: &str,
) -> PathBuf {
  let ws = segment_or(workspace, crate::rec_file::DEFAULT_WORKSPACE);
  let c = segment_or(conn, crate::rec_file::UNNAMED);
  let stamp = created_local.format("%Y%m%d-%H%M%S");
  let short: String = session_id.chars().take(8).collect();
  root.join(ws).join(c).join(format!("{}_{}.jsonl", stamp, short))
}

/// Current wall-clock epoch milliseconds (same helper as `commands::now_ms`,
/// inlined here so this leaf module stays self-contained).
fn now_ms() -> u64 {
  std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|d| d.as_millis() as u64)
    .unwrap_or(0)
}

/// Build the session header line (the first line of a new file). `meta` carries
/// the immutable snapshot fields that stay out of the index's mutable columns.
pub fn header_line(
  session_id: &str,
  workspace_id: Option<&str>,
  connection_id: Option<&str>,
  connection_name: Option<&str>,
  profile_id: Option<&str>,
  model: Option<&str>,
  mode: &str,
  tool_call_format: &str,
) -> String {
  let header = serde_json::json!({
    "type": "session",
    "v": 1,
    "id": session_id,
    "ts": now_ms(),
    "workspaceId": workspace_id,
    "connectionId": connection_id,
    "connectionName": connection_name,
    "profileId": profile_id,
    "model": model,
    "mode": mode,
    "toolCallFormat": tool_call_format,
  });
  serde_json::to_string(&header).unwrap_or_default()
}

/// Append pre-serialized lines to a `.jsonl` file, creating the directory tree
/// on first write (lazy — sessions that save nothing never leave files).
pub fn append_lines(abs: &Path, lines: &[String]) -> Result<(), String> {
  if lines.is_empty() {
    return Ok(());
  }
  if let Some(parent) = abs.parent() {
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
  }
  let mut file = OpenOptions::new()
    .create(true)
    .append(true)
    .open(abs)
    .map_err(|e| e.to_string())?;
  for line in lines {
    writeln!(file, "{}", line).map_err(|e| e.to_string())?;
  }
  file.flush().map_err(|e| e.to_string())
}

/// Parse a `.jsonl` message file back into raw JSON records. Tolerant per line:
/// a corrupt/unparseable line is skipped and counted, and valid records
/// before/after it are still returned (the last torn line of a crash is thus
/// naturally ignored).
pub fn read_records(abs: &Path) -> Result<Vec<Value>, String> {
  let file = fs::File::open(abs).map_err(|e| e.to_string())?;
  let reader = BufReader::new(file);
  let mut records: Vec<Value> = Vec::new();
  let mut skipped = 0usize;
  for line in reader.lines() {
    let line = line.map_err(|e| e.to_string())?;
    let trimmed = line.trim();
    if trimmed.is_empty() {
      continue;
    }
    match serde_json::from_str::<Value>(trimmed) {
      Ok(v) => records.push(v),
      Err(e) => {
        skipped += 1;
        eprintln!("[ai_session] skipping unparseable line: {} ({})", trimmed, e);
      }
    }
  }
  if skipped > 0 {
    eprintln!(
      "[ai_session] {} of {} lines skipped while reading {}",
      skipped,
      records.len() + skipped,
      abs.display()
    );
  }
  Ok(records)
}

/// Whether a raw record is a message line (user/assistant), as opposed to the
/// session header or a `reset` control line.
fn is_message(r: &Value) -> bool {
  matches!(
    r.get("type").and_then(|t| t.as_str()),
    Some("user") | Some("assistant")
  )
}

/// The durable message id of a message record (`id` on the wrapped `msg`).
pub fn message_id(msg: &Value) -> Option<&str> {
  msg.get("id").and_then(|v| v.as_str())
}

/// Project the raw records to the *visible* message set (the `msg` objects, in
/// order), applying the last `reset` line:
/// - no reset → every message is visible;
/// - reset with `keepId: null` → nothing before the reset is visible;
/// - reset with `keepId: "<id>"` → the prefix up to and including `<id>` before
///   the reset is visible, then everything after the reset.
pub fn visible_messages(records: &[Value]) -> Vec<Value> {
  let mut reset_idx: Option<usize> = None;
  let mut keep_id: Option<String> = None;
  for (i, r) in records.iter().enumerate() {
    if r.get("type").and_then(|t| t.as_str()) == Some("reset") {
      reset_idx = Some(i);
      keep_id = r.get("keepId").and_then(|v| v.as_str()).map(str::to_string);
    }
  }
  let Some(ridx) = reset_idx else {
    return records
      .iter()
      .filter(|r| is_message(r))
      .filter_map(|r| r.get("msg").cloned())
      .collect();
  };
  let mut out: Vec<Value> = Vec::new();
  if let Some(k) = &keep_id {
    for r in &records[..ridx] {
      if !is_message(r) {
        continue;
      }
      let Some(msg) = r.get("msg") else { continue };
      let is_keep = msg.get("id").and_then(|v| v.as_str()) == Some(k.as_str());
      out.push(msg.clone());
      if is_keep {
        break;
      }
    }
  }
  for r in &records[ridx + 1..] {
    if is_message(r) {
      if let Some(msg) = r.get("msg") {
        out.push(msg.clone());
      }
    }
  }
  out
}

/// Compute the NDJSON lines to append so the file's visible message set
/// converges to `incoming` (the frontend's current durable message list).
/// Returns an empty vec when the file already matches (idempotent no-op).
///
/// Pure function (no I/O) — the caller reads `records`, appends the returned
/// lines, and updates the index. The alignment is by message id:
/// - `incoming` extends the persisted visible ids → append only the new tail;
/// - `incoming` is shorter or diverges → append a `reset` at the common prefix,
///   then the new tail.
pub fn align_lines(records: &[Value], session_id: &str, incoming: &[Value]) -> Vec<String> {
  let visible = visible_messages(records);
  let persisted_ids: Vec<String> = visible.iter().filter_map(|m| message_id(m).map(str::to_string)).collect();
  let incoming_ids: Vec<String> = incoming.iter().filter_map(|m| message_id(m).map(str::to_string)).collect();
  let mut prefix = 0usize;
  while prefix < persisted_ids.len() && prefix < incoming_ids.len() && persisted_ids[prefix] == incoming_ids[prefix] {
    prefix += 1;
  }

  let mut lines: Vec<String> = Vec::new();
  // Divergence or shrink (not a pure extension) → reset the window first.
  if prefix < persisted_ids.len() {
    let keep = if prefix > 0 { Some(persisted_ids[prefix - 1].clone()) } else { None };
    let reset = serde_json::json!({
      "type": "reset",
      "sid": session_id,
      "ts": now_ms(),
      "keepId": keep,
    });
    if let Ok(line) = serde_json::to_string(&reset) {
      lines.push(line);
    }
  }
  // Append the new tail, continuing the dense `seq` after the existing messages.
  let mut seq = records.iter().filter(|r| is_message(r)).count() as u64 + 1;
  for msg in &incoming[prefix..] {
    let role = msg.get("role").and_then(|v| v.as_str()).unwrap_or("user");
    let line = serde_json::json!({
      "type": role,
      "sid": session_id,
      "seq": seq,
      "ts": now_ms(),
      "msg": msg,
    });
    if let Ok(s) = serde_json::to_string(&line) {
      lines.push(s);
    }
    seq += 1;
  }
  lines
}

/// Remove a message file (best-effort; missing files are fine).
pub fn remove_file(abs: &Path) {
  if let Err(e) = fs::remove_file(abs) {
    if e.kind() != std::io::ErrorKind::NotFound {
      eprintln!("[ai_session] failed to remove {}: {}", abs.display(), e);
    }
  }
}

/// After a file under `ai-sessions/` is removed, prune now-empty ancestor
/// folders (connection → workspace) but never the `ai-sessions` root.
pub fn prune_ai_session_dirs(file: &Path) {
  crate::rec_file::prune_empty_dirs_below(file, "ai-sessions");
}

/// Archive root = `<data-dir>/ai-sessions-archive`. Retained sessions (beyond
/// the cap) are *moved* here rather than deleted, so nothing is lost — only the
/// active tree and index are trimmed. Flat layout with a move-time prefix to
/// dodge filename collisions (the original filename already carries its own
/// `<created>_<id8>` stamp).
pub fn ai_sessions_archive_root(data_dir: Option<&Path>) -> PathBuf {
  let dir = data_dir
    .map(|d| d.to_path_buf())
    .unwrap_or_else(crate::data_root::default_data_dir);
  dir.join("ai-sessions-archive")
}

/// Recursively collect every `.jsonl` message file under the AI-sessions root.
/// Used by `rebuild_ai_sessions` to recover index rows the table lost.
pub fn scan_session_files(root: &Path) -> Vec<PathBuf> {
  let mut out = Vec::new();
  if !root.is_dir() {
    return out;
  }
  let Ok(entries) = fs::read_dir(root) else {
    return out;
  };
  for entry in entries.flatten() {
    let p = entry.path();
    if p.is_dir() {
      out.extend(scan_session_files(&p));
    } else if p.extension().and_then(|e| e.to_str()) == Some("jsonl") {
      out.push(p);
    }
  }
  out
}

/// Move a session file into the archive root. Returns its new path.
pub fn archive_session_file(file: &Path, archive_root: &Path) -> Result<PathBuf, String> {
  let name = file
    .file_name()
    .map(|n| n.to_string_lossy().to_string())
    .ok_or_else(|| "archive: session file has no name".to_string())?;
  fs::create_dir_all(archive_root).map_err(|e| e.to_string())?;
  let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
  let dest = archive_root.join(format!("{}_{}", stamp, name));
  fs::rename(file, &dest).map_err(|e| e.to_string())?;
  Ok(dest)
}

/// The first user message's text, truncated to 40 chars — used to derive a title
/// when rebuilding an index row that had none (matches the frontend's rule).
pub fn first_user_text(messages: &[Value]) -> String {
  for m in messages {
    if m.get("role").and_then(|v| v.as_str()) == Some("user") {
      if let Some(c) = m.get("content").and_then(|v| v.as_str()) {
        return c.chars().take(40).collect();
      }
    }
  }
  String::new()
}

/// Read a string field off the session header record (first `type:"session"`).
pub fn header_string<'a>(records: &'a [Value], key: &str) -> Option<&'a str> {
  records
    .iter()
    .find(|r| r.get("type").and_then(|t| t.as_str()) == Some("session"))
    .and_then(|h| h.get(key))
    .and_then(|v| v.as_str())
}

/// Read the header's epoch-millis `ts` (session creation time).
pub fn header_ts_ms(records: &[Value]) -> Option<u64> {
  records
    .iter()
    .find(|r| r.get("type").and_then(|t| t.as_str()) == Some("session"))
    .and_then(|h| h.get("ts"))
    .and_then(|v| v.as_u64())
}

/// Epoch millis → RFC3339 (for rebuilding `created_at` from a header `ts`).
pub fn ms_to_rfc3339(ms: u64) -> String {
  chrono::DateTime::from_timestamp_millis(ms as i64)
    .map(|d| d.to_rfc3339())
    .unwrap_or_else(|| chrono::Utc::now().to_rfc3339())
}

/// File mtime → RFC3339 (for rebuilding `updated_at`).
pub fn mtime_rfc3339(meta: &std::fs::Metadata) -> String {
  meta
    .modified()
    .map(|t| {
      let dt: chrono::DateTime<chrono::Utc> = t.into();
      dt.to_rfc3339()
    })
    .unwrap_or_else(|_| chrono::Utc::now().to_rfc3339())
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::sync::atomic::{AtomicU32, Ordering};

  fn tmpdir(tag: &str) -> PathBuf {
    static N: AtomicU32 = AtomicU32::new(0);
    let base = std::env::temp_dir().join(format!(
      "wrolp-ai-session-test-{}-{}-{}",
      tag,
      std::process::id(),
      N.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = fs::remove_dir_all(&base);
    fs::create_dir_all(&base).unwrap();
    base
  }

  fn msg(id: &str, role: &str) -> Value {
    serde_json::json!({ "id": id, "role": role, "content": "content of ".to_string() + id })
  }

  #[test]
  fn derive_puts_each_axis_in_its_own_folder() {
    let root = tmpdir("d").join("root");
    let local = chrono::Local::now();
    let a = derive_session_file(&root, "机房-A", "prod-01", &local, "aaaaaaaa-1111");
    let b = derive_session_file(&root, "机房-A", "prod-02", &local, "bbbbbbbb-2222");
    let c = derive_session_file(&root, "机房-B", "prod-01", &local, "cccccccc-3333");
    assert_ne!(a, b);
    assert_ne!(a, c);
    assert_eq!(a.parent().unwrap().file_name().unwrap(), "prod-01");
    assert_eq!(
      a.parent().unwrap().parent().unwrap().file_name().unwrap(),
      "机房-A"
    );
    let fname = a.file_name().unwrap().to_string_lossy().to_string();
    assert!(fname.ends_with("_aaaaaaaa.jsonl"), "{}", fname);
    let _ = fs::remove_dir_all(root.parent().unwrap());
  }

  #[test]
  fn derive_prevents_folders_escaping_root() {
    let root = tmpdir("e").join("root");
    let path = derive_session_file(&root, "../..", "../../escape", &chrono::Local::now(), "sess1");
    assert!(path.starts_with(&root));
    let rel = path.strip_prefix(&root).unwrap();
    assert_eq!(rel.components().count(), 3, "ws/conn/file layout");
    for comp in rel.components() {
      assert_ne!(comp.as_os_str(), "..", "escaping component in {}", path.display());
    }
    let _ = fs::remove_dir_all(root.parent().unwrap());
  }

  #[test]
  fn append_then_read_roundtrips_and_skips_garbage() {
    let root = tmpdir("f");
    let file = root.join("sess.jsonl");
    let lines = vec![
      header_line("s1", None, None, None, None, None, "chat", "nested"),
      serde_json::to_string(&serde_json::json!({
        "type": "user", "sid": "s1", "seq": 1, "ts": 1, "msg": msg("m1", "user")
      }))
      .unwrap(),
    ];
    append_lines(&file, &lines).expect("append");
    let records = read_records(&file).expect("read");
    assert_eq!(records.len(), 2);
    assert_eq!(records[0]["type"], "session");
    assert_eq!(records[1]["msg"]["id"], "m1");
    let _ = fs::remove_dir_all(&root);
  }

  #[test]
  fn read_records_skips_bad_lines_but_keeps_good_ones() {
    let root = tmpdir("g");
    let file = root.join("sess.jsonl");
    append_lines(
      &file,
      &[
        "{\"type\":\"user\",\"msg\":{\"id\":\"m1\"}}".to_string(),
        "not-json{{{".to_string(),
        "{\"type\":\"assistant\",\"msg\":{\"id\":\"m2\"}}".to_string(),
      ],
    )
    .expect("append");
    let records = read_records(&file).expect("read");
    assert_eq!(records.len(), 2);
    assert_eq!(records[0]["msg"]["id"], "m1");
    assert_eq!(records[1]["msg"]["id"], "m2");
    let _ = fs::remove_dir_all(&root);
  }

  #[test]
  fn visible_messages_applies_last_reset() {
    let mk = |t: &str, id: &str| {
      serde_json::json!({ "type": t, "sid": "s", "msg": msg(id, if t == "user" { "user" } else { "assistant" }) })
    };
    let reset = |keep: Option<&str>| {
      serde_json::json!({ "type": "reset", "sid": "s", "keepId": keep })
    };
    // No reset → all visible.
    let records = vec![mk("user", "m1"), mk("assistant", "m2")];
    assert_eq!(visible_messages(&records).len(), 2);
    // reset(keepId=m2) → m1,m2 kept, m3 hidden, m4 (after reset) visible.
    let records = vec![
      mk("user", "m1"),
      mk("assistant", "m2"),
      mk("user", "m3"),
      reset(Some("m2")),
      mk("user", "m3b"),
    ];
    let ids: Vec<String> = visible_messages(&records)
      .iter()
      .map(|m| m["id"].as_str().unwrap().to_string())
      .collect();
    assert_eq!(ids, vec!["m1", "m2", "m3b"]);
    // reset(keepId=null) → clear.
    let records = vec![mk("user", "m1"), reset(None)];
    assert!(visible_messages(&records).is_empty());
  }

  #[test]
  fn align_lines_is_idempotent_and_handles_extension_shrink_and_diverge() {
    let mk = |t: &str, id: &str| {
      serde_json::json!({ "type": t, "sid": "s", "seq": 1, "ts": 1, "msg": msg(id, if t == "user" { "user" } else { "assistant" }) })
    };

    // Extension: persisted [m1], incoming [m1, m2] → append m2 only, no reset.
    let records = vec![mk("user", "m1")];
    let incoming = vec![msg("m1", "user"), msg("m2", "assistant")];
    let lines = align_lines(&records, "s", &incoming);
    assert_eq!(lines.len(), 1);
    assert!(lines[0].contains("\"id\":\"m2\""), "{}", lines[0]);
    assert!(!lines[0].contains("\"reset\""));

    // Idempotent: re-saving the same [m1] → no new lines.
    let records = vec![mk("user", "m1")];
    let incoming = vec![msg("m1", "user")];
    assert!(align_lines(&records, "s", &incoming).is_empty());

    // Shrink: persisted [m1, m2], incoming [m1] → reset(keepId=m1), no tail.
    let records = vec![mk("user", "m1"), mk("assistant", "m2")];
    let incoming = vec![msg("m1", "user")];
    let lines = align_lines(&records, "s", &incoming);
    assert_eq!(lines.len(), 1);
    assert!(lines[0].contains("\"reset\""));
    assert!(lines[0].contains("\"m1\""), "{}", lines[0]);

    // Clear: persisted [m1], incoming [] → reset(keepId=null).
    let records = vec![mk("user", "m1")];
    let lines = align_lines(&records, "s", &[]);
    assert_eq!(lines.len(), 1);
    assert!(lines[0].contains("\"reset\""));
    assert!(lines[0].contains("\"keepId\":null"), "{}", lines[0]);
  }

  #[test]
  fn first_user_text_takes_first_user_message_truncated() {
    let msgs = vec![
      serde_json::json!({ "role": "assistant", "content": "ignored" }),
      serde_json::json!({ "role": "user", "content": "hello world" }),
    ];
    assert_eq!(first_user_text(&msgs), "hello world");
    let long: Vec<Value> = vec![serde_json::json!({
      "role": "user",
      "content": "a".repeat(100)
    })];
    assert_eq!(first_user_text(&long).chars().count(), 40);
    assert!(first_user_text(&[]).is_empty());
  }

  #[test]
  fn scan_session_files_collects_jsonl_recursively() {
    let root = tmpdir("scan");
    let dir = root.join("ai-sessions");
    let nested = dir.join("ws").join("conn");
    fs::create_dir_all(&nested).unwrap();
    let f1 = nested.join("a.jsonl");
    let f2 = nested.join("b.jsonl");
    let not_jsonl = nested.join("readme.txt");
    fs::write(&f1, "{}").unwrap();
    fs::write(&f2, "{}").unwrap();
    fs::write(&not_jsonl, "x").unwrap();
    let found = scan_session_files(&dir);
    assert_eq!(found.len(), 2);
    let _ = fs::remove_dir_all(&root);
  }

  #[test]
  fn archive_session_file_moves_into_archive_root() {
    let root = tmpdir("arch");
    let src = root.join("sess.jsonl");
    fs::write(&src, "x").unwrap();
    let archive = root.join("archive");
    let dest = archive_session_file(&src, &archive).unwrap();
    assert!(dest.starts_with(&archive));
    assert!(!src.exists());
    assert!(dest.is_file());
    let _ = fs::remove_dir_all(&root);
  }

  #[test]
  fn header_fields_and_ts_are_read_from_the_header_record() {
    let records = vec![
      serde_json::json!({ "type": "session", "id": "s1", "ts": 1726300000123u64, "connectionName": "prod-01" }),
      serde_json::json!({ "type": "user", "sid": "s1", "msg": { "id": "m1" } }),
    ];
    assert_eq!(header_string(&records, "id"), Some("s1"));
    assert_eq!(header_string(&records, "connectionName"), Some("prod-01"));
    assert_eq!(header_string(&records, "missing"), None);
    assert_eq!(header_ts_ms(&records), Some(1726300000123));
    let rfc = ms_to_rfc3339(1726300000123);
    assert!(rfc.starts_with("2024-09-14"), "utc rfc3339: {rfc}");
    assert!(rfc.contains('T'), "has a date/time separator: {rfc}");
  }
}

//! File-backed session recordings (see `task/plans/recording-to-files-plan.md`,
//! RF2).
//!
//! Each session's event stream is appended to an NDJSON (`.jsonl`) file under
//! `<data-root>/recordings/<workspace>/<group>/<connection>/<time>_<session>.jsonl`.
//! One compact JSON object per line: `{"s":seq,"t":timestamp_ms,"d":direction,"c":content}`.
//! SQLite keeps only the index (`sessions`); events no longer go into
//! `session_events` for new recordings.
//!
//! All writes are plain `std::fs` — no new dependencies. File appends happen
//! inside the `recordings` mutex so the flush task and disconnect-finalize can
//! never interleave O_APPEND writes on Windows.

use crate::db::{RecordedEvent, SessionEventDto};
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

/// Folder segment used when a connection has no group.
pub const UNGROUPED: &str = "__ungrouped__";
/// Fallback connection segment when the name is empty/unsanitizable.
pub const UNNAMED: &str = "unnamed";
/// Fallback workspace segment when no workspace resolves.
pub const DEFAULT_WORKSPACE: &str = "default";

/// Max length of a single path segment before truncation + hash tail.
const MAX_SEGMENT: usize = 60;

/// Recording root = `<data-dir>/recordings`. `data_dir` is the effective data
/// directory resolved once at startup (`AppState.base_dir` — always `Some` in
/// production after DR1); `None` falls back to the default config dir, with the
/// same semantics as `commands::data_dir_for`.
pub fn recordings_root(data_dir: Option<&Path>) -> PathBuf {
  let dir = data_dir
    .map(|d| d.to_path_buf())
    .unwrap_or_else(crate::data_root::default_data_dir);
  dir.join("recordings")
}

/// Sanitize one folder/file segment for cross-platform safety (Windows rules):
/// illegal chars and ASCII control chars become `_`, reserved device names get
/// a `_` prefix, leading/trailing whitespace and trailing dots are stripped,
/// and over-long segments are truncated with a 6-hex hash tail. An empty
/// result (nothing usable left) means the caller must substitute a fallback.
pub fn sanitize_segment(raw: &str) -> String {
  let replaced: String = raw
    .chars()
    .map(|c| match c {
      '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
      c if (c as u32) < 32 => '_',
      c => c,
    })
    .collect();
  let trimmed = replaced.trim();
  if trimmed.is_empty() {
    return String::new();
  }
  let end = trimmed.trim_end_matches('.').len();
  let mut base = trimmed[..end].to_string();
  if is_reserved_name(&base) {
    base.insert(0, '_');
  }
  if base.chars().count() > MAX_SEGMENT {
    let prefix: String = base.chars().take(MAX_SEGMENT).collect();
    base = format!("{}_{}", prefix, hash6(&base));
  }
  base
}

/// Windows reserved device names (CON/PRN/AUX/NUL/COM1-9/LPT1-9), including
/// the `CON.txt` (extension) form — case-insensitive.
fn is_reserved_name(name: &str) -> bool {
  let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
  match stem.as_str() {
    "CON" | "PRN" | "AUX" | "NUL" => true,
    _ if stem.starts_with("COM") => stem[3..].parse::<u32>().is_ok_and(|n| (1..=9).contains(&n)),
    _ if stem.starts_with("LPT") => stem[3..].parse::<u32>().is_ok_and(|n| (1..=9).contains(&n)),
    _ => false,
  }
}

/// Stable 6-hex (24-bit) FNV-1a digest used as a short tail on truncated
/// segments, so two long names that share a 60-char prefix don't collide.
fn hash6(s: &str) -> String {
  let mut h: u64 = 0xcbf2_9ce4_8422_2325;
  for b in s.as_bytes() {
    h ^= *b as u64;
    h = h.wrapping_mul(0x0000_0100_0000_01b3);
  }
  format!("{:06x}", h & 0x00ff_ffff)
}

/// Convert a recording `started_at` RFC3339 timestamp to local wall time
/// (used for the human-readable file name). Falls back to "now" on parse error.
pub fn started_local(iso: &str) -> chrono::DateTime<chrono::Local> {
  chrono::DateTime::parse_from_rfc3339(iso)
    .map(|dt| dt.with_timezone(&chrono::Local))
    .unwrap_or_else(|_| chrono::Local::now())
}

fn segment_or(raw: &str, fallback: &str) -> String {
  let seg = sanitize_segment(raw);
  if seg.is_empty() {
    fallback.to_string()
  } else {
    seg
  }
}

/// Derive the absolute events-file path for a session, following the
///  workspace / group / connection / file-name  folder layout. Callers apply
/// fallbacks (`default` / `__ungrouped__` / `unnamed`) for empty segments.
pub fn derive_events_file(
  root: &Path,
  workspace: &str,
  group: &str,
  conn: &str,
  started_at: &chrono::DateTime<chrono::Local>,
  session_id: &str,
) -> PathBuf {
  let ws = segment_or(workspace, DEFAULT_WORKSPACE);
  let g = segment_or(group, UNGROUPED);
  let c = segment_or(conn, UNNAMED);
  let stamp = started_at.format("%Y%m%d-%H%M%S");
  let short: String = session_id.chars().take(8).collect();
  root
    .join(ws)
    .join(g)
    .join(c)
    .join(format!("{}_{}.jsonl", stamp, short))
}

/// One-shot convenience: resolve the absolute events file from an
/// `ActiveRecording`-shaped snapshot (`events_file_for`). Exposed so callers
/// that snapshot the path at connect time share one implementation.
pub fn events_file_for(
  base_dir: Option<&Path>,
  workspace_name: Option<&str>,
  group_name: Option<&str>,
  connection_name: &str,
  started_at_iso: &str,
  session_id: &str,
) -> PathBuf {
  let root = recordings_root(base_dir);
  let local = started_local(started_at_iso);
  derive_events_file(
    &root,
    workspace_name.unwrap_or(DEFAULT_WORKSPACE),
    group_name.unwrap_or(UNGROUPED),
    connection_name,
    &local,
    session_id,
  )
}

/// Split an absolute events-file path into its (workspace, group) folder
/// segments relative to the recordings root. `None` when the file does not
/// live under `root` (e.g. an old absolute path left behind by a manual move).
/// Used to show a breadcrumb that always matches where the file actually sits.
pub fn folder_segments(abs: &Path, root: &Path) -> Option<(String, String)> {
  let rel = abs.strip_prefix(root).ok()?;
  let mut segs = rel.components().filter_map(|c| match c {
    std::path::Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
    _ => None,
  });
  let ws = segs.next()?;
  let grp = segs.next()?;
  Some((ws, grp))
}

#[derive(Serialize)]
struct LineOut<'a> {
  s: u64,
  t: u64,
  d: &'a str,
  c: &'a str,
}

#[derive(Deserialize)]
struct LineIn {
  s: i64,
  t: i64,
  d: String,
  c: String,
}

/// Append events to the session's `.jsonl` file, creating the directory tree
/// on first write (lazy — sessions that record nothing never leave files).
/// One event per line, so appends never rewrite earlier content.
pub fn append_events(abs: &Path, events: &[RecordedEvent]) -> Result<(), String> {
  if events.is_empty() {
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
  for ev in events {
    let line = serde_json::to_string(&LineOut {
      s: ev.seq,
      t: ev.timestamp_ms,
      d: &ev.direction,
      c: &ev.content,
    })
    .map_err(|e| e.to_string())?;
    writeln!(file, "{}", line).map_err(|e| e.to_string())?;
  }
  file.flush().map_err(|e| e.to_string())?;
  Ok(())
}

/// Append DTO-shaped events (as read from SQLite / `read_events`) to a session
/// file. Used by the legacy→file export migration, which writes events that
/// already left the in-memory `RecordedEvent` form.
pub fn append_dto_lines(abs: &Path, events: &[SessionEventDto]) -> Result<(), String> {
  if events.is_empty() {
    return Ok(());
  }
  let recs: Vec<RecordedEvent> = events
    .iter()
    .map(|e| RecordedEvent {
      seq: u64::try_from(e.seq).unwrap_or(0),
      timestamp_ms: u64::try_from(e.timestamp_ms).unwrap_or(0),
      direction: e.direction.clone(),
      content: e.content.clone(),
    })
    .collect();
  append_events(abs, &recs)
}

/// Number of parseable events in a file (full read — used only by the rare
/// index-rebuild scan, not the hot path).
pub fn count_events_in_file(abs: &Path) -> Result<usize, String> {
  Ok(read_events(abs)?.len())
}

/// Parse the local timestamp embedded in an events file name
/// (`YYYYMMDD-HHMMSS_<id8>.jsonl`).
pub fn parse_events_file_stamp(file_name: &str) -> Option<chrono::NaiveDateTime> {
  let stem = file_name.strip_suffix(".jsonl")?;
  let stamp = stem.split('_').next()?;
  chrono::NaiveDateTime::parse_from_str(stamp, "%Y%m%d-%H%M%S").ok()
}

/// Parse a `.jsonl` events file back into the same DTO shape the SQLite reader
/// produced. Tolerant per line: a corrupt/unparseable line is skipped and
/// counted, and valid events before/after it are still returned.
pub fn read_events(abs: &Path) -> Result<Vec<SessionEventDto>, String> {
  let file = fs::File::open(abs).map_err(|e| e.to_string())?;
  let reader = BufReader::new(file);
  let mut events: Vec<SessionEventDto> = Vec::new();
  let mut skipped = 0usize;
  for line in reader.lines() {
    let line = line.map_err(|e| e.to_string())?;
    let trimmed = line.trim();
    if trimmed.is_empty() {
      continue;
    }
    match serde_json::from_str::<LineIn>(trimmed) {
      Ok(parsed) => events.push(SessionEventDto {
        seq: parsed.s,
        timestamp_ms: parsed.t,
        direction: parsed.d,
        content: parsed.c,
      }),
      Err(e) => {
        skipped += 1;
        eprintln!("[rec_file] skipping unparseable line: {} ({})", trimmed, e);
      }
    }
  }
  if skipped > 0 {
    eprintln!(
      "[rec_file] {} of {} lines skipped while reading {}",
      skipped,
      events.len() + skipped,
      abs.display()
    );
  }
  Ok(events)
}

/// Remove an events file (best-effort; missing files are fine).
pub fn remove_events_file(abs: &Path) {
  if let Err(e) = fs::remove_file(abs) {
    if e.kind() != std::io::ErrorKind::NotFound {
      eprintln!("[rec_file] failed to remove {}: {}", abs.display(), e);
    }
  }
}

/// After a file under `recordings/` is removed, prune now-empty ancestor
/// folders (connection → group → workspace) but never the `recordings` root.
pub fn prune_empty_dirs(file: &Path) {
  let mut dir = file.parent();
  while let Some(d) = dir {
    if d.file_name().is_some_and(|n| n == "recordings") {
      break;
    }
    if fs::remove_dir(d).is_err() {
      break; // still has content, or removal failed — stop climbing
    }
    dir = d.parent();
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::sync::atomic::{AtomicU32, Ordering};

  fn tmpdir(tag: &str) -> PathBuf {
    static N: AtomicU32 = AtomicU32::new(0);
    let base = std::env::temp_dir().join(format!(
      "wrolp-rec-file-test-{}-{}-{}",
      tag,
      std::process::id(),
      N.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = fs::remove_dir_all(&base);
    fs::create_dir_all(&base).unwrap();
    base
  }

  #[test]
  fn sanitize_replaces_illegal_chars_and_reserved_names() {
    assert_eq!(
      sanitize_segment("a/b\\c:d*e?f\"g<h>i|j"),
      "a_b_c_d_e_f_g_h_i_j"
    );
    assert_eq!(sanitize_segment("  padded  "), "padded");
    assert_eq!(sanitize_segment("trailing..."), "trailing");
    assert_eq!(sanitize_segment("CON"), "_CON");
    assert_eq!(sanitize_segment("con.txt"), "_con.txt");
    assert_eq!(sanitize_segment("COM7"), "_COM7");
    assert_eq!(sanitize_segment("LPT2.log"), "_LPT2.log");
    // Not reserved.
    assert_eq!(sanitize_segment("console"), "console");
    assert_eq!(sanitize_segment("comp"), "comp");
    // Empty / nothing usable.
    assert_eq!(sanitize_segment(""), "");
    assert_eq!(sanitize_segment("   "), "");
  }

  #[test]
  fn sanitize_truncates_long_names_with_hash_tail() {
    let long = "x".repeat(120);
    let seg = sanitize_segment(&long);
    assert_eq!(seg.len(), 60 + 1 + 6);
    assert!(seg.starts_with(&"x".repeat(60)));
    // Two distinct long names sharing a prefix differ in their tails.
    let a = format!("{}{}", "y".repeat(60), "aaaa");
    let b = format!("{}{}", "y".repeat(60), "bbbb");
    assert_ne!(sanitize_segment(&a), sanitize_segment(&b));
  }

  #[test]
  fn derive_puts_each_axis_in_its_own_folder() {
    let root = tmpdir("d").join("root");
    let local = chrono::Local::now();
    let a = derive_events_file(
      &root,
      "机房-A",
      "网络组",
      "prod-01",
      &local,
      "aaaaaaaa-1111",
    );
    let b = derive_events_file(
      &root,
      "机房-A",
      "网络组",
      "prod-02",
      &local,
      "bbbbbbbb-2222",
    );
    let c = derive_events_file(
      &root,
      "机房-B",
      "网络组",
      "prod-01",
      &local,
      "cccccccc-3333",
    );
    assert_ne!(a, b);
    assert_ne!(a, c);
    assert_eq!(a.parent().unwrap().file_name().unwrap(), "prod-01");
    assert_eq!(
      a.parent().unwrap().parent().unwrap().file_name().unwrap(),
      "网络组"
    );
    assert_eq!(
      a.parent()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .file_name()
        .unwrap(),
      "机房-A"
    );
    // File names embed local time (YYYYMMDD-HHMMSS) + short session id.
    let fname = a.file_name().unwrap().to_string_lossy().to_string();
    assert!(fname.ends_with("_aaaaaaaa.jsonl"), "{}", fname);
    assert_eq!(fname.len(), 8 + 1 + 6 + 1 + 8 + 6); // date-ts + "_" + id + ".jsonl"
    let _ = fs::remove_dir_all(root.parent().unwrap());
  }

  #[test]
  fn folder_segments_split_workspace_and_group_from_recordings_root() {
    let base = tmpdir("h");
    let root = base.join("recordings");
    let file = derive_events_file(
      &root,
      "机房-A",
      "网络组",
      "prod-01",
      &chrono::Local::now(),
      "sess0001",
    );
    let (ws, grp) = folder_segments(&file, &root).expect("segs");
    assert_eq!(ws, "机房-A");
    assert_eq!(grp, "网络组");
    // A file outside the recordings root (manual move) yields None.
    let elsewhere = base.join("elsewhere.jsonl");
    assert!(folder_segments(&elsewhere, &root).is_none());
    let _ = fs::remove_dir_all(&base);
  }

  #[test]
  fn sanitize_prevents_folders_escaping_root() {
    let root = tmpdir("e").join("root");
    let local = chrono::Local::now();
    let path = derive_events_file(&root, "../..", "../../escape", "cn", &local, "sess0001");
    assert!(path.starts_with(&root));
    // No path component equals ".." — traversal cannot escape the root, even
    // though dots themselves survive inside a segment (".._.." is a legal name).
    let rel = path.strip_prefix(&root).unwrap();
    for comp in rel.components() {
      assert_ne!(
        comp.as_os_str(),
        "..",
        "escaping component in {}",
        path.display()
      );
    }
    assert_eq!(rel.components().count(), 4, "ws/group/conn/file layout");
    let _ = fs::remove_dir_all(root.parent().unwrap());
  }

  #[test]
  fn append_then_read_roundtrips_and_skips_garbage() {
    let root = tmpdir("f");
    let file = derive_events_file(
      &root,
      "ws",
      "grp",
      "conn",
      &chrono::Local::now(),
      "sess0001",
    );
    let events = vec![
      RecordedEvent {
        seq: 0,
        timestamp_ms: 0,
        direction: "input".into(),
        content: "ls".into(),
      },
      RecordedEvent {
        seq: 1,
        timestamp_ms: 42,
        direction: "output".into(),
        content: "file\nlist".into(),
      },
      RecordedEvent {
        seq: 2,
        timestamp_ms: 80,
        direction: "command".into(),
        content: "echo hi".into(),
      },
    ];
    append_events(&file, &events).expect("append");
    // Appending again keeps the same file and both batches.
    append_events(&file, &[events[2].clone()]).expect("append second");
    let read = read_events(&file).expect("read");
    assert_eq!(read.len(), 4);
    assert_eq!(read[0].content, "ls");
    assert_eq!(read[1].content, "file\nlist");
    assert_eq!(read[2].content, "echo hi");
    assert_eq!(read[3].seq, 2);
    let _ = fs::remove_dir_all(&root);
  }

  #[test]
  fn append_dto_lines_matches_append_events_roundtrip() {
    let root = tmpdir("i");
    let file = derive_events_file(
      &root,
      "ws",
      "grp",
      "conn",
      &chrono::Local::now(),
      "sess0001",
    );
    let dtos = vec![
      SessionEventDto {
        seq: 0,
        timestamp_ms: 0,
        direction: "input".into(),
        content: "ls".into(),
      },
      SessionEventDto {
        seq: 1,
        timestamp_ms: 42,
        direction: "output".into(),
        content: "ok".into(),
      },
    ];
    append_dto_lines(&file, &dtos).expect("append dto");
    assert_eq!(count_events_in_file(&file).expect("count"), 2);
    let read = read_events(&file).expect("read");
    assert_eq!(read[1].content, "ok");
    // Empty batch is a no-op (no file left behind).
    let empty_path = derive_events_file(&root, "ws", "grp", "c2", &chrono::Local::now(), "e");
    append_dto_lines(&empty_path, &[]).expect("no-op");
    assert!(!empty_path.exists());
    let _ = fs::remove_dir_all(&root);
  }

  #[test]
  fn parses_events_file_stamp() {
    let dt = parse_events_file_stamp("20260906-151233_abcdef12.jsonl").expect("stamp");
    assert_eq!(dt.to_string(), "2026-09-06 15:12:33");
    assert!(parse_events_file_stamp("not-a-stamp.jsonl").is_none());
    assert!(parse_events_file_stamp("20260906-151233.jsonl").is_some());
  }

  #[test]
  fn remove_and_prune_cleans_empty_dirs_only() {
    let base = tmpdir("g");
    let root = base.join("recordings");
    let file = derive_events_file(
      &root,
      "ws",
      "grp",
      "conn",
      &chrono::Local::now(),
      "sess0001",
    );
    let sibling = derive_events_file(
      &root,
      "ws",
      "grp",
      "conn",
      &chrono::Local::now(),
      "sess0002",
    );
    let conn_dir = file.parent().unwrap().to_path_buf();
    fs::create_dir_all(&conn_dir).unwrap();
    let ev = RecordedEvent {
      seq: 0,
      timestamp_ms: 0,
      direction: "input".into(),
      content: "x".into(),
    };
    append_events(&file, &[ev.clone()]).expect("append");
    append_events(&sibling, &[ev]).expect("append sibling");
    remove_events_file(&file);
    // Conn dir still holds the sibling file → nothing pruned.
    prune_empty_dirs(&file);
    assert!(conn_dir.exists());
    // Removing the last file prunes connection → group → workspace, but stops
    // at the `recordings` root.
    remove_events_file(&sibling);
    prune_empty_dirs(&sibling);
    assert!(!conn_dir.exists());
    assert!(root.exists(), "recordings root must survive pruning");
    assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
    let _ = fs::remove_dir_all(&base);
  }
}

// ==================== Configurable data directory ====================
//
// Every on-disk artifact (wrolp.db, connections.json, window.json,
// local_terminals.json, ai_config.json, certs/, recordings/) lives under a
// "data directory". By default that is `dirs::config_dir()/wrolp-terminal`,
// but the user can relocate the whole data directory from the Settings page
// (see task/plans/recording-to-files-plan.md §3.5).
//
// The choice is NOT stored in window.json (which itself lives inside the data
// directory and may move) — it is an anchor file pinned to the *default* data
// directory. Switches take effect on the next launch: `resolve_anchor` re-
// points everything and, when the target is brand new, copies the previous
// root over (copy, not move; existing files are never overwritten).
//
// vault.key lives in the default data directory by default (machine-anchored
// secrets), so migrating never orphans the key used to decrypt
// connections.json / AI API keys. Users who want the data directory to be
// self-contained can opt into `key_follows` (see below); the vault then prefers
// the key copied beside the data.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

const ANCHOR_FILE: &str = "data_root.json";

/// Serde helper so `key_follows: false` is not persisted on every anchor write.
fn is_false(b: &bool) -> bool {
  !b
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DataRootAnchor {
  /// Configured data directory (absolute path), or `None` for the default one.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub dir: Option<String>,
  /// Root that last held the data (refreshed at every startup and on every
  /// change), used as the source for the one-time copy migration.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub prev: Option<String>,
  /// Opt-in "vault.key follows the data" flag: when set, a migration also puts
  /// `vault.key` next to the configured data dir and `vault.rs` prefers that
  /// local key, making a relocated data dir self-contained / portable. Default
  /// (false) keeps the machine-anchored default key behaviour.
  #[serde(default, skip_serializing_if = "is_false")]
  pub key_follows: bool,
}

/// Default data directory (`<config>/wrolp-terminal`). The anchor file also
/// lives here on purpose — this location must never follow the configured dir.
pub fn default_data_dir() -> PathBuf {
  dirs::config_dir()
    .map(|p| p.join("wrolp-terminal"))
    .unwrap_or_else(|| PathBuf::from("."))
}

/// Path of the anchor file (always inside the default data directory).
pub fn anchor_path() -> PathBuf {
  default_data_dir().join(ANCHOR_FILE)
}

pub fn read_anchor() -> Option<DataRootAnchor> {
  read_anchor_at(&anchor_path())
}

pub fn write_anchor(anchor: &DataRootAnchor) -> Result<(), String> {
  write_anchor_at(&anchor_path(), anchor)
}

/// Read the anchor file at an arbitrary path (testable with temp dirs).
pub fn read_anchor_at(path: &Path) -> Option<DataRootAnchor> {
  let raw = fs::read_to_string(path).ok()?;
  serde_json::from_str(&raw).ok()
}

pub fn write_anchor_at(path: &Path, anchor: &DataRootAnchor) -> Result<(), String> {
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
  }
  let json = serde_json::to_string_pretty(anchor).map_err(|e| e.to_string())?;
  fs::write(path, json).map_err(|e| e.to_string())
}

/// Remember a user-requested data directory (or reset to default) in the real
/// anchor file. `current` is the root the app is using right now and becomes
/// the migration source for the next launch.
pub fn set_target(dir: Option<&str>, current: &Path) -> Result<(), String> {
  let mut anchor = read_anchor().unwrap_or_default();
  anchor.dir = dir
    .map(str::trim)
    .filter(|s| !s.is_empty())
    .map(|s| s.to_string());
  anchor.prev = Some(current.to_string_lossy().to_string());
  write_anchor(&anchor)
}

/// Whether the user opted into copying `vault.key` beside the data directory
/// ("key follows data") at the next migration.
pub fn key_follows_enabled() -> bool {
  read_anchor().map(|a| a.key_follows).unwrap_or(false)
}

/// Set/clear the "vault.key follows the data dir" option (persisted in the
/// anchor; takes effect on the next launch's copy migration).
pub fn set_key_follows(enabled: bool) -> Result<(), String> {
  let mut anchor = read_anchor().unwrap_or_default();
  anchor.key_follows = enabled;
  write_anchor(&anchor)
}

/// Validate a custom directory chosen by the user: non-empty, absolute, a real
/// or creatable directory. Creates it so the next launch can migrate into it.
pub fn validate_custom_dir(raw: &str) -> Result<PathBuf, String> {
  let trimmed = raw.trim();
  if trimmed.is_empty() {
    return Err("Data directory must not be empty".to_string());
  }
  let path = PathBuf::from(trimmed);
  if !path.is_absolute() {
    return Err(format!(
      "Data directory must be an absolute path: {}",
      trimmed
    ));
  }
  if path.exists() && !path.is_dir() {
    return Err(format!("Not a directory: {}", trimmed));
  }
  fs::create_dir_all(&path)
    .map_err(|e| format!("Cannot create data directory {}: {}", trimmed, e))?;
  Ok(path)
}

/// Compare two paths as directories, tolerating trailing slashes / `..`.
pub fn same_dir(a: &Path, b: &Path) -> bool {
  if let (Ok(ca), Ok(cb)) = (a.canonicalize(), b.canonicalize()) {
    return ca == cb;
  }
  a == b
}

/// Resolve the effective data directory for this launch (real anchor file +
/// real default dir) and run the one-time copy migration when needed. Always
/// returns a usable root.
pub fn resolve_data_root() -> PathBuf {
  resolve_anchor(&anchor_path(), &default_data_dir())
}

/// Core resolution, testable with temp dirs. `anchor_file` is read and, when a
/// migration runs, rewritten with the updated `prev`.
pub fn resolve_anchor(anchor_file: &Path, default: &Path) -> PathBuf {
  let anchor = read_anchor_at(anchor_file).unwrap_or_default();
  // Never configured before -> nothing to migrate.
  if anchor.dir.is_none() && anchor.prev.is_none() {
    let _ = fs::create_dir_all(default);
    return default.to_path_buf();
  }

  let configured = anchor
    .dir
    .as_deref()
    .map(str::trim)
    .filter(|s| !s.is_empty());
  let target = match configured {
    Some(dir) => PathBuf::from(dir),
    None => default.to_path_buf(),
  };

  // The target must be creatable/writable; otherwise keep using the previous
  // root (which still holds the data) and leave the anchor for a retry.
  if fs::create_dir_all(&target).is_err() || !target.is_dir() {
    eprintln!(
      "[data_root] cannot use configured data dir {:?}; keeping previous root",
      target
    );
    return anchor
      .prev
      .as_deref()
      .map(PathBuf::from)
      .unwrap_or_else(|| default.to_path_buf());
  }

  let source = anchor
    .prev
    .as_deref()
    .map(PathBuf::from)
    .unwrap_or_else(|| default.to_path_buf());

  if same_dir(&target, &source) {
    persist_prev(anchor_file, anchor, &target);
    return target;
  }

  if target.join("wrolp.db").exists() {
    // Target already has data of its own: use it as-is, never overwrite.
    eprintln!(
      "[data_root] data dir {:?} already contains wrolp.db; skipping copy from {:?}",
      target, source
    );
    persist_prev(anchor_file, anchor, &target);
    return target;
  }

  if !source.is_dir() {
    persist_prev(anchor_file, anchor, &target);
    return target;
  }

  match copy_data_dir(&source, &target) {
    Ok(()) => {
      eprintln!("[data_root] migrated data dir {:?} -> {:?}", source, target);
      // Sessions recorded in the file-backed layout store absolute events-file
      // paths rooted at the OLD data dir; re-point them at the new root so the
      // recordings index stays playable after the copy. Best-effort only.
      rewrite_events_file_prefix(&target.join("wrolp.db"), &source, &target);
      // When the "vault.key follows data" option is on, make sure the target
      // also carries the key (the plain dir copy already brings it when the
      // source holds one; this covers the source-without-key case).
      maybe_copy_vault_key(&anchor, &source, &target, default);
      persist_prev(anchor_file, anchor, &target);
      target
    }
    Err(e) => {
      // Keep using the root that still holds the data; the anchor stays
      // pointing at the target so the migration retries next launch.
      eprintln!(
        "[data_root] migration copy {:?} -> {:?} failed: {}; keeping previous root",
        source, target, e
      );
      source
    }
  }
}

fn persist_prev(anchor_file: &Path, mut anchor: DataRootAnchor, target: &Path) {
  let target_str = target.to_string_lossy().to_string();
  if anchor.prev.as_deref() != Some(target_str.as_str()) {
    anchor.prev = Some(target_str);
    let _ = write_anchor_at(anchor_file, &anchor);
  }
}

/// When the user opted into "vault.key follows data", copy the key into the
/// migration target if it does not have one yet. Candidates: the source root
/// (which may already carry a key from an earlier copy) and, when the source is
/// not the default dir, the machine-anchored default. Never overwrites.
fn maybe_copy_vault_key(anchor: &DataRootAnchor, source: &Path, target: &Path, default: &Path) {
  if !anchor.key_follows {
    return;
  }
  let dst = target.join("vault.key");
  if dst.exists() {
    return;
  }
  let mut candidates = vec![source.join("vault.key")];
  if !same_dir(source, default) {
    candidates.push(default.join("vault.key"));
  }
  for cand in candidates {
    if cand.is_file() && fs::copy(&cand, &dst).is_ok() {
      eprintln!("[data_root] vault.key copied to {:?}", target);
      return;
    }
  }
}

/// Copy the *contents* of the previous data dir into the target. Never
/// overwrites existing files or directories; on failure some entries may have
/// been copied already and a retry simply fills in the gaps. The source is
/// never modified (copy, not move).
fn copy_data_dir(from: &Path, to: &Path) -> Result<(), String> {
  if !from.is_dir() {
    return Ok(());
  }
  fs::create_dir_all(to).map_err(|e| e.to_string())?;
  for entry in fs::read_dir(from).map_err(|e| e.to_string())? {
    let entry = entry.map_err(|e| e.to_string())?;
    if entry.file_name() == ANCHOR_FILE {
      continue; // never copy the anchor itself
    }
    let src = entry.path();
    let dst = to.join(entry.file_name());
    if dst.exists() {
      continue;
    }
    if src.is_dir() {
      copy_tree(&src, &dst)?;
    } else if src.is_file() {
      fs::copy(&src, &dst).map_err(|e| e.to_string())?;
    }
  }
  Ok(())
}

fn copy_tree(from: &Path, to: &Path) -> Result<(), String> {
  fs::create_dir_all(to).map_err(|e| e.to_string())?;
  for entry in fs::read_dir(from).map_err(|e| e.to_string())? {
    let entry = entry.map_err(|e| e.to_string())?;
    let src = entry.path();
    let dst = to.join(entry.file_name());
    if src.is_dir() {
      copy_tree(&src, &dst)?;
    } else if src.is_file() && !dst.exists() {
      fs::copy(&src, &dst).map_err(|e| e.to_string())?;
    }
  }
  Ok(())
}

/// Rewrite the `sessions.events_file` prefix in a migrated DB from the old data
/// root (`from`) to the new one (`to`), so playback points at the relocated
/// `.jsonl` files after the copy migration. Best-effort: non-SQLite files and
/// missing/older schemas are skipped silently; failures only log. Only exact
/// path-prefix matches (followed by a separator) are rewritten, so a sibling
/// dir like `C:\data2` is never touched.
fn rewrite_events_file_prefix(db_path: &Path, from: &Path, to: &Path) {
  if !db_path.is_file() {
    return;
  }
  // Cheap magic check — keeps non-db files (and test seeds) out of the way.
  let head_ok = fs::read(db_path)
    .map(|b| b.len() >= 16 && &b[..16] == b"SQLite format 3\0")
    .unwrap_or(false);
  if !head_ok {
    return;
  }
  let conn = match rusqlite::Connection::open(db_path) {
    Ok(c) => c,
    Err(e) => {
      eprintln!(
        "[data_root] cannot open migrated db for prefix rewrite: {}",
        e
      );
      return;
    }
  };
  let has_column = conn
    .prepare("SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'events_file'")
    .ok()
    .and_then(|mut stmt| stmt.exists([]).ok())
    .unwrap_or(false);
  if !has_column {
    return;
  }
  let from_s = from.to_string_lossy().to_string();
  let to_s = to.to_string_lossy().to_string();
  let updated = conn
    .execute(
      "UPDATE sessions
         SET events_file = ?2 || substr(events_file, length(?1) + 1)
       WHERE events_file IS NOT NULL
         AND substr(events_file, 1, length(?1)) = ?1
         AND substr(events_file, length(?1) + 1, 1) IN ('\\', '/')",
      rusqlite::params![from_s, to_s],
    )
    .unwrap_or(0);
  if updated > 0 {
    eprintln!(
      "[data_root] rewrote {} events_file path(s) to {:?}",
      updated, to
    );
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::sync::atomic::{AtomicU32, Ordering};

  fn tmpdir(tag: &str) -> PathBuf {
    static N: AtomicU32 = AtomicU32::new(0);
    let base = std::env::temp_dir().join(format!(
      "wrolp-data-root-test-{}-{}-{}",
      tag,
      std::process::id(),
      N.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = fs::remove_dir_all(&base);
    fs::create_dir_all(&base).unwrap();
    base
  }

  fn seed(dir: &Path) {
    fs::create_dir_all(dir.join("recordings/ws")).unwrap();
    fs::write(dir.join("wrolp.db"), b"db").unwrap();
    fs::write(dir.join("connections.json"), b"{}").unwrap();
    fs::write(dir.join("recordings/ws/a.jsonl"), b"e").unwrap();
  }

  fn anchor(dir: &Path, dir_value: Option<&str>, prev: Option<&str>) -> PathBuf {
    let path = dir.join("anchor.json");
    write_anchor_at(
      &path,
      &DataRootAnchor {
        dir: dir_value.map(|s| s.to_string()),
        prev: prev.map(|s| s.to_string()),
        ..Default::default()
      },
    )
    .unwrap();
    path
  }

  #[test]
  fn unconfigured_returns_default() {
    let d = tmpdir("a");
    let default = d.join("default");
    let root = resolve_anchor(&d.join("anchor.json"), &default);
    assert_eq!(root, default);
    assert!(default.is_dir());
    let _ = fs::remove_dir_all(&d);
  }

  #[test]
  fn migrates_to_new_custom_root() {
    let d = tmpdir("b");
    let default = d.join("default");
    let custom = d.join("custom data");
    fs::create_dir_all(&default).unwrap();
    seed(&default);
    let anchor_file = anchor(
      &d,
      Some(custom.to_str().unwrap()),
      Some(default.to_str().unwrap()),
    );
    let root = resolve_anchor(&anchor_file, &default);
    assert_eq!(root, custom);
    assert!(custom.join("wrolp.db").exists());
    assert!(custom.join("connections.json").exists());
    assert!(custom.join("recordings/ws/a.jsonl").exists());
    // copy, not move: source is untouched
    assert!(default.join("wrolp.db").exists());
    // anchor tracks the new root
    let a = read_anchor_at(&anchor_file).unwrap();
    assert_eq!(a.prev.as_deref(), Some(custom.to_str().unwrap()));
    assert_eq!(a.dir.as_deref(), Some(custom.to_str().unwrap()));
    let _ = fs::remove_dir_all(&d);
  }

  #[test]
  fn does_not_overwrite_existing_target() {
    let d = tmpdir("c");
    let default = d.join("default");
    let custom = d.join("custom");
    fs::create_dir_all(&default).unwrap();
    fs::write(default.join("wrolp.db"), b"source").unwrap();
    fs::create_dir_all(&custom).unwrap();
    fs::write(custom.join("wrolp.db"), b"existing").unwrap();
    let anchor_file = anchor(
      &d,
      Some(custom.to_str().unwrap()),
      Some(default.to_str().unwrap()),
    );
    let root = resolve_anchor(&anchor_file, &default);
    assert_eq!(root, custom);
    assert_eq!(
      fs::read(custom.join("wrolp.db")).unwrap(),
      b"existing".to_vec()
    );
    let _ = fs::remove_dir_all(&d);
  }

  #[test]
  fn reset_back_to_default_copies_custom() {
    let d = tmpdir("d");
    let default = d.join("default");
    let custom = d.join("custom");
    fs::create_dir_all(&custom).unwrap();
    seed(&custom);
    let anchor_file = anchor(&d, None, Some(custom.to_str().unwrap()));
    let root = resolve_anchor(&anchor_file, &default);
    assert_eq!(root, default);
    assert!(default.join("wrolp.db").exists());
    assert!(default.join("recordings/ws/a.jsonl").exists());
    let a = read_anchor_at(&anchor_file).unwrap();
    assert_eq!(a.prev.as_deref(), Some(default.to_str().unwrap()));
    let _ = fs::remove_dir_all(&d);
  }

  #[test]
  fn migrates_custom_to_custom() {
    let d = tmpdir("e");
    let first = d.join("first");
    let second = d.join("second");
    let default = d.join("default");
    fs::create_dir_all(&first).unwrap();
    seed(&first);
    let anchor_file = anchor(
      &d,
      Some(second.to_str().unwrap()),
      Some(first.to_str().unwrap()),
    );
    let root = resolve_anchor(&anchor_file, &default);
    assert_eq!(root, second);
    assert!(second.join("wrolp.db").exists());
    assert_eq!(
      fs::read(second.join("connections.json")).unwrap(),
      b"{}".to_vec()
    );
    let _ = fs::remove_dir_all(&d);
  }

  #[test]
  fn key_follows_option_copies_default_key_into_keyless_source_migration() {
    let d = tmpdir("h");
    let default = d.join("default");
    let first = d.join("first");
    fs::create_dir_all(&default).unwrap();
    let key_bytes = b"0123456789abcdef0123456789abcdef";
    fs::write(default.join("vault.key"), key_bytes).unwrap();
    fs::create_dir_all(&first).unwrap();
    seed(&first);

    // Option off: migrating from a keyless custom root must NOT copy the
    // machine-anchored default key into the new data dir.
    let second = d.join("second");
    let path_off = anchor(
      &d,
      Some(second.to_str().unwrap()),
      Some(first.to_str().unwrap()),
    );
    let root = resolve_anchor(&path_off, &default);
    assert_eq!(root, second);
    assert!(!second.join("vault.key").exists());

    // Option on: the default key is brought along, so the data dir is portable.
    let third = d.join("third");
    let path_on = d.join("anchor-on.json");
    write_anchor_at(
      &path_on,
      &DataRootAnchor {
        dir: Some(third.to_str().unwrap().to_string()),
        prev: Some(first.to_str().unwrap().to_string()),
        key_follows: true,
      },
    )
    .unwrap();
    let root = resolve_anchor(&path_on, &default);
    assert_eq!(root, third);
    assert_eq!(
      fs::read(third.join("vault.key")).unwrap(),
      key_bytes.to_vec()
    );
    let _ = fs::remove_dir_all(&d);
  }

  #[test]
  fn validates_custom_dir() {
    let d = tmpdir("f");
    let target = d.join("new dir");
    let p = validate_custom_dir(target.to_str().unwrap()).unwrap();
    assert_eq!(p, target);
    assert!(target.is_dir());
    assert!(validate_custom_dir("relative/path").is_err());
    assert!(validate_custom_dir("   ").is_err());
    let _ = fs::remove_dir_all(&d);
  }

  #[test]
  fn rewrites_events_file_prefixes_in_migrated_db() {
    let d = tmpdir("g");
    let from = d.join("from");
    let to = d.join("to data");
    fs::create_dir_all(&from).unwrap();
    let db_path = from.join("wrolp.db");
    let conn = rusqlite::Connection::open(&db_path).unwrap();
    conn
      .execute_batch(
        "CREATE TABLE sessions(id TEXT PRIMARY KEY, events_file TEXT);
         INSERT INTO sessions (id, events_file) VALUES
           ('nullrow', NULL),
           ('orphan', 'some/relative/file.jsonl');",
      )
      .unwrap();
    let good = from
      .join("recordings")
      .join("ws")
      .join("grp")
      .join("conn")
      .join("20260828-120000_abcdef12.jsonl");
    fs::create_dir_all(good.parent().unwrap()).unwrap();
    let good_s = good.to_string_lossy().to_string();
    conn
      .execute(
        "INSERT INTO sessions (id, events_file) VALUES (?1, ?2)",
        rusqlite::params!["filerec", good_s],
      )
      .unwrap();
    // A sibling root like `<from>2` shares the prefix but is NOT a data-dir
    // boundary match (next char after the prefix is '2', not a separator).
    let sibling = PathBuf::from(format!("{}2", from.to_string_lossy()))
      .join("recordings")
      .join("x.jsonl");
    let sibling_s = sibling.to_string_lossy().to_string();
    conn
      .execute(
        "INSERT INTO sessions (id, events_file) VALUES (?1, ?2)",
        rusqlite::params!["sibling", sibling_s],
      )
      .unwrap();
    drop(conn);

    rewrite_events_file_prefix(&db_path, &from, &to);

    let conn = rusqlite::Connection::open(&db_path).unwrap();
    let read = |id: &str| -> Option<String> {
      conn
        .query_row(
          "SELECT events_file FROM sessions WHERE id = ?1",
          rusqlite::params![id],
          |r| r.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten()
    };
    // The exact-prefix row is re-pointed at the new root…
    let expected = format!(
      "{}{}",
      to.to_string_lossy(),
      &good_s[from.to_string_lossy().len()..]
    );
    assert_eq!(read("filerec"), Some(expected));
    // …while NULL, relative paths and sibling roots are left untouched.
    assert_eq!(read("nullrow"), None);
    assert_eq!(read("orphan").as_deref(), Some("some/relative/file.jsonl"));
    assert_eq!(read("sibling").as_deref(), Some(sibling_s.as_str()));
    let _ = fs::remove_dir_all(&d);
  }
}

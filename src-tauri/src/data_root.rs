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
// vault.key deliberately stays in the default data directory (machine-anchored
// secrets), so migrating never orphans the key used to decrypt
// connections.json / AI API keys.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

const ANCHOR_FILE: &str = "data_root.json";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DataRootAnchor {
  /// Configured data directory (absolute path), or `None` for the default one.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub dir: Option<String>,
  /// Root that last held the data (refreshed at every startup and on every
  /// change), used as the source for the one-time copy migration.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub prev: Option<String>,
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
}

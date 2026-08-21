//! Local filesystem implementation of [`RemoteFs`], so the file panel can
//! browse the user's own machine when the focused tab is a local shell.

use std::path::{Path, PathBuf};

use crate::remote_fs::RemoteFs;
use crate::ssh_session::{FileEntry, FileMeta};

/// File system access for the user's local machine.
pub struct LocalFs {
  root: PathBuf,
}

impl LocalFs {
  pub fn new() -> Self {
    Self {
      // An empty path (e.g. a local terminal entry without a configured
      // directory) resolves to the user's home directory.
      root: dirs::home_dir().unwrap_or_else(|| {
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
      }),
    }
  }

  /// Resolve a logical path ("/", "/foo/bar", or "C:/foo") to a local absolute
  /// path. On Windows a bare "/" has no drive letter — map it to the current
  /// drive's root (e.g. "C:\") so listing the root works.
  fn resolve(&self, path: &str) -> PathBuf {
    if path.is_empty() {
      return self.root.clone();
    }
    let p = Path::new(path);
    #[cfg(windows)]
    {
      if p.to_string_lossy() == "/" {
        let drive = std::env::current_dir()
          .ok()
          .and_then(|c| {
            c.components()
              .next()
              .map(|c| c.as_os_str().to_string_lossy().to_string())
          })
          .unwrap_or_else(|| "C:".to_string());
        return PathBuf::from(format!("{}\\", drive));
      }
    }
    if p.is_absolute() {
      p.to_path_buf()
    } else {
      self.root.join(p)
    }
  }
}

/// Format a `std::io::Result<SystemTime>` as unix-seconds string (as SFTP does).
fn fmt_mtime(t: std::io::Result<std::time::SystemTime>) -> String {
  t.ok()
    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
    .map(|d| d.as_secs().to_string())
    .unwrap_or_default()
}

/// Approximate a `rwxr-xr-x`-style mode string from permissions.
fn fmt_mode(meta: &std::fs::Metadata) -> String {
  #[cfg(unix)]
  {
    use std::os::unix::fs::PermissionsExt;
    let m = meta.permissions().mode();
    let mut s = String::new();
    s.push(if meta.is_dir() { 'd' } else { '-' });
    for i in (0..3).rev() {
      let shift = i * 3;
      s.push(if m & (0o400 >> shift) != 0 { 'r' } else { '-' });
      s.push(if m & (0o200 >> shift) != 0 { 'w' } else { '-' });
      s.push(if m & (0o100 >> shift) != 0 { 'x' } else { '-' });
    }
    s
  }
  #[cfg(not(unix))]
  {
    if meta.is_dir() {
      "d---------".to_string()
    } else {
      "-rw-rw-rw-".to_string()
    }
  }
}

fn to_entry(path: PathBuf, meta: &std::fs::Metadata) -> FileEntry {
  let name = path
    .file_name()
    .map(|s| s.to_string_lossy().to_string())
    .unwrap_or_else(|| path.to_string_lossy().to_string());
  FileEntry {
    name,
    path: normalize(path.to_string_lossy().as_ref()),
    is_dir: meta.is_dir(),
    size: meta.len(),
    mode: fmt_mode(meta),
    modified: fmt_mtime(meta.modified()),
  }
}

/// Normalize a local path to a forward-slash logical path for the UI.
fn normalize(p: &str) -> String {
  #[cfg(windows)]
  {
    p.replace('\\', "/")
  }
  #[cfg(not(windows))]
  {
    p.to_string()
  }
}

#[async_trait::async_trait]
impl RemoteFs for LocalFs {
  async fn list_dir(&self, path: &str) -> Result<Vec<FileEntry>, String> {
    let resolved = self.resolve(path);
    let rd = std::fs::read_dir(&resolved)
      .map_err(|e| format!("read_dir {}: {}", resolved.display(), e))?;
    let mut out = Vec::new();
    for ent in rd.flatten() {
      let p = ent.path();
      let meta = match p.symlink_metadata() {
        Ok(m) => m,
        Err(_) => continue,
      };
      out.push(to_entry(p, &meta));
    }
    out.sort_by(|a, b| {
      b.is_dir
        .cmp(&a.is_dir)
        .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
  }

  async fn metadata(&self, path: &str) -> Result<FileMeta, String> {
    let resolved = self.resolve(path);
    let meta = std::fs::metadata(&resolved)
      .map_err(|e| format!("metadata {}: {}", resolved.display(), e))?;
    Ok(FileMeta {
      path: normalize(resolved.to_string_lossy().as_ref()),
      is_dir: meta.is_dir(),
      size: meta.len(),
      mode: fmt_mode(&meta),
      modified: fmt_mtime(meta.modified()),
    })
  }

  async fn read_file(&self, path: &str) -> Result<Vec<u8>, String> {
    let resolved = self.resolve(path);
    std::fs::read(&resolved).map_err(|e| format!("read {}: {}", resolved.display(), e))
  }

  async fn write_file(&self, path: &str, data: &[u8]) -> Result<(), String> {
    let resolved = self.resolve(path);
    if let Some(parent) = resolved.parent() {
      std::fs::create_dir_all(parent).ok();
    }
    std::fs::write(&resolved, data).map_err(|e| format!("write {}: {}", resolved.display(), e))
  }

  async fn create_dir(&self, path: &str) -> Result<(), String> {
    let resolved = self.resolve(path);
    std::fs::create_dir_all(&resolved).map_err(|e| format!("mkdir {}: {}", resolved.display(), e))
  }

  async fn rename(&self, from: &str, to: &str) -> Result<(), String> {
    let a = self.resolve(from);
    let b = self.resolve(to);
    std::fs::rename(&a, &b).map_err(|e| format!("rename {} → {}: {}", a.display(), b.display(), e))
  }

  async fn remove_file(&self, path: &str) -> Result<(), String> {
    let resolved = self.resolve(path);
    std::fs::remove_file(&resolved).map_err(|e| format!("rm {}: {}", resolved.display(), e))
  }

  async fn remove_dir(&self, path: &str) -> Result<(), String> {
    let resolved = self.resolve(path);
    std::fs::remove_dir_all(&resolved).map_err(|e| format!("rmdir {}: {}", resolved.display(), e))
  }
}

impl Default for LocalFs {
  fn default() -> Self {
    Self::new()
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[tokio::test]
  async fn list_current_dir() {
    let fs = LocalFs::new();
    let cwd = std::env::current_dir().unwrap();
    let path = cwd.to_string_lossy().replace('\\', "/");
    let entries = fs.list_dir(&path).await.unwrap();
    assert!(!entries.is_empty(), "expected entries in {path}");
    assert!(
      entries.iter().any(|e| e.is_dir),
      "expected at least one dir"
    );
    eprintln!("local_fs list_dir OK: {} entries", entries.len());
  }

  #[test]
  fn resolve_absolute() {
    let fs = LocalFs::new();
    let cwd = std::env::current_dir().unwrap();
    let p = cwd.to_string_lossy().replace('\\', "/");
    assert_eq!(fs.resolve(&p), PathBuf::from(&p));
  }
}

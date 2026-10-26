//! A `RemoteFs` implementation whose operations are performed by shelling out
//! to a command runner that executes POSIX commands on a remote/inner system.
//!
//! Two runners use it today:
//! - Docker containers, via `docker exec` on the jump host ([`crate::docker_fs`]).
//! - WSL distributions, via a local `wsl.exe` ([`crate::wsl_fs`]).
//!
//! Paths are always passed as positional arguments to a `sh -c` script (never
//! interpolated into the script text) to avoid shell-injection issues.

use crate::remote_fs::RemoteFs;
use crate::ssh_session::{FileEntry, FileMeta};

/// Executes a command on the inner system and captures its output.
#[async_trait::async_trait]
pub(crate) trait Runner: Send + Sync {
  /// Run `inner` (argv, already split) on the inner system. Each element is
  /// passed through unchanged; the runner is responsible for any outer quoting.
  async fn run(
    &self,
    inner: &[String],
    stdin: Option<&[u8]>,
  ) -> Result<(Vec<u8>, Vec<u8>, u32), String>;
}

/// A generic [`RemoteFs`] backed by a [`Runner`].
pub(crate) struct CmdFs<R: Runner> {
  runner: R,
  /// When true, a "." path also resolves to the inner home directory (the file
  /// panel's "Home" button loads "."). Docker keeps "." meaning the container's
  /// working directory, so this is opt-in.
  dot_is_home: bool,
}

impl<R: Runner> CmdFs<R> {
  pub(crate) fn new(runner: R, dot_is_home: bool) -> Self {
    Self {
      runner,
      dot_is_home,
    }
  }

  /// Resolve the inner system's home directory (used when the caller passes an
  /// empty path — the frontend uses "" to mean "the user's home").
  async fn resolve_home(&self) -> Result<String, String> {
    let inner = vec![
      "sh".to_string(),
      "-c".to_string(),
      "printf %s \"$HOME\"".to_string(),
    ];
    let (out, err, status) = self.runner.run(&inner, None).await?;
    if status != 0 {
      return Err(format!(
        "Failed to resolve home directory: {}",
        String::from_utf8_lossy(&err).trim()
      ));
    }
    let home = String::from_utf8_lossy(&out).trim().to_string();
    if home.is_empty() {
      return Err("Home directory is empty".into());
    }
    Ok(home)
  }

  /// Rewrite a leading `~` to the inner system's home directory.
  ///
  /// Neither runner may leave that to a shell: `wsl.exe -e` and `docker exec` run
  /// without a login shell, and a path always arrives here as a *quoted*
  /// positional argument, where POSIX shells expand no tildes either. Left as it
  /// is, `~/projects` names a literal directory called `~` — which never exists,
  /// so a `cd ~` + `ls` in a WSL tab listed nothing and every entry lost its
  /// directory type. Costs one extra `$HOME` lookup, and only for a tilde path.
  async fn expand_tilde(&self, path: &str) -> Result<String, String> {
    if path == "~" {
      return self.resolve_home().await;
    }
    if let Some(rest) = path.strip_prefix("~/") {
      return Ok(format!("{}/{}", self.resolve_home().await?, rest));
    }
    Ok(path.to_string())
  }
}

/// Directory-listing script executed on the inner system. Entries are emitted
/// one per line, fields separated by the ASCII unit separator \037 (octal for
/// 0x1f, POSIX-compatible — unlike \x1f which is bash-specific).
const LIST_SCRIPT: &str = r#"cd "${1:-$HOME}" || exit 1
for n in * .[!.]* ..?*; do
  [ -e "$n" ] || [ -L "$n" ] || continue
  if [ -d "$n" ]; then t=d; else t=f; fi
  [ -L "$n" ] && t=l
  if s=$(stat -c%s "$n" 2>/dev/null) && m=$(stat -c%Y "$n" 2>/dev/null); then
    o=$(stat -c%A "$n" 2>/dev/null || echo "?")
  else
    r=$(ls -ld "$n" 2>/dev/null) || continue
    set -- $r
    o="$1"; s="$5"; m="0"
  fi
  printf '%s\037%s\037%s\037%s\037%s\n' "$t" "$s" "$m" "$o" "$n"
done"#;

/// Parse the `LIST_SCRIPT` output into [`FileEntry`] values, resolving each
/// entry's full path against `path`.
pub(crate) fn parse_listing(path: &str, out: &[u8]) -> Vec<FileEntry> {
  let text = String::from_utf8_lossy(out);
  let mut files = Vec::new();
  for line in text.lines() {
    if line.is_empty() {
      continue;
    }
    let mut parts = line.splitn(5, '\x1f');
    let t = parts.next().unwrap_or("");
    let size = parts.next().unwrap_or("0").trim().parse().unwrap_or(0);
    let modified = parts.next().unwrap_or("").trim().to_string();
    let mode = parts.next().unwrap_or("").to_string();
    let name = parts.next().unwrap_or("").to_string();
    if name.is_empty() {
      continue;
    }
    let full_path = if path.ends_with('/') {
      format!("{}{}", path, name)
    } else {
      format!("{}/{}", path, name)
    };
    files.push(FileEntry {
      name,
      path: full_path,
      is_dir: t == "d",
      size,
      mode,
      modified,
    });
  }
  sort_entries(&mut files);
  files
}

/// Sort entries directories-first, then case-insensitively by name.
pub(crate) fn sort_entries(files: &mut [FileEntry]) {
  files.sort_by(|a, b| {
    b.is_dir
      .cmp(&a.is_dir)
      .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
  });
}

/// Parse `stat -c "%s %Y %A %F"` output.
pub(crate) fn parse_stat(path: &str, out: &[u8]) -> FileMeta {
  let text = String::from_utf8_lossy(out);
  let text = text.trim();
  let mut it = text.splitn(4, ' ');
  let size = it.next().unwrap_or("0").trim().parse().unwrap_or(0);
  let modified = it.next().unwrap_or("").trim().to_string();
  let mode = it.next().unwrap_or("").to_string();
  let ftype = it.next().unwrap_or("").to_string();
  FileMeta {
    path: path.to_string(),
    is_dir: ftype.contains("directory"),
    size,
    mode,
    modified,
  }
}

#[async_trait::async_trait]
impl<R: Runner> RemoteFs for CmdFs<R> {
  async fn list_dir(&self, path: &str) -> Result<Vec<FileEntry>, String> {
    // An empty path (or, for WSL, ".") means "the user's home directory" —
    // resolve it up front so the returned entry paths are absolute.
    let path = if path.is_empty() || (self.dot_is_home && path == ".") {
      self.resolve_home().await?
    } else {
      self.expand_tilde(path).await?
    };
    let inner = vec![
      "sh".to_string(),
      "-c".to_string(),
      LIST_SCRIPT.to_string(),
      "_".to_string(),
      path.clone(),
    ];
    let (out, err, status) = self.runner.run(&inner, None).await?;
    if status != 0 {
      return Err(format!(
        "Failed to list directory: {}",
        String::from_utf8_lossy(&err).trim()
      ));
    }
    Ok(parse_listing(&path, &out))
  }

  async fn metadata(&self, path: &str) -> Result<FileMeta, String> {
    let path = self.expand_tilde(path).await?;
    // %s=size %Y=mtime(epoch) %A=perms(symbolic) %F=file type
    let inner = vec![
      "stat".to_string(),
      "-c".to_string(),
      "%s %Y %A %F".to_string(),
      "--".to_string(),
      path.to_string(),
    ];
    let (out, err, status) = self.runner.run(&inner, None).await?;
    if status != 0 {
      return Err(format!(
        "stat failed: {}",
        String::from_utf8_lossy(&err).trim()
      ));
    }
    Ok(parse_stat(&path, &out))
  }

  async fn read_file(&self, path: &str) -> Result<Vec<u8>, String> {
    let path = self.expand_tilde(path).await?;
    let inner = vec!["cat".to_string(), "--".to_string(), path];
    let (out, err, status) = self.runner.run(&inner, None).await?;
    if status != 0 {
      return Err(format!(
        "Failed to read file: {}",
        String::from_utf8_lossy(&err).trim()
      ));
    }
    Ok(out)
  }

  async fn write_file(&self, path: &str, data: &[u8]) -> Result<(), String> {
    let inner = vec![
      "sh".to_string(),
      "-c".to_string(),
      "mkdir -p -- \"$(dirname -- \"$1\")\" && cat > \"$1\"".to_string(),
      "_".to_string(),
      self.expand_tilde(path).await?,
    ];
    let (_out, err, status) = self.runner.run(&inner, Some(data)).await?;
    if status != 0 {
      return Err(format!(
        "Failed to write file: {}",
        String::from_utf8_lossy(&err).trim()
      ));
    }
    Ok(())
  }

  async fn create_dir(&self, path: &str) -> Result<(), String> {
    let inner = vec![
      "mkdir".to_string(),
      "-p".to_string(),
      "--".to_string(),
      self.expand_tilde(path).await?,
    ];
    let (_o, err, status) = self.runner.run(&inner, None).await?;
    if status != 0 {
      return Err(format!(
        "Failed to create directory: {}",
        String::from_utf8_lossy(&err).trim()
      ));
    }
    Ok(())
  }

  async fn rename(&self, from: &str, to: &str) -> Result<(), String> {
    let inner = vec![
      "mv".to_string(),
      "-T".to_string(),
      "--".to_string(),
      self.expand_tilde(from).await?,
      self.expand_tilde(to).await?,
    ];
    let (_o, err, status) = self.runner.run(&inner, None).await?;
    if status != 0 {
      return Err(format!(
        "Failed to rename: {}",
        String::from_utf8_lossy(&err).trim()
      ));
    }
    Ok(())
  }

  async fn remove_file(&self, path: &str) -> Result<(), String> {
    let inner = vec![
      "rm".to_string(),
      "-f".to_string(),
      "--".to_string(),
      self.expand_tilde(path).await?,
    ];
    let (_o, err, status) = self.runner.run(&inner, None).await?;
    if status != 0 {
      return Err(format!(
        "Failed to delete file: {}",
        String::from_utf8_lossy(&err).trim()
      ));
    }
    Ok(())
  }

  async fn remove_dir(&self, path: &str) -> Result<(), String> {
    let inner = vec![
      "rm".to_string(),
      "-rf".to_string(),
      "--".to_string(),
      self.expand_tilde(path).await?,
    ];
    let (_o, err, status) = self.runner.run(&inner, None).await?;
    if status != 0 {
      return Err(format!(
        "Failed to delete directory: {}",
        String::from_utf8_lossy(&err).trim()
      ));
    }
    Ok(())
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::sync::Mutex;

  /// Answers a `$HOME` lookup with `home` and any listing with one directory,
  /// while recording every argv it was asked to run.
  struct FakeRunner {
    home: &'static str,
    runs: Mutex<Vec<Vec<String>>>,
  }

  #[async_trait::async_trait]
  impl Runner for FakeRunner {
    async fn run(
      &self,
      inner: &[String],
      _stdin: Option<&[u8]>,
    ) -> Result<(Vec<u8>, Vec<u8>, u32), String> {
      self.runs.lock().unwrap().push(inner.to_vec());
      if inner.len() == 3 && inner[2].starts_with("printf %s") {
        return Ok((self.home.as_bytes().to_vec(), Vec::new(), 0));
      }
      let listing = b"-\x1f12\x1f1700000000\x1f-rw-r--r--\x1fnotes\n";
      Ok((listing.to_vec(), Vec::new(), 0))
    }
  }

  fn fake(home: &'static str) -> CmdFs<FakeRunner> {
    CmdFs::new(
      FakeRunner {
        home,
        runs: Mutex::new(Vec::new()),
      },
      true,
    )
  }

  #[tokio::test]
  async fn tilde_listing_resolves_against_the_inner_home() {
    let fs = fake("/home/ubuntu");
    let entries = fs.list_dir("~/projects").await.unwrap();
    // The path handed back to the frontend hangs off the EXPANDED directory, so a
    // click on the entry cannot drift into one literally named `~`.
    assert_eq!(entries[0].path, "/home/ubuntu/projects/notes");
    let runs = fs.runner.runs.lock().unwrap();
    assert_eq!(runs[0][2], "printf %s \"$HOME\"");
    // argv: sh -c <script> _ <path>
    assert_eq!(runs[1][4], "/home/ubuntu/projects");
    assert_eq!(runs[1][2], LIST_SCRIPT);
  }

  #[tokio::test]
  async fn bare_tilde_and_absolute_paths_behave_differently() {
    let fs = fake("/home/ubuntu");
    fs.metadata("~").await.unwrap();
    fs.metadata("/etc").await.unwrap();
    let runs = fs.runner.runs.lock().unwrap();
    assert_eq!(runs.len(), 3, "only the tilde may cost a $HOME lookup");
    // argv 0 is the lookup; 1 is the stat of the expanded home, 2 the plain stat.
    assert_eq!(runs[1][runs[1].len() - 1], "/home/ubuntu");
    assert_eq!(runs[2][runs[2].len() - 1], "/etc");
  }

  #[test]
  fn parses_listing_lines() {
    // t \037 size \037 mtime \037 mode \037 name
    let raw = b"d\x1f4096\x1f1700000000\x1fdrwxr-xr-x\x1fsub\n\
                -\x1f12\x1f1700000001\x1f-rw-r--r--\x1fa.txt\n";
    let entries = parse_listing("/home/u", raw);
    // Directories sort first.
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0].name, "sub");
    assert!(entries[0].is_dir);
    assert_eq!(entries[0].path, "/home/u/sub");
    assert_eq!(entries[1].name, "a.txt");
    assert!(!entries[1].is_dir);
    assert_eq!(entries[1].size, 12);
    assert_eq!(entries[1].path, "/home/u/a.txt");
  }

  #[test]
  fn listing_path_joins_without_double_slash() {
    let raw = b"-\x1f1\x1f0\x1f-rw-r--r--\x1fx\n";
    let entries = parse_listing("/", raw);
    assert_eq!(entries[0].path, "/x");
  }

  #[test]
  fn parses_stat_output() {
    let meta = parse_stat("/etc", b"4096 1700000000 drwxr-xr-x directory\n");
    assert!(meta.is_dir);
    assert_eq!(meta.size, 4096);
    assert_eq!(meta.mode, "drwxr-xr-x");
    assert_eq!(meta.path, "/etc");
  }
}

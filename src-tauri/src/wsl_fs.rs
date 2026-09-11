//! WSL distribution filesystem access via the local `wsl.exe` launcher.
//!
//! File operations run as POSIX commands inside the distribution
//! (`wsl.exe [-d <distro>] -- sh -c ...`), mirroring the Docker exec backend so
//! the same `RemoteFs` code path serves both. This gives authentic Linux
//! semantics (permission bits, symlinks) rather than the Windows/9p view seen
//! through `\\wsl$\<distro>`.

use crate::cmd_fs::{CmdFs, Runner};

/// Runs commands inside a WSL distribution.
pub(crate) struct WslRunner {
  distro: Option<String>,
}

impl WslRunner {
  /// Build the `wsl.exe` argv for a command destined for the distribution.
  fn argv(&self, inner: &[String]) -> Vec<String> {
    let mut v = vec!["wsl.exe".to_string()];
    if let Some(d) = &self.distro {
      let d = d.trim();
      if !d.is_empty() {
        v.push("-d".to_string());
        v.push(d.to_string());
      }
    }
    // `-e` (--exec) runs the command DIRECTLY via execvp. Without it, wsl.exe
    // feeds the command to the distro's default shell, which strips quotes and
    // expands `$var` from the environment BEFORE our own `sh -c` runs — so a
    // script's `$1`/`$n`/`$foo` arrive empty and the listing silently yields
    // nothing. Verified against Ubuntu-24.04: `--` → `G=[]`, `-e` → `G=[name]`.
    v.push("-e".to_string());
    v.extend(inner.iter().cloned());
    v
  }
}

#[async_trait::async_trait]
impl Runner for WslRunner {
  async fn run(
    &self,
    inner: &[String],
    stdin: Option<&[u8]>,
  ) -> Result<(Vec<u8>, Vec<u8>, u32), String> {
    let argv = self.argv(inner);
    let stdin = stdin.map(|s| s.to_vec());
    // A synchronous spawned process must not run on an async worker.
    tokio::task::spawn_blocking(move || -> Result<(Vec<u8>, Vec<u8>, u32), String> {
      use std::io::Write;
      use std::process::{Command, Stdio};

      let mut cmd = Command::new(&argv[0]);
      cmd.args(&argv[1..]);
      cmd.stdin(if stdin.is_some() {
        Stdio::piped()
      } else {
        Stdio::null()
      });
      cmd.stdout(Stdio::piped());
      cmd.stderr(Stdio::piped());

      let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to run wsl.exe: {}", e))?;
      if let Some(data) = stdin {
        if let Some(mut si) = child.stdin.take() {
          si.write_all(&data)
            .map_err(|e| format!("Failed to write stdin to wsl.exe: {}", e))?;
        }
        // Dropping `si` closes the child's stdin so `cat` sees EOF.
      }
      let out = child
        .wait_with_output()
        .map_err(|e| format!("wsl.exe failed: {}", e))?;
      // A killed process reports no code; treat that as failure.
      let status = out.status.code().unwrap_or(1).max(0) as u32;
      Ok((out.stdout, out.stderr, status))
    })
    .await
    .map_err(|e| format!("wsl.exe task join error: {}", e))?
  }
}

/// Build a [`RemoteFs`](crate::remote_fs::RemoteFs) for a WSL distribution.
/// An empty/absent distro uses the system default.
pub(crate) fn new_wsl_fs(distro: Option<String>) -> CmdFs<WslRunner> {
  // The file panel's "Home" button loads "." — treat it as the WSL home dir.
  CmdFs::new(WslRunner { distro }, true)
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::remote_fs::RemoteFs;

  /// End-to-end probe against a real WSL distribution. Ignored by default so it
  /// never runs on machines without WSL; run with:
  /// `cargo test --lib wsl_fs -- --ignored --nocapture`
  #[tokio::test]
  #[ignore = "requires a WSL distribution"]
  async fn lists_wsl_home() {
    let fs = new_wsl_fs(None);
    let entries = fs.list_dir("").await.expect("list WSL home");
    eprintln!("wsl home entries: {}", entries.len());
    for e in entries.iter().take(8) {
      eprintln!(
        "  name={:?} path={:?} dir={} mode={} size={}",
        e.name, e.path, e.is_dir, e.mode, e.size
      );
    }
    assert!(!entries.is_empty(), "expected entries in the WSL home dir");
  }

  /// Full read/write/rename/delete round-trip inside a scratch dir. Ignored by
  /// default (needs WSL); run with `cargo test --lib wsl_fs -- --ignored`.
  #[tokio::test]
  #[ignore = "requires a WSL distribution"]
  async fn wsl_fs_roundtrip() {
    let fs = new_wsl_fs(None);
    let dir = "/tmp/wrolp_fs_probe";
    let _ = fs.remove_dir(dir).await;
    fs.create_dir(dir).await.expect("create_dir");
    let file = format!("{dir}/a.txt");
    let data = b"hello\nworld\n".to_vec();
    fs.write_file(&file, &data).await.expect("write_file");
    let meta = fs.metadata(&file).await.expect("metadata");
    assert!(!meta.is_dir);
    assert_eq!(meta.size, data.len() as u64);
    assert_eq!(fs.read_file(&file).await.expect("read_file"), data);
    let renamed = format!("{dir}/b.txt");
    fs.rename(&file, &renamed).await.expect("rename");
    assert!(fs.metadata(&file).await.is_err(), "old name must be gone");
    fs.remove_file(&renamed).await.expect("remove_file");
    fs.remove_dir(dir).await.expect("remove_dir");
  }

  fn runner(distro: Option<&str>) -> WslRunner {
    WslRunner {
      distro: distro.map(|s| s.to_string()),
    }
  }

  #[test]
  fn argv_uses_exec_and_default_distro() {
    let inner = vec![
      "cat".to_string(),
      "--".to_string(),
      "/etc/hosts".to_string(),
    ];
    let argv = runner(None).argv(&inner);
    assert_eq!(argv, vec!["wsl.exe", "-e", "cat", "--", "/etc/hosts"]);
  }

  #[test]
  fn argv_named_distro() {
    let inner = vec!["sh".to_string(), "-c".to_string(), "pwd".to_string()];
    let argv = runner(Some("Ubuntu-22.04")).argv(&inner);
    assert_eq!(
      argv,
      vec!["wsl.exe", "-d", "Ubuntu-22.04", "-e", "sh", "-c", "pwd"]
    );
  }

  #[test]
  fn argv_blank_distro_is_default() {
    let inner = vec!["pwd".to_string()];
    let argv = runner(Some("   ")).argv(&inner);
    assert_eq!(argv, vec!["wsl.exe", "-e", "pwd"]);
  }
}

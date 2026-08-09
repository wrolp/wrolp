//! Docker container filesystem access via `docker exec` on the jump host (P6).
//!
//! Most containers have no sshd, so file operations run as commands through an
//! SSH exec channel on the jump host: `docker exec <cid> <cmd>`. Paths are
//! always passed as positional arguments to a `sh -c` script (never interpolated
//! into the script text) to avoid shell-injection issues.

use russh::client::Handle;
use russh::ChannelMsg;
use std::sync::Arc;

use crate::remote_fs::RemoteFs;
use crate::ssh_session::{ContainerInfo, FileEntry, FileMeta, SshHandler};

/// Shell-quote a single argument for the remote (jump host) shell.
pub(crate) fn shell_quote(s: &str) -> String {
  format!("'{}'", s.replace('\'', "'\\''"))
}

/// Run a command on the jump host over an existing SSH handle, capturing
/// stdout, stderr and exit status. Each argv element is shell-quoted so the
/// remote shell passes it through unchanged.
pub(crate) async fn exec_on_jump(
  jump: &Handle<SshHandler>,
  argv: &[String],
  stdin: Option<&[u8]>,
) -> Result<(Vec<u8>, Vec<u8>, u32), String> {
  if jump.is_closed() {
    return Err("Jump host connection is closed".into());
  }
  let cmd = argv
    .iter()
    .map(|a| shell_quote(a))
    .collect::<Vec<_>>()
    .join(" ");

  let mut channel = jump
    .channel_open_session()
    .await
    .map_err(|e| format!("Failed to open exec channel: {}", e))?;
  channel
    .exec(true, cmd)
    .await
    .map_err(|e| format!("Failed to exec on jump host: {}", e))?;

  if let Some(data) = stdin {
    channel
      .data(data)
      .await
      .map_err(|e| format!("Failed to write stdin: {}", e))?;
    channel
      .eof()
      .await
      .map_err(|e| format!("Failed to send stdin EOF: {}", e))?;
  }

  let mut stdout = Vec::new();
  let mut stderr = Vec::new();
  let mut status = 0u32;
  while let Some(msg) = channel.wait().await {
    match msg {
      ChannelMsg::Data { data } => stdout.extend_from_slice(&data),
      ChannelMsg::ExtendedData { ext, data } => {
        if ext == 1 {
          stderr.extend_from_slice(&data);
        }
      }
      ChannelMsg::ExitStatus { exit_status } => status = exit_status,
      ChannelMsg::Eof | ChannelMsg::Close => break,
      _ => {}
    }
  }
  Ok((stdout, stderr, status))
}

/// Open a streaming exec channel on the jump host — for long-running commands
/// like `docker logs -f`. The caller must read from the returned channel in
/// a background loop and close it when done.
pub(crate) async fn exec_streaming_on_jump(
  jump: &Handle<SshHandler>,
  argv: &[String],
) -> Result<russh::Channel<russh::client::Msg>, String> {
  if jump.is_closed() {
    return Err("Jump host connection is closed".into());
  }
  let cmd = argv
    .iter()
    .map(|a| shell_quote(a))
    .collect::<Vec<_>>()
    .join(" ");

  let channel = jump
    .channel_open_session()
    .await
    .map_err(|e| format!("Failed to open exec channel: {}", e))?;
  channel
    .exec(true, cmd)
    .await
    .map_err(|e| format!("Failed to exec on jump host: {}", e))?;
  Ok(channel)
}

/// Remote filesystem backed by `docker exec` on the jump host.
pub struct DockerExecFs {
  jump: Arc<Handle<SshHandler>>,
  container: String,
  user: Option<String>,
}

impl DockerExecFs {
  pub fn new(jump: Arc<Handle<SshHandler>>, container: String, user: Option<String>) -> Self {
    Self {
      jump,
      container,
      user,
    }
  }

  /// Build `docker exec` argv: `docker exec [-i] [-u user] <cid> <inner...>`.
  fn argv(&self, interactive: bool, inner: &[&str]) -> Vec<String> {
    let mut v = vec!["docker".to_string(), "exec".to_string()];
    if interactive {
      v.push("-i".to_string());
    }
    if let Some(u) = &self.user {
      v.push("-u".to_string());
      v.push(u.clone());
    }
    v.push(self.container.clone());
    for a in inner {
      v.push(a.to_string());
    }
    v
  }

  async fn run(
    &self,
    interactive: bool,
    inner: &[&str],
    stdin: Option<&[u8]>,
  ) -> Result<(Vec<u8>, Vec<u8>, u32), String> {
    exec_on_jump(&self.jump, &self.argv(interactive, inner), stdin).await
  }
}

/// Directory-listing script executed inside the container. Entries are emitted
/// one per line, fields separated by the ASCII unit separator \037 (octal for
/// 0x1f, POSIX-compatible — unlike \x1f which is bash-specific).
const LIST_SCRIPT: &str = r#"cd "$1" || exit 1
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

#[async_trait::async_trait]
impl RemoteFs for DockerExecFs {
  async fn list_dir(&self, path: &str) -> Result<Vec<FileEntry>, String> {
    let (out, err, status) = self
      .run(false, &["sh", "-c", LIST_SCRIPT, "_", path], None)
      .await?;
    if status != 0 {
      return Err(format!(
        "Failed to list directory: {}",
        String::from_utf8_lossy(&err).trim()
      ));
    }
    let text = String::from_utf8_lossy(&out);
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
    files.sort_by(|a, b| {
      b.is_dir
        .cmp(&a.is_dir)
        .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(files)
  }

  async fn metadata(&self, path: &str) -> Result<FileMeta, String> {
    // %s=size %Y=mtime(epoch) %A=perms( symbolic) %F=file type
    let (out, err, status) = self
      .run(false, &["stat", "-c", "%s %Y %A %F", "--", path], None)
      .await?;
    if status != 0 {
      return Err(format!(
        "stat failed: {}",
        String::from_utf8_lossy(&err).trim()
      ));
    }
    let text = String::from_utf8_lossy(&out);
    let text = text.trim();
    let mut it = text.splitn(4, ' ');
    let size = it.next().unwrap_or("0").trim().parse().unwrap_or(0);
    let modified = it.next().unwrap_or("").trim().to_string();
    let mode = it.next().unwrap_or("").to_string();
    let ftype = it.next().unwrap_or("").to_string();
    Ok(FileMeta {
      path: path.to_string(),
      is_dir: ftype.contains("directory"),
      size,
      mode,
      modified,
    })
  }

  async fn read_file(&self, path: &str) -> Result<Vec<u8>, String> {
    let (out, err, status) = self.run(false, &["cat", "--", path], None).await?;
    if status != 0 {
      return Err(format!(
        "Failed to read file: {}",
        String::from_utf8_lossy(&err).trim()
      ));
    }
    Ok(out)
  }

  async fn write_file(&self, path: &str, data: &[u8]) -> Result<(), String> {
    let (_out, err, status) = self
      .run(
        true,
        &[
          "sh",
          "-c",
          "mkdir -p -- \"$(dirname -- \"$1\")\" && cat > \"$1\"",
          "_",
          path,
        ],
        Some(data),
      )
      .await?;
    if status != 0 {
      return Err(format!(
        "Failed to write file: {}",
        String::from_utf8_lossy(&err).trim()
      ));
    }
    Ok(())
  }

  async fn create_dir(&self, path: &str) -> Result<(), String> {
    let (_o, err, status) = self.run(false, &["mkdir", "-p", "--", path], None).await?;
    if status != 0 {
      return Err(format!(
        "Failed to create directory: {}",
        String::from_utf8_lossy(&err).trim()
      ));
    }
    Ok(())
  }

  async fn rename(&self, from: &str, to: &str) -> Result<(), String> {
    let (_o, err, status) = self.run(false, &["mv", "-T", "--", from, to], None).await?;
    if status != 0 {
      return Err(format!(
        "Failed to rename: {}",
        String::from_utf8_lossy(&err).trim()
      ));
    }
    Ok(())
  }

  async fn remove_file(&self, path: &str) -> Result<(), String> {
    let (_o, err, status) = self.run(false, &["rm", "-f", "--", path], None).await?;
    if status != 0 {
      return Err(format!(
        "Failed to delete file: {}",
        String::from_utf8_lossy(&err).trim()
      ));
    }
    Ok(())
  }

  async fn remove_dir(&self, path: &str) -> Result<(), String> {
    let (_o, err, status) = self.run(false, &["rm", "-rf", "--", path], None).await?;
    if status != 0 {
      return Err(format!(
        "Failed to delete directory: {}",
        String::from_utf8_lossy(&err).trim()
      ));
    }
    Ok(())
  }
}

/// List Docker containers visible to the jump host user via `docker ps`.
pub async fn list_docker_containers(
  jump: Arc<Handle<SshHandler>>,
) -> Result<Vec<ContainerInfo>, String> {
  // NOTE: docker's `--format` template only exposes `.Status` (e.g. "Up 3 hours",
  // "Exited (0) 2 days ago") on `containerContext`. There is no top-level `.State`
  // field, so we derive the normalized state word from the Status text instead.
  let argv = vec![
    "docker".to_string(),
    "ps".to_string(),
    "--format".to_string(),
    "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}".to_string(),
  ];
  let (out, err, status) = exec_on_jump(&jump, &argv, None).await?;
  if status != 0 {
    return Err(format!(
      "docker ps failed (does the jump user have docker permission?): {}",
      String::from_utf8_lossy(&err).trim()
    ));
  }
  let text = String::from_utf8_lossy(&out);
  let mut list = Vec::new();
  for line in text.lines() {
    if line.trim().is_empty() {
      continue;
    }
    let mut p = line.splitn(4, '\t');
    let id = p.next().unwrap_or("").to_string();
    let name = p.next().unwrap_or("").to_string();
    let image = p.next().unwrap_or("").to_string();
    let status = p.next().unwrap_or("").to_string();
    list.push(ContainerInfo {
      id,
      name,
      image,
      state: normalize_state(&status),
      status,
    });
  }
  Ok(list)
}

/// Map a docker `Status` string to a normalized, lowercase state word
/// (`running` / `exited` / `paused` / `dead` / `created` / `restarting`).
fn normalize_state(status: &str) -> String {
  let word = status
    .split_whitespace()
    .next()
    .unwrap_or("")
    .to_lowercase();
  match word.as_str() {
    "up" => "running".into(),
    "exited" => "exited".into(),
    "paused" => "paused".into(),
    "dead" => "dead".into(),
    "created" => "created".into(),
    "restarting" => "restarting".into(),
    other => other.to_string(),
  }
}

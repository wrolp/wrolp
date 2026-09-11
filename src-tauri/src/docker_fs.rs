//! Docker container filesystem access via `docker exec` on the jump host (P6).
//!
//! Most containers have no sshd, so file operations run as commands through an
//! SSH exec channel on the jump host: `docker exec <cid> <cmd>`. The shared
//! command-driven [`CmdFs`] turns those commands into a
//! [`RemoteFs`](crate::remote_fs::RemoteFs); paths are always passed as
//! positional arguments to a `sh -c` script (never interpolated into the script
//! text) to avoid shell-injection issues.

use russh::client::Handle;
use russh::ChannelMsg;
use std::sync::Arc;

use crate::cmd_fs::{CmdFs, Runner};
use crate::ssh_session::{ContainerInfo, SshHandler};

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

/// Runs commands inside a Docker container via `docker exec` on the jump host.
pub(crate) struct DockerRunner {
  jump: Arc<Handle<SshHandler>>,
  container: String,
  user: Option<String>,
}

impl DockerRunner {
  /// Build `docker exec` argv: `docker exec [-i] [-u user] <cid> <inner...>`.
  fn argv(&self, interactive: bool, inner: &[String]) -> Vec<String> {
    let mut v = vec!["docker".to_string(), "exec".to_string()];
    if interactive {
      v.push("-i".to_string());
    }
    if let Some(u) = &self.user {
      v.push("-u".to_string());
      v.push(u.clone());
    }
    v.push(self.container.clone());
    v.extend(inner.iter().cloned());
    v
  }
}

#[async_trait::async_trait]
impl Runner for DockerRunner {
  async fn run(
    &self,
    inner: &[String],
    stdin: Option<&[u8]>,
  ) -> Result<(Vec<u8>, Vec<u8>, u32), String> {
    // `-i` is only added when we actually feed stdin: an interactive exec with
    // no EOF would otherwise block waiting for input.
    let argv = self.argv(stdin.is_some(), inner);
    exec_on_jump(&self.jump, &argv, stdin).await
  }
}

/// Build a Docker-container filesystem backed by `docker exec` on the jump host.
pub(crate) fn new_docker_fs(
  jump: Arc<Handle<SshHandler>>,
  container: String,
  user: Option<String>,
) -> CmdFs<DockerRunner> {
  CmdFs::new(
    DockerRunner {
      jump,
      container,
      user,
    },
    false,
  )
}

/// List Docker containers visible to the jump host user via `docker ps`.
pub async fn list_docker_containers(
  jump: Arc<Handle<SshHandler>>,
) -> Result<Vec<ContainerInfo>, String> {
  // NOTE: docker's `--format` template only exposes `.Status` (e.g. "Up 3 hours",
  // "Exited (0) 2 days ago") on `containerContext`. There is no top-level `.State`
  // field, so we derive the normalized state word from the Status text instead.
  // `-a` lists all containers (running + stopped); callers filter by state.
  let argv = vec![
    "docker".to_string(),
    "ps".to_string(),
    "-a".to_string(),
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

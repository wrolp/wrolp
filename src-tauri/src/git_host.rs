//! Where a `git …` argv actually runs: on a jump host over SSH, or on this machine.
//!
//! Mirrors [`crate::docker_host`] / [`crate::k8s_host`]: every Git feature in the
//! app is an argv list that starts with `git`, and this module owns the one thing
//! that differs between the transports — how that argv is executed.
//!
//! No libgit2 is involved. The user's own `git` and its configuration stay the
//! source of truth for credentials, hooks and `core.autocrlf`, on either target.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

use crate::ssh_session::AppState;
use crate::win_proc::HideConsole;

/// `git --version` should answer instantly; a hung probe must not block the panel.
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
/// Status / diff / log / branch reads.
pub const READ_TIMEOUT: Duration = Duration::from_secs(15);
/// Index writes (stage, unstage, commit) can run hooks.
pub const WRITE_TIMEOUT: Duration = Duration::from_secs(30);
/// Network operations have no hard timeout, but this bounds a truly stuck one.
pub const NETWORK_TIMEOUT: Duration = Duration::from_secs(600);

/// The host a git command runs against. `Ssh` opens a fresh exec channel on the
/// interactive session; `Local` spawns the CLI on this machine.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum GitHostRef {
  #[serde(rename = "ssh")]
  Ssh {
    #[serde(rename = "jumpTabId")]
    jump_tab_id: u32,
  },
  #[serde(rename = "local")]
  Local,
}

impl GitHostRef {
  /// Persistence / lock key: `ssh:<tabId>` or `local`.
  pub fn key(&self) -> String {
    match self {
      GitHostRef::Ssh { jump_tab_id } => format!("ssh:{jump_tab_id}"),
      GitHostRef::Local => "local".to_string(),
    }
  }
}

/// What `git_probe` answers. `message` is the raw diagnostic, shown as detail —
/// the UI owns the sentence that acts on it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitProbe {
  pub installed: bool,
  pub version: Option<String>,
  /// Which executable answered (`git`, or an absolute fallback path).
  pub bin: Option<String>,
  pub message: String,
}

/// Everything the Git commands share that is not part of `AppState`.
///
/// Deliberately separate from [`AppState`]: that struct is constructed in many
/// places (`new_with_base`, tests), and nothing here needs to be there.
#[derive(Default)]
pub struct GitState {
  /// One lock per (host, root): stage / commit / branch switches must not write
  /// the same index concurrently.
  locks: Arc<StdMutex<HashSet<String>>>,
  /// Cancellation flags, keyed by the frontend's `opId`.
  ops: Arc<StdMutex<HashMap<String, Arc<AtomicBool>>>>,
  /// Resolved local `git` executable, cached after the first successful probe.
  local_bin: Arc<StdMutex<Option<String>>>,
}

/// Held for the duration of a repository write; releasing is `Drop`.
pub struct GitLock {
  locks: Arc<StdMutex<HashSet<String>>>,
  key: String,
}

impl Drop for GitLock {
  fn drop(&mut self) {
    if let Ok(mut set) = self.locks.lock() {
      set.remove(&self.key);
    }
  }
}

impl GitState {
  /// Acquire the repository-wide write lock, or report `git_busy:<repo>`.
  pub fn try_lock(&self, host: &GitHostRef, root: &str) -> Result<GitLock, String> {
    let key = format!("{}|{}", host.key(), root);
    let mut set = self.locks.lock().map_err(|e| e.to_string())?;
    if !set.insert(key.clone()) {
      return Err(format!("git_busy:{key}"));
    }
    Ok(GitLock {
      locks: self.locks.clone(),
      key,
    })
  }

  /// The flag a running network operation checks; created on first use.
  pub fn cancel_flag(&self, op_id: &str) -> Arc<AtomicBool> {
    let mut ops = self.ops.lock().expect("git ops mutex poisoned");
    ops
      .entry(op_id.to_string())
      .or_insert_with(|| Arc::new(AtomicBool::new(false)))
      .clone()
  }

  /// Set the flag for a running operation. An unknown id is not an error — the
  /// operation may already have finished.
  pub fn cancel(&self, op_id: &str) {
    let ops = self.ops.lock().expect("git ops mutex poisoned");
    if let Some(flag) = ops.get(op_id) {
      flag.store(true, Ordering::SeqCst);
    }
  }

  /// Drop a finished operation's flag so abandoned ids do not pile up.
  pub fn finish(&self, op_id: &str) {
    let mut ops = self.ops.lock().expect("git ops mutex poisoned");
    ops.remove(op_id);
  }
}

/// `git [ -C root ] -c core.quotepath=false --no-pager <args>`.
///
/// `-c core.quotepath=false` keeps CJK paths literal instead of octal-escaped;
/// `--no-pager` makes the CLI behave as a pipe even on a terminal-capable host.
pub fn git_argv(root: Option<&str>, args: &[String]) -> Vec<String> {
  let mut argv = vec!["git".to_string()];
  if let Some(root) = root {
    argv.push("-C".into());
    argv.push(root.to_string());
  }
  argv.push("-c".into());
  argv.push("core.quotepath=false".into());
  argv.push("--no-pager".into());
  argv.extend(args.iter().cloned());
  argv
}

/// One remote command line: login-shell PATH plus the environment the panel
/// needs. Quoting each argv element individually is what keeps a path with
/// spaces or quotes from being re-parsed as shell syntax.
fn remote_line(argv: &[String]) -> String {
  let inner = argv
    .iter()
    .map(|a| crate::commands::shell_quote_arg(a))
    .collect::<Vec<_>>()
    .join(" ");
  format!(
    "env LC_ALL=C GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat bash -lc {}",
    crate::commands::shell_quote_arg(&inner)
  )
}

/// Candidate local executables: `git` on PATH, then the two Windows install
/// locations. A GUI process on Windows frequently has no Git in PATH at all.
fn local_candidates() -> Vec<String> {
  let mut out = vec!["git".to_string()];
  if let Ok(pf) = std::env::var("ProgramFiles") {
    out.push(format!("{}\\Git\\cmd\\git.exe", pf.trim_end_matches('\\')));
  }
  if let Ok(la) = std::env::var("LOCALAPPDATA") {
    out.push(format!(
      "{}\\Programs\\Git\\cmd\\git.exe",
      la.trim_end_matches('\\')
    ));
  }
  out
}

/// Ask one candidate for its version. `None` means "cannot spawn or not git".
async fn version_of(bin: &str) -> Option<String> {
  let mut cmd = Command::new(bin);
  cmd.hide_console();
  cmd
    .arg("--version")
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::null())
    .kill_on_drop(true);
  let child = cmd.spawn().ok()?;
  let out = tokio::time::timeout(PROBE_TIMEOUT, child.wait_with_output())
    .await
    .ok()?
    .ok()?;
  if !out.status.success() {
    return None;
  }
  let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
  (!text.is_empty()).then_some(text)
}

/// The executable to use for local commands, cached after the first success.
async fn local_git_bin(cli: &GitState) -> Result<String, String> {
  if let Some(bin) = cli.local_bin.lock().map(|b| b.clone()).unwrap_or(None) {
    return Ok(bin);
  }
  for bin in local_candidates() {
    if version_of(&bin).await.is_some() {
      if let Ok(mut cache) = cli.local_bin.lock() {
        *cache = Some(bin.clone());
      }
      return Ok(bin);
    }
  }
  Err("git_no_git:git was not found on PATH or in the usual Windows install locations"
    .to_string())
}

/// Probe whether the host has git. Never an `Err`: "not installed" is a state the
/// panel renders, not a failed call.
pub async fn probe_git(
  state: &tauri::State<'_, AppState>,
  cli: &GitState,
  host: &GitHostRef,
) -> GitProbe {
  let args = vec!["--version".to_string()];
  match host {
    GitHostRef::Ssh { jump_tab_id } => {
      let argv = git_argv(None, &args);
      match remote_exec(state, *jump_tab_id, &argv, None, PROBE_TIMEOUT).await {
        Ok((out, _err, 0)) => {
          let text = String::from_utf8_lossy(&out).trim().to_string();
          GitProbe {
            installed: !text.is_empty(),
            version: (!text.is_empty()).then_some(text),
            bin: None,
            message: String::new(),
          }
        }
        Ok((_, err, status)) => GitProbe {
          installed: false,
          version: None,
          bin: None,
          message: format!(
            "git --version exited {status}: {}",
            String::from_utf8_lossy(&err).trim()
          ),
        },
        Err(e) => GitProbe {
          installed: false,
          version: None,
          bin: None,
          message: e,
        },
      }
    }
    GitHostRef::Local => {
      let mut found = None;
      for bin in local_candidates() {
        if let Some(v) = version_of(&bin).await {
          found = Some((bin, v));
          break;
        }
      }
      match found {
        Some((bin, version)) => {
          if let Ok(mut cache) = cli.local_bin.lock() {
            *cache = Some(bin.clone());
          }
          GitProbe {
            installed: true,
            version: Some(version),
            bin: Some(bin),
            message: String::new(),
          }
        }
        None => GitProbe {
          installed: false,
          version: None,
          bin: None,
          message: "git was not found on PATH or in the usual Windows install locations"
            .to_string(),
        },
      }
    }
  }
}

/// Run `git …` to completion on `host`, returning `(stdout, stderr, exit)`.
///
/// `root` is the repository root (`git -C root`). A command that must run outside
/// a repository (`init`, `--version`) passes `None`.
pub async fn exec_git(
  state: &tauri::State<'_, AppState>,
  cli: &GitState,
  host: &GitHostRef,
  root: Option<&str>,
  args: &[String],
  stdin: Option<&[u8]>,
  timeout: Duration,
) -> Result<(Vec<u8>, Vec<u8>, u32), String> {
  let argv = git_argv(root, args);
  match host {
    GitHostRef::Ssh { jump_tab_id } => {
      remote_exec(state, *jump_tab_id, &argv, stdin, timeout).await
    }
    GitHostRef::Local => local_exec(cli, &argv, stdin, timeout).await,
  }
}

/// The SSH half of [`exec_git`]: a fresh exec channel per call, never the
/// interactive PTY (whose output belongs to the terminal). `SshHandler` already
/// filters auxiliary channel output out of the terminal buffer.
async fn remote_exec(
  state: &tauri::State<'_, AppState>,
  jump_tab_id: u32,
  argv: &[String],
  stdin: Option<&[u8]>,
  timeout: Duration,
) -> Result<(Vec<u8>, Vec<u8>, u32), String> {
  let jump = crate::remote_fs::get_jump_handle(state, jump_tab_id)?;
  if jump.is_closed() {
    return Err("git_timeout:the SSH connection is closed".to_string());
  }
  let line = remote_line(argv);
  let fut = async {
    let mut channel = jump
      .channel_open_session()
      .await
      .map_err(|e| format!("git_no_git:failed to open exec channel: {e}"))?;
    channel
      .exec(true, line)
      .await
      .map_err(|e| format!("git_no_git:failed to execute git on the host: {e}"))?;
    if let Some(data) = stdin {
      channel
        .data(data)
        .await
        .map_err(|e| format!("failed to write git stdin: {e}"))?;
      channel
        .eof()
        .await
        .map_err(|e| format!("failed to close git stdin: {e}"))?;
    }
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut status = 0u32;
    while let Some(msg) = channel.wait().await {
      match msg {
        russh::ChannelMsg::Data { data } => stdout.extend_from_slice(&data),
        russh::ChannelMsg::ExtendedData { ext, data } => {
          if ext == 1 {
            stderr.extend_from_slice(&data);
          }
        }
        russh::ChannelMsg::ExitStatus { exit_status } => status = exit_status,
        russh::ChannelMsg::Eof | russh::ChannelMsg::Close => break,
        _ => {}
      }
    }
    Ok((stdout, stderr, status))
  };
  tokio::time::timeout(timeout, fut)
    .await
    .map_err(|_| format!("git_timeout:git did not finish within {}s", timeout.as_secs()))?
}

/// The local half of [`exec_git`]: argv goes straight to the process, so no
/// shell can re-parse a path.
async fn local_exec(
  cli: &GitState,
  argv: &[String],
  stdin: Option<&[u8]>,
  timeout: Duration,
) -> Result<(Vec<u8>, Vec<u8>, u32), String> {
  let bin = local_git_bin(cli).await?;
  let mut cmd = Command::new(&bin);
  cmd.hide_console();
  cmd
    .args(&argv[1..])
    .env("LC_ALL", "C")
    .env("GIT_TERMINAL_PROMPT", "0")
    .env("GIT_PAGER", "cat")
    .stdin(if stdin.is_some() {
      Stdio::piped()
    } else {
      Stdio::null()
    })
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .kill_on_drop(true);
  let mut child = cmd
    .spawn()
    .map_err(|e| format!("git_no_git:failed to start `{bin}`: {e}"))?;
  if let Some(data) = stdin {
    if let Some(mut sink) = child.stdin.take() {
      let _ = sink.write_all(data).await;
      // Dropping the handle closes the pipe; `commit -F -` waits for EOF.
      drop(sink);
    }
  }
  let joined = argv.join(" ");
  tokio::time::timeout(timeout, child.wait_with_output())
    .await
    .map_err(|_| format!("git_timeout:`{joined}` timed out after {}s", timeout.as_secs()))?
    .map_err(|e| format!("`{joined}` failed: {e}"))
    .map(|out| {
      (
        out.stdout,
        out.stderr,
        out.status.code().unwrap_or(-1) as u32,
      )
    })
}

// ==================== Network progress ====================

/// One progress tick for a fetch / pull / push. Broadcast as `git-progress`;
/// the panel filters by `opId` and drops late events.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitProgressEvent {
  pub op_id: String,
  /// `receiving` / `resolving` / `compressing` / `writing` / `remote` / `done` / `cancelled`.
  pub phase: String,
  pub received: u64,
  pub total: u64,
  pub percent: Option<u32>,
  pub text: String,
}

impl GitProgressEvent {
  fn new(op_id: &str, phase: &str) -> Self {
    Self {
      op_id: op_id.to_string(),
      phase: phase.to_string(),
      received: 0,
      total: 0,
      percent: None,
      text: String::new(),
    }
  }
}

/// Parse one line of `--progress` output, e.g.
/// `Receiving objects:  45% (123/456), 1.2 MiB | 300 KiB/s`.
fn parse_progress_line(line: &str) -> Option<(&'static str, Option<u32>)> {
  let trimmed = line.trim();
  let (phase, rest) = if let Some(r) = trimmed.strip_prefix("Receiving objects:") {
    ("receiving", r)
  } else if let Some(r) = trimmed.strip_prefix("Resolving deltas:") {
    ("resolving", r)
  } else if let Some(r) = trimmed.strip_prefix("Compressing objects:") {
    ("compressing", r)
  } else if let Some(r) = trimmed.strip_prefix("Writing objects:") {
    ("writing", r)
  } else if trimmed.starts_with("remote:") {
    ("remote", trimmed)
  } else {
    return None;
  };
  let percent = if phase == "remote" {
    None
  } else {
    rest
      .split('%')
      .next()
      .and_then(|n| n.trim().parse::<u32>().ok())
  };
  Some((phase, percent))
}

/// Run a network git command, reading both streams as they arrive and emitting
/// `git-progress` for the panel. `cancel` is polled; on it (or a timeout) the
/// local child is killed / the remote channel is closed, which is what stops the
/// remote `git` too.
#[allow(clippy::too_many_arguments)]
pub async fn exec_git_streaming(
  app: &tauri::AppHandle,
  state: &tauri::State<'_, AppState>,
  cli: &GitState,
  host: &GitHostRef,
  root: Option<&str>,
  args: &[String],
  op_id: &str,
  cancel: Arc<AtomicBool>,
) -> Result<(Vec<u8>, Vec<u8>, u32), String> {
  use tauri::Emitter;
  let argv = git_argv(root, args);

  let result = match host {
    GitHostRef::Ssh { jump_tab_id } => {
      streaming_remote(
        app,
        state,
        *jump_tab_id,
        &argv,
        op_id,
        cancel.clone(),
        NETWORK_TIMEOUT,
      )
      .await
    }
    GitHostRef::Local => streaming_local(app, cli, &argv, op_id, cancel.clone()).await,
  };

  let mut end = GitProgressEvent::new(op_id, "done");
  if cancel.load(Ordering::SeqCst) {
    end.phase = "cancelled".to_string();
  }
  let _ = app.emit("git-progress", end);
  result
}

/// Splits stderr into lines while keeping the complete text for error messages.
struct LineCollector {
  buf: Vec<u8>,
  text: Vec<u8>,
  on_line: Box<dyn FnMut(&str) + Send>,
}

impl LineCollector {
  fn push(&mut self, bytes: &[u8]) {
    self.text.extend_from_slice(bytes);
    for b in bytes {
      if *b == b'\n' {
        let line = std::mem::take(&mut self.buf);
        let clean = strip_cr(&line);
        (self.on_line)(&clean);
      } else {
        self.buf.push(*b);
      }
    }
  }

  fn flush(&mut self) {
    if !self.buf.is_empty() {
      let line = std::mem::take(&mut self.buf);
      let clean = strip_cr(&line);
      (self.on_line)(&clean);
    }
  }
}

fn strip_cr(line: &[u8]) -> String {
  // Progress lines carry a carriage return; the text is already valid UTF-8 in
  // practice, and lossy decoding keeps odd bytes from aborting the loop.
  String::from_utf8_lossy(line)
    .trim_end_matches('\r')
    .to_string()
}

#[allow(clippy::too_many_arguments)]
async fn streaming_remote(
  app: &tauri::AppHandle,
  state: &tauri::State<'_, AppState>,
  jump_tab_id: u32,
  argv: &[String],
  op_id: &str,
  cancel: Arc<AtomicBool>,
  timeout: Duration,
) -> Result<(Vec<u8>, Vec<u8>, u32), String> {
  use tauri::Emitter;
  let jump = crate::remote_fs::get_jump_handle(state, jump_tab_id)?;
  if jump.is_closed() {
    return Err("git_timeout:the SSH connection is closed".to_string());
  }
  let line = remote_line(argv);
  let fut = async {
    let mut channel = jump
      .channel_open_session()
      .await
      .map_err(|e| format!("git_no_git:failed to open exec channel: {e}"))?;
    channel
      .exec(true, line)
      .await
      .map_err(|e| format!("git_no_git:failed to execute git on the host: {e}"))?;
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut status = 0u32;
    let mut collector = LineCollector {
      buf: Vec::new(),
      text: Vec::new(),
      on_line: {
        let op_id = op_id.to_string();
        let app = app.clone();
        Box::new(move |l: &str| {
          if let Some((phase, percent)) = parse_progress_line(l) {
            let _ = app.emit(
              "git-progress",
              GitProgressEvent {
                percent,
                text: l.to_string(),
                ..GitProgressEvent::new(&op_id, phase)
              },
            );
          }
        })
      },
    };
    loop {
      if cancel.load(Ordering::SeqCst) {
        break;
      }
      let msg = tokio::select! {
        _ = tokio::time::sleep(Duration::from_millis(50)) => continue,
        msg = channel.wait() => msg,
      };
      match msg {
        Some(russh::ChannelMsg::Data { data }) => stdout.extend_from_slice(&data),
        Some(russh::ChannelMsg::ExtendedData { ext, data }) => {
          if ext == 1 {
            collector.push(&data);
          }
        }
        Some(russh::ChannelMsg::ExitStatus { exit_status }) => status = exit_status,
        Some(russh::ChannelMsg::Eof) | Some(russh::ChannelMsg::Close) | None => break,
        _ => {}
      }
    }
    collector.flush();
    stderr.extend_from_slice(&collector.text);
    // Dropping / closing the channel is the cancellation: the remote git sees
    // EOF on its stream and stops on its own.
    let _ = channel.close().await;
    Ok((stdout, stderr, status))
  };
  tokio::time::timeout(timeout, fut)
    .await
    .map_err(|_| format!("git_timeout:git did not finish within {}s", timeout.as_secs()))?
}

async fn streaming_local(
  app: &tauri::AppHandle,
  cli: &GitState,
  argv: &[String],
  op_id: &str,
  cancel: Arc<AtomicBool>,
) -> Result<(Vec<u8>, Vec<u8>, u32), String> {
  use tauri::Emitter;
  let bin = local_git_bin(cli).await?;
  let mut cmd = Command::new(&bin);
  cmd.hide_console();
  cmd
    .args(&argv[1..])
    .env("LC_ALL", "C")
    .env("GIT_TERMINAL_PROMPT", "0")
    .env("GIT_PAGER", "cat")
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .kill_on_drop(true);
  let mut child = cmd
    .spawn()
    .map_err(|e| format!("git_no_git:failed to start `{bin}`: {e}"))?;

  let stdout_handle = child.stdout.take();
  let stderr_handle = child.stderr.take();
  let out_task = tauri::async_runtime::spawn(async move {
    let mut out = Vec::new();
    if let Some(mut stdout) = stdout_handle {
      let _ = stdout.read_to_end(&mut out).await;
    }
    out
  });
  let err_task = {
    let op_id = op_id.to_string();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
      let mut text = Vec::new();
      if let Some(stderr) = stderr_handle {
        let mut reader = BufReader::new(stderr);
        let mut collector = LineCollector {
          buf: Vec::new(),
          text: Vec::new(),
          on_line: Box::new(move |l: &str| {
            if let Some((phase, percent)) = parse_progress_line(l) {
              let _ = app.emit(
                "git-progress",
                GitProgressEvent {
                  percent,
                  text: l.to_string(),
                  ..GitProgressEvent::new(&op_id, phase)
                },
              );
            }
          }),
        };
        let mut buf = [0u8; 4096];
        loop {
          match reader.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => collector.push(&buf[..n]),
          }
        }
        collector.flush();
        text.extend_from_slice(&collector.text);
      }
      text
    })
  };

  let monitored = async {
    loop {
      tokio::select! {
        _ = tokio::time::sleep(Duration::from_millis(50)) => {
          if cancel.load(Ordering::SeqCst) {
            let _ = child.kill().await;
            return Err("git_cancelled:cancelled by the user".to_string());
          }
        }
        status = child.wait() => {
          let status = status.map_err(|e| format!("`{}` failed: {e}", argv.join(" ")))?;
          return Ok::<u32, String>(status.code().unwrap_or(-1) as u32);
        }
      }
    }
  };
  let result = tokio::time::timeout(NETWORK_TIMEOUT, monitored)
    .await
    .map_err(|_| "git_timeout:git did not finish within 600s".to_string())??;
  let stdout = out_task.await.unwrap_or_default();
  let stderr = err_task.await.unwrap_or_default();
  Ok((stdout, stderr, result))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn the_host_ref_round_trips_as_the_tagged_form_the_frontend_sends() {
    let local: GitHostRef = serde_json::from_str(r#"{"kind":"local"}"#).unwrap();
    assert!(matches!(local, GitHostRef::Local));
    assert_eq!(local.key(), "local");
    let ssh: GitHostRef = serde_json::from_str(r#"{"kind":"ssh","jumpTabId":7}"#).unwrap();
    match ssh {
      GitHostRef::Ssh { jump_tab_id } => assert_eq!(jump_tab_id, 7),
      GitHostRef::Local => panic!("ssh host decoded as local"),
    }
    assert_eq!(ssh.key(), "ssh:7");
  }

  #[test]
  fn argv_puts_global_options_before_the_verb() {
    let args = vec!["status".to_string(), "--porcelain=v2".to_string()];
    assert_eq!(
      git_argv(Some("/repo"), &args),
      vec![
        "git",
        "-C",
        "/repo",
        "-c",
        "core.quotepath=false",
        "--no-pager",
        "status",
        "--porcelain=v2"
      ]
    );
    assert_eq!(git_argv(None, &args).len(), 6);
  }

  #[test]
  fn the_remote_line_runs_through_a_login_shell_and_quotes_every_argument() {
    let args = vec!["status".to_string(), "--porcelain=v2".to_string()];
    let line = remote_line(&git_argv(Some("/my repo"), &args));
    assert!(line.starts_with("env LC_ALL=C GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat bash -lc "));
    assert!(line.contains("/my repo"));
    assert!(line.contains("--porcelain=v2"));
  }

  #[test]
  fn progress_lines_map_to_phases_and_percentages() {
    assert_eq!(
      parse_progress_line("Receiving objects:  45% (123/456), 1.2 MiB | 300 KiB/s"),
      Some(("receiving", Some(45)))
    );
    assert_eq!(
      parse_progress_line("Resolving deltas:  70% (70/100)"),
      Some(("resolving", Some(70)))
    );
    assert_eq!(
      parse_progress_line("remote: Counting objects: 100%"),
      Some(("remote", None))
    );
    assert_eq!(parse_progress_line("branch 'main' set up to track"), None);
  }
}

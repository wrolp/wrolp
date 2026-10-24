//! `kubectl port-forward` runtimes.
//!
//! A forward is a *long-lived kubectl process*, so unlike the other Kubernetes
//! commands it needs a registry (like [`crate::ssh_session`]'s tunnels and Docker log
//! streams) and a way to be killed.
//!
//! Two transports, and the SSH one is really two hops: `kubectl port-forward` binds a
//! port on the machine it runs on, so when kubectl runs on a jump host the pod is
//! reachable there — not here. A jump-host forward is therefore the kubectl process
//! *plus* an `ssh -L` tunnel (the runtime in [`crate::commands::tunnels`]) from this
//! machine to the port kubectl opened on the jump host's loopback. Locally the two
//! collapse into the single kubectl process.

use serde::Serialize;
use std::collections::VecDeque;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use tokio::io::{AsyncReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::oneshot;

use crate::ssh_session::AppState;
use crate::win_proc::HideConsole;

use crate::k8s_host::kubectl_argv;

/// How many output lines a forward keeps for the panel's status read-out. kubectl
/// repeats its "Handling connections" chatter, so this is a tail, not a log.
const MAX_LINES: usize = 40;

/// The workload kinds `kubectl port-forward` accepts and the panel offers. kubectl's
/// own aliases are included because the target string is typed by the user in the
/// dialog's read-out and stored verbatim.
pub const FORWARD_TARGET_KINDS: [&str; 9] = [
  "pod",
  "pods",
  "svc",
  "service",
  "services",
  "deployment",
  "deploy",
  "statefulset",
  "sts",
];

/// One row of the panel's forward list. `running == false` means the process ended on
/// its own and the row is kept so `message` (why) stays readable until removed.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct K8sPortForward {
  pub id: u32,
  /// `"local"` or `"ssh"` — which machine kubectl runs on.
  pub host_kind: &'static str,
  /// Jump-host forwards name the session carrying them.
  pub jump_tab_id: Option<u32>,
  pub context: Option<String>,
  pub namespace: String,
  /// `pod/web-0`, `service/api`, …
  pub target: String,
  /// Pod-side port or named port.
  pub remote_port: String,
  /// What to connect to from this machine, e.g. `127.0.0.1:8080`.
  pub listen_addr: String,
  pub started_at: i64,
  pub running: bool,
  pub message: String,
}

/// A live forward: metadata plus the shutdown sender and, for the jump-host case, the
/// tunnel that makes the jump-host port reachable here.
pub struct ForwardRuntime {
  pub id: u32,
  pub host_kind: &'static str,
  pub jump_tab_id: Option<u32>,
  pub context: Option<String>,
  pub namespace: String,
  pub target: String,
  pub remote_port: String,
  pub listen_addr: String,
  pub started_at: i64,
  pub running: Arc<AtomicBool>,
  pub lines: Arc<StdMutex<VecDeque<String>>>,
  pub cancel: oneshot::Sender<()>,
  pub tunnel_id: Option<u32>,
}

impl ForwardRuntime {
  pub fn info(&self) -> K8sPortForward {
    let message = self
      .lines
      .lock()
      .map(|l| l.iter().cloned().collect::<Vec<_>>().join("\n"))
      .unwrap_or_default();
    K8sPortForward {
      id: self.id,
      host_kind: self.host_kind,
      jump_tab_id: self.jump_tab_id,
      context: self.context.clone(),
      namespace: self.namespace.clone(),
      target: self.target.clone(),
      remote_port: self.remote_port.clone(),
      listen_addr: self.listen_addr.clone(),
      started_at: self.started_at,
      running: self.running.load(Ordering::SeqCst),
      message,
    }
  }
}

/// `kind/name` → the target kubectl will accept. The kind is an allow-list and the
/// name is restricted to DNS-label characters, so a target can never carry a flag or
/// a shell metacharacter into the argv.
pub fn checked_target(target: &str) -> Result<String, String> {
  let t = target.trim();
  let Some((kind, name)) = t.split_once('/') else {
    return Err(format!(
      "port-forward target must look like `pod/name`, got `{t}`"
    ));
  };
  if !FORWARD_TARGET_KINDS.contains(&kind) {
    return Err(format!("port-forward does not support `{kind}` targets"));
  }
  if name.is_empty()
    || !name
      .chars()
      .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
  {
    return Err(format!("invalid resource name in `{t}`"));
  }
  Ok(format!("{kind}/{name}"))
}

/// A pod-side port: a number, or a named port (`http`). Both are what
/// `kubectl port-forward x 8080:<this>` accepts.
pub fn checked_remote_port(port: &str) -> Result<String, String> {
  let p = port.trim();
  if p.is_empty() {
    return Err("missing target port".to_string());
  }
  if let Ok(n) = p.parse::<u16>() {
    if n > 0 {
      return Ok(n.to_string());
    }
    return Err("target port must be 1-65535".to_string());
  }
  let named = p.len() <= 29
    && p
      .chars()
      .next()
      .map(|c| c.is_ascii_lowercase())
      .unwrap_or(false)
    && p
      .chars()
      .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '_'));
  if named {
    return Ok(p.to_string());
  }
  Err(format!(
    "`{p}` is neither a port number nor a lowercase port name"
  ))
}

/// `kubectl [--context C] -n NS port-forward <target> <listen>:<remote> [--address …]`
///
/// `all_interfaces` only applies where kubectl runs (the local case); a jump-host
/// forward keeps kubectl on the jump host's loopback and widens the *tunnel* instead.
pub fn port_forward_argv(
  context: Option<&str>,
  namespace: &str,
  target: &str,
  listen_port: u16,
  remote_port: &str,
  all_interfaces: bool,
) -> Vec<String> {
  let mut argv = kubectl_argv(
    context,
    Some(namespace),
    false,
    &[
      "port-forward".to_string(),
      target.to_string(),
      format!("{listen_port}:{remote_port}"),
    ],
  );
  if all_interfaces {
    argv.push("--address".into());
    argv.push("0.0.0.0".into());
  }
  argv
}

/// The address the panel shows for a forward.
pub fn listen_addr(local_port: u16, all_interfaces: bool) -> String {
  format!(
    "{}:{}",
    if all_interfaces {
      "0.0.0.0"
    } else {
      "127.0.0.1"
    },
    local_port
  )
}

/// Byte stream → complete lines in a bounded ring.
///
/// Lines are only decoded once their terminator has arrived, so a multi-byte character
/// split across reads can never be mangled into U+FFFD (the reason `commands`'
/// `split_incomplete_utf8` exists for the terminal path).
pub(crate) struct LineCollector {
  pending: Vec<u8>,
  lines: Arc<StdMutex<VecDeque<String>>>,
}

impl LineCollector {
  pub(crate) fn new(lines: Arc<StdMutex<VecDeque<String>>>) -> Self {
    Self {
      pending: Vec::new(),
      lines,
    }
  }

  pub(crate) fn push(&mut self, chunk: &[u8]) {
    self.pending.extend_from_slice(chunk);
    while let Some(pos) = self.pending.iter().position(|b| *b == b'\n') {
      let line: Vec<u8> = self.pending.drain(..=pos).collect();
      let text = String::from_utf8_lossy(&line[..pos])
        .trim_end_matches('\r')
        .to_string();
      if text.is_empty() {
        continue;
      }
      if let Ok(mut ring) = self.lines.lock() {
        while ring.len() >= MAX_LINES {
          ring.pop_front();
        }
        ring.push_back(text);
      }
    }
  }

  /// Emit a trailing line that never got its newline (the process was killed mid-write).
  pub(crate) fn flush(&mut self) {
    if self.pending.is_empty() {
      return;
    }
    let text = String::from_utf8_lossy(&std::mem::take(&mut self.pending))
      .trim_end()
      .to_string();
    if text.is_empty() {
      return;
    }
    if let Ok(mut ring) = self.lines.lock() {
      while ring.len() >= MAX_LINES {
        ring.pop_front();
      }
      ring.push_back(text);
    }
  }
}

/// Run `kubectl port-forward` on this machine. The returned pump task owns the child:
/// `kill_on_drop` means the task ending *is* the kill, so no process table is needed
/// (same trick as the Docker log pump). The sender stops it.
///
/// `id` names the registry row so the pump can release the local listener when the
/// process dies on its own — a dead forward must not leave a port bound.
pub(crate) async fn spawn_local_forward(
  app: tauri::AppHandle,
  id: u32,
  argv: Vec<String>,
  lines: Arc<StdMutex<VecDeque<String>>>,
  running: Arc<AtomicBool>,
) -> Result<(tauri::async_runtime::JoinHandle<()>, oneshot::Sender<()>), String> {
  let (cancel_tx, mut cancel_rx) = oneshot::channel::<()>();
  let mut cmd = Command::new(&argv[0]);
  cmd.hide_console();
  cmd
    .args(&argv[1..])
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .kill_on_drop(true);
  let mut child = cmd
    .spawn()
    .map_err(|e| format!("failed to start `{}`: {e}", argv[0]))?;
  let stdout = child
    .stdout
    .take()
    .ok_or_else(|| "kubectl port-forward gave us no stdout handle".to_string())?;
  let stderr = child.stderr.take();

  // kubectl's errors go to stderr, so it is collected too. Its own task: reading two
  // pipes from one select loop would need two live borrows of the collector ring.
  if let Some(err_pipe) = stderr {
    let err_lines = lines.clone();
    tauri::async_runtime::spawn(async move {
      let mut reader = BufReader::new(err_pipe);
      let mut col = LineCollector::new(err_lines);
      let mut buf = [0u8; 4096];
      loop {
        match reader.read(&mut buf).await {
          Ok(0) | Err(_) => break,
          Ok(n) => col.push(&buf[..n]),
        }
      }
      col.flush();
    });
  }

  let mut reader = BufReader::new(stdout);
  let mut col = LineCollector::new(lines.clone());
  Ok((
    tauri::async_runtime::spawn(async move {
      let mut buf = [0u8; 4096];
      loop {
        tokio::select! {
          _ = &mut cancel_rx => break,
          n = reader.read(&mut buf) => match n {
            // EOF: kubectl exited (port in use, target gone, cluster unreachable).
            Ok(0) | Err(_) => break,
            Ok(n) => col.push(&buf[..n]),
          }
        }
      }
      col.flush();
      running.store(false, Ordering::SeqCst);
      // Dropping the child here is what kills the process on the cancel path.
      drop(child);
      release_tunnel(&app, id);
    }),
    cancel_tx,
  ))
}

/// Run `kubectl port-forward` on a jump host over the session's exec channel, and read
/// both streams of the remote process into `lines`.
pub(crate) async fn spawn_jump_forward(
  app: tauri::AppHandle,
  id: u32,
  state: &tauri::State<'_, AppState>,
  jump_tab_id: u32,
  argv: Vec<String>,
  lines: Arc<StdMutex<VecDeque<String>>>,
  running: Arc<AtomicBool>,
) -> Result<(tauri::async_runtime::JoinHandle<()>, oneshot::Sender<()>), String> {
  let jump = crate::remote_fs::get_jump_handle(state, jump_tab_id)?;
  let mut channel = crate::docker_fs::exec_streaming_on_jump(&jump, &argv).await?;
  let (cancel_tx, mut cancel_rx) = oneshot::channel::<()>();
  let sink = lines.clone();
  Ok((
    tauri::async_runtime::spawn(async move {
      use russh::ChannelMsg;
      let mut col = LineCollector::new(sink);
      loop {
        tokio::select! {
          _ = &mut cancel_rx => break,
          msg = channel.wait() => match msg {
            Some(ChannelMsg::Data { data }) => col.push(&data),
            // stderr: kubectl's failure text (e.g. "unable to listen on 8080").
            Some(ChannelMsg::ExtendedData { ref data, .. }) => col.push(data),
            Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
            _ => {}
          }
        }
      }
      col.flush();
      running.store(false, Ordering::SeqCst);
      // Ask the server to close the channel; the remote kubectl sees EOF on its
      // stdout and exits. Without this the process would outlive the forward.
      let _ = channel.close().await;
      release_tunnel(&app, id);
    }),
    cancel_tx,
  ))
}

/// Stop the local listener a jump-host forward rides on, once the forward is gone: a
/// dead kubectl must not leave a port bound that silently refuses. Returns true when a
/// tunnel was released, so the caller can refresh the sidebar's tunnel list.
pub(crate) fn release_tunnel(app: &tauri::AppHandle, id: u32) -> bool {
  use tauri::{Emitter, Manager};
  let Some(state) = app.try_state::<AppState>() else {
    return false;
  };
  let tunnel_id = match state.k8s_forwards.lock() {
    Ok(mut map) => map.get_mut(&id).and_then(|rt| rt.tunnel_id.take()),
    Err(_) => return false,
  };
  let Some(tunnel_id) = tunnel_id else {
    return false;
  };
  crate::commands::tunnels::stop_tunnel_runtime(&state, tunnel_id);
  let _ = app.emit("tunnel-changed", serde_json::json!({}));
  true
}

/// Stop one forward: remove it from the registry, signal its pump, and drop the tunnel
/// that carried it (jump-host case). Returns false when the id is unknown.
pub fn stop_forward(state: &AppState, id: u32) -> bool {
  let runtime = state
    .k8s_forwards
    .lock()
    .ok()
    .and_then(|mut m| m.remove(&id));
  let Some(runtime) = runtime else { return false };
  // A pump that already ended drops the sender on exit, so a failed send is normal.
  let _ = runtime.cancel.send(());
  if let Some(tunnel_id) = runtime.tunnel_id {
    crate::commands::tunnels::stop_tunnel_runtime(state, tunnel_id);
  }
  true
}

/// Stop every forward carried by `tab_id`'s SSH session (called on disconnect). Their
/// tunnels are already being aborted by `cleanup_tunnels_for_tab`.
pub fn cleanup_forwards_for_tab(state: &AppState, tab_id: u32) {
  let ids: Vec<u32> = match state.k8s_forwards.lock() {
    Ok(map) => map
      .iter()
      .filter(|(_, f)| f.jump_tab_id == Some(tab_id))
      .map(|(id, _)| *id)
      .collect(),
    Err(_) => return,
  };
  for id in ids {
    stop_forward(state, id);
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn only_workload_targets_are_accepted() {
    assert_eq!(checked_target("pod/web-0").unwrap(), "pod/web-0");
    assert_eq!(checked_target("service/api").unwrap(), "service/api");
    // Trimmed, because the dialog's read-out is user-typed.
    assert_eq!(checked_target(" deploy/web ").unwrap(), "deploy/web");
    for bad in [
      "web-0",
      "secret/db-creds",
      "pod/",
      "pod/../etc",
      "pod/web 0",
      "pods;rm -rf/x",
    ] {
      assert!(checked_target(bad).is_err(), "{bad} should be rejected");
    }
  }

  #[test]
  fn a_remote_port_is_a_number_or_a_lowercase_name() {
    assert_eq!(checked_remote_port("80").unwrap(), "80");
    assert_eq!(checked_remote_port(" 8080 ").unwrap(), "8080");
    assert_eq!(checked_remote_port("http").unwrap(), "http");
    for bad in [
      "", "0", "70000", "80 80", "-80", "HTTP", "9p", "http!", "65536",
    ] {
      assert!(
        checked_remote_port(bad).is_err(),
        "{bad:?} should be rejected"
      );
    }
  }

  #[test]
  fn the_argv_binds_listen_and_target_and_widens_only_when_asked() {
    let argv = port_forward_argv(Some("prod"), "apps", "pod/web-0", 8080, "http", false);
    assert_eq!(
      argv,
      vec![
        "kubectl",
        "--context",
        "prod",
        "-n",
        "apps",
        "port-forward",
        "pod/web-0",
        "8080:http"
      ]
    );
    let wide = port_forward_argv(None, "default", "svc/api", 9000, "9000", true);
    assert_eq!(
      wide[wide.len() - 2..],
      ["--address".to_string(), "0.0.0.0".to_string()]
    );
    assert_eq!(listen_addr(9000, false), "127.0.0.1:9000");
    assert_eq!(listen_addr(9000, true), "0.0.0.0:9000");
  }

  #[test]
  fn collected_lines_survive_split_reads_and_drop_blanks() {
    let lines = Arc::new(StdMutex::new(VecDeque::new()));
    let mut col = LineCollector::new(lines.clone());
    // A CRLF line split across two reads, then a blank line and a trailing fragment.
    col.push(b"Forwarding from 127.0.0.1:80");
    col.push(b"80 -> 8080\r\n\r\nerror: unable to li");
    col.flush();
    let got = lines.lock().unwrap().clone();
    assert_eq!(
      got.iter().cloned().collect::<Vec<_>>(),
      vec![
        "Forwarding from 127.0.0.1:8080 -> 8080".to_string(),
        "error: unable to li".to_string()
      ]
    );
  }

  #[test]
  fn a_multibyte_line_split_across_reads_is_not_mangled() {
    let lines = Arc::new(StdMutex::new(VecDeque::new()));
    let mut col = LineCollector::new(lines.clone());
    let text = "日志: 中文输出\n".as_bytes();
    // Split in the middle of a 3-byte character.
    col.push(&text[..5]);
    col.push(&text[5..]);
    let got = lines.lock().unwrap().clone();
    assert_eq!(got.len(), 1);
    assert_eq!(got[0], "日志: 中文输出");
  }

  #[test]
  fn the_ring_keeps_only_the_newest_lines() {
    let lines = Arc::new(StdMutex::new(VecDeque::new()));
    let mut col = LineCollector::new(lines.clone());
    let mut feed = String::new();
    for i in 0..(MAX_LINES + 10) {
      feed.push_str(&format!("line {i}\n"));
    }
    col.push(feed.as_bytes());
    let got = lines.lock().unwrap().clone();
    assert_eq!(got.len(), MAX_LINES);
    // The newest MAX_LINES of the MAX_LINES + 10 fed: the first 10 were dropped.
    assert_eq!(got.front().unwrap(), "line 10");
    assert_eq!(got.back().unwrap(), &format!("line {}", MAX_LINES + 9));
  }
}

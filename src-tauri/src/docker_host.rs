//! Where a `docker …` argv actually runs: on a jump host over SSH, or on this machine
//! (`LOCAL-DOCKER-PLAN.md` P0).
//!
//! Every Docker feature in the app is an argv list that starts with `docker`. This
//! module owns the one thing that differs between the two transports — how that argv is
//! executed — so no command above it has to fork on "is this local".

use serde::{Deserialize, Serialize};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::ssh_session::AppState;

/// How long a probe may hang before the UI is told it failed. A CLI whose daemon is
/// down can block for many seconds on a socket connect, and the sidebar probes on boot.
const TIMEOUT: Duration = Duration::from_secs(3);

/// Which CLI answers on this machine, and whether its daemon is reachable. Every field
/// except `bin` is display-only; `bin` is what the local transport actually execs.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerProbe {
  pub installed: bool,
  pub server_running: bool,
  /// `"docker"` / `"podman"`, or `None` when neither is on PATH.
  pub bin: Option<String>,
  pub client_version: Option<String>,
  pub server_version: Option<String>,
  /// `DOCKER_HOST` as the environment sets it. Shown so a custom endpoint is not
  /// mistaken for the default daemon (decision ③: default context + `DOCKER_HOST` only).
  pub docker_host: Option<String>,
  /// Diagnostic text — the raw CLI error when the probe failed. UI labels come from the
  /// flags above through `t()`, not from here.
  pub message: String,
}

/// The CLI to try, in order. With `DOCKER_HOST` set only `docker` means anything:
/// podman talks to its own socket and would report a different daemon than the one the
/// user configured.
fn candidate_clis(docker_host: Option<&str>) -> &'static [&'static str] {
  match docker_host.map(str::trim) {
    Some(v) if !v.is_empty() => &["docker"],
    _ => &["docker", "podman"],
  }
}

/// Pull `(client, server)` out of
/// `docker version --format '{{.Client.Version}}\n{{.Server.Version}}'`. Either half can
/// be absent, and an unexpanded template prints `<no value>` rather than nothing — both
/// count as "unknown", never as a version string.
fn parse_version_lines(text: &str) -> (Option<String>, Option<String>) {
  let pick = |s: &str| -> Option<String> {
    let t = s.trim();
    (!t.is_empty() && t != "<no value>").then(|| t.to_string())
  };
  let mut lines = text.lines();
  (
    lines.next().map_or(None, |l| pick(l)),
    lines.next().map_or(None, |l| pick(l)),
  )
}

/// Run `bin args…` to completion under a hard timeout, capturing both streams.
/// An `Err` means the process could not be started or never finished; a non-zero exit
/// code is a successful run whose *result* failed, and comes back as `Ok(_, _, code)`.
async fn run_captured(
  bin: &str,
  args: &[&str],
  stdin: Option<&[u8]>,
) -> Result<(Vec<u8>, Vec<u8>, u32), String> {
  let mut cmd = Command::new(bin);
  cmd
    .args(args)
    .stdin(if stdin.is_some() {
      Stdio::piped()
    } else {
      Stdio::null()
    })
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    // A timed-out `docker logs -f` must not outlive the call that gave up on it.
    .kill_on_drop(true);
  let mut child = cmd
    .spawn()
    .map_err(|e| format!("failed to start `{bin}`: {e}"))?;
  if let Some(data) = stdin {
    if let Some(mut sink) = child.stdin.take() {
      let _ = sink.write_all(data).await;
      // Dropping the handle closes the pipe; without that the child waits for input.
      drop(sink);
    }
  }
  let joined = args.join(" ");
  let output = tokio::time::timeout(TIMEOUT, child.wait_with_output())
    .await
    .map_err(|_| format!("`{bin} {joined}` timed out after {}s", TIMEOUT.as_secs()))?
    .map_err(|e| format!("`{bin} {joined}` failed: {e}"))?;
  Ok((
    output.stdout,
    output.stderr,
    output.status.code().unwrap_or(-1) as u32,
  ))
}

/// Ask this machine what it has. Never fails: an unusable Docker is a `DockerProbe` with
/// `installed == false`, so the sidebar can show a retry instead of an error toast.
pub async fn probe_local() -> DockerProbe {
  let docker_host = std::env::var("DOCKER_HOST")
    .ok()
    .map(|v| v.trim().to_string())
    .filter(|v| !v.is_empty());

  for bin in candidate_clis(docker_host.as_deref()) {
    // `--version` answers with no daemon at all — that is the "installed" signal.
    let Ok((cout, _, 0)) = run_captured(bin, &["--version"], None).await else {
      continue;
    };
    let (client0, _) = parse_version_lines(&String::from_utf8_lossy(&cout));
    // `version` needs a reachable daemon, so its failure is exactly the difference
    // between "installed" and "daemon running".
    let fmt = "{{.Client.Version}}\n{{.Server.Version}}";
    return match run_captured(bin, &["version", "--format", fmt], None).await {
      Ok((out, _, 0)) => {
        let (client, server) = parse_version_lines(&String::from_utf8_lossy(&out));
        DockerProbe {
          installed: true,
          server_running: true,
          bin: Some(bin.to_string()),
          client_version: client.or(client0),
          server_version: server,
          docker_host,
          message: String::new(),
        }
      }
      Ok((_, err, _)) => DockerProbe {
        installed: true,
        server_running: false,
        bin: Some(bin.to_string()),
        client_version: client0,
        server_version: None,
        docker_host,
        message: String::from_utf8_lossy(&err).trim().to_string(),
      },
      Err(e) => DockerProbe {
        installed: true,
        server_running: false,
        bin: Some(bin.to_string()),
        client_version: client0,
        server_version: None,
        docker_host,
        message: e,
      },
    };
  }

  DockerProbe {
    installed: false,
    server_running: false,
    bin: None,
    client_version: None,
    server_version: None,
    docker_host,
    message: "no docker or podman CLI found on PATH".to_string(),
  }
}

/// The CLI to exec locally, probing and caching when nothing is known yet. Callers that
/// want to *display* capability should use `probe_local_docker` instead — this one is
/// allowed to fail, because it is called from a command the user already triggered.
pub async fn resolve_cli(state: &tauri::State<'_, AppState>) -> Result<String, String> {
  let cached = state
    .local_docker
    .lock()
    .ok()
    .and_then(|c| c.clone())
    .filter(|p| p.server_running)
    .and_then(|p| p.bin);
  if let Some(bin) = cached {
    return Ok(bin);
  }
  let probe = probe_local().await;
  let bin = probe.bin.clone();
  let running = probe.server_running;
  if let Ok(mut c) = state.local_docker.lock() {
    *c = Some(probe);
  }
  match bin {
    Some(b) if running => Ok(b),
    _ => Err(
      "no local Docker daemon is available (docker/podman not installed or not running)"
        .to_string(),
    ),
  }
}

/// The host a Docker command runs against. `Ssh` is the existing jump-host path;
/// `Local` is this machine.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum DockerHostRef {
  #[serde(rename = "ssh")]
  Ssh {
    #[serde(rename = "jumpTabId")]
    jump_tab_id: u32,
  },
  #[serde(rename = "local")]
  Local,
}

impl DockerHostRef {
  pub fn is_local(&self) -> bool {
    matches!(self, DockerHostRef::Local)
  }
}

/// Run a `docker …` argv on this machine. `argv[0]` is the CLI the caller asked for and
/// is replaced by whatever the probe resolved, so a podman host needs no other change;
/// the rest goes straight to the process — no shell, so `--format` templates and
/// container names need no quoting and cannot be interpolated into a command line.
pub async fn exec_local(
  state: &tauri::State<'_, AppState>,
  argv: &[String],
  stdin: Option<&[u8]>,
) -> Result<(Vec<u8>, Vec<u8>, u32), String> {
  if argv.is_empty() {
    return Err("empty docker argv".to_string());
  }
  let bin = resolve_cli(state).await?;
  exec_bin(&bin, &argv[1..], stdin).await
}

/// Run an already-resolved CLI with `args` (everything *after* the program name).
/// `exec_local` is this plus the probe lookup; the container filesystem runner resolves
/// the CLI once when its target is built and calls this directly, so it never needs
/// `State` in its `Runner::run`.
pub async fn exec_bin(
  bin: &str,
  args: &[String],
  stdin: Option<&[u8]>,
) -> Result<(Vec<u8>, Vec<u8>, u32), String> {
  let refs: Vec<&str> = args.iter().map(String::as_str).collect();
  run_captured(bin, &refs, stdin).await
}

/// The one entry point every Docker command should use.
pub async fn exec_docker(
  state: &tauri::State<'_, AppState>,
  host: &DockerHostRef,
  argv: &[String],
  stdin: Option<&[u8]>,
) -> Result<(Vec<u8>, Vec<u8>, u32), String> {
  match host {
    DockerHostRef::Ssh { jump_tab_id } => {
      let jump = crate::remote_fs::get_jump_handle(state, *jump_tab_id)?;
      crate::docker_fs::exec_on_jump(&jump, argv, stdin).await
    }
    DockerHostRef::Local => exec_local(state, argv, stdin).await,
  }
}

/// Run a `docker …` argv that must succeed, and return its stdout. Start / stop /
/// restart / remove and one-shot logs all reduce to this, so "a non-zero exit is an
/// error, and name the verb that failed" lives in one place.
pub async fn exec_docker_ok(
  state: &tauri::State<'_, AppState>,
  host: &DockerHostRef,
  argv: &[String],
) -> Result<Vec<u8>, String> {
  let verb = argv.get(1).cloned().unwrap_or_default();
  let (out, err, status) = exec_docker(state, host, argv, None).await?;
  if status != 0 {
    return Err(format!(
      "docker {} failed (exit {}): {}",
      verb,
      status,
      String::from_utf8_lossy(&err).trim()
    ));
  }
  Ok(out)
}

/// Begin a long-running `docker logs -f …` and hand back its stdout as a chunk stream.
///
/// Both transports are bridged into the same `mpsc` so the command layer has one shape
/// to drain. The pump task *owns* the transport and stops when the receiver is dropped —
/// which is how stopping a stream kills the local process: the child is `kill_on_drop`,
/// so the pump exiting is the kill, and no stream_id → Child table is needed.
pub async fn exec_docker_streaming(
  state: &tauri::State<'_, AppState>,
  host: &DockerHostRef,
  argv: &[String],
) -> Result<tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>, String> {
  let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
  match host {
    DockerHostRef::Ssh { jump_tab_id } => {
      let jump = crate::remote_fs::get_jump_handle(state, *jump_tab_id)?;
      let mut channel = crate::docker_fs::exec_streaming_on_jump(&jump, argv).await?;
      tauri::async_runtime::spawn(async move {
        use russh::ChannelMsg;
        while let Some(msg) = channel.wait().await {
          match msg {
            ChannelMsg::Data { data } => {
              if tx.send(data.to_vec()).is_err() {
                break; // the receiver went away — stop reading
              }
            }
            ChannelMsg::Eof | ChannelMsg::Close => break,
            _ => {}
          }
        }
      });
    }
    DockerHostRef::Local => {
      let bin = resolve_cli(state).await?;
      let args: Vec<&str> = argv[1..].iter().map(String::as_str).collect();
      let mut child = Command::new(&bin)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("failed to start `{bin}`: {e}"))?;
      // `take()` moves the pipe out so the `Child` itself stays whole: dropping it at the
      // end of this task is what sends the kill to `docker logs -f`.
      let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "docker logs -f gave us no stdout handle".to_string())?;
      let mut reader = tokio::io::BufReader::new(stdout);
      tauri::async_runtime::spawn(async move {
        use tokio::io::AsyncReadExt;
        let mut buf = vec![0u8; 8 * 1024];
        loop {
          match reader.read(&mut buf).await {
            Ok(0) | Err(_) => break, // EOF (the container went away) or a read error
            Ok(n) => {
              if tx.send(buf[..n].to_vec()).is_err() {
                break;
              }
            }
          }
        }
        drop(child);
      });
    }
  }
  Ok(rx)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn a_custom_docker_host_disqualifies_podman() {
    assert_eq!(candidate_clis(Some("tcp://build:2376")), vec!["docker"]);
    assert_eq!(candidate_clis(None), vec!["docker", "podman"]);
    // An empty or blank setting is the same as not setting it.
    assert_eq!(candidate_clis(Some("   ")), vec!["docker", "podman"]);
  }

  #[test]
  fn version_lines_tolerate_a_missing_or_unexpanded_half() {
    assert_eq!(
      parse_version_lines("27.1.1\n27.1.1\n"),
      (Some("27.1.1".into()), Some("27.1.1".into()))
    );
    // A daemon that printed nothing for the server row is "unknown", not Some("").
    assert_eq!(
      parse_version_lines("27.1.1\n"),
      (Some("27.1.1".into()), None)
    );
    assert_eq!(
      parse_version_lines("27.1.1\n<no value>\n"),
      (Some("27.1.1".into()), None)
    );
    assert_eq!(parse_version_lines(""), (None, None));
  }

  #[test]
  fn the_local_host_round_trips_as_the_tagged_form_the_frontend_sends() {
    let local: DockerHostRef = serde_json::from_str(r#"{"kind":"local"}"#).unwrap();
    assert!(local.is_local());
    let ssh: DockerHostRef = serde_json::from_str(r#"{"kind":"ssh","jumpTabId":7}"#).unwrap();
    match ssh {
      DockerHostRef::Ssh { jump_tab_id } => assert_eq!(jump_tab_id, 7),
      DockerHostRef::Local => panic!("ssh host decoded as local"),
    }
  }

  /// Against a real daemon: `cargo test -- -- --ignored` on a machine that has one.
  ///
  /// Gated twice on purpose. `#[ignore]` keeps it out of the ordinary run (this repo's
  /// convention for host-dependent tests), and the env check means someone who runs
  /// `--ignored` on a machine *without* Docker gets a printed reason and a green result
  /// rather than a failure — the plan is explicit that this must never hang on a timeout.
  #[tokio::test]
  #[ignore]
  async fn probes_the_real_local_daemon() {
    let probe = probe_local().await;
    if !probe.installed {
      eprintln!(
        "SKIP: no docker/podman CLI on PATH ({}). Start Docker Desktop, or run this on a \
         machine with one — it is also skipped unless passed `--ignored`.",
        probe.message
      );
      return;
    }
    let bin = probe.bin.clone().expect("installed implies a resolved CLI");
    assert!(bin == "docker" || bin == "podman", "unexpected CLI {bin}");

    // The same spawn path the commands use, with no shell in between.
    let (out, _err, status) = exec_bin(&bin, &["--version".to_string()], None)
      .await
      .expect("`--version` should spawn once the probe found the CLI");
    assert_eq!(status, 0);
    assert!(
      String::from_utf8_lossy(&out)
        .to_ascii_lowercase()
        .contains("version"),
      "unexpected `--version` output: {}",
      String::from_utf8_lossy(&out)
    );

    if !probe.server_running {
      eprintln!(
        "SKIP: {bin} is installed but its daemon is not running ({}).",
        probe.message
      );
      return;
    }
    let (out, err, status) = exec_bin(
      &bin,
      &[
        "ps".to_string(),
        "-a".to_string(),
        "--format".to_string(),
        "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}".to_string(),
      ],
      None,
    )
    .await
    .expect("`docker ps` should spawn against a running daemon");
    assert_eq!(
      status,
      0,
      "`ps` failed while the probe reported the daemon up: {}",
      String::from_utf8_lossy(&err)
    );
    eprintln!(
      "OK: {bin} client={} server={} running, {} container line(s)",
      probe.client_version.unwrap_or_default(),
      probe.server_version.unwrap_or_default(),
      String::from_utf8_lossy(&out).lines().count(),
    );
  }
}

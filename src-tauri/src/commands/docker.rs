// ==================== Docker host (this machine / jump host) ====================
//
// `LOCAL-DOCKER-PLAN.md` P0. The sidebar cannot offer 「本机 Docker」 until it knows
// whether this machine has a Docker CLI and a reachable daemon, and the one read-only
// command it needs (`docker ps`) has to accept either host. The mutating operations —
// start / stop / logs / analysis — still take a jump tab id and move here in P1 / P3.

use super::*;
use crate::docker_host::{DockerHostRef, DockerProbe};

/// What this machine has: is a CLI installed, is its daemon reachable, which binary do
/// local commands exec. Cached in `AppState::local_docker` because the sidebar probes on
/// boot; `refresh` (the 重试 affordance) drops the cache and asks again.
///
/// Never returns `Err` for "no Docker here" — that is a `DockerProbe` with
/// `installed == false`, so the UI can show a retry line instead of an error toast.
#[tauri::command]
pub async fn probe_local_docker(
  state: tauri::State<'_, AppState>,
  refresh: Option<bool>,
) -> Result<DockerProbe, String> {
  if refresh.unwrap_or(false) {
    if let Ok(mut cache) = state.local_docker.lock() {
      *cache = None;
    }
  }
  if let Some(cached) = state.local_docker.lock().ok().and_then(|c| c.clone()) {
    return Ok(cached);
  }
  let probe = crate::docker_host::probe_local().await;
  if let Ok(mut cache) = state.local_docker.lock() {
    *cache = Some(probe.clone());
  }
  Ok(probe)
}

/// List Docker containers reachable from `host`: a connected jump-host tab, or this
/// machine.
#[tauri::command]
pub async fn list_docker_containers(
  state: tauri::State<'_, AppState>,
  host: DockerHostRef,
) -> Result<Vec<ContainerInfo>, String> {
  crate::docker_fs::list_docker_containers(&state, &host).await
}

/// Analyse a Docker container — the three-layer report (inspect / in-container probe /
/// stats) — against whichever daemon `host` names.
#[tauri::command]
pub async fn analyze_docker_container(
  state: tauri::State<'_, AppState>,
  host: DockerHostRef,
  container_name: String,
) -> Result<crate::docker_analysis::DockerAnalysis, String> {
  // The report still carries the session tab it was asked from, for the panel that owns
  // it; a local container has no jump session, so 0.
  let tab_id = match &host {
    DockerHostRef::Ssh { jump_tab_id } => *jump_tab_id,
    DockerHostRef::Local => 0,
  };
  crate::docker_analysis::analyze_docker_container(&state, &host, &container_name, tab_id).await
}

/// Fetch logs from a Docker container: `docker logs --tail N <container>`.
#[tauri::command]
pub async fn docker_container_logs(
  state: tauri::State<'_, AppState>,
  host: DockerHostRef,
  container_name: String,
  tail_lines: Option<u32>,
) -> Result<String, String> {
  let tail = tail_lines.unwrap_or(200).to_string();
  let argv = vec![
    "docker".into(),
    "logs".into(),
    "--tail".into(),
    tail,
    container_name.clone(),
  ];
  // The exit status is deliberately not checked: a container that writes to *its* stderr
  // makes `docker logs` report that stream as an error even though it succeeded, so
  // treating non-zero as failure would hide the log text the user asked for. Only a
  // transport failure (no CLI, jump host gone) is an error here.
  match crate::docker_host::exec_docker(&state, &host, &argv, None).await {
    Ok((out, _err, _status)) => Ok(String::from_utf8_lossy(&out).to_string()),
    Err(e) => Err(format!("docker logs failed for {}: {}", container_name, e)),
  }
}

/// The four lifecycle verbs are the same call with a different word in it.
async fn docker_lifecycle(
  state: &tauri::State<'_, AppState>,
  host: &DockerHostRef,
  verb: &str,
  container_name: String,
) -> Result<(), String> {
  let argv = vec!["docker".into(), verb.into(), container_name];
  crate::docker_host::exec_docker_ok(state, host, &argv)
    .await
    .map(|_| ())
}

/// Restart a Docker container: `docker restart <container>`.
#[tauri::command]
pub async fn restart_docker_container(
  state: tauri::State<'_, AppState>,
  host: DockerHostRef,
  container_name: String,
) -> Result<(), String> {
  docker_lifecycle(&state, &host, "restart", container_name).await
}

/// Stop a running Docker container: `docker stop <container>`.
#[tauri::command]
pub async fn stop_docker_container(
  state: tauri::State<'_, AppState>,
  host: DockerHostRef,
  container_name: String,
) -> Result<(), String> {
  docker_lifecycle(&state, &host, "stop", container_name).await
}

/// Start a stopped Docker container: `docker start <container>`.
#[tauri::command]
pub async fn start_docker_container(
  state: tauri::State<'_, AppState>,
  host: DockerHostRef,
  container_name: String,
) -> Result<(), String> {
  docker_lifecycle(&state, &host, "start", container_name).await
}

/// Remove a Docker container: `docker rm <container>` (only valid once it is stopped).
#[tauri::command]
pub async fn remove_docker_container(
  state: tauri::State<'_, AppState>,
  host: DockerHostRef,
  container_name: String,
) -> Result<(), String> {
  docker_lifecycle(&state, &host, "rm", container_name).await
}

/// Start streaming `docker logs --tail N -f <container>`.
/// Returns a stream_id for use with `poll_docker_logs` / `stop_docker_logs_stream`.
#[tauri::command]
pub async fn docker_logs_stream_start(
  app: tauri::AppHandle,
  state: tauri::State<'_, AppState>,
  host: DockerHostRef,
  container_name: String,
  tail_lines: Option<u32>,
) -> Result<String, String> {
  let tail = tail_lines.unwrap_or(200).to_string();
  let argv = vec![
    "docker".to_string(),
    "logs".to_string(),
    "--tail".to_string(),
    tail,
    "-f".to_string(),
    container_name.clone(),
  ];
  // Opened before the id exists on purpose: whatever the pump reads in between sits in
  // its mpsc queue, so no line is lost between here and the loop below.
  let mut rx = crate::docker_host::exec_docker_streaming(&state, &host, &argv).await?;

  let stream_id = {
    let id = state
      .next_docker_log_stream_id
      .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("dlog_{}", id)
  };
  let (shutdown_tx, mut shutdown_rx) = tokio::sync::oneshot::channel::<()>();
  {
    let mut streams = state.docker_log_streams.lock().map_err(|e| e.to_string())?;
    streams.insert(stream_id.clone(), shutdown_tx);
  }

  let sid = stream_id.clone();
  let container = container_name.clone();
  tauri::async_runtime::spawn(async move {
    loop {
      tokio::select! {
        _ = &mut shutdown_rx => {
          eprintln!("[docker-logs-stream] {} ({}) shutdown signaled", sid, container);
          break;
        }
        chunk = rx.recv() => match chunk {
          Some(bytes) => {
            if let Some(app_state) = app.try_state::<AppState>() {
              if let Ok(mut buffers) = app_state.docker_log_buffers.lock() {
                buffers
                  .entry(sid.clone())
                  .or_default()
                  .push(String::from_utf8_lossy(&bytes).to_string());
              }
            }
          }
          // The pump ended: the jump channel closed, or the local process exited
          // (container removed, daemon stopped).
          None => {
            eprintln!("[docker-logs-stream] {} ({}) ended", sid, container);
            break;
          }
        }
      }
    }
    // Dropping `rx` is what tears the transport down: the pump's sends start failing,
    // it returns, and the `kill_on_drop` child dies with it.
    drop(rx);
    if let Some(app_state) = app.try_state::<AppState>() {
      if let Ok(mut streams) = app_state.docker_log_streams.lock() {
        streams.remove(&sid);
      }
    }
  });

  eprintln!(
    "[docker-logs-stream] started stream_id={} for container={} local={}",
    stream_id,
    container_name,
    host.is_local()
  );
  Ok(stream_id)
}

/// Poll new output chunks from a running `docker logs -f` stream.
#[tauri::command]
pub async fn poll_docker_logs(
  state: tauri::State<'_, AppState>,
  stream_id: String,
) -> Result<Vec<String>, String> {
  let mut buffers = state.docker_log_buffers.lock().map_err(|e| e.to_string())?;
  let chunks = buffers.remove(&stream_id).unwrap_or_default();
  Ok(chunks)
}

/// Stop a running `docker logs -f` stream.
#[tauri::command]
pub async fn stop_docker_logs_stream(
  state: tauri::State<'_, AppState>,
  stream_id: String,
) -> Result<bool, String> {
  let tx = {
    let mut streams = state.docker_log_streams.lock().map_err(|e| e.to_string())?;
    streams.remove(&stream_id)
  };
  if let Some(tx) = tx {
    let _ = tx.send(());
    // Also clean up any remaining buffer
    if let Ok(mut buffers) = state.docker_log_buffers.lock() {
      buffers.remove(&stream_id);
    }
    eprintln!("[docker-logs-stream] stopped stream_id={}", stream_id);
    Ok(true)
  } else {
    Ok(false)
  }
}

/// What a `command -v bash` probe answers: the path when the image has bash, otherwise
/// `sh`. When even the lookup fails (a distroless image, or a container that just
/// stopped) `sh` is still what gets spawned, so the daemon's own complaint is what lands
/// in the terminal instead of a second error the user cannot act on.
fn shell_from_probe(out: Option<&[u8]>) -> String {
  match out.map(|b| String::from_utf8_lossy(b).trim().to_string()) {
    Some(found) if !found.is_empty() => found,
    _ => "/bin/sh".to_string(),
  }
}

/// The shell to run inside a container: `bash` when the image has one — readline and
/// history are worth the extra round trip — otherwise `sh`.
async fn pick_container_shell(bin: &str, container: &str) -> String {
  let argv = vec![
    "exec".to_string(),
    container.to_string(),
    "sh".to_string(),
    "-c".to_string(),
    "command -v bash".to_string(),
  ];
  match crate::docker_host::exec_bin(bin, &argv, None).await {
    Ok((out, _, 0)) => shell_from_probe(Some(&out)),
    _ => shell_from_probe(None),
  }
}

/// Open a terminal running `<cli> exec -it <container> <shell>` on this machine — a
/// local container's shell as a real PTY, not `docker exec` typed into some other
/// session's terminal (`LOCAL-DOCKER-PLAN.md` P2b, decision ⑤). It registers as an
/// ordinary local shell, so input / resize / close / the exit notification all follow
/// the existing local-terminal path.
#[tauri::command]
pub async fn open_local_docker_shell(
  app: tauri::AppHandle,
  state: tauri::State<'_, AppState>,
  tab_id: u32,
  container: String,
  reuse_existing: bool,
  cols: u32,
  rows: u32,
) -> Result<(), String> {
  // Same remount rule as the local terminal: a floated tab that is re-attaching must
  // not restart the shell it already has.
  if reuse_existing && crate::commands::local_shell::live_local_shell(&state, tab_id)? {
    eprintln!(
      "[open_local_docker_shell] reusing live shell for tab={}",
      tab_id
    );
    return Ok(());
  }
  let container = container.trim().to_string();
  if container.is_empty() {
    return Err("no container name given".to_string());
  }
  let bin = crate::docker_host::resolve_cli(&state).await?;
  let shell = pick_container_shell(&bin, &container).await;
  let args = vec!["exec".to_string(), "-it".to_string(), container, shell];
  // No cwd: the container's own workdir is what the process starts in.
  crate::commands::local_shell::spawn_local_pty(app, &state, tab_id, bin, args, None, cols, rows)
    .await
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn a_container_with_bash_gets_bash() {
    assert_eq!(shell_from_probe(Some(b"/usr/bin/bash\n")), "/usr/bin/bash");
  }

  #[test]
  fn an_empty_or_failed_probe_falls_back_to_sh() {
    // `command -v bash` exits non-zero on a slim image, and some runtimes print an
    // empty line rather than nothing.
    assert_eq!(shell_from_probe(Some(b"")), "/bin/sh");
    assert_eq!(shell_from_probe(Some(b"  \r\n")), "/bin/sh");
    assert_eq!(shell_from_probe(None), "/bin/sh");
  }
}

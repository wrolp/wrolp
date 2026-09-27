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

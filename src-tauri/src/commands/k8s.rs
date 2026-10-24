//! Kubernetes panel commands.
//!
//! Every command is a `kubectl` argv executed on the jump host (over the interactive
//! session's exec channel) or on this machine. Parsing lives in [`crate::k8s_host`] so
//! it can be unit-tested without a cluster.

use super::*;
use crate::k8s_host::{
  exec_kubectl, kubectl_argv, parse_contexts, parse_namespaces, parse_resources, K8sContext,
  K8sHostRef, K8sNamespace, K8sResource, RESOURCE_KINDS,
};
use serde_json::Value;

/// Reject anything outside the panel's allow-list. This is the only place a
/// frontend-provided kind reaches kubectl, and it must be one of our words — never an
/// anchored argument that starts with `-`.
fn checked_kind(kind: &str) -> Result<&'static str, String> {
  let k = kind.trim().to_ascii_lowercase();
  RESOURCE_KINDS
    .iter()
    .copied()
    .find(|allowed| *allowed == k)
    .ok_or_else(|| format!("unsupported Kubernetes resource kind: {kind}"))
}

/// `kubectl [--context C] …` for cluster-scoped reads (contexts, namespaces).
fn context_argv(context: Option<&str>, rest: &[&str]) -> Vec<String> {
  let mut argv = vec!["kubectl".to_string()];
  if let Some(ctx) = context.map(str::trim).filter(|c| !c.is_empty()) {
    argv.push("--context".into());
    argv.push(ctx.to_string());
  }
  argv.extend(rest.iter().map(|s| s.to_string()));
  argv
}

fn failure(verb: &str, err: &[u8], status: u32) -> String {
  format!(
    "kubectl {verb} failed (exit {status}): {}",
    String::from_utf8_lossy(err).trim()
  )
}

fn stdout_or_error(verb: &str, out: Vec<u8>, err: Vec<u8>, status: u32) -> Result<String, String> {
  if status != 0 {
    return Err(failure(verb, &err, status));
  }
  Ok(String::from_utf8_lossy(&out).to_string())
}

/// kubeconfig contexts, current one flagged. An empty list means the file has none —
/// not an error; the panel shows "no contexts".
#[tauri::command]
pub async fn k8s_list_contexts(
  state: tauri::State<'_, AppState>,
  host: K8sHostRef,
) -> Result<Vec<K8sContext>, String> {
  let argv = context_argv(None, &["config", "view", "-o", "json"]);
  let (out, err, status) = exec_kubectl(&state, &host, &argv, None)
    .await
    .map_err(|e| format!("kubectl is not available on this host: {e}"))?;
  if status != 0 {
    return Err(failure("config view", &err, status));
  }
  let cfg: Value = serde_json::from_slice(&out)
    .map_err(|e| format!("kubectl returned invalid kubeconfig JSON: {e}"))?;
  Ok(parse_contexts(&cfg))
}

/// Namespaces visible to the selected context.
#[tauri::command]
pub async fn k8s_list_namespaces(
  state: tauri::State<'_, AppState>,
  host: K8sHostRef,
  context: Option<String>,
) -> Result<Vec<K8sNamespace>, String> {
  let argv = context_argv(context.as_deref(), &["get", "namespaces", "-o", "json"]);
  let (out, err, status) = exec_kubectl(&state, &host, &argv, None).await?;
  if status != 0 {
    return Err(failure("get namespaces", &err, status));
  }
  let json: Value = serde_json::from_slice(&out)
    .map_err(|e| format!("kubectl returned invalid namespace JSON: {e}"))?;
  Ok(parse_namespaces(&json))
}

/// One kind's objects. `namespace` of `None` / `""` / `"*"` means all namespaces.
#[tauri::command]
pub async fn k8s_list_resources(
  state: tauri::State<'_, AppState>,
  host: K8sHostRef,
  context: Option<String>,
  namespace: Option<String>,
  kind: String,
) -> Result<Vec<K8sResource>, String> {
  let kind = checked_kind(&kind)?;
  let all = matches!(
    namespace.as_deref().map(str::trim),
    None | Some("") | Some("*")
  );
  let argv = kubectl_argv(
    context.as_deref(),
    namespace.as_deref(),
    all,
    &[
      "get".to_string(),
      kind.to_string(),
      "-o".to_string(),
      "json".to_string(),
    ],
  );
  let (out, err, status) = exec_kubectl(&state, &host, &argv, None).await?;
  if status != 0 {
    return Err(failure(&format!("get {kind}"), &err, status));
  }
  let json: Value = serde_json::from_slice(&out)
    .map_err(|e| format!("kubectl returned invalid {kind} JSON: {e}"))?;
  Ok(parse_resources(kind, &json))
}

/// The object's full YAML, for the read-only describe modal.
#[tauri::command]
pub async fn k8s_resource_yaml(
  state: tauri::State<'_, AppState>,
  host: K8sHostRef,
  context: Option<String>,
  namespace: Option<String>,
  kind: String,
  name: String,
) -> Result<String, String> {
  let kind = checked_kind(&kind)?;
  let argv = kubectl_argv(
    context.as_deref(),
    namespace.as_deref(),
    false,
    &[
      "get".to_string(),
      kind.to_string(),
      name.clone(),
      "-o".to_string(),
      "yaml".to_string(),
    ],
  );
  let (out, err, status) = exec_kubectl(&state, &host, &argv, None).await?;
  stdout_or_error(&format!("get {kind} {name} -o yaml"), out, err, status)
}

/// `kubectl logs --tail N`, optionally for one container of a multi-container pod.
#[tauri::command]
pub async fn k8s_pod_logs(
  state: tauri::State<'_, AppState>,
  host: K8sHostRef,
  context: Option<String>,
  namespace: Option<String>,
  pod: String,
  container: Option<String>,
  tail_lines: Option<u32>,
) -> Result<String, String> {
  let tail = tail_lines.unwrap_or(500).to_string();
  let mut args = vec!["logs".to_string(), pod.clone(), "--tail".to_string(), tail];
  if let Some(c) = container
    .as_deref()
    .map(str::trim)
    .filter(|c| !c.is_empty())
  {
    args.push("-c".into());
    args.push(c.to_string());
  }
  let argv = kubectl_argv(context.as_deref(), namespace.as_deref(), false, &args);
  // A pod whose container writes to stderr still logs successfully; only a
  // transport failure is an error here, so the text the user asked for is never
  // replaced by a status word.
  match exec_kubectl(&state, &host, &argv, None).await {
    Ok((out, _, 0)) => Ok(String::from_utf8_lossy(&out).to_string()),
    Ok((_, err, status)) => Err(failure(&format!("logs {pod}"), &err, status)),
    Err(e) => Err(format!("kubectl logs failed for {pod}: {e}")),
  }
}

/// Delete one object. `--wait=false` returns as soon as the deletion is accepted —
/// pods sit in Terminating for their grace period and blocking the panel on that
/// would look like a hang.
#[tauri::command]
pub async fn k8s_delete_resource(
  state: tauri::State<'_, AppState>,
  host: K8sHostRef,
  context: Option<String>,
  namespace: Option<String>,
  kind: String,
  name: String,
) -> Result<(), String> {
  let kind = checked_kind(&kind)?;
  let argv = kubectl_argv(
    context.as_deref(),
    namespace.as_deref(),
    false,
    &[
      "delete".to_string(),
      kind.to_string(),
      name.clone(),
      "--wait=false".to_string(),
    ],
  );
  let (out, err, status) = exec_kubectl(&state, &host, &argv, None).await?;
  stdout_or_error(&format!("delete {kind} {name}"), out, err, status).map(|_| ())
}

/// `kubectl scale` for the workload kinds that support it.
#[tauri::command]
pub async fn k8s_scale_resource(
  state: tauri::State<'_, AppState>,
  host: K8sHostRef,
  context: Option<String>,
  namespace: Option<String>,
  kind: String,
  name: String,
  replicas: u32,
) -> Result<String, String> {
  let kind = checked_kind(&kind)?;
  if !matches!(kind, "deployments" | "statefulsets") {
    return Err(format!("{kind} cannot be scaled"));
  }
  let argv = kubectl_argv(
    context.as_deref(),
    namespace.as_deref(),
    false,
    &[
      "scale".to_string(),
      format!("{kind}/{name}"),
      format!("--replicas={replicas}"),
    ],
  );
  let (out, err, status) = exec_kubectl(&state, &host, &argv, None).await?;
  stdout_or_error(&format!("scale {kind}/{name}"), out, err, status)
}

/// Apply a YAML document from the panel's editor. The document goes over stdin, so
/// `kubectl apply -f -` handles multi-document files and never sees a temp path.
#[tauri::command]
pub async fn k8s_apply_yaml(
  state: tauri::State<'_, AppState>,
  host: K8sHostRef,
  context: Option<String>,
  namespace: Option<String>,
  yaml: String,
) -> Result<String, String> {
  if yaml.trim().is_empty() {
    return Err("nothing to apply: the YAML document is empty".to_string());
  }
  // With an explicit namespace we scope the request (`-n`). For "all namespaces"
  // the manifest's own metadata.namespace decides, so no `-n` is added.
  let scoped = namespace
    .as_deref()
    .map(str::trim)
    .filter(|n| !n.is_empty() && *n != "*");
  let mut argv = context_argv(context.as_deref(), &[]);
  if let Some(ns) = scoped {
    argv.push("-n".into());
    argv.push(ns.to_string());
  }
  argv.push("apply".into());
  argv.push("-f".into());
  argv.push("-".into());
  let (out, err, status) = exec_kubectl(&state, &host, &argv, Some(yaml.as_bytes())).await?;
  let mut text = String::from_utf8_lossy(&out).to_string();
  text.push_str(&String::from_utf8_lossy(&err));
  if status != 0 {
    return Err(format!(
      "kubectl apply failed (exit {status}): {}",
      text.trim()
    ));
  }
  Ok(text.trim().to_string())
}

/// The shell line that enters a pod's shell from an SSH terminal. The frontend types
/// it as the pane's `postConnectCmd`, so a reconnect re-enters the same pod.
#[tauri::command]
pub fn k8s_pod_exec_command(
  context: Option<String>,
  namespace: String,
  pod: String,
  container: Option<String>,
) -> Result<String, String> {
  if pod.trim().is_empty() {
    return Err("missing pod name".to_string());
  }
  Ok(crate::k8s_host::pod_exec_command(
    context.as_deref(),
    &namespace,
    &pod,
    container.as_deref(),
  ))
}

/// Open a PTY running `kubectl exec -it <pod> -- /bin/sh` on this machine. Mirrors
/// `open_local_docker_shell`: a local cluster's pod shell is a real PTY of its own,
/// not a command typed into somebody else's session.
#[tauri::command]
pub async fn open_local_kubectl_shell(
  app: tauri::AppHandle,
  state: tauri::State<'_, AppState>,
  tab_id: u32,
  context: Option<String>,
  namespace: String,
  pod: String,
  container: Option<String>,
  reuse_existing: bool,
  cols: u32,
  rows: u32,
) -> Result<(), String> {
  if reuse_existing && crate::commands::local_shell::live_local_shell(&state, tab_id)? {
    eprintln!(
      "[open_local_kubectl_shell] reusing live shell for tab={}",
      tab_id
    );
    return Ok(());
  }
  if pod.trim().is_empty() {
    return Err("missing pod name".to_string());
  }
  // `pod_exec_args` starts with the program name; the PTY spawn takes it separately.
  let args =
    crate::k8s_host::pod_exec_args(context.as_deref(), &namespace, &pod, container.as_deref())
      .into_iter()
      .skip(1)
      .collect();
  crate::commands::local_shell::spawn_local_pty(
    app,
    &state,
    tab_id,
    "kubectl".to_string(),
    args,
    None,
    cols,
    rows,
  )
  .await
}

// ==================== Port forwarding ====================

/// Start `kubectl port-forward <target> <localPort>:<remotePort>` and keep it running.
///
/// The jump-host case is two hops and both are started here: kubectl binds the port on
/// the jump host's loopback, and an `ssh -L` tunnel (see
/// [`crate::commands::tunnels::start_tunnel_runtime`]) maps the same port number from
/// this machine onto that listener. `all_interfaces` widens whichever end the *user*
/// connects to — the local process's bind address, or the tunnel's.
#[tauri::command]
pub async fn k8s_port_forward_start(
  app: tauri::AppHandle,
  state: tauri::State<'_, AppState>,
  host: K8sHostRef,
  context: Option<String>,
  namespace: String,
  target: String,
  local_port: u16,
  remote_port: String,
  all_interfaces: Option<bool>,
) -> Result<u32, String> {
  let target = crate::k8s_forward::checked_target(&target)?;
  let remote = crate::k8s_forward::checked_remote_port(&remote_port)?;
  if local_port == 0 {
    return Err("choose a local port to listen on".to_string());
  }
  let all_if = all_interfaces.unwrap_or(false);
  let ctx = context
    .as_deref()
    .map(str::trim)
    .filter(|c| !c.is_empty())
    .map(str::to_string);
  let ns = {
    let t = namespace.trim();
    (if t.is_empty() { "default" } else { t }).to_string()
  };
  let jump_tab_id = match &host {
    K8sHostRef::Ssh { jump_tab_id } => Some(*jump_tab_id),
    K8sHostRef::Local => None,
  };
  let host_kind: &'static str = if jump_tab_id.is_some() {
    "ssh"
  } else {
    "local"
  };
  // Only the local case lets kubectl itself bind on 0.0.0.0: a jump host is somebody
  // else's machine, and exposing a pod port on its interface is not ours to decide.
  let argv = crate::k8s_forward::port_forward_argv(
    ctx.as_deref(),
    &ns,
    &target,
    local_port,
    &remote,
    all_if && host_kind == "local",
  );

  let id = state.next_k8s_forward_id.fetch_add(1, Ordering::Relaxed) as u32;
  let lines = Arc::new(StdMutex::new(std::collections::VecDeque::<String>::new()));
  let running = Arc::new(AtomicBool::new(true));
  let (_pump, cancel) = match jump_tab_id {
    // Dropping the JoinHandle detaches the pump; it is stopped through `cancel`.
    None => {
      crate::k8s_forward::spawn_local_forward(app.clone(), id, argv, lines.clone(), running.clone())
        .await?
    }
    Some(tab) => {
      crate::k8s_forward::spawn_jump_forward(
        app.clone(),
        id,
        &state,
        tab,
        argv,
        lines.clone(),
        running.clone(),
      )
      .await?
    }
  };

  // The second hop. A tunnel that cannot bind means the forward is unreachable from
  // here, so the kubectl process is unwound rather than left half-alive.
  let mut tunnel_id = None;
  if let Some(tab) = jump_tab_id {
    let args = StartTunnelArgs {
      tab_id: tab,
      connection_id: None,
      config_id: None,
      local_addr: Some(if all_if { "0.0.0.0" } else { "127.0.0.1" }.to_string()),
      local_port,
      remote_host: "127.0.0.1".to_string(),
      remote_port: local_port,
      name: Some(format!("kubectl {target}:{remote}")),
    };
    match crate::commands::tunnels::start_tunnel_runtime(&app, &state, args).await {
      Ok(tid) => tunnel_id = Some(tid),
      Err(e) => {
        let _ = cancel.send(());
        return Err(format!(
          "kubectl is forwarding on the jump host, but this machine cannot listen on {local_port}: {e}"
        ));
      }
    }
  }

  {
    let mut map = state.k8s_forwards.lock().map_err(|e| e.to_string())?;
    map.insert(
      id,
      crate::k8s_forward::ForwardRuntime {
        id,
        host_kind,
        jump_tab_id,
        context: ctx,
        namespace: ns,
        target: target.clone(),
        remote_port: remote.clone(),
        listen_addr: crate::k8s_forward::listen_addr(local_port, all_if),
        started_at: chrono::Utc::now().timestamp(),
        running,
        lines,
        cancel,
        tunnel_id,
      },
    );
  }
  eprintln!("[k8s] port-forward {id} ({host_kind}) -> {target}:{remote} on {local_port}");
  Ok(id)
}

/// Every forward this session started, running or recently exited. Polled by the
/// panel rather than pushed — the same rule the terminal output follows.
#[tauri::command]
pub async fn k8s_list_port_forwards(
  state: tauri::State<'_, AppState>,
) -> Result<Vec<crate::k8s_forward::K8sPortForward>, String> {
  let mut out: Vec<_> = state
    .k8s_forwards
    .lock()
    .map_err(|e| e.to_string())?
    .values()
    .map(|f| f.info())
    .collect();
  out.sort_by_key(|f| f.id);
  Ok(out)
}

/// Stop a forward (and its tunnel), or drop a row whose process already exited.
#[tauri::command]
pub async fn k8s_stop_port_forward(
  app: tauri::AppHandle,
  state: tauri::State<'_, AppState>,
  id: u32,
) -> Result<(), String> {
  if !crate::k8s_forward::stop_forward(&state, id) {
    return Err(format!("no such port forward: {id}"));
  }
  // The tunnel is gone with it, so the sidebar's tunnel list has to be re-read.
  use tauri::Emitter;
  let _ = app.emit("tunnel-changed", serde_json::json!({}));
  Ok(())
}

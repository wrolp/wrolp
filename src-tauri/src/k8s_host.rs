//! Where a `kubectl …` argv actually runs: on a jump host over SSH, or on this
//! machine. Mirrors [`crate::docker_host`]: every Kubernetes feature in the app is
//! an argv list that starts with `kubectl`, and this module owns the one thing that
//! differs between the two transports — how that argv is executed.
//!
//! No cluster API is spoken directly; the user's own kubectl and kubeconfig stay the
//! source of truth for contexts, auth and proxies.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::ssh_session::AppState;
use crate::win_proc::HideConsole;

/// Local calls wait longer than the Docker probe's 3s: `kubectl get` can go through an
/// exec credential plugin or a slow API server, and `apply` writes a batch of objects.
const LOCAL_TIMEOUT: Duration = Duration::from_secs(60);

/// The resource kinds the panel offers. Kept as an allow-list so a frontend value can
/// never turn into an arbitrary kubectl argument (a resource name is passed positionally
/// after this word, never as a flag).
pub const RESOURCE_KINDS: [&str; 10] = [
  "pods",
  "deployments",
  "statefulsets",
  "daemonsets",
  "services",
  "ingresses",
  "jobs",
  "cronjobs",
  "configmaps",
  "secrets",
];

/// The host a kubectl command runs against. `Ssh` reuses the interactive session's
/// exec channel; `Local` spawns the CLI on this machine.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum K8sHostRef {
  #[serde(rename = "ssh")]
  Ssh {
    #[serde(rename = "jumpTabId")]
    jump_tab_id: u32,
  },
  #[serde(rename = "local")]
  Local,
}

/// One kubeconfig context. `namespace` is the context's default, which is what the
/// panel preselects (falling back to `default`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct K8sContext {
  pub name: String,
  pub cluster: String,
  pub user: String,
  pub namespace: Option<String>,
  pub current: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct K8sNamespace {
  pub name: String,
  pub status: String,
}

/// One row in the panel. The shape is deliberately generic: the list renders every
/// kind through it, and `status` / `ready` / `detail` are filled per kind below.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct K8sResource {
  pub kind: String,
  pub name: String,
  pub namespace: String,
  /// Short state word shown as the chip (pod phase, Ready/Progressing, service type…).
  pub status: String,
  /// `ready/total` when the kind has a notion of ready replicas or containers.
  pub ready: String,
  pub restarts: u64,
  /// One-line summary under the name (image, address, schedule…).
  pub detail: String,
  /// Container names, for the pod logs / exec pickers.
  pub containers: Vec<String>,
  /// Exposed ports, for the port-forward dialog's prefill (container ports, or a
  /// service's own).
  pub ports: Vec<u16>,
  pub created_at: Option<String>,
}

/// Run `args` (already starting with `kubectl`) against `host`.
pub async fn exec_kubectl(
  state: &tauri::State<'_, AppState>,
  host: &K8sHostRef,
  args: &[String],
  stdin: Option<&[u8]>,
) -> Result<(Vec<u8>, Vec<u8>, u32), String> {
  match host {
    K8sHostRef::Ssh { jump_tab_id } => {
      let jump = crate::remote_fs::get_jump_handle(state, *jump_tab_id)?;
      crate::docker_fs::exec_on_jump(&jump, args, stdin).await
    }
    K8sHostRef::Local => exec_local(args, stdin).await,
  }
}

/// Spawn `kubectl` on this machine to completion. `args[0]` is dropped because the
/// program name is fixed here; the rest goes straight to the process — no shell, so
/// names with spaces or quotes cannot be re-parsed as syntax.
async fn exec_local(
  args: &[String],
  stdin: Option<&[u8]>,
) -> Result<(Vec<u8>, Vec<u8>, u32), String> {
  let program = args.first().map(String::as_str).unwrap_or("kubectl");
  let rest = args.get(1..).unwrap_or(&[]);
  let mut cmd = Command::new(program);
  cmd.hide_console();
  cmd
    .args(rest)
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
    .map_err(|e| format!("failed to start `{program}`: {e}"))?;
  if let Some(data) = stdin {
    if let Some(mut sink) = child.stdin.take() {
      let _ = sink.write_all(data).await;
      // Dropping the handle closes the pipe; `apply -f -` would otherwise wait forever.
      drop(sink);
    }
  }
  let joined = rest.join(" ");
  let output = tokio::time::timeout(LOCAL_TIMEOUT, child.wait_with_output())
    .await
    .map_err(|_| {
      format!(
        "`{program} {joined}` timed out after {}s",
        LOCAL_TIMEOUT.as_secs()
      )
    })?
    .map_err(|e| format!("`{program} {joined}` failed: {e}"))?;
  Ok((
    output.stdout,
    output.stderr,
    output.status.code().unwrap_or(-1) as u32,
  ))
}

/// `kubectl [--context C] -n N …` — the flag order every namespaced command shares.
///
/// `--all-namespaces` is appended after `args` instead of sitting before them: it is
/// a *get* flag, not a persistent one, and `kubectl -A get pods` is parsed as a plugin
/// invocation and fails with "flags cannot be placed before plugin name".
pub fn kubectl_argv(
  context: Option<&str>,
  namespace: Option<&str>,
  all_namespaces: bool,
  args: &[String],
) -> Vec<String> {
  let mut argv = vec!["kubectl".to_string()];
  if let Some(ctx) = context.map(str::trim).filter(|c| !c.is_empty()) {
    argv.push("--context".into());
    argv.push(ctx.to_string());
  }
  if all_namespaces {
    argv.extend(args.iter().cloned());
    argv.push("--all-namespaces".into());
    return argv;
  }
  argv.push("-n".into());
  argv.push(
    namespace
      .map(str::trim)
      .filter(|n| !n.is_empty())
      .unwrap_or("default")
      .to_string(),
  );
  argv.extend(args.iter().cloned());
  argv
}

/// argv for `kubectl exec -it <pod> -- /bin/sh`, without the program name. Shared by
/// the SSH path (turned into a shell-quoted line) and the local PTY (spawned directly).
/// `/bin/sh` rather than bash: it exists in Alpine, distroless-adjacent and slim images.
pub fn pod_exec_args(
  context: Option<&str>,
  namespace: &str,
  pod: &str,
  container: Option<&str>,
) -> Vec<String> {
  let mut args = kubectl_argv(context, Some(namespace), false, &[]);
  args.push("exec".into());
  args.push("-it".into());
  args.push(pod.to_string());
  if let Some(c) = container.map(str::trim).filter(|c| !c.is_empty()) {
    args.push("-c".into());
    args.push(c.to_string());
  }
  args.push("--".into());
  args.push("/bin/sh".into());
  args
}

/// Render `pod_exec_args` as one line for `postConnectCmd`, which the terminal types
/// into the SSH shell — every element quoted, so a context or pod name cannot inject.
pub fn pod_exec_command(
  context: Option<&str>,
  namespace: &str,
  pod: &str,
  container: Option<&str>,
) -> String {
  let argv = pod_exec_args(context, namespace, pod, container);
  let program = &argv[0];
  let quoted = argv[1..]
    .iter()
    .map(|a| {
      // Flags and verbs are word-safe; only the values (context, namespace, pod,
      // container) can carry characters a shell would reinterpret.
      if a.starts_with('-') || a == "exec" {
        a.clone()
      } else {
        crate::docker_fs::shell_quote(a)
      }
    })
    .collect::<Vec<_>>()
    .join(" ");
  format!("{program} {quoted}")
}

fn str_at<'a>(v: &'a Value, path: &[&str]) -> Option<&'a str> {
  let mut cur = v;
  for key in path {
    cur = cur.get(*key)?;
  }
  cur.as_str()
}

fn u64_at(v: &Value, path: &[&str]) -> u64 {
  let mut cur = v;
  for key in path {
    match cur.get(*key) {
      Some(next) => cur = next,
      None => return 0,
    }
  }
  cur.as_u64().unwrap_or(0)
}

/// Ports worth forwarding: a workload's container ports, else a service's own.
fn push_port(out: &mut Vec<u16>, value: Option<&Value>) {
  if let Some(n) = value
    .and_then(Value::as_u64)
    .and_then(|n| u16::try_from(n).ok())
  {
    if n > 0 && !out.contains(&n) {
      out.push(n);
    }
  }
}

fn exposed_ports(item: &Value) -> Vec<u16> {
  let mut out: Vec<u16> = Vec::new();
  let Some(spec) = item.get("spec") else {
    return out;
  };
  for container in spec
    .get("containers")
    .and_then(Value::as_array)
    .into_iter()
    .flatten()
  {
    for port in container
      .get("ports")
      .and_then(Value::as_array)
      .into_iter()
      .flatten()
    {
      push_port(&mut out, port.get("containerPort"));
    }
  }
  if out.is_empty() {
    for port in spec
      .get("ports")
      .and_then(Value::as_array)
      .into_iter()
      .flatten()
    {
      push_port(&mut out, port.get("port"));
    }
  }
  out
}

/// Pull the contexts out of `kubectl config view -o json`.
pub fn parse_contexts(config: &Value) -> Vec<K8sContext> {
  let current = config
    .get("current-context")
    .and_then(Value::as_str)
    .unwrap_or("");
  let mut out = Vec::new();
  for entry in config
    .get("contexts")
    .and_then(Value::as_array)
    .into_iter()
    .flatten()
  {
    let Some(name) = entry.get("name").and_then(Value::as_str) else {
      continue;
    };
    let ctx = entry.get("context");
    let ns = ctx
      .and_then(|c| c.get("namespace"))
      .and_then(Value::as_str)
      .map(str::to_string)
      .filter(|n| !n.is_empty());
    out.push(K8sContext {
      name: name.to_string(),
      cluster: ctx
        .and_then(|c| c.get("cluster"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string(),
      user: ctx
        .and_then(|c| c.get("user"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string(),
      namespace: ns,
      current: name == current,
    });
  }
  out
}

pub fn parse_namespaces(json: &Value) -> Vec<K8sNamespace> {
  let mut out = Vec::new();
  for item in json
    .get("items")
    .and_then(Value::as_array)
    .into_iter()
    .flatten()
  {
    let Some(name) = str_at(item, &["metadata", "name"]) else {
      continue;
    };
    out.push(K8sNamespace {
      name: name.to_string(),
      status: str_at(item, &["status", "phase"]).unwrap_or("").to_string(),
    });
  }
  out
}

/// Parse `kubectl get <kind> -o json`. Unknown kinds yield an empty list rather than an
/// error: the panel is driven by `RESOURCE_KINDS`, so this is only a safety net.
pub fn parse_resources(kind: &str, json: &Value) -> Vec<K8sResource> {
  json
    .get("items")
    .and_then(Value::as_array)
    .into_iter()
    .flatten()
    .filter_map(|item| resource_from(kind, item))
    .collect()
}

fn resource_from(kind: &str, item: &Value) -> Option<K8sResource> {
  let name = str_at(item, &["metadata", "name"])?.to_string();
  let namespace = str_at(item, &["metadata", "namespace"])
    .unwrap_or("")
    .to_string();
  let created_at = str_at(item, &["metadata", "creationTimestamp"]).map(str::to_string);

  let containers = item
    .get("spec")
    .and_then(|s| s.get("containers"))
    .and_then(Value::as_array)
    .map(|cs| {
      cs.iter()
        .filter_map(|c| c.get("name").and_then(Value::as_str).map(str::to_string))
        .collect::<Vec<_>>()
    })
    .unwrap_or_default();

  let images = item
    .get("spec")
    .and_then(|s| s.get("containers"))
    .and_then(Value::as_array)
    .map(|cs| {
      cs.iter()
        .filter_map(|c| c.get("image").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join(", ")
    })
    .unwrap_or_default();

  let status = item.get("status").cloned().unwrap_or(Value::Null);

  let (status_word, ready, restarts, detail) = match kind {
    "pods" => {
      let phase = status
        .get("phase")
        .and_then(Value::as_str)
        .unwrap_or("Unknown")
        .to_string();
      let statuses = status
        .get("containerStatuses")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
      let total = if statuses.is_empty() {
        containers.len() as u64
      } else {
        statuses.len() as u64
      };
      let ready_n = statuses
        .iter()
        .filter(|c| c.get("ready").and_then(Value::as_bool).unwrap_or(false))
        .count() as u64;
      let restarts = statuses
        .iter()
        .map(|c| c.get("restartCount").and_then(Value::as_u64).unwrap_or(0))
        .sum();
      let node = str_at(item, &["spec", "nodeName"]).unwrap_or("");
      let detail = match (images.is_empty(), node.is_empty()) {
        (false, false) => format!("{images} · {node}"),
        (false, true) => images,
        (true, false) => node.to_string(),
        (true, true) => String::new(),
      };
      (phase, format!("{ready_n}/{total}"), restarts, detail)
    }
    "deployments" | "statefulsets" => {
      let desired = u64_at(item, &["spec", "replicas"]).max(
        // A scaled-to-zero deployment reports 0/0; a manifest without `replicas`
        // still means one, which is what the API server defaults it to.
        if item.get("spec").and_then(|s| s.get("replicas")).is_some() {
          0
        } else {
          1
        },
      );
      let ready_n = u64_at(item, &["status", "readyReplicas"]);
      let word = if desired == 0 {
        "Stopped"
      } else if ready_n >= desired {
        "Ready"
      } else if ready_n == 0 {
        "Pending"
      } else {
        "Progressing"
      };
      (word.to_string(), format!("{ready_n}/{desired}"), 0, images)
    }
    "daemonsets" => {
      let desired = u64_at(item, &["status", "desiredNumberScheduled"]);
      let ready_n = u64_at(item, &["status", "numberReady"]);
      let word = if desired == 0 {
        "Stopped"
      } else if ready_n >= desired {
        "Ready"
      } else if ready_n == 0 {
        "Pending"
      } else {
        "Progressing"
      };
      (word.to_string(), format!("{ready_n}/{desired}"), 0, images)
    }
    "services" => {
      let ty = str_at(item, &["spec", "type"]).unwrap_or("ClusterIP");
      let ip = str_at(item, &["spec", "clusterIP"]).unwrap_or("");
      let ports = item
        .get("spec")
        .and_then(|s| s.get("ports"))
        .and_then(Value::as_array)
        .map(|ps| {
          ps.iter()
            .filter_map(|p| {
              let port = p.get("port").and_then(Value::as_u64)?;
              let proto = p.get("protocol").and_then(Value::as_str).unwrap_or("TCP");
              Some(format!("{port}/{proto}"))
            })
            .collect::<Vec<_>>()
            .join(", ")
        })
        .unwrap_or_default();
      let detail = [ip, ports.as_str()]
        .iter()
        .filter(|s| !s.is_empty())
        .cloned()
        .collect::<Vec<_>>()
        .join(" · ");
      (ty.to_string(), String::new(), 0, detail)
    }
    "ingresses" => {
      let hosts = item
        .get("spec")
        .and_then(|s| s.get("rules"))
        .and_then(Value::as_array)
        .map(|rs| {
          rs.iter()
            .filter_map(|r| r.get("host").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(", ")
        })
        .unwrap_or_default();
      ("Active".to_string(), String::new(), 0, hosts)
    }
    "jobs" => {
      let completions = u64_at(item, &["spec", "completions"]).max(1);
      let succeeded = u64_at(item, &["status", "succeeded"]);
      let failed = u64_at(item, &["status", "failed"]);
      let word = if succeeded >= completions {
        "Complete"
      } else if failed > 0 {
        "Failed"
      } else {
        "Running"
      };
      (
        word.to_string(),
        format!("{succeeded}/{completions}"),
        0,
        images,
      )
    }
    "cronjobs" => {
      let suspended = item
        .get("spec")
        .and_then(|s| s.get("suspend"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
      let schedule = str_at(item, &["spec", "schedule"]).unwrap_or("");
      (
        if suspended { "Suspended" } else { "Scheduled" }.to_string(),
        String::new(),
        0,
        schedule.to_string(),
      )
    }
    // ConfigMaps / Secrets: the useful fact is how many keys they carry.
    _ => {
      let keys = item
        .get("data")
        .and_then(Value::as_object)
        .map(|m| m.len())
        .unwrap_or(0)
        + item
          .get("binaryData")
          .and_then(Value::as_object)
          .map(|m| m.len())
          .unwrap_or(0);
      (
        "Active".to_string(),
        String::new(),
        0,
        format!("{keys} key(s)"),
      )
    }
  };

  Some(K8sResource {
    kind: kind.to_string(),
    name,
    namespace,
    status: status_word,
    ready,
    restarts,
    detail,
    containers,
    ports: exposed_ports(item),
    created_at,
  })
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  #[test]
  fn the_host_ref_round_trips_as_the_tagged_form_the_frontend_sends() {
    let local: K8sHostRef = serde_json::from_str(r#"{"kind":"local"}"#).unwrap();
    assert!(matches!(local, K8sHostRef::Local));
    let ssh: K8sHostRef = serde_json::from_str(r#"{"kind":"ssh","jumpTabId":7}"#).unwrap();
    match ssh {
      K8sHostRef::Ssh { jump_tab_id } => assert_eq!(jump_tab_id, 7),
      K8sHostRef::Local => panic!("ssh host decoded as local"),
    }
  }

  #[test]
  fn contexts_keep_the_current_flag_and_namespace_default() {
    let cfg = json!({
      "current-context": "prod",
      "contexts": [
        { "name": "prod", "context": { "cluster": "c1", "user": "u1", "namespace": "apps" } },
        { "name": "dev", "context": { "cluster": "c2", "user": "u2" } },
        { "context": { "cluster": "no-name" } }
      ]
    });
    let ctxs = parse_contexts(&cfg);
    assert_eq!(ctxs.len(), 2);
    assert_eq!(ctxs[0].name, "prod");
    assert!(ctxs[0].current);
    assert_eq!(ctxs[0].namespace.as_deref(), Some("apps"));
    assert!(!ctxs[1].current);
    assert_eq!(ctxs[1].namespace, None);
  }

  #[test]
  fn pod_rows_carry_phase_readiness_restarts_and_node() {
    let json = json!({
      "items": [{
        "metadata": { "name": "web-0", "namespace": "apps", "creationTimestamp": "2026-10-01T00:00:00Z" },
        "spec": {
          "nodeName": "node-1",
          "containers": [{ "name": "web", "image": "nginx:1.29", "ports": [{ "containerPort": 8080 }] }]
        },
        "status": {
          "phase": "Running",
          "containerStatuses": [
            { "ready": true, "restartCount": 2 },
            { "ready": false, "restartCount": 3 }
          ]
        }
      }]
    });
    let rows = parse_resources("pods", &json);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].status, "Running");
    assert_eq!(rows[0].ready, "1/2");
    assert_eq!(rows[0].restarts, 5);
    assert_eq!(rows[0].containers, vec!["web"]);
    assert_eq!(rows[0].ports, vec![8080]);
    assert!(rows[0].detail.contains("nginx:1.29"));
    assert!(rows[0].detail.contains("node-1"));
  }

  #[test]
  fn workloads_read_the_replica_counts_and_stop_at_zero() {
    let json = json!({
      "items": [
        { "metadata": { "name": "up" }, "spec": { "replicas": 3, "containers": [{ "image": "a" }] },
          "status": { "readyReplicas": 3 } },
        { "metadata": { "name": "half" }, "spec": { "replicas": 2 }, "status": { "readyReplicas": 1 } },
        { "metadata": { "name": "off" }, "spec": { "replicas": 0 }, "status": {} }
      ]
    });
    let rows = parse_resources("deployments", &json);
    assert_eq!(rows[0].status, "Ready");
    assert_eq!(rows[0].ready, "3/3");
    assert_eq!(rows[1].status, "Progressing");
    assert_eq!(rows[2].status, "Stopped");
    assert_eq!(rows[2].ready, "0/0");
  }

  #[test]
  fn services_show_type_and_address_ports() {
    let json = json!({
      "items": [{
        "metadata": { "name": "api" },
        "spec": {
          "type": "NodePort",
          "clusterIP": "10.0.0.7",
          "ports": [{ "port": 80, "protocol": "TCP" }, { "port": 443, "protocol": "TCP" }]
        }
      }]
    });
    let rows = parse_resources("services", &json);
    assert_eq!(rows[0].status, "NodePort");
    assert_eq!(rows[0].detail, "10.0.0.7 · 80/TCP, 443/TCP");
    // No container ports on a service, so its own `spec.ports` are what a forward
    // dialog prefills from.
    assert_eq!(rows[0].ports, vec![80, 443]);
  }

  #[test]
  fn argv_puts_context_before_the_namespace_switch() {
    let args = vec!["get".to_string(), "pods".to_string()];
    assert_eq!(
      kubectl_argv(Some("prod"), Some("apps"), false, &args),
      vec!["kubectl", "--context", "prod", "-n", "apps", "get", "pods"]
    );
    assert_eq!(
      kubectl_argv(None, Some(""), true, &args),
      vec!["kubectl", "get", "pods", "--all-namespaces"]
    );
    // An empty namespace falls back to `default` for a namespaced request.
    assert_eq!(
      kubectl_argv(None, Some("  "), false, &args),
      vec!["kubectl", "-n", "default", "get", "pods"]
    );
  }

  #[test]
  fn the_exec_line_quotes_every_argument() {
    let line = pod_exec_command(Some("prod"), "apps", "web-0", Some("web"));
    assert_eq!(
      line,
      "kubectl --context 'prod' -n 'apps' exec -it 'web-0' -c 'web' -- '/bin/sh'"
    );
    assert_eq!(
      pod_exec_command(None, "apps", "web-0", None),
      "kubectl -n 'apps' exec -it 'web-0' -- '/bin/sh'"
    );
  }

  /// Against a real kubectl/kubeconfig: `cargo test --lib k8s_host -- --ignored`.
  ///
  /// Gated twice on purpose, like the Docker probe: `#[ignore]` keeps it out of the
  /// ordinary run, and a machine without the CLI prints a reason and stays green.
  /// `config view` only reads the client config — no cluster connection is made.
  #[tokio::test]
  #[ignore]
  async fn probes_the_real_local_kubectl() {
    let argv = vec![
      "kubectl".to_string(),
      "config".to_string(),
      "view".to_string(),
      "-o".to_string(),
      "json".to_string(),
    ];
    let (out, err, status) = match exec_local(&argv, None).await {
      Ok(v) => v,
      Err(e) => {
        eprintln!("SKIP: {e}");
        return;
      }
    };
    if status != 0 {
      eprintln!(
        "SKIP: `kubectl config view` exited {status}: {}",
        String::from_utf8_lossy(&err).trim()
      );
      return;
    }
    let cfg: Value = serde_json::from_slice(&out).expect("kubectl returned valid JSON");
    let contexts = parse_contexts(&cfg);
    eprintln!(
      "OK: {} context(s), current={:?}",
      contexts.len(),
      contexts.iter().find(|c| c.current).map(|c| c.name.as_str())
    );
  }
}

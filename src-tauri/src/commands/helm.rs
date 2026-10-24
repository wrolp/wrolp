//! Helm panel commands.
//!
//! Each one is a helm argv built by [`crate::helm`] and run through the same transport
//! as kubectl. Names, charts and versions are validated first, so nothing a release is
//! called can turn into a flag.

use super::*;
use crate::helm::{
  checked_chart, checked_release, checked_revision, checked_version, exec_helm_ok, parse_history,
  parse_releases, probe, HelmProbe, HelmRelease, HelmRevision,
};
use crate::k8s_host::K8sHostRef;
use serde_json::Value;

/// The scope flags every command shares: `--kube-context` and `-n`, before the verb.
fn scoped(context: Option<&str>, namespace: Option<&str>, args: &[&str]) -> Vec<String> {
  crate::helm::helm_argv(
    context,
    namespace,
    &args.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
  )
}

fn json_out(verb: &str, out: Vec<u8>) -> Result<Value, String> {
  serde_json::from_slice(&out).map_err(|e| format!("helm {verb} returned invalid JSON: {e}"))
}

fn trimmed(namespace: Option<&str>) -> Option<String> {
  namespace
    .map(str::trim)
    .filter(|n| !n.is_empty() && *n != "*")
    .map(str::to_string)
}

fn trimmed_ctx(context: Option<&str>) -> Option<String> {
  context
    .map(str::trim)
    .filter(|c| !c.is_empty())
    .map(str::to_string)
}

/// Whether this host has helm, so the panel can say that instead of showing a CLI error.
#[tauri::command]
pub async fn helm_probe(
  state: tauri::State<'_, AppState>,
  host: K8sHostRef,
) -> Result<HelmProbe, String> {
  Ok(probe(&state, &host).await)
}

/// Releases in one namespace, or across all of them when `namespace` is empty.
#[tauri::command]
pub async fn helm_list_releases(
  state: tauri::State<'_, AppState>,
  host: K8sHostRef,
  context: Option<String>,
  namespace: Option<String>,
) -> Result<Vec<HelmRelease>, String> {
  let ns = trimmed(namespace.as_deref());
  let mut args = scoped(
    trimmed_ctx(context.as_deref()).as_deref(),
    ns.as_deref(),
    &["list", "-o", "json"],
  );
  // Only when no namespace was picked — `--all-namespaces` alongside `-n` would list
  // everything and quietly ignore the scope the user chose. It also has to come after
  // the verb: in the global position helm parses it as a plugin invocation, the same
  // trap kubectl's `-A` is.
  if ns.is_none() {
    args.push("--all-namespaces".to_string());
  }
  let (out, err, status) = crate::k8s_host::exec_kubectl(&state, &host, &args, None).await?;
  if status != 0 {
    return Err(format!(
      "helm list failed (exit {status}): {}",
      String::from_utf8_lossy(&err).trim()
    ));
  }
  Ok(parse_releases(&json_out("list", out)?))
}

/// The values a release was installed with. `all` includes the chart defaults.
#[tauri::command]
pub async fn helm_release_values(
  state: tauri::State<'_, AppState>,
  host: K8sHostRef,
  context: Option<String>,
  namespace: Option<String>,
  release: String,
  all: Option<bool>,
) -> Result<String, String> {
  let release = checked_release(&release)?;
  let mut args = vec!["get".to_string(), "values".to_string(), release];
  if all.unwrap_or(false) {
    args.push("--all".to_string());
  }
  args.push("-o".to_string());
  args.push("yaml".to_string());
  let argv = scoped(
    trimmed_ctx(context.as_deref()).as_deref(),
    trimmed(namespace.as_deref()).as_deref(),
    &args.iter().map(String::as_str).collect::<Vec<_>>(),
  );
  exec_helm_ok(&state, &host, &argv, None).await
}

/// Revision history, newest last. `--max` is raised from helm's default of 10 because
/// the whole point of opening this is to pick an older revision.
#[tauri::command]
pub async fn helm_release_history(
  state: tauri::State<'_, AppState>,
  host: K8sHostRef,
  context: Option<String>,
  namespace: Option<String>,
  release: String,
) -> Result<Vec<HelmRevision>, String> {
  let release = checked_release(&release)?;
  let args = scoped(
    trimmed_ctx(context.as_deref()).as_deref(),
    trimmed(namespace.as_deref()).as_deref(),
    &["history", release.as_str(), "--max", "200", "-o", "json"],
  );
  let (out, err, status) = crate::k8s_host::exec_kubectl(&state, &host, &args, None).await?;
  if status != 0 {
    return Err(format!(
      "helm history failed (exit {status}): {}",
      String::from_utf8_lossy(&err).trim()
    ));
  }
  Ok(parse_history(&json_out("history", out)?))
}

/// Roll a release back to a revision (the previous one when none is given).
#[tauri::command]
pub async fn helm_rollback(
  state: tauri::State<'_, AppState>,
  host: K8sHostRef,
  context: Option<String>,
  namespace: Option<String>,
  release: String,
  revision: Option<u32>,
) -> Result<String, String> {
  let release = checked_release(&release)?;
  let mut args = vec!["rollback".to_string(), release];
  if let Some(rev) = revision {
    args.push(checked_revision(rev)?);
  }
  args.push("--wait".to_string());
  let argv = scoped(
    trimmed_ctx(context.as_deref()).as_deref(),
    trimmed(namespace.as_deref()).as_deref(),
    &args.iter().map(String::as_str).collect::<Vec<_>>(),
  );
  exec_helm_ok(&state, &host, &argv, None).await
}

/// Remove a release. `--keep-history` is deliberately not offered: the panel's word for
/// the result is "deleted", and a hidden history would make that untrue.
#[tauri::command]
pub async fn helm_uninstall(
  state: tauri::State<'_, AppState>,
  host: K8sHostRef,
  context: Option<String>,
  namespace: Option<String>,
  release: String,
) -> Result<String, String> {
  let release = checked_release(&release)?;
  let args = scoped(
    trimmed_ctx(context.as_deref()).as_deref(),
    trimmed(namespace.as_deref()).as_deref(),
    &["uninstall", release.as_str(), "--no-hooks"],
  );
  exec_helm_ok(&state, &host, &args, None).await
}

/// `helm upgrade --install` — the one verb that also installs, and the reason the
/// dialog is called "install / upgrade" rather than two commands.
#[tauri::command]
pub async fn helm_upgrade_install(
  state: tauri::State<'_, AppState>,
  host: K8sHostRef,
  context: Option<String>,
  namespace: String,
  release: String,
  chart: String,
  version: Option<String>,
  values: Option<String>,
  wait: Option<bool>,
  create_namespace: Option<bool>,
) -> Result<String, String> {
  let release = checked_release(&release)?;
  let chart = checked_chart(&chart)?;
  let version = checked_version(version.as_deref())?;
  let ns = trimmed(Some(&namespace)).ok_or_else(|| {
    "helm needs a namespace to install into — pick one instead of “all namespaces”".to_string()
  })?;
  let mut args = vec![
    "upgrade".to_string(),
    "--install".to_string(),
    release,
    chart,
  ];
  if let Some(v) = version {
    args.push("--version".to_string());
    args.push(v);
  }
  let values = values.unwrap_or_default();
  let has_values = !values.trim().is_empty();
  if has_values {
    args.push("-f".to_string());
    // The document arrives on stdin, so no temp file and no quoting of its contents.
    args.push("-".to_string());
  }
  if create_namespace.unwrap_or(false) {
    args.push("--create-namespace".to_string());
  }
  if wait.unwrap_or(false) {
    args.push("--wait".to_string());
  }
  let argv = scoped(
    trimmed_ctx(context.as_deref()).as_deref(),
    Some(ns.as_str()),
    &args.iter().map(String::as_str).collect::<Vec<_>>(),
  );
  exec_helm_ok(
    &state,
    &host,
    &argv,
    if has_values {
      Some(values.as_bytes())
    } else {
      None
    },
  )
  .await
}

//! `helm …` for the panel's Helm mode. Every Helm feature here is an argv list, built
//! and validated in this module and executed on a jump host or this machine — the user's
//! own helm, its repositories and its kubeconfig stay the source of truth.
//!
//! The transport is kubectl's: [`crate::k8s_host::exec_kubectl`] execs whatever
//! `argv[0]` names, so a jump-host helm reuses that session's exec channel and a local
//! one is spawned directly.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::k8s_host::{exec_kubectl, K8sHostRef};
use crate::ssh_session::AppState;

/// One deployed release, as `helm list -o json` reports it. `revision` and
/// `app_version` stay strings: helm prints them that way and an empty one is normal.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HelmRelease {
  pub name: String,
  pub namespace: String,
  pub revision: String,
  pub updated: String,
  pub status: String,
  pub chart: String,
  pub app_version: String,
}

/// One entry of `helm history -o json`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HelmRevision {
  pub revision: u32,
  pub updated: String,
  pub status: String,
  pub chart: String,
  pub app_version: String,
  pub description: String,
}

/// Whether this host has helm at all, so the panel can say that instead of showing a
/// raw CLI error where a release list would be.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelmProbe {
  pub installed: bool,
  pub version: Option<String>,
  /// Raw CLI diagnostic; the UI labels come from `installed`.
  pub message: String,
}

/// `helm [--kube-context C] [-n NS] …`. Namespace is passed for every verb that takes
/// one; the list-only `-A` is appended by the caller because it is not a persistent
/// flag (`helm -A list` is parsed as a plugin invocation, exactly like kubectl's `-A`).
pub fn helm_argv(context: Option<&str>, namespace: Option<&str>, args: &[String]) -> Vec<String> {
  let mut argv = vec!["helm".to_string()];
  if let Some(ctx) = context.map(str::trim).filter(|c| !c.is_empty()) {
    argv.push("--kube-context".into());
    argv.push(ctx.to_string());
  }
  if let Some(ns) = namespace.map(str::trim).filter(|n| !n.is_empty()) {
    argv.push("-n".into());
    argv.push(ns.to_string());
  }
  argv.extend(args.iter().cloned());
  argv
}

/// A release name: helm allows DNS-label-ish names; anything else cannot be a name and
/// might carry a flag, so it is refused before it reaches the argv.
pub fn checked_release(name: &str) -> Result<String, String> {
  let n = name.trim();
  let ok = !n.is_empty()
    && n.len() <= 53
    && n
      .chars()
      .next()
      .map(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
      .unwrap_or(false)
    && n
      .chars()
      .last()
      .map(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
      .unwrap_or(false)
    && n
      .chars()
      .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '.' | '_'));
  if ok {
    Ok(n.to_string())
  } else {
    Err(format!("`{name}` is not a valid release name"))
  }
}

/// A chart reference: a repo path (`stable/nginx`), a name, or an OCI URL.
pub fn checked_chart(chart: &str) -> Result<String, String> {
  let c = chart.trim();
  let ok = !c.is_empty()
    && c.len() <= 256
    && c
      .chars()
      .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-' | '/' | ':' | '@'));
  if ok {
    Ok(c.to_string())
  } else {
    Err(format!("`{chart}` is not a valid chart reference"))
  }
}

/// A chart version or a `--version` value. Empty means "whatever is current".
pub fn checked_version(version: Option<&str>) -> Result<Option<String>, String> {
  let Some(v) = version.map(str::trim).filter(|v| !v.is_empty()) else {
    return Ok(None);
  };
  let ok = v.len() <= 64
    && v
      .chars()
      .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '+'));
  if ok {
    Ok(Some(v.to_string()))
  } else {
    Err(format!("`{v}` is not a valid chart version"))
  }
}

/// A revision number for `helm rollback`.
pub fn checked_revision(revision: u32) -> Result<String, String> {
  if revision == 0 {
    return Err("revision numbers start at 1".to_string());
  }
  Ok(revision.to_string())
}

/// Run a helm argv on `host` and require success, answering with stdout+stderr — the
/// verbs that change the cluster print what they did, and that is the read-out.
pub async fn exec_helm_ok(
  state: &tauri::State<'_, AppState>,
  host: &K8sHostRef,
  args: &[String],
  stdin: Option<&[u8]>,
) -> Result<String, String> {
  let argv = helm_argv(None, None, args);
  let verb = args.first().map(String::as_str).unwrap_or("").to_string();
  let (out, err, status) = exec_kubectl(state, host, &argv, stdin).await?;
  let mut text = String::from_utf8_lossy(&out).to_string();
  let errors = String::from_utf8_lossy(&err).trim().to_string();
  if status != 0 {
    return Err(format!(
      "helm {verb} failed (exit {status}): {}",
      if text.trim().is_empty() {
        errors
      } else {
        text.trim().to_string()
      }
    ));
  }
  if !errors.is_empty() {
    // Helm warns on stderr while succeeding (e.g. an outdated chart repo index).
    text.push('\n');
    text.push_str(&errors);
  }
  Ok(text.trim().to_string())
}

/// Ask this host whether helm exists. Never an error: "no helm" is a `HelmProbe` with
/// `installed == false`.
pub async fn probe(state: &tauri::State<'_, AppState>, host: &K8sHostRef) -> HelmProbe {
  let argv = helm_argv(None, None, &["version".to_string(), "--short".to_string()]);
  match exec_kubectl(state, host, &argv, None).await {
    Ok((out, _, 0)) => {
      let text = String::from_utf8_lossy(&out).trim().to_string();
      // `v3.16.2+g10652ea` — keep the part before the metadata `+`.
      let version = text
        .trim_start_matches('v')
        .split('+')
        .next()
        .filter(|v| !v.is_empty())
        .map(str::to_string);
      HelmProbe {
        installed: version.is_some(),
        version,
        message: text,
      }
    }
    Ok((_, err, status)) => HelmProbe {
      installed: false,
      version: None,
      message: format!("exit {status}: {}", String::from_utf8_lossy(&err).trim()),
    },
    Err(e) => HelmProbe {
      installed: false,
      version: None,
      message: e,
    },
  }
}

fn text(v: Option<&Value>) -> String {
  v.and_then(Value::as_str).unwrap_or("").to_string()
}

/// `helm list -o json` — a bare array, and an empty one is a normal answer.
pub fn parse_releases(json: &Value) -> Vec<HelmRelease> {
  json
    .as_array()
    .into_iter()
    .flatten()
    .filter_map(|item| {
      let name = item.get("name").and_then(Value::as_str)?;
      Some(HelmRelease {
        name: name.to_string(),
        namespace: text(item.get("namespace")),
        revision: text(item.get("revision")),
        updated: text(item.get("updated")),
        status: text(item.get("status")),
        chart: text(item.get("chart")),
        app_version: text(item.get("app_version")),
      })
    })
    .collect()
}

/// `helm history <release> -o json`.
pub fn parse_history(json: &Value) -> Vec<HelmRevision> {
  json
    .as_array()
    .into_iter()
    .flatten()
    .filter_map(|item| {
      let revision = item.get("revision").and_then(Value::as_u64)? as u32;
      Some(HelmRevision {
        revision,
        updated: text(item.get("updated")),
        status: text(item.get("status")),
        chart: text(item.get("chart")),
        app_version: text(item.get("app_version")),
        description: text(item.get("description")),
      })
    })
    .collect()
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  #[test]
  fn global_flags_come_before_the_verb_and_the_namespace_is_optional() {
    let args = vec!["list".to_string(), "-o".to_string(), "json".to_string()];
    assert_eq!(
      helm_argv(Some("prod"), Some("apps"), &args),
      vec![
        "helm",
        "--kube-context",
        "prod",
        "-n",
        "apps",
        "list",
        "-o",
        "json"
      ]
    );
    // No namespace means helm's own default (the kubeconfig context's).
    assert_eq!(
      helm_argv(None, Some(" "), &args),
      vec!["helm", "list", "-o", "json"]
    );
  }

  #[test]
  fn release_names_are_checked_before_reaching_helm() {
    for ok in ["nginx", "web-0", "a.b_c", "release-2026-10-24"] {
      assert_eq!(checked_release(ok).unwrap(), ok);
    }
    for bad in ["", "  ", "-x", "x-", "Nginx", "a b", "a;rm", "../x", "a$b"] {
      assert!(checked_release(bad).is_err(), "{bad:?} should be rejected");
    }
  }

  #[test]
  fn chart_refs_cover_repo_paths_names_and_oci_urls() {
    assert_eq!(checked_chart("bitnami/nginx").unwrap(), "bitnami/nginx");
    assert_eq!(checked_chart("nginx").unwrap(), "nginx");
    assert_eq!(
      checked_chart("oci://registry.local/charts/web").unwrap(),
      "oci://registry.local/charts/web"
    );
    for bad in ["", "local /path", "$(chart)", "a|b"] {
      assert!(checked_chart(bad).is_err(), "{bad:?} should be rejected");
    }
    assert_eq!(
      checked_version(Some(" 1.2.3 ")).unwrap(),
      Some("1.2.3".to_string())
    );
    assert_eq!(checked_version(None).unwrap(), None);
    assert!(checked_version(Some("1.2;3")).is_err());
    assert_eq!(checked_revision(4).unwrap(), "4");
    assert!(checked_revision(0).is_err());
  }

  #[test]
  fn a_release_row_keeps_the_strings_helm_prints() {
    let json = json!([
      {
        "name": "web",
        "namespace": "apps",
        "revision": "7",
        "updated": "2026-10-24 09:00:00 +0000 UTC",
        "status": "deployed",
        "chart": "nginx-1.2.3",
        "app_version": "1.25"
      },
      { "namespace": "no-name" }
    ]);
    let rows = parse_releases(&json);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].name, "web");
    assert_eq!(rows[0].revision, "7");
    assert_eq!(rows[0].app_version, "1.25");
    // `helm list -o json` with nothing deployed is an empty array, not an error.
    assert_eq!(parse_releases(&json!([])).len(), 0);
  }

  #[test]
  fn history_rows_need_their_revision_number() {
    let json = json!([
      { "revision": 1, "updated": "then", "status": "superseded", "chart": "nginx-1", "app_version": "", "description": "Install complete" },
      { "revision": 2, "updated": "now", "status": "deployed", "chart": "nginx-1", "app_version": "", "description": "Upgrade complete" },
      { "status": "no number" }
    ]);
    let rows = parse_history(&json);
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[1].revision, 2);
    assert_eq!(rows[1].status, "deployed");
    assert_eq!(rows[0].description, "Install complete");
  }
}

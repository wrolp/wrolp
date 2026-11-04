//! argv builders for remotes and the three network verbs.
//!
//! Progress and cancellation live in [`crate::git_host`]; these builders only
//! decide the flags. Pull is fixed to `--ff-only` (decision D2): a divergence is
//! reported as `git_not_fast_forward` and the user resolves it in a terminal,
//! rather than the panel opening a merge it cannot visualise.

pub fn list_args() -> Vec<String> {
  vec!["remote".to_string(), "-v".to_string()]
}

/// A remote name is passed positionally; refuse anything that could look like a
/// flag or carry shell syntax.
pub fn checked_remote(name: &str) -> Result<String, String> {
  let n = name.trim();
  if n.is_empty() {
    return Err(super::git_error("remote", "missing remote name"));
  }
  if n.starts_with('-') || n.chars().any(|c| c.is_control() || c == ' ' || c == '~' || c == '^') {
    return Err(super::git_error(
      "remote",
      format!("invalid remote name: {name}"),
    ));
  }
  Ok(n.to_string())
}

pub fn fetch_args(remote: Option<&str>) -> Vec<String> {
  let mut argv = vec!["fetch".to_string()];
  match remote {
    Some(r) => argv.push(r.to_string()),
    None => {
      argv.push("--all".to_string());
    }
  }
  argv.push("--prune".to_string());
  argv.push("--progress".to_string());
  argv
}

pub fn pull_args(remote: Option<&str>, branch: Option<&str>) -> Vec<String> {
  let mut argv = vec!["pull".to_string(), "--ff-only".to_string()];
  if let Some(r) = remote {
    argv.push(r.to_string());
    if let Some(b) = branch {
      argv.push(b.to_string());
    }
  }
  argv
}

/// With a known remote/branch, `--set-upstream` makes the first push self-
/// sufficient and is harmless once the upstream already exists.
pub fn push_args(remote: Option<&str>, branch: Option<&str>) -> Vec<String> {
  match (remote, branch) {
    (Some(r), Some(b)) => vec![
      "push".to_string(),
      "--set-upstream".to_string(),
      r.to_string(),
      b.to_string(),
    ],
    (Some(r), None) => vec!["push".to_string(), r.to_string()],
    _ => vec!["push".to_string()],
  }
}

/// `git remote add <name> <url>` — the URL is one argv element, never shell text.
pub fn add_args(name: &str, url: &str) -> Vec<String> {
  vec![
    "remote".to_string(),
    "add".to_string(),
    name.to_string(),
    url.to_string(),
  ]
}

/// `git remote remove <name>`.
pub fn remove_args(name: &str) -> Vec<String> {
  vec!["remote".to_string(), "remove".to_string(), name.to_string()]
}

/// A remote URL becomes one argv element: refuse anything git could read as an
/// option or that a shell could mangle. Everything else passes untouched — the
/// URL schema space (https, ssh, scp-like, file://) is git's problem.
pub fn checked_url(url: &str) -> Result<String, String> {
  let u = url.trim();
  if u.is_empty() {
    return Err(super::git_error("remote", "missing remote URL"));
  }
  if u.starts_with('-') || u.chars().any(|c| c.is_control() || c.is_whitespace()) {
    return Err(super::git_error("remote", format!("invalid remote URL: {u}")));
  }
  Ok(u.to_string())
}

/// The branch to push when the caller did not name one.
pub fn checked_branch(branch: &str) -> Result<String, String> {
  super::status::checked_branch_name(branch)
}

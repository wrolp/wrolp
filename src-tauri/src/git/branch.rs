//! argv builders for branch reads and writes.

/// Seven NUL-separated fields per ref, newest commit first.
pub fn list_args() -> Vec<String> {
  vec![
    "for-each-ref".to_string(),
    "--sort=-committerdate".to_string(),
    "--format=%(refname)%00%(objectname)%00%(objectname:short)%00%(upstream:short)%00%(HEAD)%00%(committerdate:unix)%00%(subject)".to_string(),
    "refs/heads".to_string(),
    "refs/remotes".to_string(),
  ]
}

/// `git switch -c <name> [start]` (checkout) or `git branch <name> [start]`.
pub fn create_args(name: &str, start_point: Option<&str>, checkout: bool) -> Vec<String> {
  let mut argv = if checkout {
    vec![
      "switch".to_string(),
      "-c".to_string(),
      name.to_string(),
    ]
  } else {
    vec!["branch".to_string(), name.to_string()]
  };
  if let Some(start) = start_point.filter(|s| !s.trim().is_empty()) {
    argv.push(start.trim().to_string());
  }
  argv
}

/// `git switch <name>`; a dirty worktree is refused by git itself and the
/// refusal text is what the panel shows.
pub fn switch_args(name: &str) -> Vec<String> {
  vec!["switch".to_string(), name.to_string()]
}

/// `-d` refuses unmerged branches; `-D` is only sent after an explicit confirm.
pub fn delete_args(name: &str, force: bool) -> Vec<String> {
  vec![
    "branch".to_string(),
    if force { "-D" } else { "-d" }.to_string(),
    name.to_string(),
  ]
}

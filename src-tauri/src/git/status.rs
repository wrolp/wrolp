//! argv builders for working-tree and index operations.
//!
//! Keeping these as functions (rather than inline vectors in the commands) is what
//! lets the unit tests assert flag order and the `--` separator without a repo.

/// `git status --porcelain=v2 -z --branch --untracked-files=all`.
pub fn status_args() -> Vec<String> {
  [
    "status",
    "--porcelain=v2",
    "-z",
    "--branch",
    "--untracked-files=all",
  ]
  .iter()
  .map(|s| s.to_string())
  .collect()
}

/// Bare or not — the panel refuses a bare repository (there is no worktree).
pub fn is_bare_args() -> Vec<String> {
  ["rev-parse", "--is-bare-repository"]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

/// The worktree root, absolute.
pub fn toplevel_args() -> Vec<String> {
  ["rev-parse", "--show-toplevel"]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

/// `git add -- <paths>`.
pub fn stage_args(paths: &[String]) -> Vec<String> {
  let mut argv = vec!["add".to_string(), "--".to_string()];
  argv.extend(paths.iter().cloned());
  argv
}

/// `git restore --staged -- <paths>` — the modern spelling of `reset`.
pub fn unstage_args(paths: &[String]) -> Vec<String> {
  let mut argv = vec![
    "restore".to_string(),
    "--staged".to_string(),
    "--".to_string(),
  ];
  argv.extend(paths.iter().cloned());
  argv
}

/// Unborn-HEAD fallback for unstage: there is no commit for `restore --staged`
/// to read, so the index entry is removed directly.
pub fn unstage_unborn_args(paths: &[String]) -> Vec<String> {
  let mut argv = vec![
    "rm".to_string(),
    "--cached".to_string(),
    "--".to_string(),
  ];
  argv.extend(paths.iter().cloned());
  argv
}

/// Tracked discard: rewrite the worktree file from the index.
pub fn restore_worktree_args(paths: &[String]) -> Vec<String> {
  let mut argv = vec![
    "restore".to_string(),
    "--worktree".to_string(),
    "--".to_string(),
  ];
  argv.extend(paths.iter().cloned());
  argv
}

/// Untracked discard: `clean -f` deletes files only — no `-d`, so no directory
/// outside the listed paths is ever removed.
pub fn clean_args(paths: &[String]) -> Vec<String> {
  let mut argv = vec!["clean".to_string(), "-f".to_string(), "--".to_string()];
  argv.extend(paths.iter().cloned());
  argv
}

/// Which of the candidate paths git actually tracks. Used to split discard into
/// `restore --worktree` (tracked) and `clean -f` (untracked).
pub fn ls_files_args(paths: &[String]) -> Vec<String> {
  let mut argv = vec![
    "ls-files".to_string(),
    "-z".to_string(),
    "--".to_string(),
  ];
  argv.extend(paths.iter().cloned());
  argv
}

/// `git commit -F -` — the message goes over stdin so it never becomes argv text.
pub fn commit_args(amend: bool) -> Vec<String> {
  let mut argv = vec![
    "commit".to_string(),
    "-F".to_string(),
    "-".to_string(),
  ];
  if amend {
    argv.push("--amend".to_string());
  }
  argv
}

/// `git init <path>`; the path is already validated by the caller.
pub fn init_args(path: &str) -> Vec<String> {
  vec!["init".to_string(), path.to_string()]
}

/// `git merge|rebase|cherry-pick|revert --abort`, for the in-progress-operation
/// banner. The option is an allow-list, never a frontend string.
pub fn abort_args(op: &str) -> Option<Vec<String>> {
  let verb = match op {
    "merge" => "merge",
    "rebase" => "rebase",
    "cherry-pick" => "cherry-pick",
    "revert" => "revert",
    _ => return None,
  };
  Some(vec![verb.to_string(), "--abort".to_string()])
}

/// Validate a branch name before it becomes an argv element. Tree-ish names with
/// slashes are fine; a leading `-` would be read as an option by git.
pub fn checked_branch_name(name: &str) -> Result<String, String> {
  let n = name.trim();
  if n.is_empty() {
    return Err(super::git_error("branch", "missing branch name"));
  }
  if n.starts_with('-') {
    return Err(super::git_error("branch", format!("invalid branch name: {n}")));
  }
  if n.chars().any(|c| c.is_control() || c == ' ' || c == '~' || c == '^' || c == ':') {
    return Err(super::git_error("branch", format!("invalid branch name: {n}")));
  }
  Ok(n.to_string())
}

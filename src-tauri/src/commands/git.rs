//! Git panel commands.
//!
//! Every command is a `git` argv executed through [`crate::git_host::exec_git`]
//! on the jump host or on this machine; parsing lives in [`crate::git`] so it can
//! be unit-tested without a repository. Registration happens in three places
//! (here, `commands/mod.rs`, `lib.rs`) — the third one failing is a runtime
//! "command not found", not a compile error.

use super::*;
use crate::git::branch;
use crate::git::conflict;
use crate::git::history;
use crate::git::parse;
use crate::git::remote;
use crate::git::stash;
use crate::git::status;
use crate::git::{
  GitBlameLine, GitBranch, GitCommitFile, GitCommitResult, GitConflicts, GitDiff, GitLogPage,
  GitNetworkResult, GitRemote, GitRepoInfo, GitStash, GitStatus, MAX_STATUS_ENTRIES,
};
use crate::git_host::{
  exec_git, exec_git_streaming, probe_git, GitHostRef, GitProbe, GitState, READ_TIMEOUT,
  WRITE_TIMEOUT,
};

/// The repository root must name something; everything downstream uses it as
/// `git -C root`.
fn checked_root(root: &str) -> Result<String, String> {
  let r = root.trim();
  if r.is_empty() {
    return Err(crate::git::git_error("no_folder", "no repository path"));
  }
  Ok(r.to_string())
}

fn failed(stage: &str, out: &[u8], err: &[u8], code: u32) -> String {
  let text = if err.is_empty() { out } else { err };
  if text.is_empty() {
    return crate::git::git_error(stage, format!("git exited {code}"));
  }
  crate::git::classify_error(stage, text)
}

async fn status_of(
  state: &tauri::State<'_, AppState>,
  cli: &GitState,
  host: &GitHostRef,
  root: &str,
) -> Result<GitStatus, String> {
  let (out, err, code) = exec_git(
    state,
    cli,
    host,
    Some(root),
    &status::status_args(),
    None,
    READ_TIMEOUT,
  )
  .await?;
  if code != 0 {
    return Err(failed("status", &out, &err, code));
  }
  Ok(parse::parse_status(&out, MAX_STATUS_ENTRIES))
}

async fn branches_of(
  state: &tauri::State<'_, AppState>,
  cli: &GitState,
  host: &GitHostRef,
  root: &str,
) -> Result<Vec<GitBranch>, String> {
  let (out, err, code) = exec_git(
    state,
    cli,
    host,
    Some(root),
    &branch::list_args(),
    None,
    READ_TIMEOUT,
  )
  .await?;
  if code != 0 {
    return Err(failed("branch", &out, &err, code));
  }
  Ok(parse::parse_branches(&out))
}

/// Whether the host has git. Always `Ok`: "not installed" is a state the panel
/// renders, not a failed call.
#[tauri::command]
pub async fn git_probe(
  state: tauri::State<'_, AppState>,
  cli: tauri::State<'_, GitState>,
  host: GitHostRef,
  bin: Option<String>,
) -> Result<GitProbe, String> {
  Ok(probe_git(&state, cli.inner(), &host, bin.as_deref()).await)
}

/// `rev-parse` inside `path`: the worktree root, or `git_not_repo` for anything
/// that is not a repository.
#[tauri::command]
pub async fn git_repo_info(
  state: tauri::State<'_, AppState>,
  cli: tauri::State<'_, GitState>,
  host: GitHostRef,
  path: String,
) -> Result<GitRepoInfo, String> {
  let path = path.trim();
  if path.is_empty() {
    return Err(crate::git::git_error("no_folder", "no folder selected"));
  }
  let (bare_out, bare_err, bare_code) = exec_git(
    &state,
    cli.inner(),
    &host,
    Some(path),
    &status::is_bare_args(),
    None,
    READ_TIMEOUT,
  )
  .await?;
  if bare_code != 0 {
    return Err(failed("not_repo", &bare_out, &bare_err, bare_code));
  }
  let bare = String::from_utf8_lossy(&bare_out).trim() == "true";
  if bare {
    return Ok(GitRepoInfo {
      root: path.to_string(),
      bare: true,
    });
  }
  let (out, err, code) = exec_git(
    &state,
    cli.inner(),
    &host,
    Some(path),
    &status::toplevel_args(),
    None,
    READ_TIMEOUT,
  )
  .await?;
  if code != 0 {
    return Err(failed("not_repo", &out, &err, code));
  }
  let root = String::from_utf8_lossy(&out).trim().to_string();
  if root.is_empty() {
    return Err(crate::git::git_error("not_repo", "git reported no worktree root"));
  }
  Ok(GitRepoInfo { root, bare: false })
}

#[tauri::command]
pub async fn git_status(
  state: tauri::State<'_, AppState>,
  cli: tauri::State<'_, GitState>,
  host: GitHostRef,
  root: String,
) -> Result<GitStatus, String> {
  let root = checked_root(&root)?;
  status_of(&state, cli.inner(), &host, &root).await
}

#[tauri::command]
pub async fn git_diff(
  state: tauri::State<'_, AppState>,
  cli: tauri::State<'_, GitState>,
  host: GitHostRef,
  root: String,
  path: Option<String>,
  scope: String,
  oid: Option<String>,
) -> Result<GitDiff, String> {
  let root = checked_root(&root)?;
  let rel = match path.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
    Some(p) => Some(crate::git::checked_rel_path(p)?),
    None => None,
  };
  let mut argv = match scope.as_str() {
    "unstaged" => vec![
      "diff".to_string(),
      "--no-color".to_string(),
      "--no-ext-diff".to_string(),
      "--unified=3".to_string(),
      "--".to_string(),
    ],
    "staged" => vec![
      "diff".to_string(),
      "--cached".to_string(),
      "--no-color".to_string(),
      "--no-ext-diff".to_string(),
      "--unified=3".to_string(),
      "--".to_string(),
    ],
    "commit" => {
      let oid = history::checked_oid(oid.as_deref().unwrap_or(""))?;
      vec![
        "show".to_string(),
        "--format=".to_string(),
        "--no-color".to_string(),
        "--unified=3".to_string(),
        oid,
        "--".to_string(),
      ]
    }
    other => {
      return Err(crate::git::git_error(
        "diff",
        format!("unknown diff scope: {other}"),
      ))
    }
  };
  if let Some(p) = rel {
    argv.push(p);
  }
  let (out, err, code) = exec_git(
    &state,
    cli.inner(),
    &host,
    Some(&root),
    &argv,
    None,
    READ_TIMEOUT,
  )
  .await?;
  if code != 0 {
    return Err(failed("diff", &out, &err, code));
  }
  Ok(parse::parse_diff(&out))
}

#[tauri::command]
pub async fn git_log(
  state: tauri::State<'_, AppState>,
  cli: tauri::State<'_, GitState>,
  host: GitHostRef,
  root: String,
  limit: usize,
  skip: usize,
) -> Result<GitLogPage, String> {
  let root = checked_root(&root)?;
  let (out, err, code) = exec_git(
    &state,
    cli.inner(),
    &host,
    Some(&root),
    &history::log_args(limit, skip),
    None,
    READ_TIMEOUT,
  )
  .await?;
  if code != 0 {
    return Err(failed("log", &out, &err, code));
  }
  Ok(parse::parse_log(&out, limit.clamp(1, history::MAX_LOG_LIMIT)))
}

#[tauri::command]
pub async fn git_commit_files(
  state: tauri::State<'_, AppState>,
  cli: tauri::State<'_, GitState>,
  host: GitHostRef,
  root: String,
  oid: String,
) -> Result<Vec<GitCommitFile>, String> {
  let root = checked_root(&root)?;
  let oid = history::checked_oid(&oid)?;
  let (out, err, code) = exec_git(
    &state,
    cli.inner(),
    &host,
    Some(&root),
    &history::commit_files_args(&oid),
    None,
    READ_TIMEOUT,
  )
  .await?;
  if code != 0 {
    return Err(failed("log", &out, &err, code));
  }
  Ok(parse::parse_commit_files(&out))
}

/// `git blame --line-porcelain` for one tracked path, optionally at a commit.
#[tauri::command]
pub async fn git_blame(
  state: tauri::State<'_, AppState>,
  cli: tauri::State<'_, GitState>,
  host: GitHostRef,
  root: String,
  path: String,
  oid: Option<String>,
) -> Result<Vec<GitBlameLine>, String> {
  let root = checked_root(&root)?;
  let rel = crate::git::checked_rel_path(&path)?;
  let oid = match oid.as_deref().map(str::trim).filter(|o| !o.is_empty()) {
    Some(o) => Some(history::checked_oid(o)?),
    None => None,
  };
  let (out, err, code) = exec_git(
    &state,
    cli.inner(),
    &host,
    Some(&root),
    &history::blame_args(&rel, oid.as_deref()),
    None,
    READ_TIMEOUT,
  )
  .await?;
  if code != 0 {
    return Err(failed("blame", &out, &err, code));
  }
  Ok(parse::parse_blame(&out))
}

#[tauri::command]
pub async fn git_branches(
  state: tauri::State<'_, AppState>,
  cli: tauri::State<'_, GitState>,
  host: GitHostRef,
  root: String,
) -> Result<Vec<GitBranch>, String> {
  let root = checked_root(&root)?;
  branches_of(&state, cli.inner(), &host, &root).await
}

#[tauri::command]
pub async fn git_remotes(
  state: tauri::State<'_, AppState>,
  cli: tauri::State<'_, GitState>,
  host: GitHostRef,
  root: String,
) -> Result<Vec<GitRemote>, String> {
  let root = checked_root(&root)?;
  let (out, err, code) = exec_git(
    &state,
    cli.inner(),
    &host,
    Some(&root),
    &remote::list_args(),
    None,
    READ_TIMEOUT,
  )
  .await?;
  if code != 0 {
    return Err(failed("remote", &out, &err, code));
  }
  Ok(parse::parse_remotes(&out))
}

#[tauri::command]
pub async fn git_stage(
  state: tauri::State<'_, AppState>,
  cli: tauri::State<'_, GitState>,
  host: GitHostRef,
  root: String,
  paths: Vec<String>,
) -> Result<GitStatus, String> {
  let root = checked_root(&root)?;
  let paths = crate::git::checked_rel_paths(&paths)?;
  let _lock = cli.try_lock(&host, &root)?;
  let (out, err, code) = exec_git(
    &state,
    cli.inner(),
    &host,
    Some(&root),
    &status::stage_args(&paths),
    None,
    WRITE_TIMEOUT,
  )
  .await?;
  if code != 0 {
    return Err(failed("stage", &out, &err, code));
  }
  status_of(&state, cli.inner(), &host, &root).await
}

#[tauri::command]
pub async fn git_unstage(
  state: tauri::State<'_, AppState>,
  cli: tauri::State<'_, GitState>,
  host: GitHostRef,
  root: String,
  paths: Vec<String>,
) -> Result<GitStatus, String> {
  let root = checked_root(&root)?;
  let paths = crate::git::checked_rel_paths(&paths)?;
  let _lock = cli.try_lock(&host, &root)?;
  let (out, err, code) = exec_git(
    &state,
    cli.inner(),
    &host,
    Some(&root),
    &status::unstage_args(&paths),
    None,
    WRITE_TIMEOUT,
  )
  .await?;
  if code != 0 {
    // An unborn HEAD has no commit for `restore --staged` to read; removing the
    // index entry directly is the equivalent operation.
    let text = String::from_utf8_lossy(&err).to_ascii_lowercase();
    if text.contains("could not resolve head") {
      let (out, err, code) = exec_git(
        &state,
        cli.inner(),
        &host,
        Some(&root),
        &status::unstage_unborn_args(&paths),
        None,
        WRITE_TIMEOUT,
      )
      .await?;
      if code != 0 {
        return Err(failed("unstage", &out, &err, code));
      }
    } else {
      return Err(failed("unstage", &out, &err, code));
    }
  }
  status_of(&state, cli.inner(), &host, &root).await
}

/// Discard: tracked paths are rewritten from the index, untracked ones are
/// deleted as files. `clean -f` never takes `-d`, so a listed directory outside
/// the worktree's ignore rules is not recursed into.
#[tauri::command]
pub async fn git_discard(
  state: tauri::State<'_, AppState>,
  cli: tauri::State<'_, GitState>,
  host: GitHostRef,
  root: String,
  paths: Vec<String>,
) -> Result<GitStatus, String> {
  let root = checked_root(&root)?;
  let paths = crate::git::checked_rel_paths(&paths)?;
  let _lock = cli.try_lock(&host, &root)?;
  let (out, _, _) = exec_git(
    &state,
    cli.inner(),
    &host,
    Some(&root),
    &status::ls_files_args(&paths),
    None,
    READ_TIMEOUT,
  )
  .await?;
  let tracked: std::collections::HashSet<String> = out
    .split(|b| *b == 0)
    .map(|t| String::from_utf8_lossy(t).to_string())
    .filter(|s| !s.is_empty())
    .collect();
  let (tracked_paths, untracked_paths): (Vec<String>, Vec<String>) =
    paths.into_iter().partition(|p| tracked.contains(p));
  if !tracked_paths.is_empty() {
    let (out, err, code) = exec_git(
      &state,
      cli.inner(),
      &host,
      Some(&root),
      &status::restore_worktree_args(&tracked_paths),
      None,
      WRITE_TIMEOUT,
    )
    .await?;
    if code != 0 {
      return Err(failed("discard", &out, &err, code));
    }
  }
  if !untracked_paths.is_empty() {
    let (out, err, code) = exec_git(
      &state,
      cli.inner(),
      &host,
      Some(&root),
      &status::clean_args(&untracked_paths),
      None,
      WRITE_TIMEOUT,
    )
    .await?;
    if code != 0 {
      return Err(failed("discard", &out, &err, code));
    }
  }
  status_of(&state, cli.inner(), &host, &root).await
}

#[tauri::command]
pub async fn git_commit(
  state: tauri::State<'_, AppState>,
  cli: tauri::State<'_, GitState>,
  host: GitHostRef,
  root: String,
  message: String,
  amend: bool,
) -> Result<GitCommitResult, String> {
  let root = checked_root(&root)?;
  if message.trim().is_empty() {
    return Err(crate::git::git_error(
      "commit",
      "the commit message is empty",
    ));
  }
  let _lock = cli.try_lock(&host, &root)?;
  let (out, err, code) = exec_git(
    &state,
    cli.inner(),
    &host,
    Some(&root),
    &status::commit_args(amend),
    Some(message.as_bytes()),
    WRITE_TIMEOUT,
  )
  .await?;
  if code != 0 {
    return Err(failed("commit", &out, &err, code));
  }
  let (oid_out, _, _) = exec_git(
    &state,
    cli.inner(),
    &host,
    Some(&root),
    &["rev-parse".to_string(), "HEAD".to_string()],
    None,
    READ_TIMEOUT,
  )
  .await?;
  let oid = String::from_utf8_lossy(&oid_out).trim().to_string();
  let (sum_out, _, _) = exec_git(
    &state,
    cli.inner(),
    &host,
    Some(&root),
    &[
      "log".to_string(),
      "-1".to_string(),
      "--format=%s".to_string(),
    ],
    None,
    READ_TIMEOUT,
  )
  .await?;
  Ok(GitCommitResult {
    oid,
    summary: String::from_utf8_lossy(&sum_out).trim().to_string(),
  })
}

#[tauri::command]
pub async fn git_branch_create(
  state: tauri::State<'_, AppState>,
  cli: tauri::State<'_, GitState>,
  host: GitHostRef,
  root: String,
  name: String,
  start_point: Option<String>,
  checkout: bool,
) -> Result<GitStatus, String> {
  let root = checked_root(&root)?;
  let name = status::checked_branch_name(&name)?;
  let start = start_point
    .as_deref()
    .map(str::trim)
    .filter(|s| !s.is_empty());
  let _lock = cli.try_lock(&host, &root)?;
  let (out, err, code) = exec_git(
    &state,
    cli.inner(),
    &host,
    Some(&root),
    &branch::create_args(&name, start, checkout),
    None,
    WRITE_TIMEOUT,
  )
  .await?;
  if code != 0 {
    return Err(failed("branch", &out, &err, code));
  }
  status_of(&state, cli.inner(), &host, &root).await
}

#[tauri::command]
pub async fn git_branch_switch(
  state: tauri::State<'_, AppState>,
  cli: tauri::State<'_, GitState>,
  host: GitHostRef,
  root: String,
  name: String,
) -> Result<GitStatus, String> {
  let root = checked_root(&root)?;
  let name = status::checked_branch_name(&name)?;
  let _lock = cli.try_lock(&host, &root)?;
  let (out, err, code) = exec_git(
    &state,
    cli.inner(),
    &host,
    Some(&root),
    &branch::switch_args(&name),
    None,
    WRITE_TIMEOUT,
  )
  .await?;
  if code != 0 {
    return Err(failed("branch", &out, &err, code));
  }
  status_of(&state, cli.inner(), &host, &root).await
}

#[tauri::command]
pub async fn git_branch_delete(
  state: tauri::State<'_, AppState>,
  cli: tauri::State<'_, GitState>,
  host: GitHostRef,
  root: String,
  name: String,
  force: bool,
) -> Result<Vec<GitBranch>, String> {
  let root = checked_root(&root)?;
  let name = status::checked_branch_name(&name)?;
  let _lock = cli.try_lock(&host, &root)?;
  let (out, err, code) = exec_git(
    &state,
    cli.inner(),
    &host,
    Some(&root),
    &branch::delete_args(&name, force),
    None,
    WRITE_TIMEOUT,
  )
  .await?;
  if code != 0 {
    return Err(failed("branch", &out, &err, code));
  }
  branches_of(&state, cli.inner(), &host, &root).await
}

/// Abort an in-progress merge / rebase / cherry-pick / revert, so the panel's
/// banner can restore a clean worktree without a terminal.
#[tauri::command]
pub async fn git_abort(
  state: tauri::State<'_, AppState>,
  cli: tauri::State<'_, GitState>,
  host: GitHostRef,
  root: String,
  operation: String,
) -> Result<GitStatus, String> {
  let root = checked_root(&root)?;
  let argv = status::abort_args(&operation).ok_or_else(|| {
    crate::git::git_error("abort", format!("unknown operation: {operation}"))
  })?;
  let _lock = cli.try_lock(&host, &root)?;
  let (out, err, code) = exec_git(
    &state,
    cli.inner(),
    &host,
    Some(&root),
    &argv,
    None,
    WRITE_TIMEOUT,
  )
  .await?;
  if code != 0 {
    return Err(failed("abort", &out, &err, code));
  }
  status_of(&state, cli.inner(), &host, &root).await
}

/// Unmerged paths and the in-progress operation. `in_progress` is detected by
/// probing the marker refs (`MERGE_HEAD`, …); anything unexpected there is not
/// an error the panel needs — the status list is the source of truth for rows.
#[tauri::command]
pub async fn git_conflicts(
  state: tauri::State<'_, AppState>,
  cli: tauri::State<'_, GitState>,
  host: GitHostRef,
  root: String,
) -> Result<GitConflicts, String> {
  let root = checked_root(&root)?;
  let mut in_progress = None;
  for op in conflict::IN_PROGRESS_OPERATIONS {
    let Some(argv) = conflict::in_progress_probe_args(op) else {
      continue;
    };
    let (_, _, code) = exec_git(&state, cli.inner(), &host, Some(&root), &argv, None, READ_TIMEOUT)
      .await?;
    if code == 0 {
      in_progress = Some(op.to_string());
      break;
    }
  }
  let (out, err, code) = exec_git(
    &state,
    cli.inner(),
    &host,
    Some(&root),
    &conflict::list_args(),
    None,
    READ_TIMEOUT,
  )
  .await?;
  if code != 0 {
    return Err(failed("conflict", &out, &err, code));
  }
  let paths = out
    .split(|b| *b == 0)
    .map(|t| String::from_utf8_lossy(t).to_string())
    .filter(|s| !s.is_empty())
    .collect();
  Ok(GitConflicts { in_progress, paths })
}

/// One conflict path, one decision: take a side or re-add after a manual edit.
#[tauri::command]
pub async fn git_resolve(
  state: tauri::State<'_, AppState>,
  cli: tauri::State<'_, GitState>,
  host: GitHostRef,
  root: String,
  path: String,
  resolution: String,
) -> Result<GitStatus, String> {
  let root = checked_root(&root)?;
  let path = crate::git::checked_rel_path(&path)?;
  let argv = conflict::resolve_args(&path, &resolution).ok_or_else(|| {
    crate::git::git_error("resolve", format!("unknown resolution: {resolution}"))
  })?;
  let _lock = cli.try_lock(&host, &root)?;
  let (out, err, code) = exec_git(
    &state,
    cli.inner(),
    &host,
    Some(&root),
    &argv,
    None,
    WRITE_TIMEOUT,
  )
  .await?;
  if code != 0 {
    return Err(failed("resolve", &out, &err, code));
  }
  status_of(&state, cli.inner(), &host, &root).await
}

#[tauri::command]
pub async fn git_init(
  state: tauri::State<'_, AppState>,
  cli: tauri::State<'_, GitState>,
  host: GitHostRef,
  path: String,
) -> Result<GitRepoInfo, String> {
  let path = path.trim();
  if path.is_empty() {
    return Err(crate::git::git_error("no_folder", "no folder selected"));
  }
  let (out, err, code) = exec_git(
    &state,
    cli.inner(),
    &host,
    None,
    &status::init_args(path),
    None,
    WRITE_TIMEOUT,
  )
  .await?;
  if code != 0 {
    return Err(failed("init", &out, &err, code));
  }
  git_repo_info(state, cli, host, path.to_string()).await
}

/// `git remote add <name> <url>`. Returns the refreshed remote list.
#[tauri::command]
pub async fn git_remote_add(
  state: tauri::State<'_, AppState>,
  cli: tauri::State<'_, GitState>,
  host: GitHostRef,
  root: String,
  name: String,
  url: String,
) -> Result<Vec<GitRemote>, String> {
  let root = checked_root(&root)?;
  let name = remote::checked_remote(&name)?;
  let url = remote::checked_url(&url)?;
  let _lock = cli.try_lock(&host, &root)?;
  let (out, err, code) = exec_git(
    &state,
    cli.inner(),
    &host,
    Some(&root),
    &remote::add_args(&name, &url),
    None,
    WRITE_TIMEOUT,
  )
  .await?;
  if code != 0 {
    return Err(failed("remote", &out, &err, code));
  }
  let (out, err, code) = exec_git(
    &state,
    cli.inner(),
    &host,
    Some(&root),
    &remote::list_args(),
    None,
    READ_TIMEOUT,
  )
  .await?;
  if code != 0 {
    return Err(failed("remote", &out, &err, code));
  }
  Ok(parse::parse_remotes(&out))
}

/// `git remote remove <name>`. Returns the refreshed remote list.
#[tauri::command]
pub async fn git_remote_remove(
  state: tauri::State<'_, AppState>,
  cli: tauri::State<'_, GitState>,
  host: GitHostRef,
  root: String,
  name: String,
) -> Result<Vec<GitRemote>, String> {
  let root = checked_root(&root)?;
  let name = remote::checked_remote(&name)?;
  let _lock = cli.try_lock(&host, &root)?;
  let (out, err, code) = exec_git(
    &state,
    cli.inner(),
    &host,
    Some(&root),
    &remote::remove_args(&name),
    None,
    WRITE_TIMEOUT,
  )
  .await?;
  if code != 0 {
    return Err(failed("remote", &out, &err, code));
  }
  let (out, err, code) = exec_git(
    &state,
    cli.inner(),
    &host,
    Some(&root),
    &remote::list_args(),
    None,
    READ_TIMEOUT,
  )
  .await?;
  if code != 0 {
    return Err(failed("remote", &out, &err, code));
  }
  Ok(parse::parse_remotes(&out))
}

// ==================== Stash ====================

/// Helper shared by every stash command: read the list back after a write, so
/// the panel always renders what git actually has.
async fn stash_list_of(
  state: &tauri::State<'_, AppState>,
  cli: &GitState,
  host: &GitHostRef,
  root: &str,
) -> Result<Vec<GitStash>, String> {
  let (out, err, code) = exec_git(
    state,
    cli,
    host,
    Some(root),
    &stash::list_args(),
    None,
    READ_TIMEOUT,
  )
  .await?;
  if code != 0 {
    return Err(failed("stash", &out, &err, code));
  }
  Ok(parse::parse_stash_list(&out))
}

#[tauri::command]
pub async fn git_stash_list(
  state: tauri::State<'_, AppState>,
  cli: tauri::State<'_, GitState>,
  host: GitHostRef,
  root: String,
) -> Result<Vec<GitStash>, String> {
  let root = checked_root(&root)?;
  stash_list_of(&state, cli.inner(), &host, &root).await
}

/// `git stash push`: the working tree leaves, the stash entry appears. Untracked
/// files are included only when the panel asked for them.
#[tauri::command]
pub async fn git_stash_push(
  state: tauri::State<'_, AppState>,
  cli: tauri::State<'_, GitState>,
  host: GitHostRef,
  root: String,
  message: Option<String>,
  include_untracked: bool,
) -> Result<Vec<GitStash>, String> {
  let root = checked_root(&root)?;
  let _lock = cli.try_lock(&host, &root)?;
  let (out, err, code) = exec_git(
    &state,
    cli.inner(),
    &host,
    Some(&root),
    &stash::push_args(message.as_deref(), include_untracked),
    None,
    WRITE_TIMEOUT,
  )
  .await?;
  if code != 0 {
    return Err(failed("stash", &out, &err, code));
  }
  stash_list_of(&state, cli.inner(), &host, &root).await
}

/// `pop` applies and drops; `apply` keeps the entry; `drop` discards it.
#[tauri::command]
pub async fn git_stash_entry(
  state: tauri::State<'_, AppState>,
  cli: tauri::State<'_, GitState>,
  host: GitHostRef,
  root: String,
  index: u32,
  action: String,
) -> Result<Vec<GitStash>, String> {
  let root = checked_root(&root)?;
  let argv = stash::entry_args(&action, index)
    .ok_or_else(|| crate::git::git_error("stash", format!("unknown stash action: {action}")))?;
  let _lock = cli.try_lock(&host, &root)?;
  let (out, err, code) = exec_git(
    &state,
    cli.inner(),
    &host,
    Some(&root),
    &argv,
    None,
    WRITE_TIMEOUT,
  )
  .await?;
  if code != 0 {
    return Err(failed("stash", &out, &err, code));
  }
  stash_list_of(&state, cli.inner(), &host, &root).await
}

// ==================== Network ====================

/// Shared tail of fetch / pull / push: streaming progress, cancellation, and the
/// exit check. `finish` runs even when the call failed, so a cancelled op id
/// cannot linger in `GitState`.
async fn run_network(
  app: &tauri::AppHandle,
  state: &tauri::State<'_, AppState>,
  cli: &GitState,
  host: &GitHostRef,
  root: &str,
  args: &[String],
  op_id: &str,
  stage: &str,
) -> Result<GitNetworkResult, String> {
  let flag = cli.cancel_flag(op_id);
  let result = exec_git_streaming(app, state, cli, host, Some(root), args, op_id, flag).await;
  cli.finish(op_id);
  let (out, err, code) = result?;
  if code != 0 {
    return Err(failed(stage, &out, &err, code));
  }
  Ok(GitNetworkResult {
    stdout: String::from_utf8_lossy(&out).trim().to_string(),
    stderr: String::from_utf8_lossy(&err).trim().to_string(),
  })
}

fn checked_op_id(op_id: &str) -> Result<String, String> {
  let id = op_id.trim();
  if id.is_empty() {
    return Err(crate::git::git_error("network", "missing operation id"));
  }
  Ok(id.to_string())
}

#[tauri::command]
pub async fn git_fetch(
  app: tauri::AppHandle,
  state: tauri::State<'_, AppState>,
  cli: tauri::State<'_, GitState>,
  host: GitHostRef,
  root: String,
  remote: Option<String>,
  op_id: String,
) -> Result<GitNetworkResult, String> {
  let root = checked_root(&root)?;
  let op_id = checked_op_id(&op_id)?;
  let remote = match remote.as_deref().map(str::trim).filter(|r| !r.is_empty()) {
    Some(r) => Some(remote::checked_remote(r)?),
    None => None,
  };
  run_network(
    &app,
    &state,
    cli.inner(),
    &host,
    &root,
    &remote::fetch_args(remote.as_deref()),
    &op_id,
    "fetch",
  )
  .await
}

#[tauri::command]
pub async fn git_pull(
  app: tauri::AppHandle,
  state: tauri::State<'_, AppState>,
  cli: tauri::State<'_, GitState>,
  host: GitHostRef,
  root: String,
  remote: Option<String>,
  branch: Option<String>,
  op_id: String,
) -> Result<GitNetworkResult, String> {
  let root = checked_root(&root)?;
  let op_id = checked_op_id(&op_id)?;
  let remote = match remote.as_deref().map(str::trim).filter(|r| !r.is_empty()) {
    Some(r) => Some(remote::checked_remote(r)?),
    None => None,
  };
  let branch = match branch.as_deref().map(str::trim).filter(|b| !b.is_empty()) {
    Some(b) => Some(status::checked_branch_name(b)?),
    None => None,
  };
  let _lock = cli.try_lock(&host, &root)?;
  run_network(
    &app,
    &state,
    cli.inner(),
    &host,
    &root,
    &remote::pull_args(remote.as_deref(), branch.as_deref()),
    &op_id,
    "pull",
  )
  .await
}

#[tauri::command]
pub async fn git_push(
  app: tauri::AppHandle,
  state: tauri::State<'_, AppState>,
  cli: tauri::State<'_, GitState>,
  host: GitHostRef,
  root: String,
  remote: Option<String>,
  branch: Option<String>,
  force: bool,
  op_id: String,
) -> Result<GitNetworkResult, String> {
  let root = checked_root(&root)?;
  let op_id = checked_op_id(&op_id)?;
  let remote = match remote.as_deref().map(str::trim).filter(|r| !r.is_empty()) {
    Some(r) => Some(remote::checked_remote(r)?),
    None => None,
  };
  let branch = match branch.as_deref().map(str::trim).filter(|b| !b.is_empty()) {
    Some(b) => Some(remote::checked_branch(b)?),
    None => None,
  };
  run_network(
    &app,
    &state,
    cli.inner(),
    &host,
    &root,
    &remote::push_args(remote.as_deref(), branch.as_deref(), force),
    &op_id,
    "push",
  )
  .await
}

/// Cooperative cancel: flag the operation, which kills the local child or closes
/// the remote channel. Unknown / already-finished ids are not an error.
#[tauri::command]
pub async fn git_cancel(
  cli: tauri::State<'_, GitState>,
  op_id: String,
) -> Result<(), String> {
  cli.cancel(&op_id);
  Ok(())
}

/// A clone destination is a host-side path, not a repo-relative one — validate
/// shape only: non-empty, no option prefix, no control characters.
fn checked_dest(dest: &str) -> Result<String, String> {
  let d = dest.trim();
  if d.is_empty() {
    return Err(crate::git::git_error("clone", "missing destination path"));
  }
  if d.starts_with('-') || d.chars().any(|c| c.is_control()) {
    return Err(crate::git::git_error("clone", format!("invalid destination: {d}")));
  }
  Ok(d.to_string())
}

/// `git clone --progress <url> <dest>` — streaming like the network verbs, then
/// the new repository is probed so the panel can open it directly.
#[tauri::command]
pub async fn git_clone(
  app: tauri::AppHandle,
  state: tauri::State<'_, AppState>,
  cli: tauri::State<'_, GitState>,
  host: GitHostRef,
  url: String,
  dest: String,
  op_id: String,
) -> Result<GitRepoInfo, String> {
  let url = remote::checked_url(&url)?;
  let dest = checked_dest(&dest)?;
  let op_id = checked_op_id(&op_id)?;
  let flag = cli.cancel_flag(&op_id);
  let result = exec_git_streaming(
    &app,
    &state,
    cli.inner(),
    &host,
    None,
    &[
      "clone".to_string(),
      "--progress".to_string(),
      url,
      dest.clone(),
    ],
    &op_id,
    flag,
  )
  .await;
  cli.finish(&op_id);
  let (out, err, code) = result?;
  if code != 0 {
    return Err(failed("clone", &out, &err, code));
  }
  git_repo_info(state, cli, host, dest).await
}

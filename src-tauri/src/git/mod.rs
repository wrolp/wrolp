//! Git panel models, error vocabulary and shared validation.
//!
//! The panel speaks to the host's own `git` CLI (see [`crate::git_host`]), so every
//! type here is what one command's stdout parses into. Error strings follow the
//! reference implementation's `git_<stage>:<message>` convention: the frontend maps
//! the stage to a translated sentence and shows the rest verbatim.

pub mod parse;
pub mod branch;
pub mod conflict;
pub mod history;
pub mod remote;
pub mod scan;
pub mod stash;
pub mod status;

#[cfg(test)]
mod tests;

use serde::{Deserialize, Serialize};

/// The most status entries the panel accepts. A bigger working tree is truncated
/// rather than shipped across IPC and painted.
pub const MAX_STATUS_ENTRIES: usize = 5000;
/// One side of a diff. Beyond this the viewer asks the user to use a terminal.
pub const MAX_DIFF_BYTES: usize = 2 * 1024 * 1024;

// ==================== Models ====================

/// Where the repository is. `bare` repositories have no worktree, so the panel
/// shows a terminal hint instead of pretending a status exists.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRepoInfo {
  pub root: String,
  pub bare: bool,
}

/// Working-tree state, parsed from `git status --porcelain=v2 -z --branch`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
  /// `None` means detached HEAD.
  pub branch: Option<String>,
  pub head_oid: Option<String>,
  pub detached: bool,
  /// A fresh `git init`: HEAD names a branch that has no commit yet.
  pub unborn: bool,
  pub upstream: Option<String>,
  pub ahead: u32,
  pub behind: u32,
  pub entries: Vec<GitStatusEntry>,
  pub truncated: bool,
}

/// One working-tree row. `x` / `y` are the porcelain letters passed through
/// untouched; the panel colours them, the backend never translates them.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusEntry {
  pub path: String,
  pub orig_path: Option<String>,
  /// Index letter (`.` = unchanged).
  pub x: String,
  /// Worktree letter (`.` = unchanged).
  pub y: String,
  /// `modified` / `untracked` / `conflicted` / `ignored` / `renamed`.
  pub kind: String,
  pub staged: bool,
  pub unstaged: bool,
  pub conflicted: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiff {
  pub text: String,
  pub truncated: bool,
  pub binary: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommit {
  pub oid: String,
  pub short_oid: String,
  pub author_name: String,
  pub author_email: String,
  /// Unix seconds; the panel formats relative time.
  pub timestamp: i64,
  pub parents: Vec<String>,
  /// Decoration (`HEAD -> main, origin/main`), already split on `, `.
  pub refs: Vec<String>,
  pub subject: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLogPage {
  pub commits: Vec<GitCommit>,
  pub has_more: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitFile {
  pub path: String,
  /// The `--name-status` letter (`M`, `A`, `D`, `R100`…).
  pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranch {
  /// `main` or `origin/main` (prefix stripped).
  pub name: String,
  pub full_name: String,
  pub oid: String,
  pub short_oid: String,
  pub upstream: Option<String>,
  pub current: bool,
  pub remote: bool,
  pub date: i64,
  pub subject: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRemote {
  pub name: String,
  /// Credentials stripped before reaching the UI.
  pub fetch_url: String,
  pub push_url: String,
}

/// What `git_commit` learnt back. The panel shows the short oid and the summary.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitResult {
  pub oid: String,
  pub summary: String,
}

/// The tail of a network command, for the panel's log line.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitNetworkResult {
  pub stdout: String,
  pub stderr: String,
}

/// One blame row: who last touched this line, and the line itself.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBlameLine {
  /// 1-based line number in the blamed file.
  pub line: u32,
  pub oid: String,
  pub short_oid: String,
  pub author: String,
  /// Unix seconds.
  pub timestamp: i64,
  pub summary: String,
  /// The file line, with the leading tab git prints stripped.
  pub text: String,
}

/// One `git stash` entry. `index` addresses it as `stash@{index}`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStash {
  pub index: u32,
  pub oid: String,
  /// Unix seconds.
  pub timestamp: i64,
  /// The reflog subject (`WIP on main: …` or the `-m` message).
  pub message: String,
}

/// The three index stages of one unmerged path, as text.
///
/// `None` means the stage does not exist (a modify/delete conflict has no side
/// for the deleted stage), which the merge view renders as an empty pane.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitConflictStages {
  pub base: Option<String>,
  pub ours: Option<String>,
  pub theirs: Option<String>,
  pub binary: bool,
  pub truncated: bool,
}

/// Unmerged paths plus the operation whose merge markers are still live, if any.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitConflicts {
  /// `merge` / `rebase` / `cherry-pick` / `revert`, or `None` when clean.
  pub in_progress: Option<String>,
  pub paths: Vec<String>,
}

// ==================== Errors ====================

/// `git_<stage>:<message>`. Unknown stages reach the UI untouched — swallowing
/// them would hide real git output.
pub fn git_error(stage: &str, message: impl std::fmt::Display) -> String {
  format!("git_{stage}:{message}")
}

/// Map stderr to the specific error stages the panel translates. `stage` is the
/// fallback (`status`, `commit`, …); anything recognisable wins over it.
pub fn classify_error(stage: &str, stderr: &[u8]) -> String {
  let text = String::from_utf8_lossy(stderr).trim().to_string();
  let low = text.to_ascii_lowercase();
  if low.contains("not a git repository") {
    return git_error("not_repo", text);
  }
  if low.contains("index.lock") && low.contains("exists") {
    return git_error("index_locked", text);
  }
  if low.contains("not possible to fast-forward")
    || low.contains("non-fast-forward")
    || low.contains("diverging branches")
  {
    return git_error("not_fast_forward", text);
  }
  if low.contains("authentication failed")
    || low.contains("could not read username")
    || low.contains("could not read password")
    || low.contains("permission denied (publickey)")
    || low.contains("terminal prompts disabled")
  {
    return git_error("auth_required", text);
  }
  if low.contains("no such remote") || low.contains("does not appear to be a git repository") {
    return git_error("no_remote", text);
  }
  if low.contains("please tell me who you are")
    || low.contains("unable to auto-detect email address")
    || low.contains("author identity unknown")
  {
    return git_error("no_identity", text);
  }
  git_error(stage, if text.is_empty() { "git failed" } else { &text })
}

// ==================== Validation ====================

/// Accept only a repository-relative path: never absolute, never a drive letter,
/// never a `..` segment, never a backslash. What the panel calls "discard" must
/// not be able to address anything outside the worktree.
pub fn checked_rel_path(path: &str) -> Result<String, String> {
  let p = path.trim();
  if p.is_empty() {
    return Err(git_error("path_outside", "empty path"));
  }
  if p.starts_with('/') || p.starts_with('\\') {
    return Err(git_error("path_outside", format!("absolute path: {p}")));
  }
  let bytes = p.as_bytes();
  if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
    return Err(git_error("path_outside", format!("drive path: {p}")));
  }
  if p.contains('\\') {
    return Err(git_error("path_outside", format!("backslash path: {p}")));
  }
  if p.contains('\0') {
    return Err(git_error("path_outside", "path contains a NUL byte"));
  }
  if p.split('/').any(|seg| seg == ".." || seg == ".") {
    return Err(git_error("path_outside", format!("relative segment: {p}")));
  }
  Ok(p.to_string())
}

pub fn checked_rel_paths(paths: &[String]) -> Result<Vec<String>, String> {
  if paths.is_empty() {
    return Err(git_error("path_outside", "no paths given"));
  }
  paths.iter().map(|p| checked_rel_path(p)).collect()
}

/// One `.git/info/exclude` line for a repository-relative path.
///
/// Anchored with a leading `/` so a bare file name cannot also match at any
/// depth, and every gitignore metacharacter (`*`, `?`, `[`, `\`) is escaped so
/// the path is matched literally. A leading `#` or `!` would otherwise turn the
/// line into a comment or a negation, so it is escaped too.
pub fn exclude_pattern(path: &str) -> String {
  let mut out = String::with_capacity(path.len() + 2);
  out.push('/');
  for (i, ch) in path.chars().enumerate() {
    match ch {
      '*' | '?' | '[' | ']' | '\\' => {
        out.push('\\');
        out.push(ch);
      }
      '#' | '!' if i == 0 => {
        out.push('\\');
        out.push(ch);
      }
      _ => out.push(ch),
    }
  }
  out
}

/// Drop credentials from a remote URL before it reaches the UI.
///
/// `https://user:pass@host/x` → `https://host/x`, and the scp-like
/// `user@host:path` → `host:path`. The panel only displays these; git itself is
/// still configured with the real URL on the host.
pub fn redacted_url(url: &str) -> String {
  let trimmed = url.trim();
  if let Some(scheme_end) = trimmed.find("://") {
    let rest = &trimmed[scheme_end + 3..];
    let authority_end = rest.find('/').unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    let host = match authority.rfind('@') {
      Some(at) => &authority[at + 1..],
      None => authority,
    };
    let tail = &rest[authority_end..];
    return format!("{}://{}{}", &trimmed[..scheme_end], host, tail);
  }
  // scp-like: `user@host:path` — the authority is everything before the first
  // colon, and a URL scheme would have been caught above.
  if let Some(colon) = trimmed.find(':') {
    let before = &trimmed[..colon];
    if !before.contains('/') {
      if let Some(at) = before.rfind('@') {
        return trimmed[at + 1..].to_string();
      }
    }
  }
  trimmed.to_string()
}

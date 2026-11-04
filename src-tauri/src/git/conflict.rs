//! argv builders for merge-conflict inspection and resolution.
//!
//! The panel already lists conflicted paths from `status --porcelain=v2`; what
//! it lacks is the in-progress-operation banner (`merge`/`rebase`/…) and the
//! ours / theirs choice. Detection runs one `rev-parse --verify -q <HEAD-file>`
//! per known operation — a missing ref exits non-zero quietly, which is the
//! "not in progress" answer, not a failure.

/// Unmerged paths, NUL-separated.
pub fn list_args() -> Vec<String> {
  [
    "diff",
    "--name-only",
    "--diff-filter=U",
    "-z",
    "--no-color",
  ]
  .iter()
  .map(|s| s.to_string())
  .collect()
}

/// `rev-parse -q --verify <ref>` for the marker file of one operation. Empty
/// output + exit 0 means the operation is in progress.
pub fn in_progress_probe_args(operation: &str) -> Option<Vec<String>> {
  let marker = match operation {
    "merge" => "MERGE_HEAD",
    "rebase" => "REBASE_HEAD",
    "cherry-pick" => "CHERRY_PICK_HEAD",
    "revert" => "REVERT_HEAD",
    _ => return None,
  };
  Some(vec![
    "rev-parse".to_string(),
    "-q".to_string(),
    "--verify".to_string(),
    marker.to_string(),
  ])
}

/// The operations probed, in order. Only one can be live at a time in practice.
pub const IN_PROGRESS_OPERATIONS: [&str; 4] = ["merge", "rebase", "cherry-pick", "revert"];

/// `resolution` is an allow-list: `ours` / `theirs` take the staged version of
/// that side, `resolved` just re-adds the file after a manual edit.
pub fn resolve_args(path: &str, resolution: &str) -> Option<Vec<String>> {
  let verb = match resolution {
    "ours" => vec!["checkout", "--ours"],
    "theirs" => vec!["checkout", "--theirs"],
    "resolved" => vec!["add"],
    _ => return None,
  };
  let mut argv: Vec<String> = verb.iter().map(|s| s.to_string()).collect();
  argv.push("--".to_string());
  argv.push(path.to_string());
  Some(argv)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn the_conflict_list_is_nul_separated() {
    assert_eq!(
      list_args(),
      vec![
        "diff",
        "--name-only",
        "--diff-filter=U",
        "-z",
        "--no-color"
      ]
    );
  }

  #[test]
  fn the_in_progress_probe_uses_the_operation_marker_ref() {
    assert_eq!(
      in_progress_probe_args("merge").unwrap(),
      vec!["rev-parse", "-q", "--verify", "MERGE_HEAD"]
    );
    assert_eq!(
      in_progress_probe_args("revert").unwrap()[3],
      "REVERT_HEAD"
    );
    assert!(in_progress_probe_args("bogus").is_none());
  }

  #[test]
  fn resolve_args_is_an_allow_list_and_always_terminates_the_path() {
    assert_eq!(
      resolve_args("a.txt", "ours").unwrap(),
      vec!["checkout", "--ours", "--", "a.txt"]
    );
    assert_eq!(
      resolve_args("a.txt", "theirs").unwrap(),
      vec!["checkout", "--theirs", "--", "a.txt"]
    );
    assert_eq!(
      resolve_args("a.txt", "resolved").unwrap(),
      vec!["add", "--", "a.txt"]
    );
    assert!(resolve_args("a.txt", "mine").is_none());
  }
}

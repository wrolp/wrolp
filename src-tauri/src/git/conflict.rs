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

/// `git show :<stage>:<path>` — one side of an unmerged path.
///
/// The object spec starts with `:`, so it can never be read as an option, and
/// the path has already passed `checked_rel_path`. A stage that does not exist
/// (add/add conflict has no base) simply exits non-zero; the caller maps that to
/// `None` rather than an error.
pub fn stage_args(stage: u8, path: &str) -> Option<Vec<String>> {
  if !(1..=3).contains(&stage) {
    return None;
  }
  Some(vec![
    "show".to_string(),
    "--no-color".to_string(),
    format!(":{stage}:{path}"),
  ])
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
  fn stage_reads_use_a_colon_object_spec_that_cannot_be_an_option() {
    assert_eq!(
      stage_args(2, "src/main.ts").unwrap(),
      vec!["show", "--no-color", ":2:src/main.ts"]
    );
    assert_eq!(stage_args(1, "a.txt").unwrap()[2], ":1:a.txt");
    assert!(stage_args(0, "a.txt").is_none());
    assert!(stage_args(4, "a.txt").is_none());
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

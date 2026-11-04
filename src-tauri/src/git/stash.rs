//! argv builders for `git stash`.
//!
//! Stash entries are addressed by index, never by a frontend-supplied ref: the
//! panel sends `stash@{n}`'s `n`, and the backend rebuilds the ref. That keeps a
//! crafted string from becoming an option or a pathspec.

/// `stash list` with NUL-separated fields and an RS between records.
///
/// `%gd` is `stash@{0}` (the selector a user copies), `%gs` the reflog subject,
/// `%H` the full oid and `%ct` the unix timestamp.
pub fn list_args() -> Vec<String> {
  vec![
    "stash".to_string(),
    "list".to_string(),
    "--no-color".to_string(),
    "--format=%gd%x00%H%x00%ct%x00%gs%x1e".to_string(),
  ]
}

/// `git stash push -m <message>` — untracked files only when explicitly asked,
/// because including them deletes them from the worktree.
pub fn push_args(message: Option<&str>, include_untracked: bool) -> Vec<String> {
  let mut argv = vec!["stash".to_string(), "push".to_string()];
  if include_untracked {
    argv.push("--include-untracked".to_string());
  }
  if let Some(m) = message.map(str::trim).filter(|m| !m.is_empty()) {
    argv.push("-m".to_string());
    argv.push(m.to_string());
  }
  argv
}

/// `git stash pop|apply|drop stash@{n}`. A negative or out-of-range index is
/// rejected by the caller; here only the shape is enforced.
pub fn entry_args(verb: &str, index: u32) -> Option<Vec<String>> {
  let verb = match verb {
    "pop" => "pop",
    "apply" => "apply",
    "drop" => "drop",
    _ => return None,
  };
  Some(vec![
    "stash".to_string(),
    verb.to_string(),
    format!("stash@{{{index}}}"),
  ])
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn the_list_format_separates_fields_and_records() {
    let args = list_args();
    assert_eq!(args[0], "stash");
    assert_eq!(args[1], "list");
    assert!(args[3].contains("%x00"));
    assert!(args[3].ends_with("%x1e"));
  }

  #[test]
  fn push_only_includes_untracked_when_asked() {
    assert_eq!(push_args(None, false), vec!["stash", "push"]);
    assert_eq!(
      push_args(Some("wip"), true),
      vec!["stash", "push", "--include-untracked", "-m", "wip"]
    );
    // A blank message is not sent as an empty -m argument.
    assert_eq!(push_args(Some("   "), false), vec!["stash", "push"]);
  }

  #[test]
  fn entries_are_addressed_by_a_rebuilt_index() {
    assert_eq!(
      entry_args("pop", 2).unwrap(),
      vec!["stash", "pop", "stash@{2}"]
    );
    assert_eq!(
      entry_args("drop", 0).unwrap(),
      vec!["stash", "drop", "stash@{0}"]
    );
    assert!(entry_args("clear", 0).is_none());
  }
}

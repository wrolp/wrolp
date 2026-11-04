//! Parser and argv unit tests. Fixtures are fixed text so no repository is
//! needed; the one end-to-end test drives a real temp repository and is
//! `#[ignore]`d like every other environment-dependent test in this repo.

use super::*;

fn status_fixture() -> Vec<u8> {
  let lines = [
    "# branch.oid 1111111111111111111111111111111111111111",
    "# branch.head main",
    "# branch.upstream origin/main",
    "# branch.ab +1 -2",
    "1 .M N... 100644 100644 100644 2222222 3333333 README.md",
    "1 M. N... 100644 100644 100644 4444444 5555555 docs/guide.md",
    "2 R. N... 100644 100644 100644 6666666 6666666 R100 new name.txt",
    "old name.txt",
    "u UU N... 100644 100644 100644 100644 7777777 8888888 9999999 conflict.txt",
    "? untracked file.txt",
  ];
  lines.join("\0").into_bytes()
}

#[test]
fn status_parses_every_record_type_and_the_branch_headers() {
  let st = parse::parse_status(&status_fixture(), MAX_STATUS_ENTRIES);
  assert_eq!(st.branch.as_deref(), Some("main"));
  assert_eq!(st.upstream.as_deref(), Some("origin/main"));
  assert_eq!(st.ahead, 1);
  assert_eq!(st.behind, 2);
  assert!(!st.detached);
  assert!(!st.unborn);
  assert_eq!(st.entries.len(), 5);

  let modified = &st.entries[0];
  assert_eq!(modified.path, "README.md");
  assert_eq!(modified.x, ".");
  assert_eq!(modified.y, "M");
  assert!(!modified.staged);
  assert!(modified.unstaged);

  let staged = &st.entries[1];
  assert_eq!(staged.path, "docs/guide.md");
  assert!(staged.staged);
  assert!(!staged.unstaged);

  let renamed = &st.entries[2];
  assert_eq!(renamed.path, "new name.txt");
  assert_eq!(renamed.orig_path.as_deref(), Some("old name.txt"));
  assert_eq!(renamed.kind, "renamed");

  let conflict = &st.entries[3];
  assert!(conflict.conflicted);
  assert_eq!(conflict.kind, "conflicted");

  let untracked = &st.entries[4];
  assert_eq!(untracked.path, "untracked file.txt");
  assert_eq!(untracked.kind, "untracked");
}

#[test]
fn status_models_detached_and_unborn_heads() {
  let detached = "# branch.oid abcd\0# branch.head (detached)\0".as_bytes().to_vec();
  let st = parse::parse_status(&detached, MAX_STATUS_ENTRIES);
  assert!(st.detached);
  assert_eq!(st.branch, None);
  assert_eq!(st.head_oid.as_deref(), Some("abcd"));

  let unborn = "# branch.oid (initial)\0# branch.head main\0".as_bytes().to_vec();
  let st = parse::parse_status(&unborn, MAX_STATUS_ENTRIES);
  assert!(st.unborn);
  assert_eq!(st.branch.as_deref(), Some("main"));
  assert_eq!(st.head_oid, None);
}

#[test]
fn status_truncates_at_the_limit_and_says_so() {
  let raw = "? a\0? b\0? c\0".as_bytes().to_vec();
  let st = parse::parse_status(&raw, 2);
  assert_eq!(st.entries.len(), 2);
  assert!(st.truncated);
  let st = parse::parse_status(&raw, 10);
  assert_eq!(st.entries.len(), 3);
  assert!(!st.truncated);
}

#[test]
fn log_splits_records_on_rs_and_fields_on_nul() {
  let raw = "a1b2c3d4\0abc123\0Alice\0a@example.com\01700000000\0p1 p2\0HEAD -> main, origin/main\0fix: parser\0\x1e\n\
             99999999\0999999\0Bob\0b@example.com\01500000000\0\0\0chore: init\0\x1e"
    .as_bytes()
    .to_vec();
  let page = parse::parse_log(&raw, 10);
  assert_eq!(page.commits.len(), 2);
  assert!(!page.has_more);
  let first = &page.commits[0];
  assert_eq!(first.oid, "a1b2c3d4");
  assert_eq!(first.subject, "fix: parser");
  assert_eq!(first.parents.len(), 2);
  assert_eq!(first.refs, vec!["HEAD -> main", "origin/main"]);
  assert_eq!(first.timestamp, 1_700_000_000);

  // Asking for one row keeps the first and reports more.
  let page = parse::parse_log(&raw, 1);
  assert_eq!(page.commits.len(), 1);
  assert!(page.has_more);
}

#[test]
fn branches_keep_upstream_head_flag_and_remote_kind() {
  let raw = "refs/heads/main\0aaa\0aaa\0origin/main\0*\01700000000\0subject line\0\n\
             refs/remotes/origin/dev\0bbb\0bbb\0\0 \01100000000\0remote subject\0\n\
             refs/remotes/origin/HEAD\0ccc\0ccc\0\0 \01000000000\0pointer\0\n"
    .as_bytes()
    .to_vec();
  let branches = parse::parse_branches(&raw);
  assert_eq!(branches.len(), 2, "origin/HEAD is a pointer, not a branch");
  assert_eq!(branches[0].name, "main");
  assert!(branches[0].current);
  assert!(!branches[0].remote);
  assert_eq!(branches[0].upstream.as_deref(), Some("origin/main"));
  assert_eq!(branches[1].name, "origin/dev");
  assert!(branches[1].remote);
  assert!(!branches[1].current);
}

#[test]
fn remotes_pair_fetch_and_push_urls_and_strip_credentials() {
  let raw = "origin\thttps://user:token@github.com/wrolp/win.git (fetch)\n\
             origin\thttps://user:token@github.com/wrolp/win.git (push)\n\
             backup\tuser@example.com:repos/win.git (fetch)\n"
    .as_bytes()
    .to_vec();
  let remotes = parse::parse_remotes(&raw);
  assert_eq!(remotes.len(), 2);
  assert_eq!(remotes[0].name, "origin");
  assert_eq!(remotes[0].fetch_url, "https://github.com/wrolp/win.git");
  assert_eq!(remotes[0].push_url, "https://github.com/wrolp/win.git");
  assert_eq!(remotes[1].fetch_url, "example.com:repos/win.git");
  // Fetch-only remotes still show an address on the push side.
  assert_eq!(remotes[1].push_url, "example.com:repos/win.git");
}

#[test]
fn commit_files_parse_the_alternating_status_and_path_tokens() {
  let raw = "M\0README.md\0A\0new.txt\0R100\0old.txt\0renamed.txt\0"
    .as_bytes()
    .to_vec();
  let files = parse::parse_commit_files(&raw);
  assert_eq!(files.len(), 3);
  assert_eq!(files[0].status, "M");
  assert_eq!(files[0].path, "README.md");
  assert_eq!(files[2].status, "R100");
  assert_eq!(files[2].path, "old.txt");
}

#[test]
fn diff_flags_binary_and_truncates_oversized_text() {
  let binary = "Binary files a/logo.png and b/logo.png differ\0"
    .as_bytes()
    .to_vec();
  let diff = parse::parse_diff(&binary);
  assert!(diff.binary);
  assert!(diff.text.is_empty());

  let big = "x".repeat(MAX_DIFF_BYTES + 10).into_bytes();
  let diff = parse::parse_diff(&big);
  assert!(!diff.binary);
  assert!(diff.truncated);
  assert_eq!(diff.text.len(), MAX_DIFF_BYTES);
}

#[test]
fn paths_outside_the_worktree_are_refused() {
  assert!(checked_rel_path("src/main.rs").is_ok());
  assert!(checked_rel_path("a file with spaces.txt").is_ok());
  for bad in [
    "",
    "/etc/passwd",
    "\\windows\\system32",
    "C:/Windows",
    "src/../../secret",
    "..",
    "./a",
  ] {
    assert!(checked_rel_path(bad).is_err(), "{bad:?} should be refused");
  }
  assert!(checked_rel_paths(&[]).is_err());
}

#[test]
fn argv_builders_place_double_dash_before_paths() {
  let paths = vec!["a.txt".to_string(), "-b.txt".to_string()];
  assert_eq!(
    status::stage_args(&paths),
    vec!["add", "--", "a.txt", "-b.txt"]
  );
  assert_eq!(
    status::unstage_args(&paths),
    vec!["restore", "--staged", "--", "a.txt", "-b.txt"]
  );
  assert_eq!(
    status::restore_worktree_args(&paths),
    vec!["restore", "--worktree", "--", "a.txt", "-b.txt"]
  );
  assert_eq!(
    status::clean_args(&paths),
    vec!["clean", "-f", "--", "a.txt", "-b.txt"]
  );
  assert_eq!(status::commit_args(false), vec!["commit", "-F", "-"]);
  assert_eq!(
    status::commit_args(true),
    vec!["commit", "-F", "-", "--amend"]
  );
  assert_eq!(status::init_args("/tmp/repo"), vec!["init", "/tmp/repo"]);
}

#[test]
fn abort_only_accepts_the_known_operations() {
  assert_eq!(
    status::abort_args("merge"),
    Some(vec!["merge".to_string(), "--abort".to_string()])
  );
  assert_eq!(status::abort_args("pull"), None);
}

#[test]
fn stash_rows_carry_the_index_git_printed() {
  // Two records; the second lacks a `stash@{` selector and is skipped.
  let raw = b"stash@{0}\x00aaaa\x001760000000\x00WIP on main: tweak\x1e\nstash@{1}\x00bbbb\x001759000000\x00on main: older\x1ejunk\x1e";
  let entries = parse::parse_stash_list(raw);
  assert_eq!(entries.len(), 2);
  assert_eq!(entries[0].index, 0);
  assert_eq!(entries[1].index, 1);
  assert_eq!(entries[0].oid, "aaaa");
  assert_eq!(entries[1].timestamp, 1759000000);
  assert_eq!(entries[1].message, "on main: older");
}

#[test]
fn remote_urls_are_argv_safe() {
  assert_eq!(remote::checked_url("https://github.com/x/y.git").unwrap(), "https://github.com/x/y.git");
  assert_eq!(remote::checked_url("git@host:repo.git").unwrap(), "git@host:repo.git");
  assert!(remote::checked_url("").is_err());
  assert!(remote::checked_url("  ").is_err());
  assert!(remote::checked_url("--upload-pack=x").is_err());
  assert!(remote::checked_url("a b").is_err());
  assert!(remote::checked_url("a\nb").is_err());
}

#[test]
fn remote_add_and_remove_keep_the_name_then_the_url() {
  assert_eq!(
    remote::add_args("origin", "https://example.com/r.git"),
    vec!["remote", "add", "origin", "https://example.com/r.git"]
  );
  assert_eq!(remote::remove_args("origin"), vec!["remote", "remove", "origin"]);
}

#[test]
fn network_argv_covers_remote_and_branch_variants() {
  assert_eq!(
    remote::fetch_args(Some("origin")),
    vec!["fetch", "origin", "--prune", "--progress"]
  );
  assert_eq!(
    remote::fetch_args(None),
    vec!["fetch", "--all", "--prune", "--progress"]
  );
  assert_eq!(
    remote::pull_args(Some("origin"), Some("main")),
    vec!["pull", "--ff-only", "origin", "main"]
  );
  assert_eq!(
    remote::push_args(Some("origin"), Some("main")),
    vec!["push", "--set-upstream", "origin", "main"]
  );
  assert_eq!(remote::push_args(None, None), vec!["push"]);
}

#[test]
fn branch_names_and_oids_reject_option_like_input() {
  assert!(status::checked_branch_name("feature/x").is_ok());
  assert!(status::checked_branch_name("-f").is_err());
  assert!(status::checked_branch_name("a b").is_err());
  assert!(history::checked_oid("abc123").is_ok());
  assert!(history::checked_oid("-abc").is_err());
  assert!(history::checked_oid("xyz").is_err());
}

#[test]
fn errors_are_staged_by_what_stderr_says() {
  let stderr = b"fatal: not a git repository (or any of the parent directories): .git";
  assert!(classify_error("status", stderr).starts_with("git_not_repo:"));
  let stderr = b"fatal: Not possible to fast-forward, aborting.";
  assert!(classify_error("pull", stderr).starts_with("git_not_fast_forward:"));
  let stderr = b"*** Please tell me who you are.";
  assert!(classify_error("commit", stderr).starts_with("git_no_identity:"));
  let stderr = b"fatal: Authentication failed for 'https://example.com/x.git/'";
  assert!(classify_error("fetch", stderr).starts_with("git_auth_required:"));
  // Unknown text keeps the caller's stage, so it is never silently swallowed.
  assert_eq!(classify_error("commit", b"something else"), "git_commit:something else");
}

/// Against a real git: `cargo test --lib git::tests -- --ignored`.
///
/// Creates a throwaway repository under the system temp dir, commits, modifies,
/// and checks that the same parsers the panel uses understand real output.
#[test]
#[ignore]
fn parses_a_real_local_repository() {
  use std::process::Command;
  let dir = match tempfile::tempdir() {
    Ok(d) => d,
    Err(e) => {
      eprintln!("SKIP: {e}");
      return;
    }
  };
  let git = |args: &[&str]| {
    let out = Command::new("git")
      .arg("-C")
      .arg(dir.path())
      .args(args)
      .env("GIT_TERMINAL_PROMPT", "0")
      .output();
    match out {
      Ok(o) if o.status.success() => Some(o.stdout),
      Ok(o) => panic!(
        "git {:?} failed: {}",
        args,
        String::from_utf8_lossy(&o.stderr)
      ),
      Err(e) => {
        eprintln!("SKIP: {e}");
        None
      }
    }
  };
  let Some(_) = git(&["init", "-q"]) else { return };
  std::fs::write(dir.path().join("a b.txt"), "one").unwrap();
  let Some(_) = git(&["add", "--", "a b.txt"]) else {
    return;
  };
  let Some(_) = git(&[
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.com",
    "commit",
    "-qm",
    "first",
  ]) else {
    return;
  };
  std::fs::write(dir.path().join("a b.txt"), "two").unwrap();

  if let Some(out) = git(&[
    "status",
    "--porcelain=v2",
    "-z",
    "--branch",
    "--untracked-files=all",
  ]) {
    let st = parse::parse_status(&out, MAX_STATUS_ENTRIES);
    assert_eq!(st.entries.len(), 1, "one modified file");
    assert_eq!(st.entries[0].path, "a b.txt");
    assert_eq!(st.entries[0].y, "M");
  }
  if let Some(out) = git(&[
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--unified=3",
    "--",
    "a b.txt",
  ]) {
    let diff = parse::parse_diff(&out);
    assert!(!diff.binary);
    assert!(diff.text.contains("-one"));
    assert!(diff.text.contains("+two"));
  }
  if let Some(out) = git(&[
    "log",
    "--no-color",
    "--format=%H%x00%h%x00%an%x00%ae%x00%at%x00%P%x00%D%x00%s%x1e",
    "-n2",
  ]) {
    let page = parse::parse_log(&out, 50);
    assert_eq!(page.commits.len(), 1);
    assert_eq!(page.commits[0].subject, "first");
  }
}

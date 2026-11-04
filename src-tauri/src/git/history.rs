//! argv builders for history reads.

/// The largest page the panel offers.
pub const MAX_LOG_LIMIT: usize = 200;

/// `git log` with NUL-separated fields and RS-separated records.
pub fn log_args(limit: usize, skip: usize) -> Vec<String> {
  let n = limit.clamp(1, MAX_LOG_LIMIT) + 1; // one extra row decides `has_more`
  vec![
    "log".to_string(),
    "--no-color".to_string(),
    "--no-show-signature".to_string(),
    format!(
      "--format=%H%x00%h%x00%an%x00%ae%x00%at%x00%P%x00%D%x00%s%x1e"
    ),
    format!("-n{n}"),
    format!("--skip={skip}"),
  ]
}

/// `git show <oid> --name-status -z`, for the commit's file list.
pub fn commit_files_args(oid: &str) -> Vec<String> {
  vec![
    "show".to_string(),
    "--format=".to_string(),
    "--name-status".to_string(),
    "-z".to_string(),
    "--no-color".to_string(),
    oid.to_string(),
  ]
}

/// An oid must be pure hex and long enough to be unambiguous. This also stops a
/// frontend string that starts with `-` from being read as an option.
pub fn checked_oid(oid: &str) -> Result<String, String> {
  let o = oid.trim();
  if o.len() < 4 || !o.chars().all(|c| c.is_ascii_hexdigit()) {
    return Err(super::git_error("log", format!("invalid object id: {oid}")));
  }
  Ok(o.to_string())
}

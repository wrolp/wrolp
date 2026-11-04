//! Pure parsers for the git CLI output shapes the panel uses.
//!
//! Every structured command is NUL-separated (`-z`, `%x00`), never newline-split:
//! a path may contain spaces, quotes or a newline, and the only reliable delimiter
//! is `\0`. These functions take bytes so a conversion failure can never lose a
//! row silently.

use super::{GitBranch, GitCommit, GitCommitFile, GitDiff, GitLogPage, GitRemote, GitStatus, GitStatusEntry, MAX_DIFF_BYTES, MAX_STATUS_ENTRIES};

fn field(bytes: &[u8]) -> String {
  String::from_utf8_lossy(bytes)
    .trim_end_matches(['\r', '\n'])
    .to_string()
}

fn entry(path: String, x: &str, y: &str, kind: &str) -> GitStatusEntry {
  GitStatusEntry {
    path,
    orig_path: None,
    x: x.to_string(),
    y: y.to_string(),
    kind: kind.to_string(),
    staged: x != "." && x != "?",
    unstaged: y != "." && y != "?",
    conflicted: false,
  }
}

/// `git status --porcelain=v2 -z --branch --untracked-files=all`.
///
/// Records: `#` headers, `1` ordinary, `2` rename/copy (whose *original* path is
/// the next NUL token), `u` unmerged, `?` untracked, `!` ignored.
pub fn parse_status(raw: &[u8], limit: usize) -> GitStatus {
  let mut st = GitStatus::default();
  let tokens: Vec<&[u8]> = raw.split(|b| *b == 0).filter(|t| !t.is_empty()).collect();
  let mut i = 0;
  while i < tokens.len() {
    let line = field(tokens[i]);
    i += 1;
    if let Some(rest) = line.strip_prefix("# ") {
      if let Some(v) = rest.strip_prefix("branch.oid ") {
        if v == "(initial)" {
          st.unborn = true;
        } else {
          st.head_oid = Some(v.to_string());
        }
      } else if let Some(v) = rest.strip_prefix("branch.head ") {
        if v == "(detached)" {
          st.detached = true;
        } else {
          st.branch = Some(v.to_string());
        }
      } else if let Some(v) = rest.strip_prefix("branch.upstream ") {
        if v != "(gone)" {
          st.upstream = Some(v.to_string());
        }
      } else if let Some(v) = rest.strip_prefix("branch.ab ") {
        let mut parts = v.split_whitespace();
        if let Some(a) = parts.next().and_then(|p| p.strip_prefix('+')) {
          st.ahead = a.parse().unwrap_or(0);
        }
        if let Some(b) = parts.next().and_then(|p| p.strip_prefix('-')) {
          st.behind = b.parse().unwrap_or(0);
        }
      }
      continue;
    }
    if let Some(rest) = line.strip_prefix("1 ") {
      let mut parts = rest.splitn(8, ' ');
      let Some(xy) = parts.next() else { continue };
      // sub, mH, mI, mW, hH, hI are unused by the panel.
      for _ in 0..6 {
        parts.next();
      }
      let Some(path) = parts.next() else { continue };
      let (x, y) = letters(xy);
      st.entries.push(entry(path.to_string(), &x, &y, "modified"));
      continue;
    }
    if let Some(rest) = line.strip_prefix("2 ") {
      let mut parts = rest.splitn(9, ' ');
      let Some(xy) = parts.next() else { continue };
      for _ in 0..7 {
        parts.next();
      }
      let Some(path) = parts.next() else { continue };
      let (x, y) = letters(xy);
      let mut e = entry(path.to_string(), &x, &y, "renamed");
      if let Some(orig) = tokens.get(i) {
        e.orig_path = Some(field(orig));
        i += 1;
      }
      st.entries.push(e);
      continue;
    }
    if let Some(rest) = line.strip_prefix("u ") {
      let mut parts = rest.splitn(10, ' ');
      let Some(xy) = parts.next() else { continue };
      for _ in 0..8 {
        parts.next();
      }
      let Some(path) = parts.next() else { continue };
      let (x, y) = letters(xy);
      let mut e = entry(path.to_string(), &x, &y, "conflicted");
      e.staged = false;
      e.unstaged = false;
      e.conflicted = true;
      st.entries.push(e);
      continue;
    }
    if let Some(path) = line.strip_prefix("? ") {
      st.entries.push(entry(path.to_string(), "?", "?", "untracked"));
      continue;
    }
    if let Some(path) = line.strip_prefix("! ") {
      st.entries.push(entry(path.to_string(), "!", "!", "ignored"));
    }
  }
  let limit = limit.min(MAX_STATUS_ENTRIES);
  let more = count_status_records(raw) > limit;
  st.entries.truncate(limit);
  st.truncated = more;
  st
}

/// How many real entries the raw status held (headers and rename tails excluded).
fn count_status_records(raw: &[u8]) -> usize {
  raw
    .split(|b| *b == 0)
    .filter(|t| {
      t.starts_with(b"1 ")
        || t.starts_with(b"2 ")
        || t.starts_with(b"u ")
        || t.starts_with(b"? ")
        || t.starts_with(b"! ")
    })
    .count()
}

fn letters(xy: &str) -> (String, String) {
  let mut chars = xy.chars();
  let x = chars.next().unwrap_or('.').to_string();
  let y = chars.next().unwrap_or('.').to_string();
  (x, y)
}

/// `git log --format=%H%x00%h%x00%an%x00%ae%x00%at%x00%P%x00%D%x00%s%x1e`.
/// The caller asks for `limit + 1` rows, so `has_more` needs no extra command.
pub fn parse_log(raw: &[u8], limit: usize) -> GitLogPage {
  let mut commits = Vec::new();
  for record in raw.split(|b| *b == 0x1e) {
    let record = record
      .iter()
      .copied()
      .skip_while(|b| *b == b'\n' || *b == b'\r')
      .collect::<Vec<u8>>();
    if record.is_empty() {
      continue;
    }
    let fields: Vec<String> = record.split(|b| *b == 0).map(field).collect();
    if fields.len() < 8 || fields[0].is_empty() {
      continue;
    }
    commits.push(GitCommit {
      oid: fields[0].clone(),
      short_oid: fields[1].clone(),
      author_name: fields[2].clone(),
      author_email: fields[3].clone(),
      timestamp: fields[4].parse().unwrap_or(0),
      parents: fields[5]
        .split_whitespace()
        .map(str::to_string)
        .collect(),
      refs: fields[6]
        .split(',')
        .map(|r| r.trim().to_string())
        .filter(|r| !r.is_empty())
        .collect(),
      subject: fields[7].clone(),
    });
  }
  let has_more = commits.len() > limit;
  commits.truncate(limit);
  GitLogPage { commits, has_more }
}

/// `git for-each-ref` with seven NUL-separated fields per line.
pub fn parse_branches(raw: &[u8]) -> Vec<GitBranch> {
  let mut out = Vec::new();
  for line in raw.split(|b| *b == b'\n') {
    if line.is_empty() {
      continue;
    }
    let fields: Vec<String> = line.split(|b| *b == 0).map(field).collect();
    if fields.len() < 7 {
      continue;
    }
    let full_name = fields[0].clone();
    let remote = full_name.starts_with("refs/remotes/");
    let name = full_name
      .strip_prefix("refs/heads/")
      .or_else(|| full_name.strip_prefix("refs/remotes/"))
      .unwrap_or(&full_name)
      .to_string();
    // `origin/HEAD` is a symbolic pointer, not a branch the user can switch to.
    if name.ends_with("/HEAD") {
      continue;
    }
    out.push(GitBranch {
      name,
      full_name,
      oid: fields[1].clone(),
      short_oid: fields[2].clone(),
      upstream: (!fields[3].is_empty()).then(|| fields[3].clone()),
      current: fields[4] == "*",
      remote,
      date: fields[5].parse().unwrap_or(0),
      subject: fields[6].clone(),
    });
  }
  out
}

/// `git remote -v`: two lines per remote (`(fetch)` and `(push)`).
pub fn parse_remotes(raw: &[u8]) -> Vec<GitRemote> {
  let mut out: Vec<GitRemote> = Vec::new();
  for line in String::from_utf8_lossy(raw).lines() {
    let line = line.trim();
    if line.is_empty() {
      continue;
    }
    let mut parts = line.splitn(2, '\t');
    let Some(name) = parts.next() else { continue };
    let Some(rest) = parts.next() else { continue };
    let rest = rest.trim();
    let (url, kind) = match rest.rsplit_once(" (") {
      Some((u, k)) => (u.trim(), k.trim_end_matches(')')),
      None => (rest, "fetch"),
    };
    let url = super::redacted_url(url);
    match out.iter_mut().find(|r| r.name == name) {
      Some(existing) => {
        if kind == "push" {
          existing.push_url = url;
        } else if existing.fetch_url.is_empty() {
          existing.fetch_url = url;
        }
      }
      None => out.push(GitRemote {
        name: name.to_string(),
        fetch_url: if kind == "push" { String::new() } else { url.clone() },
        push_url: if kind == "push" { url } else { String::new() },
      }),
    }
  }
  // A fetch-only remote still shows an address on the push side.
  for r in &mut out {
    if r.push_url.is_empty() {
      r.push_url = r.fetch_url.clone();
    }
  }
  out
}

/// `git show --name-status -z`: alternating status / path tokens.
pub fn parse_commit_files(raw: &[u8]) -> Vec<GitCommitFile> {
  let tokens: Vec<&[u8]> = raw.split(|b| *b == 0).filter(|t| !t.is_empty()).collect();
  let mut out = Vec::new();
  let mut i = 0;
  while i < tokens.len() {
    let first = field(tokens[i]);
    // Older git versions keep the status and path in one token, tab-separated.
    if let Some((status, path)) = first.split_once('\t') {
      out.push(GitCommitFile {
        status: status.trim().to_string(),
        path: path.trim().to_string(),
      });
      i += 1;
      continue;
    }
    let Some(path) = tokens.get(i + 1) else { break };
    out.push(GitCommitFile {
      status: first,
      path: field(path),
    });
    i += 2;
  }
  out
}

/// Decode one diff. Binary output is flagged rather than rendered, and one
/// oversized side is cut with `truncated` so the IPC payload stays bounded.
pub fn parse_diff(raw: &[u8]) -> GitDiff {
  let binary = raw.contains(&0)
    || raw
      .windows(13)
      .any(|w| w == b"Binary files ")
    || raw
      .windows(13)
      .any(|w| w == b"GIT binary pa");
  if binary {
    return GitDiff {
      text: String::new(),
      truncated: false,
      binary: true,
    };
  }
  let truncated = raw.len() > MAX_DIFF_BYTES;
  let slice = &raw[..raw.len().min(MAX_DIFF_BYTES)];
  GitDiff {
    text: String::from_utf8_lossy(slice).to_string(),
    truncated,
    binary: false,
  }
}

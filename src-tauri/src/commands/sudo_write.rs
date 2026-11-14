use super::*;
use russh::ChannelMsg;
use russh_sftp::protocol::{FileAttributes, OpenFlags};
use std::time::Duration;

/// Printed by the exec line right after `sudo`, so the exit status survives on
/// servers that never send an SSH exit-status message (a refused `exec` just
/// closes the channel, which used to look like "exit 1" with no reason).
const STATUS_MARK: &str = "__WROLP_SUDO_EXIT__";

/// `cp` of a config file is instantaneous. Waiting longer means sudo is stuck on
/// something we cannot answer, so report whatever arrived instead of hanging.
const SUDO_TIMEOUT: Duration = Duration::from_secs(30);

/// Save a file the logged-in user cannot write by writing it as root.
///
/// SFTP writes as the connection's user, so a root-owned file fails with
/// "permission denied" no matter how many times the user retries. The bytes are
/// staged in a private `0600` file under `/tmp` (writable by that user) over the
/// normal SFTP channel, then a separate exec channel runs a short `sh` script
/// under `sudo` that copies it to a hidden sibling of the target and renames it
/// into place — an interrupted save can no longer truncate the target.
/// The sudo password travels only over that channel's stdin — never in the
/// command line, where the remote process list would expose it.
#[tauri::command]
pub async fn sudo_write_file(
  app: tauri::AppHandle,
  state: tauri::State<'_, AppState>,
  tab_id: u32,
  path: String,
  content: String,
  password: String,
  encoding: Option<String>,
) -> Result<bool, String> {
  let encoding_ref: &Encoding =
    Encoding::for_label(encoding.as_deref().unwrap_or("utf-8").as_bytes()).unwrap_or(UTF_8);
  let (bytes, _, had_errors) = encoding_ref.encode(&content);
  if had_errors {
    return Err(format!(
      "Content cannot be encoded as {}",
      encoding_ref.name()
    ));
  }
  let bytes = bytes.into_owned();

  // Stage over the same SFTP path used by a normal save, so relative paths and
  // the selected charset behave identically.
  let sftp = super::sftp::open_sftp_session(&state, &app, tab_id).await?;
  let resolved = super::sftp::resolve_sftp_path(&sftp, &path).await?;
  let tmp = format!("/tmp/.wrolp-sudo-{}-{}", std::process::id(), Uuid::new_v4());
  {
    // 0600 on purpose: `create()` applies the server umask, which on most hosts
    // leaves a 0644 file — a copy of a root-only config readable by every local
    // user for as long as the staging file exists.
    let mut staged = sftp
      .open_with_flags_and_attributes(
        &tmp,
        OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
        FileAttributes {
          permissions: Some(0o600),
          ..Default::default()
        },
      )
      .await
      .map_err(|e| format!("Failed to stage file in /tmp: {e}"))?;
    staged
      .write_all(&bytes)
      .await
      .map_err(|e| format!("Failed to stage file in /tmp: {e}"))?;
  }

  // Clean up the staging file on every exit path. Best effort: a missed temp
  // file is harmless, but a leaked password or a failed save is not.
  let tag = sibling_tag();
  let result = sudo_copy(&state, tab_id, &tmp, &resolved, &tag, &password).await;
  let _ = sftp.remove_file(&tmp).await;
  result
}

/// Short random suffix for the hidden sibling the script writes next to the
/// target. It only has to be unlikely to collide with a leftover from a killed
/// process; the path itself is derived remotely (see [`sudo_script`]).
fn sibling_tag() -> String {
  Uuid::new_v4().simple().to_string()[..8].to_string()
}

/// The `sh` script sudo runs.
///
/// Two properties matter. First, the target is resolved with `readlink -f` so a
/// symlinked config (`/etc/resolv.conf`, `/etc/localtime`) is written *through*
/// the link instead of being replaced by a regular file. Second, the bytes land
/// in a hidden sibling of that resolved path and are renamed over it, so the
/// rename stays on one filesystem and a connection that dies mid-copy leaves the
/// target untouched — the previous in-place `cp` could truncate it, which for
/// something like `sshd_config` locks you out.
///
/// The sibling inherits the target's mode/owner/SELinux label so the replacement
/// behaves like the file it replaces; a brand-new file keeps the staged 0600
/// mode, the conservative default.
fn sudo_script(tmp: &str, target: &str, tag: &str) -> String {
  format!(
    "set -e; t=$(readlink -f -- {target} 2>/dev/null || true); \
     [ -n \"$t\" ] || t={target}; \
     n=\"$(dirname -- \"$t\")/.$(basename -- \"$t\").wrolp-{tag}\"; \
     trap 'rm -f -- \"$n\"' EXIT; \
     cp -- {tmp} \"$n\"; \
     if [ -e \"$t\" ]; then \
       chmod --reference=\"$t\" \"$n\" 2>/dev/null || true; \
       chown --reference=\"$t\" \"$n\" 2>/dev/null || true; \
       chcon --reference=\"$t\" \"$n\" 2>/dev/null || true; \
     fi; \
     mv -f -- \"$n\" \"$t\"",
    tmp = shell_quote_arg(tmp),
    target = shell_quote_arg(target),
  )
}

/// The exec line. `2>&1` folds sudo's own error messages into the stream we
/// read, and the trailing marker carries the status itself: a server that drops
/// the exit-status message then still tells us what happened. The password is
/// deliberately NOT part of this string — it goes over stdin.
fn sudo_line(tmp: &str, target: &str, tag: &str) -> String {
  format!(
    "sudo -S -p '' sh -c {} 2>&1; echo {STATUS_MARK}$?",
    shell_quote_arg(&sudo_script(tmp, target, tag))
  )
}

/// One `sudo … cp` run over a single exec channel.
struct SudoAttempt {
  /// `None` when the server closed the channel without reporting a status.
  status: Option<u32>,
  /// stdout+stderr without the marker, and without anything that looks like the
  /// password (a pty echoes it back until sudo disables echo).
  detail: String,
  /// The server rejected the request instead of running anything.
  refused: bool,
  /// Set when the remote process died from a signal rather than exiting.
  signal: Option<String>,
}

impl SudoAttempt {
  fn succeeded(&self) -> bool {
    self.status == Some(0)
  }

  /// True when the remote side asked for a terminal. `Defaults requiretty` is
  /// still common (RHEL/CentOS) and refuses sudo on a plain exec channel, so
  /// the caller retries with a pseudo-terminal instead of giving up.
  fn needs_tty(&self) -> bool {
    let d = self.detail.to_lowercase();
    [
      "must have a tty",
      "no tty present",
      "a terminal is required",
      "no askpass",
      "not a terminal",
      "unable to open /dev/tty",
    ]
    .iter()
    .any(|needle| d.contains(needle))
  }

  /// A silent failure means sudo never spoke (no password prompt, no error), so
  /// retrying with a pty cannot double-count a wrong password.
  fn silent(&self) -> bool {
    !self.succeeded() && self.detail.is_empty() && !self.refused
  }

  fn error(&self, with_pty: bool) -> String {
    let what = if with_pty {
      "sudo failed over a pseudo-terminal"
    } else {
      "sudo failed"
    };
    match self.status {
      Some(code) if !self.detail.is_empty() => format!("{what} (exit {code}): {}", self.detail),
      Some(code) => format!("{what} (exit {code}) — check the password and sudo rights"),
      None => {
        if self.refused {
          "The server refused to run sudo (the exec request was rejected)".to_string()
        } else if let Some(signal) = &self.signal {
          format!("sudo was killed by {signal} before it finished")
        } else {
          "sudo reported neither output nor an exit status — the remote shell may \
           have refused the command"
            .to_string()
        }
      }
    }
  }
}

async fn sudo_copy(
  state: &tauri::State<'_, AppState>,
  tab_id: u32,
  tmp: &str,
  target: &str,
  tag: &str,
  password: &str,
) -> Result<bool, String> {
  let handle = {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    sessions
      .get(&tab_id)
      .and_then(|s| s.session_handle.clone())
  }
  .ok_or_else(|| "SSH session is no longer available".to_string())?;

  let first = run_sudo(&handle, tmp, target, tag, password, false).await?;
  if first.succeeded() {
    return Ok(true);
  }
  if !(first.needs_tty() || first.silent()) {
    return Err(first.error(false));
  }

  let retry = run_sudo(&handle, tmp, target, tag, password, true).await?;
  if retry.succeeded() {
    return Ok(true);
  }
  if first.needs_tty() || retry.needs_tty() {
    // Both attempts failed for the same reason: report only the tty run, the
    // first one's "no tty" message was already the answer.
    return Err(retry.error(true));
  }
  Err(format!(
    "{} (also over a pty: {})",
    first.error(false),
    retry.error(true)
  ))
}

async fn run_sudo(
  handle: &russh::client::Handle<SshHandler>,
  tmp: &str,
  target: &str,
  tag: &str,
  password: &str,
  use_pty: bool,
) -> Result<SudoAttempt, String> {
  if handle.is_closed() {
    return Err("SSH session is closed".into());
  }

  let mut channel = handle
    .channel_open_session()
    .await
    .map_err(|e| format!("Failed to open exec channel: {e}"))?;

  if use_pty {
    channel
      .request_pty(true, "xterm", 80, 24, 0, 0, &[])
      .await
      .map_err(|e| format!("Failed to request a pseudo-terminal: {e}"))?;
  }

  channel
    .exec(true, sudo_line(tmp, target, tag))
    .await
    .map_err(|e| format!("Failed to start sudo: {e}"))?;
  channel
    .data(format!("{password}\n").as_bytes())
    .await
    .map_err(|e| format!("Failed to send sudo password: {e}"))?;
  channel
    .eof()
    .await
    .map_err(|e| format!("Failed to close sudo stdin: {e}"))?;

  let mut raw: Vec<u8> = Vec::new();
  let mut status: Option<u32> = None;
  let mut signal: Option<String> = None;
  let mut refused = false;
  let deadline = tokio::time::Instant::now() + SUDO_TIMEOUT;
  loop {
    let next = match tokio::time::timeout_at(deadline, channel.wait()).await {
      Ok(next) => next,
      // Never closed: keep whatever arrived instead of hanging the save.
      Err(_) => break,
    };
    let Some(msg) = next else { break };
    match msg {
      ChannelMsg::Data { data } => raw.extend_from_slice(&data),
      // stderr belongs in the message: sudo explains every refusal there.
      ChannelMsg::ExtendedData { data, .. } => raw.extend_from_slice(&data),
      ChannelMsg::ExitStatus { exit_status } => status = Some(exit_status),
      ChannelMsg::ExitSignal { signal_name, .. } => signal = Some(format!("{signal_name:?}")),
      ChannelMsg::Failure => refused = true,
      ChannelMsg::Close => break,
      // `Eof` is NOT the end of the conversation: servers may flush stderr, or
      // our marker, after it. Stopping here is what hid the real reason.
      _ => {}
    }
  }

  let (detail, marker) = parse_attempt(&raw, password);
  let attempt = SudoAttempt {
    status: marker.or(status),
    detail,
    refused: refused && status.is_none(),
    signal,
  };
  eprintln!(
    "[sudo] pty={use_pty} status={:?} refused={} detail={:?}",
    attempt.status, attempt.refused, attempt.detail
  );
  Ok(attempt)
}

/// Split the captured bytes into (human message, status carried by the marker).
/// Also strips CRLF (a pty) and any echo of the password.
fn parse_attempt(raw: &[u8], password: &str) -> (String, Option<u32>) {
  let text = String::from_utf8_lossy(raw).replace('\r', "");
  let (detail, status) = match text.rfind(STATUS_MARK) {
    Some(idx) => {
      let digits: String = text[idx + STATUS_MARK.len()..]
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
      (&text[..idx], digits.parse().ok())
    }
    None => (text.as_str(), None),
  };
  (scrub_password(detail, password).trim().to_string(), status)
}

/// A pty echoes what we write until sudo turns echo off, so the password can
/// come back in the output. Drop it line by line: the echo is always a line of
/// its own, while a short password appearing inside a real message stays read-
/// able (an inline replacement would mangle the words around it).
fn scrub_password(text: &str, password: &str) -> String {
  if password.is_empty() {
    return text.to_string();
  }
  let long_enough_to_replace = password.chars().count() >= 4;
  text
    .lines()
    .filter(|line| line.trim() != password)
    .map(|line| {
      if long_enough_to_replace {
        line.replace(password, "***")
      } else {
        line.to_string()
      }
    })
    .collect::<Vec<_>>()
    .join("\n")
}

#[cfg(test)]
mod tests {
  use super::{parse_attempt, sibling_tag, sudo_line, sudo_script, STATUS_MARK};

  #[test]
  fn the_script_resolves_the_target_and_renames_a_sibling_into_place() {
    assert_eq!(
      sudo_script("/tmp/.wrolp-sudo-1", "/etc/app.conf", "abcd1234"),
      "set -e; t=$(readlink -f -- '/etc/app.conf' 2>/dev/null || true); \
       [ -n \"$t\" ] || t='/etc/app.conf'; \
       n=\"$(dirname -- \"$t\")/.$(basename -- \"$t\").wrolp-abcd1234\"; \
       trap 'rm -f -- \"$n\"' EXIT; \
       cp -- '/tmp/.wrolp-sudo-1' \"$n\"; \
       if [ -e \"$t\" ]; then \
       chmod --reference=\"$t\" \"$n\" 2>/dev/null || true; \
       chown --reference=\"$t\" \"$n\" 2>/dev/null || true; \
       chcon --reference=\"$t\" \"$n\" 2>/dev/null || true; \
       fi; \
       mv -f -- \"$n\" \"$t\""
    );
  }

  #[test]
  fn the_sibling_tag_is_short_and_hex() {
    let tag = sibling_tag();
    assert_eq!(tag.len(), 8, "{tag}");
    assert!(tag.chars().all(|c| c.is_ascii_hexdigit()), "{tag}");
  }

  #[test]
  fn the_sudo_line_wraps_the_script_and_afterwards_prints_the_status() {
    let line = sudo_line("/tmp/x", "/etc/app.conf", "abcd1234");
    assert!(line.starts_with("sudo -S -p '' sh -c '"), "{line}");
    assert!(line.ends_with("' 2>&1; echo __WROLP_SUDO_EXIT__$?"), "{line}");
    assert!(line.contains("mv -f --"), "{line}");
  }

  /// What the remote login shell does to a single-quoted word before `sh` sees it.
  fn unquote_single(word: &str) -> String {
    let inner = word
      .strip_prefix('\'')
      .and_then(|s| s.strip_suffix('\''))
      .expect("not a single-quoted word");
    inner.replace("'\\''", "'")
  }

  #[test]
  fn the_script_survives_a_hostile_path_through_both_quoting_layers() {
    let target = "/etc/it's; rm -rf.conf";
    let line = sudo_line("/tmp/x", target, "abcd1234");

    let (head, rest) = line.split_once("sh -c ").expect("no sh -c in the line");
    assert_eq!(head, "sudo -S -p '' ");
    let script_arg = rest
      .strip_suffix(" 2>&1; echo __WROLP_SUDO_EXIT__$?")
      .expect("no status marker at the tail");

    // The login shell unquotes the argument, so `sh -c` must receive exactly the
    // script we built — the `;` inside the quoted path is then just a character.
    assert_eq!(
      unquote_single(script_arg),
      sudo_script("/tmp/x", target, "abcd1234")
    );
  }

  #[test]
  fn the_marker_status_is_peeled_off_the_message() {
    let (detail, status) = parse_attempt(
      b"sudo: 1 incorrect password attempt\r\n__WROLP_SUDO_EXIT__1\r\n",
      "s3cret",
    );
    assert_eq!(status, Some(1));
    assert_eq!(detail, "sudo: 1 incorrect password attempt");
  }

  #[test]
  fn a_pty_echo_of_the_password_never_reaches_the_message() {
    let (detail, status) = parse_attempt(
      b"s3cret\r\nsudo: no tty present, and no askpass program specified\r\n__WROLP_SUDO_EXIT__1",
      "s3cret",
    );
    assert_eq!(status, Some(1));
    assert_eq!(
      detail,
      "sudo: no tty present, and no askpass program specified"
    );
  }

  #[test]
  fn a_short_password_does_not_mangle_the_message() {
    // "cp" must stay readable in sudo's own wording; only the echoed line goes.
    let (detail, _) = parse_attempt(b"cp\r\nsudo: cp is not allowed\r\n__WROLP_SUDO_EXIT__1", "cp");
    assert_eq!(detail, "sudo: cp is not allowed");
  }

  #[test]
  fn a_channel_without_a_marker_reports_no_status() {
    assert_eq!(parse_attempt(b"", "pw"), (String::new(), None));
    assert_eq!(
      parse_attempt(b"Connection closed", "pw"),
      ("Connection closed".to_string(), None)
    );
    // The marker name alone, with no digits, is not a status.
    assert_eq!(parse_attempt(STATUS_MARK.as_bytes(), "pw").1, None);
  }
}

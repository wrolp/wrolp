// Device identity: what a session's host key said, and the rows + event that
// follow from it (`SSH-COMMAND-INDEX-COMPLETION-PLAN` §2.A).
//
// The identity is the *device*, not the saved connection: one host key can be
// reached by several connections (different users or ports), and one connection
// can meet several keys over time (a rebuilt box). Everything downstream — the
// command index, "where did I run this" — keys off the fingerprint, so it has to
// survive the connection entry being renamed, re-grouped or edited.

use tauri::{AppHandle, Emitter, Manager};

use crate::db;
use crate::ssh_session::AppState;

/// One device sighting, reduced to what the `hosts` table keys on.
#[derive(Debug, Clone)]
pub struct DeviceSeen {
  /// `SHA256:<base64>` for SSH, or a `kind:detail` fallback id (see
  /// `fallback_id`) for the session kinds with no host key.
  pub fingerprint: String,
  /// `ssh` / `local` / `wsl` / `serial` / `telnet`.
  pub kind: &'static str,
  pub host: String,
  pub port: i64,
  pub username: String,
  /// This connection was previously recorded with a different key. Decision ②
  /// turns that into a warning; enforcement is decided earlier, inside the
  /// handshake callback, where refusing is still possible.
  pub changed: bool,
  /// The key that was on record, when there was one. Shipped to the frontend so a
  /// change warning can show both halves of the comparison instead of asking the
  /// user to remember what the chip said yesterday.
  pub previous: Option<String>,
}

/// Record the sighting and push `host-identified` to the frontend. Reports
/// whether the device row is new, which is what makes "first time we've met this
/// machine" distinguishable from a reconnect.
///
/// The SQLite write goes to a blocking thread on purpose: callers run on the
/// async runtime, where anything holding the DB mutex also stalls every other
/// command — including the 100 ms `poll_output` that feeds the terminal.
pub async fn record_and_announce(
  app: &AppHandle,
  tab_id: u32,
  connection_id: Option<&str>,
  seen: &DeviceSeen,
) {
  let Some(state) = app.try_state::<AppState>() else {
    eprintln!("[host_identity] no AppState, skipping device record for tab={tab_id}");
    return;
  };
  let db = state.db.clone();
  // A local shell has no saved-connection id to link against — `open_local_shell`
  // receives a shell spec, not an entry — so its device links to itself. The link
  // row then carries the only thing that lookup needs: that this device was met.
  let connection_id = connection_id
    .unwrap_or(seen.fingerprint.as_str())
    .to_string();
  let now_ms = chrono::Utc::now().timestamp_millis();
  // Destructured up front: the blocking task needs owned copies to move in, and
  // the event below still has to report the same values afterwards.
  let DeviceSeen {
    fingerprint,
    kind,
    host,
    port,
    username,
    changed,
    previous,
  } = seen.clone();

  let recorded = tokio::task::spawn_blocking({
    let connection_id = connection_id.clone();
    let fingerprint = fingerprint.clone();
    let host = host.clone();
    let username = username.clone();
    move || {
      let conn = db.lock().map_err(|e| e.to_string())?;
      let is_new = db::record_host(&conn, &fingerprint, kind, &host, port, &username, now_ms)?;
      db::link_connection_host(&conn, &connection_id, &fingerprint, now_ms)?;
      Ok::<bool, String>(is_new)
    }
  })
  .await;

  let is_new = match recorded {
    Ok(Ok(is_new)) => is_new,
    Ok(Err(e)) => {
      // Identity is an observation, never a prerequisite: a failed write must not
      // cost the user a connection that is already up.
      eprintln!("[host_identity] record failed for tab={tab_id}: {e}");
      false
    }
    Err(e) => {
      eprintln!("[host_identity] record task panicked for tab={tab_id}: {e}");
      false
    }
  };

  let _ = app.emit(
    "host-identified",
    serde_json::json!({
      "tabId": tab_id,
      "fingerprint": fingerprint,
      "kind": kind,
      "host": host,
      "port": port,
      "username": username,
      "isNew": is_new,
      "changed": changed,
      "previousFingerprint": previous,
    }),
  );
}

/// Identity for a session kind that has no host key. The `kind:` prefix keeps it
/// in a disjoint namespace from `SHA256:…`, so the two can share one column
/// without a `kind` filter ever being required to tell them apart.
pub fn fallback_id(kind: &str, detail: &str) -> String {
  format!("{kind}:{detail}")
}

/// What to do with a host key the server just presented (decision ②).
#[derive(Debug, PartialEq, Eq)]
pub enum KeyVerdict {
  /// Let the handshake continue. `changed` marks the TOFU case: same connection,
  /// different key — worth telling the user, not worth refusing for.
  Proceed { changed: bool },
  /// Strict checking is on and the key is not the one on record. Carries the
  /// previous fingerprint so the message can show both.
  Reject { previous: String },
}

/// The whole TOFU decision, as a pure function so the four cases are testable
/// without a live SSH server.
pub fn judge_host_key(presented: &str, previous: Option<&str>, enforce: bool) -> KeyVerdict {
  match previous {
    // Never seen this connection before: nothing to compare against, so first
    // contact is trusted and recorded (that is what TOFU means here).
    None => KeyVerdict::Proceed { changed: false },
    Some(prev) if prev == presented => KeyVerdict::Proceed { changed: false },
    Some(prev) if enforce => KeyVerdict::Reject {
      previous: prev.to_string(),
    },
    Some(_) => KeyVerdict::Proceed { changed: true },
  }
}

impl DeviceSeen {
  /// A session kind with no host key. The fallback id *is* the fingerprint, so
  /// there is no key that could have changed — `changed` is structurally false.
  pub fn fallback(
    kind: &'static str,
    detail: &str,
    host: String,
    port: i64,
    username: String,
  ) -> Self {
    Self {
      fingerprint: fallback_id(kind, detail),
      kind,
      host,
      port,
      username,
      changed: false,
      previous: None,
    }
  }
}

/// This machine's name, for the `local:` identity. Read from the environment so
/// no OS-dependency crate is needed: Windows sets `COMPUTERNAME`, POSIX shells set
/// `HOSTNAME`, and a bare `uname -n` is the fallback both ways.
pub fn local_machine_name() -> String {
  for key in ["COMPUTERNAME", "HOSTNAME"] {
    if let Ok(v) = std::env::var(key) {
      if !v.trim().is_empty() {
        return v.trim().to_ascii_lowercase();
      }
    }
  }
  "unknown".to_string()
}

#[cfg(test)]
mod host_identity_tests {
  use super::*;

  #[test]
  fn fallback_ids_are_disjoint_from_key_fingerprints() {
    assert_eq!(fallback_id("local", "devbox"), "local:devbox");
    assert_eq!(fallback_id("serial", "COM3"), "serial:COM3");
    // Same host reached over telnet and serial must not collide, which is the only
    // thing the prefix buys us.
    assert_ne!(
      fallback_id("telnet", "10.0.0.1:23"),
      fallback_id("local", "10.0.0.1")
    );
  }

  #[test]
  fn machine_name_is_never_empty() {
    // Whatever the environment says, the identity column is NOT NULL and a blank
    // `local:` would collide with every other blank one.
    assert!(!local_machine_name().is_empty());
  }

  #[test]
  fn first_contact_proceeds_without_claiming_a_change() {
    assert_eq!(
      judge_host_key("SHA256:new", None, false),
      KeyVerdict::Proceed { changed: false }
    );
    // Enforcement must not turn an unknown key into a refusal — that would make
    // "strict" mean "never connect again", not "reject a changed key".
    assert_eq!(
      judge_host_key("SHA256:new", None, true),
      KeyVerdict::Proceed { changed: false }
    );
  }

  #[test]
  fn matching_key_proceeds_cleanly() {
    assert_eq!(
      judge_host_key("SHA256:aaa", Some("SHA256:aaa"), true),
      KeyVerdict::Proceed { changed: false }
    );
  }

  #[test]
  fn changed_key_warns_unless_enforcing_then_refuses() {
    assert_eq!(
      judge_host_key("SHA256:bbb", Some("SHA256:aaa"), false),
      KeyVerdict::Proceed { changed: true }
    );
    assert_eq!(
      judge_host_key("SHA256:bbb", Some("SHA256:aaa"), true),
      KeyVerdict::Reject {
        previous: "SHA256:aaa".to_string()
      }
    );
  }
}

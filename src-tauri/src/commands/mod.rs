//! Tauri `#[tauri::command]` handlers.
//!
//! This module is the shared entry point for all IPC commands. The actual
//! handlers live in focused submodules (`connections`, `ssh`, `local_shell`,
//! `sftp`, `upload`, `window`, `recordings`, `ai_chat`, `ai_term`, `tunnels`);
//! this file keeps the shared helpers used by several submodules and
//! re-exports every command so that `crate::commands::xxx` keeps working
//! unchanged from `lib.rs`.

// Shared imports (glob-imported by submodules via `use super::*`).
#[allow(unused_imports)]
pub(crate) use super::ssh_session::{
  ActiveRecording, AppState, ConnectResult, ConnectionConfig, ContainerInfo, DirDownloadSummary,
  DirUploadSummary, FileEntry, HostKeySeen, HostKeyWatch, LocalShell, LocalShellDir,
  LocalTerminalEntry, SerialSession, SshError, SshHandler, SshSession, SwitchedUser, TargetRef,
  TelnetSession, TransferControl, TransferRegistry, TunnelInfo, UploadBatch, UploadSession,
};
#[allow(unused_imports)]
pub(crate) use crate::db::{
  self, AiPromptTemplate, CommandSetDto, SessionEventDto, SessionSummary,
};
#[allow(unused_imports)]
pub(crate) use crate::remote_fs::{
  build_fs, build_sftp, copy_recursive, delete_dir_recursive, get_jump_handle, RemoteFs,
};
#[allow(unused_imports)]
pub(crate) use encoding_rs::{Encoding, UTF_8};
#[allow(unused_imports)]
pub(crate) use russh::client::{self, Handler};
#[allow(unused_imports)]
pub(crate) use russh::keys::key::PrivateKeyWithHashAlg;
#[allow(unused_imports)]
pub(crate) use russh::keys::load_secret_key;
/// Hash algorithm for the host-key fingerprint the device identity is keyed on
/// (`SHA256:<base64>`, the same string `ssh-keygen -lf` prints).
#[allow(unused_imports)]
pub(crate) use russh::keys::HashAlg;
#[allow(unused_imports)]
pub(crate) use russh::keys::PublicKeyOrCertificate;
#[allow(unused_imports)]
pub(crate) use russh::ChannelId;

pub use serial::*;
#[allow(unused_imports)]
pub(crate) use std::collections::HashMap;
#[allow(unused_imports)]
pub(crate) use std::path::PathBuf;
#[allow(unused_imports)]
pub(crate) use std::process::Command as StdCommand;
#[allow(unused_imports)]
pub(crate) use std::sync::atomic::{AtomicBool, Ordering};
#[allow(unused_imports)]
pub(crate) use std::sync::Arc;
#[allow(unused_imports)]
pub(crate) use std::sync::Mutex as StdMutex;
#[allow(unused_imports)]
pub(crate) use tauri::Emitter;
#[allow(unused_imports)]
pub(crate) use tauri::Manager;
#[allow(unused_imports)]
pub(crate) use tokio::io::{AsyncReadExt, AsyncWriteExt};
#[allow(unused_imports)]
pub(crate) use uuid::Uuid;
#[allow(unused_imports)]
pub(crate) use walkdir::WalkDir;

// --- Shared helpers -------------------------------------------------------

/// Wait if the transfer for this tab is paused. Returns immediately if not
/// paused, or an error if the transfer has been cancelled by the user.
pub(crate) async fn check_pause(control: &TransferControl) -> Result<(), String> {
  loop {
    if control.cancelled.load(Ordering::SeqCst) {
      return Err("Transfer cancelled".to_string());
    }
    if !control.paused.load(Ordering::SeqCst) {
      return Ok(());
    }
    control.notify.notified().await;
  }
}

/// Per-tab poll-buffer caps. Output is drained by `poll_output` every 100ms;
/// if a tab stalls (or the frontend stops polling) this bounds memory instead
/// of letting the queue grow without limit.
pub(crate) const MAX_OUTPUT_BYTES: usize = 1024 * 1024;
pub(crate) const MAX_OUTPUT_CHUNKS: usize = 1024;
/// Marker prepended to the poll buffer once older chunks are dropped. It is an
/// ANSI-colored line, so `parseAnsiToHtml` renders it like normal output.
pub(crate) const OUTPUT_TRUNCATION_MARKER: &str = "\r\n\u{1b}[33m…output truncated…\u{1b}[0m\r\n";

/// Caps for the AI command-capture tee (`ai_captures` / `LocalShell.ai_capture`).
pub(crate) const MAX_AI_CAPTURE_BYTES: usize = 512 * 1024;
pub(crate) const AI_CAPTURE_TRUNCATION_MARKER: &str = "…ai capture truncated…\n";

/// Append one output chunk, dropping the oldest chunks once the per-tab cap is
/// exceeded and leaving a single visible truncation marker behind.
pub(crate) fn push_capped_chunk(chunks: &mut Vec<String>, data: String) {
  chunks.push(data);
  // Keep the common case cheap: only scan sizes once the queue is non-trivial.
  if chunks.len() <= 64 {
    return;
  }
  let mut bytes: usize = chunks.iter().map(|s| s.len()).sum();
  let mut drop = 0usize;
  while (bytes > MAX_OUTPUT_BYTES || chunks.len() - drop > MAX_OUTPUT_CHUNKS)
    && chunks.len() - drop > 1
  {
    bytes -= chunks[drop].len();
    drop += 1;
  }
  if drop == 0 {
    return;
  }
  chunks.drain(..drop);
  if !chunks.iter().any(|s| s == OUTPUT_TRUNCATION_MARKER) {
    chunks.insert(0, OUTPUT_TRUNCATION_MARKER.to_string());
  }
}

/// Same as `push_capped_chunk`, but for the shared per-tab poll buffer map.
pub(crate) fn push_output_chunk(
  buffers: &mut HashMap<u32, Vec<String>>,
  tab_id: u32,
  data: String,
) {
  push_capped_chunk(buffers.entry(tab_id).or_default(), data);
}

/// Append to an AI capture buffer, keeping only the most recent bytes and
/// marking the front once content was dropped.
pub(crate) fn push_ai_capture(buf: &mut String, data: &str) {
  buf.push_str(data);
  if buf.len() <= MAX_AI_CAPTURE_BYTES {
    return;
  }
  let mut cut = buf.len() - MAX_AI_CAPTURE_BYTES;
  while cut < buf.len() && !buf.is_char_boundary(cut) {
    cut += 1;
  }
  buf.drain(..cut);
  if !buf.starts_with(AI_CAPTURE_TRUNCATION_MARKER) {
    buf.insert_str(0, AI_CAPTURE_TRUNCATION_MARKER);
  }
}

/// Move at most one poll batch out of `chunks`, leaving the rest queued.
/// Always drains at least one chunk so a single oversized chunk cannot stall.
pub(crate) const MAX_POLL_CHUNKS: usize = 128;
pub(crate) const MAX_POLL_BYTES: usize = 256 * 1024;

pub(crate) fn drain_poll_batch(chunks: &mut Vec<String>, out: &mut Vec<String>) {
  let mut bytes = 0usize;
  let mut taken = 0usize;
  while taken < chunks.len() {
    let len = chunks[taken].len();
    if taken > 0 && (taken >= MAX_POLL_CHUNKS || bytes + len > MAX_POLL_BYTES) {
      break;
    }
    bytes += len;
    taken += 1;
  }
  out.extend(chunks.drain(..taken));
}

/// Drop every buffered byte for a tab when its session ends.
pub(crate) fn clear_tab_buffers(state: &AppState, tab_id: u32) {
  if let Ok(mut buffers) = state.output_buffers.lock() {
    buffers.remove(&tab_id);
  }
  if let Ok(mut caps) = state.ai_captures.lock() {
    caps.remove(&tab_id);
  }
}

/// Stale-task guard (S2): a background task may only tear a session down (and
/// finalize its recording) while the tab still points at *its* session id and
/// the session has not been marked dead.
pub(crate) fn session_is_current(entry_session_id: u64, entry_alive: bool, mine: u64) -> bool {
  entry_session_id == mine && entry_alive
}

/// Stale-task guard for teardown helpers (S5/S6): an entry may only be removed
/// while it still belongs to the caller. `None` entries belong to nobody.
pub(crate) fn entry_is_ours(entry_session_id: Option<u64>, mine: u64) -> bool {
  entry_session_id == Some(mine)
}

/// Remove exactly `control` from a tab's control list (S6), leaving a control
/// installed by a newer transfer untouched. Returns whether it was present.
pub(crate) fn remove_control(
  list: &mut Vec<Arc<TransferControl>>,
  control: &Arc<TransferControl>,
) -> bool {
  let before = list.len();
  list.retain(|c| !Arc::ptr_eq(c, control));
  list.len() != before
}

/// RAII guard to remove a transfer control from state on drop.
///
/// `disarm()` transfers that responsibility to a longer-lived owner — a
/// streaming upload keeps its control registered across `upload_start` /
/// `upload_chunk` / `upload_end`, so the guard is only useful for its early
/// return paths.
pub(crate) struct TransferGuard {
  /// Clone of the shared registry — no raw `AppState` pointer, so the guard is
  /// `Send` by construction and cannot dangle if the tab/state is torn down.
  registry: TransferRegistry,
  tab_id: u32,
  control: Arc<TransferControl>,
  armed: bool,
}

impl TransferGuard {
  pub(crate) fn new(state: &AppState, tab_id: u32, control: Arc<TransferControl>) -> Self {
    Self {
      registry: state.transfer_controls.clone(),
      tab_id,
      control,
      armed: true,
    }
  }

  /// Keep the control registered after this command returns.
  pub(crate) fn disarm(&mut self) {
    self.armed = false;
  }
}

impl Drop for TransferGuard {
  fn drop(&mut self) {
    if !self.armed {
      return;
    }
    if let Ok(mut controls) = self.registry.lock() {
      if let Some(list) = controls.get_mut(&self.tab_id) {
        remove_control(list, &self.control);
      }
    }
  }
}

/// Expand ~ to the user's home directory
pub(crate) fn expand_tilde(path: &str) -> PathBuf {
  if path.starts_with("~/") {
    if let Some(home) = dirs::home_dir() {
      home.join(&path[2..])
    } else {
      PathBuf::from(path)
    }
  } else if path == "~" {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("~"))
  } else {
    PathBuf::from(path)
  }
}

pub(crate) fn get_data_dir() -> Option<std::path::PathBuf> {
  dirs::config_dir().map(|p| p.join("wrolp-terminal"))
}

/// Resolve the app data dir. `base` is the effective data directory resolved
/// at startup (see `data_root.rs`) and takes precedence when present;
/// otherwise it falls back to the real config dir.
pub(crate) fn data_dir_for(base: Option<&std::path::Path>) -> Option<std::path::PathBuf> {
  base.map(|b| b.to_path_buf()).or_else(get_data_dir)
}

/// Persist the current connections list to disk in the encrypted format.
pub(crate) async fn persist_connections(state: &tauri::State<'_, AppState>) -> Result<(), String> {
  let path = match data_dir_for(state.base_dir.as_deref()) {
    Some(p) => p.join("connections.json"),
    None => return Ok(()),
  };
  // Snapshot under the locks (same order: connections → workspaces → active),
  // then release all three before encrypting + writing on a blocking thread.
  // AES encryption plus fsync must not run on an async worker.
  let (all_conns, workspaces, active_id) = {
    let all_conns = state.connections.lock().map_err(|e| e.to_string())?.clone();
    let workspaces = state.workspaces.lock().map_err(|e| e.to_string())?.clone();
    let active_id = state
      .active_workspace_id
      .lock()
      .map_err(|e| e.to_string())?
      .clone();
    (all_conns, workspaces, active_id)
  };
  tokio::task::spawn_blocking(move || {
    crate::ssh_session::write_encrypted_connections(&path, &all_conns, &workspaces, &active_id)
  })
  .await
  .map_err(|e| format!("connections.json write task failed: {e}"))?
}

pub(crate) fn now_ms() -> u64 {
  std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|d| d.as_millis() as u64)
    .unwrap_or(0)
}

/// Detect common image formats from the leading magic bytes. Returns the MIME
/// type (e.g. "image/png") or `None` for non-image data.
pub(crate) fn detect_image_mime(data: &[u8]) -> Option<String> {
  let sig = &data[..data.len().min(16)];
  let mime = match sig {
    [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, ..] => "image/png",
    [0xff, 0xd8, 0xff, ..] => "image/jpeg",
    [b'G', b'I', b'F', b'8', ..] => "image/gif",
    [b'B', b'M', ..] => "image/bmp",
    [b'R', b'I', b'F', b'F', ..] => "image/webp", // RIFF....WEBP
    [0x00, 0x00, 0x01, 0x00, ..] => "image/x-icon",
    _ => return None,
  };
  Some(mime.to_string())
}

/// Sniff the image MIME from magic bytes, but only when the file is actually
/// binary (text files are never images in this app).
pub(crate) fn image_mime_of(data: &[u8], path: &str) -> Option<String> {
  let lower = path.to_ascii_lowercase();
  let mime = detect_image_mime(data);
  if mime.is_some() {
    return mime;
  }
  if lower.ends_with(".svg") || lower.ends_with(".svgz") {
    return Some("image/svg+xml".to_string());
  }
  None
}

/// Split a trailing INCOMPLETE UTF-8 sequence off `data` so the caller can hold
/// it back and decode it together with the next read. Decoding each read chunk
/// on its own (`from_utf8_lossy`) turns a multi-byte character (CJK, box
/// drawing, TUI icon glyphs) that straddles a read/packet boundary into U+FFFD
/// replacement diamonds mid-frame (BUGS.md B46 ④).
///
/// Returns `(decodable, held_back)`; `held_back` is at most 3 bytes. Genuinely
/// invalid bytes in the middle are NOT held — the caller's lossy decode
/// replaces them as before.
pub(crate) fn split_incomplete_utf8(data: &[u8]) -> (&[u8], &[u8]) {
  for k in 0..=3.min(data.len()) {
    let (head, tail) = data.split_at(data.len() - k);
    if let Ok(_) = std::str::from_utf8(head) {
      // Hold the tail only when it is itself an incomplete sequence; an empty or
      // invalid tail must decode (lossy) now, never sit held forever.
      if tail.is_empty() || matches!(std::str::from_utf8(tail), Err(e) if e.error_len().is_none()) {
        return (head, tail);
      }
    }
  }
  (data, &[])
}

pub(crate) fn decode_file_content(
  data: &[u8],
  encoding_name: Option<&str>,
) -> (String, String, bool) {
  if let Some(name) = encoding_name {
    let encoding: &Encoding = Encoding::for_label(name.as_bytes()).unwrap_or(UTF_8);
    let (cow, _, _had_errors) = encoding.decode(data);
    let needs = encoding.name() != "UTF-8";
    return (
      cow.into_owned(),
      encoding.name().to_ascii_lowercase(),
      needs,
    );
  }

  // Auto-detect: prefer UTF-8, fall back to GBK.
  if let Ok(s) = String::from_utf8(data.to_vec()) {
    return (s, "utf-8".to_string(), false);
  }
  if let Some(gbk) = Encoding::for_label(b"gbk") {
    let (cow, _, had_errors) = gbk.decode(data);
    if !had_errors {
      return (cow.into_owned(), "gbk".to_string(), true);
    }
  }
  // Last resort: UTF-8 with replacement characters.
  let (cow, _, _) = UTF_8.decode(data);
  (cow.into_owned(), "utf-8".to_string(), false)
}

pub(crate) const DEFAULT_MAX_EDIT_SIZE: u64 = 5_000_000;

/// Strip ANSI / VT escape sequences so the model sees plain text.
pub(crate) fn strip_ansi(input: &str) -> String {
  let mut out = String::with_capacity(input.len());
  let mut chars = input.chars().peekable();
  while let Some(c) = chars.next() {
    match c {
      '\x1b' => match chars.next() {
        // CSI: ESC [ params... final-byte(0x40..=0x7E)
        Some('[') => {
          for n in chars.by_ref() {
            if ('\x40'..='\x7e').contains(&n) {
              break;
            }
          }
        }
        // OSC / DCS / PM / APC: terminated by BEL or ST (ESC \)
        Some(']') | Some('P') | Some('^') | Some('_') => {
          while let Some(n) = chars.next() {
            if n == '\x07' {
              break;
            }
            if n == '\x1b' {
              if chars.peek() == Some(&'\\') {
                chars.next();
              }
              break;
            }
          }
        }
        // Charset designators consume one more byte.
        Some('(') | Some(')') | Some('*') | Some('+') => {
          chars.next();
        }
        // Any other two-byte escape: already consumed.
        _ => {}
      },
      // Bell / shift-in / shift-out carry no textual meaning.
      '\x07' | '\x0e' | '\x0f' => {}
      _ => out.push(c),
    }
  }
  out
}

/// Minimal single-argument shell quoting for safe remote exec.
pub(crate) fn shell_quote_arg(s: &str) -> String {
  let escaped = s.replace('\'', "'\\''");
  format!("'{}'", escaped)
}

// --- Submodules -----------------------------------------------------------

pub(crate) mod ai_chat;
pub(crate) mod ai_sessions;
pub(crate) mod ai_term;
pub(crate) mod command_history;
pub(crate) mod connection_recents;
pub(crate) mod connections;
pub(crate) mod db_maintenance;
pub(crate) mod docker;
pub(crate) mod ftp;
pub(crate) mod ftp_server;
pub(crate) mod git;
pub(crate) mod helm;
pub(crate) mod host_commands;
pub(crate) mod http_server;
pub(crate) mod k8s;
pub(crate) mod local_shell;
pub(crate) mod network_scan;
pub(crate) mod recordings;
pub(crate) mod serial;
pub(crate) mod sftp;
pub(crate) mod ssh;
pub(crate) mod telnet;
pub(crate) mod tftp;
pub(crate) mod tftp_server;
pub(crate) mod tunnels;
pub(crate) mod upload;
pub(crate) mod window;

// Re-export every command so `crate::commands::<name>` keeps working from lib.rs.
pub use ai_chat::*;
pub use ai_sessions::*;
pub use ai_term::*;
pub use command_history::*;
pub use connection_recents::*;
pub use connections::*;
pub use db_maintenance::*;
pub use docker::*;
pub use ftp::*;
pub use ftp_server::*;
pub use git::*;
pub use helm::*;
pub use host_commands::*;
pub use http_server::*;
pub use k8s::*;
pub use local_shell::*;
pub use network_scan::*;
pub use recordings::*;
pub use sftp::*;
pub use ssh::*;
pub use telnet::*;
pub use tftp::*;
pub use tftp_server::*;
pub use tunnels::*;
pub use upload::*;
pub use window::*;

#[cfg(test)]
mod tests {
  use super::*;
  use std::sync::atomic::AtomicBool;

  fn control() -> Arc<TransferControl> {
    Arc::new(TransferControl {
      paused: AtomicBool::new(false),
      cancelled: AtomicBool::new(false),
      notify: tokio::sync::Notify::new(),
    })
  }

  #[test]
  fn stale_task_guard_requires_same_id_and_alive() {
    // Own, live session.
    assert!(session_is_current(7, true, 7));
    // Same id but already marked dead (disconnect/failure happened first).
    assert!(!session_is_current(7, false, 7));
    // A newer session replaced ours (the stale-task case).
    assert!(!session_is_current(8, true, 7));
    assert!(!session_is_current(7, true, 8));
  }

  #[test]
  fn entry_is_ours_only_matches_exact_id() {
    assert!(entry_is_ours(Some(5), 5));
    assert!(!entry_is_ours(Some(6), 5));
    // Session already removed from the map: nobody owns it.
    assert!(!entry_is_ours(None, 5));
  }

  #[test]
  fn remove_control_targets_only_the_given_control() {
    let old = control();
    let current = control();
    let stranger = control();

    let mut list = vec![old.clone(), current.clone()];
    assert!(remove_control(&mut list, &current));
    assert_eq!(list.len(), 1);
    assert!(Arc::ptr_eq(&list[0], &old));

    // Removing an already-removed / never-registered control is a no-op.
    assert!(!remove_control(&mut list, &current));
    assert!(!remove_control(&mut list, &stranger));
    assert!(!remove_control(&mut Vec::new(), &old));
    assert!(list.len() == 1);
  }
}

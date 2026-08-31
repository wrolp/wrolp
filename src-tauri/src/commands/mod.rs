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
  DirUploadSummary, FileEntry, LocalShell, LocalShellDir, LocalTerminalEntry, SerialSession, SshError,
  SshHandler, SshSession, SwitchedUser, TargetRef, TelnetSession, TransferControl, TunnelInfo,
  UploadSession,
};
pub use serial::*;
#[allow(unused_imports)]
pub(crate) use crate::db::{self, AiPromptTemplate, CommandSetDto, SessionEventDto, SessionSummary};
#[allow(unused_imports)]
pub(crate) use crate::remote_fs::{
  build_fs, build_sftp, copy_recursive, delete_dir_recursive, get_jump_handle, RemoteFs,
};
#[allow(unused_imports)]
pub(crate) use encoding_rs::{Encoding, UTF_8};
#[allow(unused_imports)]
pub(crate) use russh::client::{self, Handler};
#[allow(unused_imports)]
pub(crate) use russh::ChannelId;
#[allow(unused_imports)]
pub(crate) use russh_keys::load_secret_key;
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

/// RAII guard to remove transfer control from state on drop
pub(crate) struct TransferGuard {
  state_ptr: *const AppState,
  tab_id: u32,
  control: Arc<TransferControl>,
}
// Safety: AppState is managed by Tauri and lives for the app lifetime
unsafe impl Send for TransferGuard {}

impl Drop for TransferGuard {
  fn drop(&mut self) {
    // Safety: state_ptr is valid because Tauri state outlives commands
    let state = unsafe { &*self.state_ptr };
    if let Ok(mut controls) = state.transfer_controls.lock() {
      if let Some(list) = controls.get_mut(&self.tab_id) {
        list.retain(|c| !Arc::ptr_eq(c, &self.control));
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

/// Resolve the app data dir, honoring an explicit base-dir override (tests).
/// `base` takes precedence when present; otherwise falls back to the real
/// config dir.
pub(crate) fn data_dir_for(base: Option<&std::path::Path>) -> Option<std::path::PathBuf> {
  base.map(|b| b.to_path_buf()).or_else(get_data_dir)
}

/// Persist the current connections list to disk in the encrypted format.
pub(crate) async fn persist_connections(state: &tauri::State<'_, AppState>) -> Result<(), String> {
  let path = data_dir_for(state.base_dir.as_deref()).map(|p| p.join("connections.json"));
  if let Some(ref path) = path {
    let all_conns = state.connections.lock().map_err(|e| e.to_string())?;
    let workspaces = state.workspaces.lock().map_err(|e| e.to_string())?;
    let active_id = state.active_workspace_id.lock().map_err(|e| e.to_string())?;
    crate::ssh_session::write_encrypted_connections(path, &all_conns, &workspaces, &active_id)?;
  }
  Ok(())
}

pub(crate) fn get_window_config_path() -> Option<std::path::PathBuf> {
  get_data_dir().map(|p| p.join("window.json"))
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

pub(crate) fn decode_file_content(data: &[u8], encoding_name: Option<&str>) -> (String, String, bool) {
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

pub(crate) mod connections;
pub(crate) mod network_scan;
pub(crate) mod serial;
pub(crate) mod telnet;
pub(crate) mod ssh;
pub(crate) mod local_shell;
pub(crate) mod sftp;
pub(crate) mod upload;
pub(crate) mod window;
pub(crate) mod recordings;
pub(crate) mod ai_chat;
pub(crate) mod ai_term;
pub(crate) mod tunnels;

// Re-export every command so `crate::commands::<name>` keeps working from lib.rs.
pub use connections::*;
pub use network_scan::*;
pub use telnet::*;
pub use ssh::*;
pub use local_shell::*;
pub use sftp::*;
pub use upload::*;
pub use window::*;
pub use recordings::*;
pub use ai_chat::*;
pub use ai_term::*;
pub use tunnels::*;

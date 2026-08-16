//! Unified remote filesystem abstraction (P6).
//!
//! A [`RemoteFs`] performs file operations on a *target*: the tab's main SSH
//! connection, a secondary server reached via ProxyJump, or a Docker container
//! on the jump host. The frontend addresses a target with [`TargetRef`] and the
//! backend builds the appropriate implementation with [`build_fs`].

use russh::client::{self, Handle};
use russh_keys::load_secret_key;
use russh_sftp::client::SftpSession;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::commands::expand_tilde;
use crate::docker_fs::DockerExecFs;
use crate::ssh_session::{AppState, FileEntry, FileMeta, SshHandler, TargetAuth, TargetRef};

/// Unified remote filesystem interface implemented by every target type.
#[async_trait::async_trait]
pub trait RemoteFs: Send + Sync {
  async fn list_dir(&self, path: &str) -> Result<Vec<FileEntry>, String>;
  async fn metadata(&self, path: &str) -> Result<FileMeta, String>;
  async fn read_file(&self, path: &str) -> Result<Vec<u8>, String>;
  async fn write_file(&self, path: &str, data: &[u8]) -> Result<(), String>;
  async fn create_dir(&self, path: &str) -> Result<(), String>;
  async fn rename(&self, from: &str, to: &str) -> Result<(), String>;
  async fn remove_file(&self, path: &str) -> Result<(), String>;
  async fn remove_dir(&self, path: &str) -> Result<(), String>;
}

/// Format a unix mtime (seconds) the same way the existing SFTP commands do.
fn fmt_mtime(t: std::io::Result<std::time::SystemTime>) -> String {
  t.ok()
    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
    .map(|d| d.as_secs().to_string())
    .unwrap_or_default()
}

/// Authenticate a freshly connected handle with password or public key.
async fn authenticate_handle(
  handle: &mut Handle<SshHandler>,
  username: &str,
  password: Option<&str>,
  key_path: Option<&str>,
  passphrase: Option<&str>,
) -> Result<(), String> {
  if let Some(pw) = password {
    if !handle
      .authenticate_password(username, pw)
      .await
      .map_err(|e| format!("Authentication error: {}", e))?
    {
      return Err(format!("Authentication failed for user '{}'", username));
    }
  } else if let Some(kp) = key_path {
    let resolved = expand_tilde(kp);
    let key = load_secret_key(&resolved, passphrase)
      .map_err(|e| format!("Failed to load key '{}': {}", kp, e))?;
    if !handle
      .authenticate_publickey(username, Arc::new(key))
      .await
      .map_err(|e| format!("Key authentication error: {}", e))?
    {
      return Err("Key authentication failed".into());
    }
  } else {
    return Err("No credentials provided".into());
  }
  Ok(())
}

/// Open the SFTP subsystem on an authenticated handle and keep the handle alive.
async fn sftp_over_handle(handle: Handle<SshHandler>) -> Result<SftpSession, String> {
  let channel = handle
    .channel_open_session()
    .await
    .map_err(|e| format!("Failed to open SFTP channel: {}", e))?;
  channel
    .request_subsystem(true, "sftp")
    .await
    .map_err(|e| format!("Failed to request SFTP subsystem: {}", e))?;
  let sftp = SftpSession::new(channel.into_stream())
    .await
    .map_err(|e| format!("Failed to start SFTP session: {}", e))?;

  // Keep the SSH handle alive for the SFTP session's lifetime.
  tauri::async_runtime::spawn(async move {
    let _h = handle;
    std::future::pending::<()>().await;
  });

  Ok(sftp)
}

/// Establish a fresh direct SSH+SFTP connection for a tab's main session.
/// Mirrors the previous `open_sftp_session` behaviour (reconnect per operation,
/// honouring any switched SFTP user).
pub async fn open_session_sftp(
  state: &tauri::State<'_, AppState>,
  app: &tauri::AppHandle,
  tab_id: u32,
) -> Result<SftpSession, String> {
  let (config, switched_user) = {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions.get(&tab_id).ok_or("Session not found")?;
    (session.config.clone(), session.switched_sftp_user.clone())
  };

  let ssh_config = Arc::new(client::Config::default());
  let handler = SshHandler {
    app_handle: app.clone(),
    tab_id,
    is_sftp: true,
    shell_channel_id: None,
  };
  let mut handle = client::connect(ssh_config, (config.host.as_str(), config.port), handler)
    .await
    .map_err(|e| format!("SFTP connect failed: {}", e))?;

  if let Some(ref su) = switched_user {
    authenticate_handle(&mut handle, &su.username, Some(&su.password), None, None).await?;
  } else {
    authenticate_handle(
      &mut handle,
      &config.username,
      config.password.as_deref(),
      config.key_path.as_deref(),
      config.passphrase.as_deref(),
    )
    .await?;
  }

  sftp_over_handle(handle).await
}

/// Establish a nested SSH+SFTP connection through a jump host (ProxyJump).
/// Opens a direct-tcpip channel on the jump connection and runs a full SSH
/// handshake over it, then authenticates with the target's own credentials.
pub async fn open_jump_sftp(
  app: &tauri::AppHandle,
  jump: &Handle<SshHandler>,
  host: &str,
  port: u16,
  auth: &TargetAuth,
  tab_id: u32,
) -> Result<SftpSession, String> {
  if jump.is_closed() {
    return Err("Jump host connection is closed".into());
  }
  let channel = jump
    .channel_open_direct_tcpip(host, port as u32, "127.0.0.1", 0)
    .await
    .map_err(|e| {
      format!(
        "Failed to open direct-tcpip channel to {}:{}: {}",
        host, port, e
      )
    })?;
  let stream = channel.into_stream();

  let ssh_config = Arc::new(client::Config::default());
  let handler = SshHandler {
    app_handle: app.clone(),
    tab_id,
    is_sftp: true,
    shell_channel_id: None,
  };
  let mut handle = client::connect_stream(ssh_config, stream, handler)
    .await
    .map_err(|e| format!("Nested SSH handshake to {}:{} failed: {}", host, port, e))?;

  authenticate_handle(
    &mut handle,
    &auth.username,
    auth.password.as_deref(),
    auth.key_path.as_deref(),
    auth.passphrase.as_deref(),
  )
  .await?;

  sftp_over_handle(handle).await
}

/// Clone the shared jump-host session handle for a connected tab.
pub(crate) fn get_jump_handle(
  state: &tauri::State<'_, AppState>,
  jump_tab_id: u32,
) -> Result<Arc<Handle<SshHandler>>, String> {
  let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
  let session = sessions
    .get(&jump_tab_id)
    .ok_or("Jump host session not found")?;
  session
    .session_handle
    .clone()
    .ok_or_else(|| "Jump host handle not available (still connecting?)".to_string())
}

/// Build the [`RemoteFs`] implementation for a target.
/// Open a raw SFTP session for the given target, without wrapping it in a
/// `RemoteFs` trait object. Fails for non-SFTP targets (Docker exec, local).
/// Used by the streaming/chunked upload path, which needs the low-level file
/// handle to keep it open across multiple `upload_chunk` invokes.
pub async fn build_sftp(
  app: &tauri::AppHandle,
  state: &tauri::State<'_, AppState>,
  target: &TargetRef,
) -> Result<SftpSession, String> {
  match target {
    TargetRef::Session { tab_id } => open_session_sftp(state, app, *tab_id).await,
    TargetRef::JumpRemote {
      jump_tab_id,
      host,
      port,
      auth,
    }
    | TargetRef::DockerSsh {
      jump_tab_id,
      host,
      port,
      auth,
    } => {
      let jump = get_jump_handle(state, *jump_tab_id)?;
      open_jump_sftp(app, &jump, host, *port, auth, *jump_tab_id).await
    }
    TargetRef::Docker { .. } => {
      Err("Target is a Docker exec target and does not support SFTP streaming upload".into())
    }
    TargetRef::Local { .. } => {
      Err("Target is a local target and does not support SFTP streaming upload".into())
    }
  }
}

pub async fn build_fs(
  app: &tauri::AppHandle,
  state: &tauri::State<'_, AppState>,
  target: &TargetRef,
) -> Result<Box<dyn RemoteFs>, String> {
  match target {
    TargetRef::Docker {
      jump_tab_id,
      container,
      user,
    } => {
      let jump = get_jump_handle(state, *jump_tab_id)?;
      Ok(Box::new(DockerExecFs::new(
        jump,
        container.clone(),
        user.clone(),
      )))
    }
    TargetRef::Local { .. } => Ok(Box::new(crate::local_fs::LocalFs::new())),
    _ => {
      let sftp = build_sftp(app, state, target).await?;
      Ok(Box::new(SftpFs::new(sftp)))
    }
  }
}

/// SFTP-backed [`RemoteFs`] (main session, ProxyJump remote, or container sshd).
pub struct SftpFs {
  sftp: SftpSession,
}

impl SftpFs {
  pub fn new(sftp: SftpSession) -> Self {
    Self { sftp }
  }
}

#[async_trait::async_trait]
impl RemoteFs for SftpFs {
  async fn list_dir(&self, path: &str) -> Result<Vec<FileEntry>, String> {
    let entries = self
      .sftp
      .read_dir(path)
      .await
      .map_err(|e| format!("Failed to list directory: {}", e))?;

    let mut files: Vec<FileEntry> = Vec::new();
    for entry in entries {
      let name = entry.file_name();
      let metadata = entry.metadata();
      let is_dir = metadata.is_dir();
      let full_path = if path.ends_with('/') {
        format!("{}{}", path, name)
      } else {
        format!("{}/{}", path, name)
      };
      files.push(FileEntry {
        name,
        path: full_path,
        is_dir,
        size: metadata.size.unwrap_or(0),
        mode: format!("{:o}", metadata.permissions.unwrap_or(0)),
        modified: fmt_mtime(metadata.modified()),
      });
    }
    files.sort_by(|a, b| {
      b.is_dir
        .cmp(&a.is_dir)
        .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(files)
  }

  async fn metadata(&self, path: &str) -> Result<FileMeta, String> {
    let m = self
      .sftp
      .metadata(path)
      .await
      .map_err(|e| format!("Failed to stat remote path: {}", e))?;
    Ok(FileMeta {
      path: path.to_string(),
      is_dir: m.is_dir(),
      size: m.size.unwrap_or(0),
      mode: format!("{:o}", m.permissions.unwrap_or(0)),
      modified: fmt_mtime(m.modified()),
    })
  }

  async fn read_file(&self, path: &str) -> Result<Vec<u8>, String> {
    let mut file = self
      .sftp
      .open(path)
      .await
      .map_err(|e| format!("Failed to open remote file: {}", e))?;
    let mut data = Vec::new();
    let mut buf = vec![0u8; 65536];
    loop {
      let n = file
        .read(&mut buf)
        .await
        .map_err(|e| format!("Failed to read: {}", e))?;
      if n == 0 {
        break;
      }
      data.extend_from_slice(&buf[..n]);
    }
    Ok(data)
  }

  async fn write_file(&self, path: &str, data: &[u8]) -> Result<(), String> {
    let mut file = self
      .sftp
      .create(path)
      .await
      .map_err(|e| format!("Failed to create remote file '{}': {}", path, e))?;
    file
      .write_all(data)
      .await
      .map_err(|e| format!("Failed to write to '{}': {}", path, e))?;
    Ok(())
  }

  async fn create_dir(&self, path: &str) -> Result<(), String> {
    self
      .sftp
      .create_dir(path)
      .await
      .map_err(|e| format!("Failed to create directory: {}", e))?;
    Ok(())
  }

  async fn rename(&self, from: &str, to: &str) -> Result<(), String> {
    self
      .sftp
      .rename(from, to)
      .await
      .map_err(|e| format!("Failed to rename: {}", e))?;
    Ok(())
  }

  async fn remove_file(&self, path: &str) -> Result<(), String> {
    self
      .sftp
      .remove_file(path)
      .await
      .map_err(|e| format!("Failed to delete file: {}", e))?;
    Ok(())
  }

  async fn remove_dir(&self, path: &str) -> Result<(), String> {
    self
      .sftp
      .remove_dir(path)
      .await
      .map_err(|e| format!("Failed to delete directory: {}", e))?;
    Ok(())
  }
}

use crate::ssh_session::DirDownloadSummary;
use std::path::Path;

/// Recursively delete a directory (and all its contents) through a `RemoteFs`.
/// Symlinks are removed as files (never followed), so cycles are impossible.
/// `on_progress` is called after each file is removed with
/// (done_files, total_files, done_bytes, total_bytes); totals come from a
/// preliminary count walk so callers can render a percentage. Returning an
/// `Err` from the callback aborts the deletion (e.g. user cancel).
pub async fn delete_dir_recursive(
  fs: &dyn RemoteFs,
  path: &str,
  on_progress: &mut (dyn FnMut(u64, u64, u64, u64) -> Result<(), String> + Send),
) -> Result<(), String> {
  // Pre-count files/bytes so progress can show a percentage.
  let mut total_files = 0u64;
  let mut total_bytes = 0u64;
  count_dir_entries(fs, path, &mut total_files, &mut total_bytes).await?;

  let mut done_files = 0u64;
  let mut done_bytes = 0u64;
  delete_dir_inner(
    fs,
    path,
    &mut done_files,
    &mut done_bytes,
    total_files,
    total_bytes,
    on_progress,
  )
  .await?;
  Ok(())
}

/// Count files and total bytes under `path`, recursively. Matches the delete
/// semantics: every non-directory entry (including symlinks) is counted as a
/// file.
async fn count_dir_entries(
  fs: &dyn RemoteFs,
  path: &str,
  files: &mut u64,
  bytes: &mut u64,
) -> Result<(), String> {
  let entries = fs.list_dir(path).await?;
  for e in entries {
    if e.is_dir {
      Box::pin(count_dir_entries(fs, &e.path, files, bytes)).await?;
    } else {
      *files += 1;
      *bytes += e.size;
    }
  }
  Ok(())
}

async fn delete_dir_inner(
  fs: &dyn RemoteFs,
  path: &str,
  done_files: &mut u64,
  done_bytes: &mut u64,
  total_files: u64,
  total_bytes: u64,
  on_progress: &mut (dyn FnMut(u64, u64, u64, u64) -> Result<(), String> + Send),
) -> Result<(), String> {
  let entries = fs.list_dir(path).await?;
  for e in entries {
    if e.is_dir {
      Box::pin(delete_dir_inner(
        fs,
        &e.path,
        done_files,
        done_bytes,
        total_files,
        total_bytes,
        &mut *on_progress,
      ))
      .await?;
    } else {
      fs.remove_file(&e.path).await?;
      *done_files += 1;
      *done_bytes += e.size;
      on_progress(*done_files, total_files, *done_bytes, total_bytes)?;
    }
  }
  fs.remove_dir(path).await?;
  Ok(())
}

/// Recursively enumerate a remote directory tree into (absolute, relative) pairs.
/// `rel` is relative to `remote_root` ("" for the root itself). Symlink entries
/// are detected via `FileEntry.mode` (starts with `l`) and skipped so the walk
/// can never loop.
async fn collect_dir_tree(
  fs: &dyn RemoteFs,
  remote_root: &str,
  rel: &str,
  dirs: &mut Vec<String>,
  files: &mut Vec<(String, String, u64)>,
  skipped: &mut usize,
) -> Result<(), String> {
  let entries = fs.list_dir(remote_root).await?;
  for e in entries {
    // Symlink detection across backends: Docker `stat -c%A` yields `lrwxrwxrwx`,
    // SFTP yields an octal mode whose file-type bits are `0120...`, LocalFs uses
    // `d`/`-` prefixes (symlinks resolved by the OS, not distinguishable here).
    let is_symlink = e.mode.starts_with('l') || e.mode.starts_with("120");
    let child_rel = if rel.is_empty() {
      e.name.clone()
    } else {
      format!("{}/{}", rel, e.name)
    };
    if is_symlink {
      *skipped += 1;
      continue;
    }
    if e.is_dir {
      dirs.push(child_rel.clone());
      Box::pin(collect_dir_tree(fs, &e.path, &child_rel, dirs, files, skipped)).await?;
    } else {
      files.push((e.path, child_rel, e.size));
    }
  }
  Ok(())
}

/// Recursively download a remote directory into `local_root`, preserving the
/// relative structure. Calls `on_file` with (relative_path, transferred, total)
/// after each file completes. Symlinks are skipped (counted in the summary).
pub async fn download_dir_recursive(
  fs: &dyn RemoteFs,
  remote_root: &str,
  local_root: &str,
  mut on_file: impl FnMut(&str, u64, u64),
) -> Result<DirDownloadSummary, String> {
  let mut dirs = Vec::new();
  let mut files = Vec::new();
  let mut skipped = 0usize;
  collect_dir_tree(fs, remote_root, "", &mut dirs, &mut files, &mut skipped).await?;

  // Create all directories first (including the root), then stream files.
  let _ = tokio::fs::create_dir_all(local_root).await;
  for d in &dirs {
    let _ = tokio::fs::create_dir_all(Path::new(local_root).join(d)).await;
  }

  let total_files = files.len();
  let total_bytes: u64 = files.iter().map(|(_, _, s)| s).sum();
  let mut done_bytes = 0u64;
  let mut done_files = 0usize;

  for (remote_path, rel, size) in &files {
    let data = fs.read_file(remote_path).await?;
    let local = Path::new(local_root).join(rel);
    if let Some(parent) = local.parent() {
      let _ = tokio::fs::create_dir_all(parent).await;
    }
    tokio::fs::write(&local, &data).await.map_err(|e| e.to_string())?;
    done_bytes += size;
    done_files += 1;
    on_file(rel, *size, *size);
  }

  Ok(DirDownloadSummary {
    total_files,
    done_files,
    total_bytes,
    done_bytes,
    skipped,
  })
}

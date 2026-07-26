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
    .map_err(|e| format!("Failed to open direct-tcpip channel to {}:{}: {}", host, port, e))?;
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
  let session = sessions.get(&jump_tab_id).ok_or("Jump host session not found")?;
  session
    .session_handle
    .clone()
    .ok_or_else(|| "Jump host handle not available (still connecting?)".to_string())
}

/// Build the [`RemoteFs`] implementation for a target.
pub async fn build_fs(
  app: &tauri::AppHandle,
  state: &tauri::State<'_, AppState>,
  target: &TargetRef,
) -> Result<Box<dyn RemoteFs>, String> {
  match target {
    TargetRef::Session { tab_id } => {
      let sftp = open_session_sftp(state, app, *tab_id).await?;
      Ok(Box::new(SftpFs::new(sftp)))
    }
    TargetRef::JumpRemote { jump_tab_id, host, port, auth }
    | TargetRef::DockerSsh { jump_tab_id, host, port, auth } => {
      let jump = get_jump_handle(state, *jump_tab_id)?;
      let sftp = open_jump_sftp(app, &jump, host, *port, auth, *jump_tab_id).await?;
      Ok(Box::new(SftpFs::new(sftp)))
    }
    TargetRef::Docker { jump_tab_id, container, user } => {
      let jump = get_jump_handle(state, *jump_tab_id)?;
      Ok(Box::new(DockerExecFs::new(jump, container.clone(), user.clone())))
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

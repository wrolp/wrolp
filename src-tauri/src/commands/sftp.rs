use super::*;
use russh_sftp::client::error::Error as SftpError;

// ==================== SFTP File Operations ====================

/// Bytes per upload read/write. Also the granularity of `transfer-progress`
/// ticks: a 4MB buffer only reported every 4MB, so a small file produced a
/// single tick at 100% and a slow link looked frozen. Matches the download
/// loop's 64KB so both transfers move at the same visible rate.
const UPLOAD_CHUNK_BYTES: usize = 64 * 1024;

/// Whether the destination already existed before an upload created it.
///
/// A cancelled upload must not delete a pre-existing file: `create()` truncates
/// it, so removing it afterwards would destroy the user's original data. The
/// partial content is left behind in that case, which is the lesser evil.
pub(crate) async fn destination_existed(
  sftp: &russh_sftp::client::SftpSession,
  path: &str,
) -> bool {
  sftp.metadata(path).await.is_ok()
}

/// Whether an aborted upload may delete its destination.
///
/// Only files this upload created are safe to remove. Pure so the rule is
/// unit-tested without an SFTP server.
pub(crate) fn may_discard_partial(existed_before: bool) -> bool {
  !existed_before
}

/// Delete a half-written file left by a failed or cancelled upload, but only if
/// the upload created it. Errors are ignored: the original failure is what the
/// UI needs to hear about, and a server that refuses the delete must not turn a
/// cancel into a confusing second error.
pub(crate) async fn discard_partial_upload(
  sftp: &russh_sftp::client::SftpSession,
  path: &str,
  existed_before: bool,
) {
  if !may_discard_partial(existed_before) {
    return;
  }
  let _ = sftp.remove_file(path).await;
}

/// Helper: establish a fresh SFTP connection for a tab's main session.
/// Delegates to the shared implementation in `remote_fs`.
pub(crate) async fn open_sftp_session(
  state: &tauri::State<'_, AppState>,
  app: &tauri::AppHandle,
  tab_id: u32,
) -> Result<russh_sftp::client::SftpSession, String> {
  crate::remote_fs::open_session_sftp(state, app, tab_id).await
}

/// Poll the remote working directory via a dedicated exec channel.
///
/// Opens a fresh SSH connection (like SFTP operations do) so it never
/// interferes with the interactive PTY. Used by the SFTP ↔ Shell sync feature
/// to keep the file panel in step with `cd` commands typed in the terminal.
#[tauri::command]
pub async fn poll_working_dir(
  app: tauri::AppHandle,
  state: tauri::State<'_, AppState>,
  tab_id: u32,
) -> Result<Option<String>, String> {
  // Reuse the tab's live SSH connection (an exec channel on the existing
  // handle) instead of opening a fresh connection + auth handshake every call.
  // The shell-sync feature polls every 5s and the `ls` capture runs it per
  // command, so a fresh handshake each time is the dominant cost. Falls back
  // to a fresh connection only if the live handle is unavailable.
  let handle = {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    sessions.get(&tab_id).and_then(|s| s.session_handle.clone())
  };

  let path = if let Some(h) = handle {
    if h.is_closed() {
      return Err("Session connection is closed".into());
    }
    crate::host_analysis::exec_on_handle(&h, "pwd").await?
  } else {
    // No live handle (e.g. session not fully connected): fall back to the
    // previous fresh-connection behaviour.
    let config = {
      let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
      sessions
        .get(&tab_id)
        .ok_or("Session not found")?
        .config
        .clone()
    };

    let ssh_config = Arc::new(client::Config::default());
    let handler = SshHandler {
      app_handle: app.clone(),
      tab_id,
      // Auxiliary connection: not the tab's interactive session.
      session_id: None,
      is_sftp: true,
      // No device record here: this per-operation SFTP connection reuses the host
      // the interactive session already identified (see `SshHandler::host_key`).
      host_key: None,
      shell_channel_id: None,
      sftp_close_notify: None,
      utf8_tail_out: Vec::new(),
      utf8_tail_err: Vec::new(),
    };

    let mut handle = client::connect(ssh_config, (config.host.as_str(), config.port), handler)
      .await
      .map_err(|e| format!("Connect failed: {}", e))?;

    // Authenticate (reuse original config credentials — cwd should reflect the
    // logged-in user, not a switched SFTP user)
    if let Some(ref pw) = config.password {
      if !handle
        .authenticate_password(&config.username, pw)
        .await
        .map_err(|e| format!("Auth error: {}", e))?
        .success()
      {
        return Err("Authentication failed".into());
      }
    } else if let Some(ref key_path) = config.key_path {
      let resolved = expand_tilde(key_path);
      let key = load_secret_key(&resolved, config.passphrase.as_deref())
        .map_err(|e| format!("Failed to load key: {}", e))?;
      if !handle
        .authenticate_publickey(
          &config.username,
          PrivateKeyWithHashAlg::new(Arc::new(key), None),
        )
        .await
        .map_err(|e| format!("Key auth error: {}", e))?
        .success()
      {
        return Err("Key authentication failed".into());
      }
    } else {
      return Err("No credentials provided".into());
    }

    // Open a channel and exec `pwd`
    let mut channel = handle
      .channel_open_session()
      .await
      .map_err(|e| format!("Failed to open channel: {}", e))?;

    channel
      .exec(true, "pwd")
      .await
      .map_err(|e| format!("Failed to exec pwd: {}", e))?;

    let mut output = String::new();
    while let Some(msg) = channel.wait().await {
      match msg {
        russh::ChannelMsg::Data { data } => {
          output.push_str(&String::from_utf8_lossy(&data));
        }
        russh::ChannelMsg::ExitStatus { .. }
        | russh::ChannelMsg::Eof
        | russh::ChannelMsg::Close => {
          break;
        }
        _ => {}
      }
    }

    // Let the handle drop gracefully in the background
    tauri::async_runtime::spawn(async move {
      let _h = handle;
    });

    output
  };

  let path = path.trim();
  if path.is_empty() {
    Ok(None)
  } else {
    Ok(Some(path.to_string()))
  }
}

#[tauri::command]
pub async fn list_files(
  app: tauri::AppHandle,
  state: tauri::State<'_, AppState>,
  tab_id: u32,
  path: String,
) -> Result<Vec<FileEntry>, String> {
  let sftp = open_sftp_session(&state, &app, tab_id).await?;

  let entries = sftp
    .read_dir(&path)
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
    let modified = metadata
      .modified()
      .map(|t| {
        t.duration_since(std::time::UNIX_EPOCH)
          .map(|d| d.as_secs().to_string())
          .unwrap_or_default()
      })
      .unwrap_or_default();
    files.push(FileEntry {
      name,
      path: full_path,
      is_dir,
      size: metadata.size.unwrap_or(0),
      mode: format!("{:o}", metadata.permissions.unwrap_or(0)),
      modified,
    });
  }

  // Sort: directories first, then alphabetical
  files.sort_by(|a, b| {
    b.is_dir
      .cmp(&a.is_dir)
      .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
  });

  Ok(files)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
  pub path: String,
  pub content: String,
  pub size: u64,
  pub mode: String,
  pub is_binary: bool,
  pub is_too_large: bool,
  /// Charset used to decode the file, e.g. "utf-8" or "gbk".
  pub encoding: String,
  /// True when the file was not valid UTF-8 (e.g. GBK) and must be
  /// re-saved with `encoding` to avoid corrupting it.
  pub needs_encoding: bool,
  /// For binary files only: the raw file bytes as Base64, so the frontend can
  /// render a hex dump. `None` for text files.
  pub hex_base64: Option<String>,
  /// For image files only: the MIME type (e.g. "image/png"), so the frontend
  /// can preview the file directly. `None` otherwise.
  pub image_mime: Option<String>,
}

/// Decode raw bytes into a String using the requested encoding, or auto-detect
/// (UTF-8 first, then GBK) when `encoding_name` is `None`.
/// Returns (content, encoding_name, needs_encoding).
/// Detect common image formats from the leading magic bytes. Returns the MIME
/// type (e.g. "image/png") or `None` for non-image data.
/// `is_binary`/`is_too_large` let the frontend refuse non-text or oversized files.
#[tauri::command]
pub async fn read_file_content(
  app: tauri::AppHandle,
  state: tauri::State<'_, AppState>,
  tab_id: u32,
  path: String,
  max_size: Option<u64>,
  encoding: Option<String>,
) -> Result<FileContent, String> {
  let max_size = max_size.unwrap_or(DEFAULT_MAX_EDIT_SIZE);
  let sftp = open_sftp_session(&state, &app, tab_id).await?;

  let metadata = sftp
    .metadata(&path)
    .await
    .map_err(|e| format!("Failed to stat remote file: {}", e))?;
  let size = metadata.size.unwrap_or(0);
  let mode = format!("{:04o}", metadata.permissions.unwrap_or(0) & 0o7777);

  if size > max_size {
    return Ok(FileContent {
      path,
      content: String::new(),
      size,
      mode,
      is_binary: false,
      is_too_large: true,
      encoding: encoding.unwrap_or_else(|| "utf-8".to_string()),
      needs_encoding: false,
      hex_base64: None,
      image_mime: None,
    });
  }

  let mut handle = sftp
    .open(&path)
    .await
    .map_err(|e| format!("Failed to open remote file: {}", e))?;
  let mut all_data = Vec::with_capacity(size as usize);
  let mut buf = vec![0u8; 65536];
  loop {
    let n = handle
      .read(&mut buf)
      .await
      .map_err(|e| format!("Failed to read: {}", e))?;
    if n == 0 {
      break;
    }
    all_data.extend_from_slice(&buf[..n]);
  }

  // NUL byte => treat as binary (not editable as text).
  // Invalid UTF-8 alone is no longer binary (it may be GBK and decodable).
  let is_binary = all_data.contains(&0);
  let (content, used_encoding, needs_encoding) = if is_binary {
    (
      String::new(),
      encoding.clone().unwrap_or_else(|| "utf-8".to_string()),
      false,
    )
  } else {
    decode_file_content(&all_data, encoding.as_deref())
  };
  let hex_base64 = if is_binary {
    use base64::Engine;
    Some(base64::engine::general_purpose::STANDARD.encode(&all_data))
  } else {
    None
  };
  let image_mime = if is_binary {
    image_mime_of(&all_data, &path)
  } else {
    None
  };

  Ok(FileContent {
    path,
    content,
    size,
    mode,
    is_binary,
    is_too_large: false,
    encoding: used_encoding,
    needs_encoding,
    hex_base64,
    image_mime,
  })
}

/// Write edited text content back to a remote file, overwriting the original.
/// The parent directory is created if it does not exist.
/// `encoding` selects the charset used to serialize the text (defaults to UTF-8).
#[tauri::command]
pub async fn write_file_content(
  app: tauri::AppHandle,
  state: tauri::State<'_, AppState>,
  tab_id: u32,
  path: String,
  content: String,
  encoding: Option<String>,
) -> Result<bool, String> {
  let sftp = open_sftp_session(&state, &app, tab_id).await?;

  // Serialize text using the requested charset (default UTF-8).
  let encoding_ref: &Encoding =
    Encoding::for_label(encoding.as_deref().unwrap_or("utf-8").as_bytes()).unwrap_or(UTF_8);
  let (bytes, _used_encoding, had_errors) = encoding_ref.encode(&content);
  if had_errors {
    return Err(format!(
      "Content cannot be encoded as {}",
      encoding_ref.name()
    ));
  }
  let bytes = bytes.into_owned();
  let resolved_path = resolve_sftp_path(&sftp, &path).await?;

  // Ensure parent directory exists on remote
  if let Some(parent) = std::path::Path::new(&resolved_path).parent() {
    let parent_str = parent.to_string_lossy().to_string();
    if !parent_str.is_empty() && parent_str != "/" {
      match sftp.metadata(&parent_str).await {
        Err(_) => {
          let parts: Vec<&str> = parent_str.trim_start_matches('/').split('/').collect();
          let mut build = String::new();
          for part in &parts {
            if part.is_empty() {
              continue;
            }
            build.push('/');
            build.push_str(part);
            let _ = sftp.create_dir(&build).await;
          }
        }
        Ok(_) => {}
      }
    }
  }

  let mut file = sftp
    .create(&resolved_path)
    .await
    .map_err(|e| format!("Failed to create remote file '{}': {}", resolved_path, e))?;
  use tokio::io::AsyncWriteExt;
  file
    .write_all(&bytes)
    .await
    .map_err(|e| format!("Failed to write data to '{}': {}", resolved_path, e))?;

  Ok(true)
}

/// Consecutive failed attempts tolerated before a download gives up. The count
/// restarts whenever an attempt moved at least one byte, so a long transfer on
/// a link that drops every few minutes is not cut off by its Nth drop overall.
const DOWNLOAD_MAX_CONSECUTIVE_FAILURES: u32 = 3;
/// Hard ceiling on attempts for one download. Only a link that keeps flapping
/// mid-transfer can reach it, since each progress-making attempt resets the
/// consecutive-failure count.
const DOWNLOAD_MAX_ATTEMPTS: u32 = 25;
const DOWNLOAD_RETRY_BASE_DELAY: std::time::Duration = std::time::Duration::from_millis(600);

/// Why one download attempt stopped before EOF.
enum CopyError {
  /// The user cancelled — never retried.
  Cancelled,
  /// The connection (or the server's answer over it) failed in a way a fresh
  /// SSH connection may fix: `Failed to read: Timeout` is the classic one,
  /// caused by a sleeping laptop, a Wi-Fi switch or a NAT idle-drop.
  Retry(String),
  /// Anything a retry cannot fix: the remote file is gone, its permissions
  /// changed, the local disk is full… Surfaced to the UI unchanged.
  Fatal(String),
}

/// A transport-level SFTP client error (as opposed to the server answering
/// "no" via a status packet) is worth another connection.
fn is_retryable_sftp_error(e: &SftpError) -> bool {
  matches!(
    e,
    SftpError::Timeout
      | SftpError::IO(_)
      | SftpError::UnexpectedPacket
      | SftpError::UnexpectedBehavior(_)
  )
}

fn classify_client_error(e: SftpError, context: &str) -> CopyError {
  let msg = format!("{}: {}", context, e);
  if is_retryable_sftp_error(&e) {
    CopyError::Retry(msg)
  } else {
    CopyError::Fatal(msg)
  }
}

/// `File::read` reports through `std::io::Error`, which wraps the SFTP client
/// error; unwrap it so "Timeout" and "connection reset" stay retryable while
/// protocol statuses (no such file, permission denied) do not.
fn classify_read_error(e: std::io::Error, context: &str) -> CopyError {
  if let Some(inner) = e.get_ref().and_then(|i| i.downcast_ref::<SftpError>()) {
    return classify_client_error(inner.clone(), context);
  }
  let retryable = matches!(
    e.kind(),
    std::io::ErrorKind::TimedOut
      | std::io::ErrorKind::Interrupted
      | std::io::ErrorKind::ConnectionReset
      | std::io::ErrorKind::ConnectionAborted
      | std::io::ErrorKind::BrokenPipe
      | std::io::ErrorKind::UnexpectedEof
      | std::io::ErrorKind::NotConnected
  );
  let msg = format!("{}: {}", context, e);
  if retryable {
    CopyError::Retry(msg)
  } else {
    CopyError::Fatal(msg)
  }
}

/// Decide what a failed attempt means: `Ok(delay)` = reconnect after `delay`,
/// `Err(message)` = surface the failure to the UI. `progressed` says whether
/// the attempt moved at least one byte before failing.
fn retry_or_give_up(
  err: CopyError,
  progressed: bool,
  consecutive_failures: &mut u32,
  attempts: u32,
) -> Result<std::time::Duration, String> {
  match err {
    CopyError::Cancelled => Err("Transfer cancelled".to_string()),
    CopyError::Fatal(msg) => Err(msg),
    CopyError::Retry(msg) => {
      *consecutive_failures = if progressed {
        1
      } else {
        *consecutive_failures + 1
      };
      if *consecutive_failures > DOWNLOAD_MAX_CONSECUTIVE_FAILURES
        || attempts >= DOWNLOAD_MAX_ATTEMPTS
      {
        return Err(format!("{} (gave up after {} attempts)", msg, attempts));
      }
      Ok(DOWNLOAD_RETRY_BASE_DELAY * 2u32.pow(*consecutive_failures - 1))
    }
  }
}

/// Copy `remote_path` into `out` from `*offset` to EOF, reporting the running
/// byte count through `on_progress`. Remote and local sides are both seeked to
/// `*offset` first, so calling this again after a reconnect resumes where the
/// last attempt stopped instead of restarting the transfer.
async fn copy_remote_into_local<F: FnMut(u64)>(
  sftp: &russh_sftp::client::SftpSession,
  remote_path: &str,
  out: &mut tokio::fs::File,
  offset: &mut u64,
  control: &TransferControl,
  local_path: &str,
  mut on_progress: F,
) -> Result<(), CopyError> {
  use tokio::io::{AsyncSeekExt, SeekFrom};

  let mut remote = sftp.open(remote_path).await.map_err(|e| {
    classify_client_error(e, &format!("Failed to open remote file '{}'", remote_path))
  })?;
  remote.seek(SeekFrom::Start(*offset)).await.map_err(|e| {
    classify_read_error(e, &format!("Failed to seek remote file '{}'", remote_path))
  })?;
  out
    .seek(SeekFrom::Start(*offset))
    .await
    .map_err(|e| CopyError::Fatal(format!("Failed to seek local file '{}': {}", local_path, e)))?;

  let mut buf = vec![0u8; 65536];
  loop {
    // Blocks while paused; only returns an error once the user cancels.
    check_pause(control)
      .await
      .map_err(|_| CopyError::Cancelled)?;
    match remote.read(&mut buf).await {
      Ok(0) => return Ok(()),
      Ok(n) => {
        out.write_all(&buf[..n]).await.map_err(|e| {
          CopyError::Fatal(format!(
            "Failed to write local file '{}': {}",
            local_path, e
          ))
        })?;
        *offset += n as u64;
        on_progress(*offset);
      }
      Err(e) => {
        return Err(classify_read_error(
          e,
          &format!("Failed to read '{}'", remote_path),
        ))
      }
    }
  }
}

#[tauri::command]
pub async fn download_file(
  app: tauri::AppHandle,
  state: tauri::State<'_, AppState>,
  tab_id: u32,
  remote_path: String,
  local_path: String,
) -> Result<bool, String> {
  // Set up pause control
  let control = Arc::new(TransferControl {
    paused: AtomicBool::new(false),
    cancelled: AtomicBool::new(false),
    notify: tokio::sync::Notify::new(),
  });
  {
    let mut controls = state.transfer_controls.lock().map_err(|e| e.to_string())?;
    controls.entry(tab_id).or_default().push(control.clone());
  }
  // Clean up control on exit
  let _cleanup = TransferGuard::new(&state, tab_id, control.clone());

  let filename = std::path::Path::new(&remote_path)
    .file_name()
    .map(|n| n.to_string_lossy().to_string())
    .unwrap_or_else(|| remote_path.clone());

  // Stream straight to disk rather than into a `Vec<u8>`: buffering the whole
  // file (and the accompanying `total as usize`) meant a multi-GB download had
  // to fit twice in memory and could overflow a 32-bit usize. Created once and
  // never re-truncated between attempts: a retry appends from the offset the
  // previous attempt reached.
  if let Some(parent) = std::path::Path::new(&local_path).parent() {
    let _ = tokio::fs::create_dir_all(parent).await;
  }
  let mut out = tokio::fs::File::create(&local_path)
    .await
    .map_err(|e| format!("Failed to create local file '{}': {}", local_path, e))?;

  let start = std::time::Instant::now();
  let mut offset: u64 = 0;
  // Identity of the remote file from the first attempt. A reconnect that
  // reports a different size or mtime means the file changed while we were
  // away: the bytes on disk no longer belong to it, so the download restarts
  // from zero rather than splicing two versions together.
  let mut stamp: Option<(u64, Option<u32>)> = None;
  let mut consecutive_failures = 0u32;
  let mut attempts = 0u32;

  loop {
    attempts += 1;
    // A pause entered before the retry parks here; a cancel aborts.
    check_pause(&control).await?;
    let offset_before = offset;

    let attempt: Result<(), CopyError> = async {
      let sftp = open_sftp_session(&state, &app, tab_id)
        .await
        .map_err(CopyError::Retry)?;
      let metadata = sftp
        .metadata(&remote_path)
        .await
        .map_err(|e| classify_client_error(e, "Failed to stat remote file"))?;
      let size = metadata.size.unwrap_or(0);
      let this_stamp = (size, metadata.mtime);
      if stamp.is_some_and(|prev| prev != this_stamp || size < offset) {
        offset = 0;
        out.set_len(0).await.map_err(|e| {
          CopyError::Fatal(format!(
            "Failed to reset local file '{}': {}",
            local_path, e
          ))
        })?;
      }
      stamp = Some(this_stamp);

      copy_remote_into_local(
        &sftp,
        &remote_path,
        &mut out,
        &mut offset,
        &control,
        &local_path,
        |transferred| {
          let _ = app.emit(
            "transfer-progress",
            serde_json::json!({
              "tabId": tab_id,
              "op": "download",
              "filename": &filename,
              "transferred": transferred,
              "total": size,
              "elapsed": start.elapsed().as_millis()
            }),
          );
        },
      )
      .await
    }
    .await;

    match attempt {
      Ok(()) => {
        out
          .flush()
          .await
          .map_err(|e| format!("Failed to flush local file '{}': {}", local_path, e))?;
        return Ok(true);
      }
      Err(err) => {
        let delay = retry_or_give_up(
          err,
          offset > offset_before,
          &mut consecutive_failures,
          attempts,
        )?;
        tokio::time::sleep(delay).await;
      }
    }
  }
}

/// Accept exactly one path component coming from a remote SFTP server.
///
/// Directory listings are server-controlled, so a hostile (or compromised)
/// server can return names like `../../evil` or `C:\Windows\x`. Anything that
/// could escape the chosen local folder, or that Windows would silently rewrite
/// (reserved device names, ADS `:`), is rejected instead of joined into a path.
fn sanitize_relative_name(name: &str) -> Option<String> {
  if name.is_empty() || name == "." || name == ".." {
    return None;
  }
  if name.contains('/') || name.contains('\\') || name.contains(':') {
    return None;
  }
  if name.chars().any(|c| c == '\0' || (c as u32) < 0x20) {
    return None;
  }
  // Windows strips trailing dots/spaces (so `a.` and `a` collide) and treats
  // these stems as devices regardless of extension (`aux.txt` is still AUX).
  if name.ends_with(' ') || name.ends_with('.') {
    return None;
  }
  const RESERVED: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
  ];
  let stem = name.split('.').next().unwrap_or("");
  if RESERVED.iter().any(|r| stem.eq_ignore_ascii_case(r)) {
    return None;
  }
  Some(name.to_string())
}

/// Recursively walk a remote directory over a single SFTP session, collecting
/// (absolute_path, relative_path, size) for files and the relative paths of all
/// directories. Symlinks are skipped so the walk cannot loop. Entries whose
/// names fail [`sanitize_relative_name`] are skipped (and counted) as well, so
/// every collected `rel` is a safe single-segment path.
async fn walk_sftp_dir(
  sftp: &russh_sftp::client::SftpSession,
  remote_root: &str,
  rel: &str,
  dirs: &mut Vec<String>,
  files: &mut Vec<(String, String, u64)>,
  skipped: &mut usize,
) -> Result<(), String> {
  let entries = sftp
    .read_dir(remote_root)
    .await
    .map_err(|e| format!("Failed to list remote directory '{}': {}", remote_root, e))?;
  for entry in entries {
    let raw_name = entry.file_name();
    let md = entry.metadata();
    if md.file_type().is_symlink() {
      *skipped += 1;
      continue;
    }
    let Some(name) = sanitize_relative_name(&raw_name) else {
      eprintln!(
        "[sftp] skipping unsafe remote entry name {:?} in {}",
        raw_name, remote_root
      );
      *skipped += 1;
      continue;
    };
    let child_abs = format!("{}/{}", remote_root.trim_end_matches('/'), name);
    let child_rel = if rel.is_empty() {
      name.clone()
    } else {
      format!("{}/{}", rel, name)
    };
    if md.is_dir() {
      dirs.push(child_rel.clone());
      Box::pin(walk_sftp_dir(
        sftp, &child_abs, &child_rel, dirs, files, skipped,
      ))
      .await?;
    } else {
      files.push((child_abs, child_rel, md.size.unwrap_or(0)));
    }
  }
  Ok(())
}

#[tauri::command]
pub async fn download_directory(
  app: tauri::AppHandle,
  state: tauri::State<'_, AppState>,
  tab_id: u32,
  remote_dir: String,
  local_dir: String,
) -> Result<DirDownloadSummary, String> {
  // Set up pause control
  let control = Arc::new(TransferControl {
    paused: AtomicBool::new(false),
    cancelled: AtomicBool::new(false),
    notify: tokio::sync::Notify::new(),
  });
  {
    let mut controls = state.transfer_controls.lock().map_err(|e| e.to_string())?;
    controls.entry(tab_id).or_default().push(control.clone());
  }
  let _cleanup = TransferGuard::new(&state, tab_id, control.clone());

  let mut sftp = open_sftp_session(&state, &app, tab_id).await?;

  // Single-session recursive walk (no per-file reconnects).
  let mut dirs = Vec::new();
  let mut files = Vec::new();
  let mut skipped = 0usize;
  walk_sftp_dir(&sftp, &remote_dir, "", &mut dirs, &mut files, &mut skipped).await?;

  // The selected local folder is the *parent*: the downloaded directory keeps
  // its own name so the tree appears as `<local_dir>/<dir_name>/...`.
  let raw_dir_name = std::path::Path::new(&remote_dir)
    .file_name()
    .map(|n| n.to_string_lossy().to_string())
    .unwrap_or_else(|| {
      remote_dir
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or("download")
        .to_string()
    });
  let dir_name = sanitize_relative_name(&raw_dir_name).unwrap_or_else(|| "download".to_string());
  let local_root = std::path::Path::new(&local_dir).join(&dir_name);

  // Create local directory skeleton (root + all subdirs).
  let _ = tokio::fs::create_dir_all(&local_root).await;
  for d in &dirs {
    let _ = tokio::fs::create_dir_all(local_root.join(d)).await;
  }

  let total_files = files.len();
  let total_bytes: u64 = files.iter().map(|(_, _, s)| s).sum();
  let mut done_bytes = 0u64;
  let mut done_files = 0usize;
  let start = std::time::Instant::now();

  for (remote_path, rel, size) in &files {
    check_pause(&control).await?;

    let local_path = local_root.join(rel);
    if let Some(parent) = local_path.parent() {
      let _ = tokio::fs::create_dir_all(parent).await;
    }
    let mut out = tokio::fs::File::create(&local_path).await.map_err(|e| {
      format!(
        "Failed to create local file '{}': {}",
        local_path.display(),
        e
      )
    })?;

    let local_label = local_path.display().to_string();
    let mut offset = 0u64;
    let mut consecutive_failures = 0u32;
    let mut attempts = 0u32;
    // Set by a failed attempt so the next pass reconnects before reopening the
    // remote file — the walk is already done, only the connection is lost.
    let mut needs_reconnect = false;
    loop {
      attempts += 1;
      check_pause(&control).await?;
      if needs_reconnect {
        match open_sftp_session(&state, &app, tab_id).await {
          Ok(fresh) => sftp = fresh,
          Err(e) => {
            let delay = retry_or_give_up(
              CopyError::Retry(e),
              false,
              &mut consecutive_failures,
              attempts,
            )?;
            tokio::time::sleep(delay).await;
            continue;
          }
        }
      }
      let offset_before = offset;
      let base_bytes = done_bytes;
      let result = copy_remote_into_local(
        &sftp,
        remote_path,
        &mut out,
        &mut offset,
        &control,
        &local_label,
        |transferred| {
          let _ = app.emit(
            "transfer-progress",
            serde_json::json!({
              "tabId": tab_id,
              "op": "directory",
              "dirName": dir_name,
              "filename": rel,
              "relativePath": rel,
              "transferred": transferred,
              "total": size,
              "doneFiles": done_files,
              "totalFiles": total_files,
              "doneBytes": base_bytes + transferred,
              "totalBytes": total_bytes,
              "elapsed": start.elapsed().as_millis()
            }),
          );
        },
      )
      .await;
      match result {
        Ok(()) => break,
        Err(err) => {
          needs_reconnect = matches!(err, CopyError::Retry(_));
          let delay = retry_or_give_up(
            err,
            offset > offset_before,
            &mut consecutive_failures,
            attempts,
          )?;
          tokio::time::sleep(delay).await;
        }
      }
    }
    done_bytes += offset;
    done_files += 1;
  }

  Ok(DirDownloadSummary {
    total_files,
    done_files,
    total_bytes,
    done_bytes,
    skipped,
  })
}

#[tauri::command]
pub async fn upload_file(
  app: tauri::AppHandle,
  state: tauri::State<'_, AppState>,
  tab_id: u32,
  local_path: String,
  remote_path: String,
) -> Result<bool, String> {
  // Set up pause control
  let control = Arc::new(TransferControl {
    paused: AtomicBool::new(false),
    cancelled: AtomicBool::new(false),
    notify: tokio::sync::Notify::new(),
  });
  {
    let mut controls = state.transfer_controls.lock().map_err(|e| e.to_string())?;
    controls.entry(tab_id).or_default().push(control.clone());
  }
  let _cleanup = TransferGuard::new(&state, tab_id, control.clone());

  let sftp = open_sftp_session(&state, &app, tab_id).await?;

  let filename = std::path::Path::new(&remote_path)
    .file_name()
    .map(|n| n.to_string_lossy().to_string())
    .unwrap_or_else(|| remote_path.clone());

  // Resolve relative paths to absolute paths
  let resolved_path = resolve_sftp_path(&sftp, &remote_path).await?;

  // Open the local file and stream it in 64KB chunks — a large file is never
  // fully buffered in memory (previously `tokio::fs::read` loaded it whole,
  // which OOMs / hangs on multi-GB uploads).
  let mut local = tokio::fs::File::open(&local_path)
    .await
    .map_err(|e| format!("Failed to open local file: {}", e))?;
  let total = local
    .metadata()
    .await
    .map_err(|e| format!("Failed to stat local file: {}", e))?
    .len();

  // Ensure parent directory exists on remote (using mkdir -p via SFTP)
  ensure_parent_dir(&sftp, &resolved_path).await?;

  // Write in chunks with progress
  let existed_before = destination_existed(&sftp, &resolved_path).await;
  let mut file = sftp
    .create(&resolved_path)
    .await
    .map_err(|e| format!("Failed to create remote file '{}': {}", resolved_path, e))?;

  let start = std::time::Instant::now();
  let chunk_size: usize = UPLOAD_CHUNK_BYTES;
  let mut buf = vec![0u8; chunk_size];
  let mut written: u64 = 0;

  let write = async {
    loop {
      check_pause(&control).await?;
      let n = local
        .read(&mut buf)
        .await
        .map_err(|e| format!("Failed to read local file: {}", e))?;
      if n == 0 {
        break;
      }
      file
        .write_all(&buf[..n])
        .await
        .map_err(|e| format!("Failed to write data to '{}': {}", resolved_path, e))?;
      written += n as u64;

      let elapsed = start.elapsed().as_millis();
      let _ = app.emit(
        "transfer-progress",
        serde_json::json!({
          "tabId": tab_id,
          "op": "upload",
          "filename": &filename,
          "transferred": written,
          "total": total,
          "elapsed": elapsed
        }),
      );
    }
    Ok::<(), String>(())
  }
  .await;

  let _ = file.close().await;
  if let Err(e) = write {
    // Cancel and write failures both leave a truncated file behind. Close the
    // handle first, then remove it so the remote directory does not fill up
    // with unusable halves (a pre-existing destination is preserved).
    discard_partial_upload(&sftp, &resolved_path, existed_before).await;
    return Err(e);
  }

  Ok(true)
}

/// Resolve SFTP path: convert relative paths (., ~, etc.) to absolute paths
pub(crate) async fn resolve_sftp_path(
  sftp: &russh_sftp::client::SftpSession,
  path: &str,
) -> Result<String, String> {
  // If path starts with /, it's already absolute
  if path.starts_with('/') {
    return Ok(path.to_string());
  }

  // Try to get real path of . (current working directory)
  let cwd = sftp
    .canonicalize(".")
    .await
    .unwrap_or_else(|_| "/".to_string());

  // Handle . or empty
  if path == "." || path.is_empty() {
    return Ok(cwd);
  }

  let clean_path = path.trim_start_matches('.').trim_start_matches('/');
  if clean_path.is_empty() {
    return Ok(cwd);
  }

  let result = format!("{}/{}", cwd.trim_end_matches('/'), clean_path);
  println!("[resolve_sftp_path] '{}' -> '{}'", path, result);

  Ok(result)
}

/// Recursively create the parent directory of `resolved_path` on the remote
/// (SFTP `mkdir -p`, best-effort: "already exists" errors are ignored).
pub(crate) async fn ensure_parent_dir(
  sftp: &russh_sftp::client::SftpSession,
  resolved_path: &str,
) -> Result<(), String> {
  if let Some(parent) = std::path::Path::new(resolved_path).parent() {
    let parent_str = parent.to_string_lossy().to_string();
    if !parent_str.is_empty() && parent_str != "/" {
      match sftp.metadata(&parent_str).await {
        Err(_) => {
          let _ = sftp.create_dir(&parent_str).await;
          let parts: Vec<&str> = parent_str.trim_start_matches('/').split('/').collect();
          let mut build = String::new();
          for part in &parts {
            if part.is_empty() {
              continue;
            }
            build.push('/');
            build.push_str(part);
            let _ = sftp.create_dir(&build).await;
          }
        }
        Ok(_) => {}
      }
    }
  }
  Ok(())
}

/// Upload file content as raw bytes (for HTML5 drag-drop where we have File data, not paths)
#[tauri::command]
pub async fn upload_file_bytes(
  app: tauri::AppHandle,
  state: tauri::State<'_, AppState>,
  tab_id: u32,
  remote_path: String,
  file_data: Vec<u8>,
) -> Result<bool, String> {
  // Set up pause control
  let control = Arc::new(TransferControl {
    paused: AtomicBool::new(false),
    cancelled: AtomicBool::new(false),
    notify: tokio::sync::Notify::new(),
  });
  {
    let mut controls = state.transfer_controls.lock().map_err(|e| e.to_string())?;
    controls.entry(tab_id).or_default().push(control.clone());
  }
  let _cleanup = TransferGuard::new(&state, tab_id, control.clone());

  let sftp = open_sftp_session(&state, &app, tab_id).await?;

  let filename = std::path::Path::new(&remote_path)
    .file_name()
    .map(|n| n.to_string_lossy().to_string())
    .unwrap_or_else(|| remote_path.clone());

  let total = file_data.len() as u64;

  // Resolve relative paths to absolute paths
  let resolved_path = resolve_sftp_path(&sftp, &remote_path).await?;

  // Ensure parent directory exists on remote
  ensure_parent_dir(&sftp, &resolved_path).await?;

  // Write in chunks with progress
  let existed_before = destination_existed(&sftp, &resolved_path).await;
  let mut file = sftp
    .create(&resolved_path)
    .await
    .map_err(|e| format!("Failed to create remote file '{}': {}", resolved_path, e))?;

  let start = std::time::Instant::now();
  let chunk_size: usize = UPLOAD_CHUNK_BYTES;
  let mut written: u64 = 0;

  let write = async {
    for chunk in file_data.chunks(chunk_size) {
      check_pause(&control).await?;
      file
        .write_all(chunk)
        .await
        .map_err(|e| format!("Failed to write data to '{}': {}", resolved_path, e))?;
      written += chunk.len() as u64;

      let elapsed = start.elapsed().as_millis();
      let _ = app.emit(
        "transfer-progress",
        serde_json::json!({
          "tabId": tab_id,
          "op": "upload",
          "filename": &filename,
          "transferred": written,
          "total": total,
          "elapsed": elapsed
        }),
      );
    }
    Ok::<(), String>(())
  }
  .await;

  let _ = file.close().await;
  if let Err(e) = write {
    discard_partial_upload(&sftp, &resolved_path, existed_before).await;
    return Err(e);
  }

  Ok(true)
}

#[tauri::command]
pub async fn file_exists(
  app: tauri::AppHandle,
  state: tauri::State<'_, AppState>,
  tab_id: u32,
  path: String,
) -> Result<bool, String> {
  let sftp = open_sftp_session(&state, &app, tab_id).await?;

  match sftp.metadata(&path).await {
    Ok(_) => Ok(true),
    Err(_) => Ok(false),
  }
}

#[tauri::command]
pub async fn create_directory(
  app: tauri::AppHandle,
  state: tauri::State<'_, AppState>,
  tab_id: u32,
  path: String,
) -> Result<bool, String> {
  let sftp = open_sftp_session(&state, &app, tab_id).await?;

  sftp
    .create_dir(&path)
    .await
    .map_err(|e| format!("Failed to create directory: {}", e))?;

  Ok(true)
}

#[tauri::command]
pub async fn rename_file(
  app: tauri::AppHandle,
  state: tauri::State<'_, AppState>,
  tab_id: u32,
  old_path: String,
  new_path: String,
) -> Result<bool, String> {
  let sftp = open_sftp_session(&state, &app, tab_id).await?;

  sftp
    .rename(&old_path, &new_path)
    .await
    .map_err(|e| format!("Failed to rename: {}", e))?;

  Ok(true)
}

#[tauri::command]
pub async fn delete_file(
  app: tauri::AppHandle,
  state: tauri::State<'_, AppState>,
  tab_id: u32,
  path: String,
  is_dir: bool,
) -> Result<bool, String> {
  let sftp = open_sftp_session(&state, &app, tab_id).await?;

  if is_dir {
    // Set up pause/cancel control so the directory delete can be aborted.
    let control = Arc::new(TransferControl {
      paused: AtomicBool::new(false),
      cancelled: AtomicBool::new(false),
      notify: tokio::sync::Notify::new(),
    });
    {
      let mut controls = state.transfer_controls.lock().map_err(|e| e.to_string())?;
      controls.entry(tab_id).or_default().push(control.clone());
    }
    let _cleanup = TransferGuard::new(&state, tab_id, control.clone());

    let fs = crate::remote_fs::SftpFs::new(sftp);
    let dir_name = std::path::Path::new(&path)
      .file_name()
      .map(|n| n.to_string_lossy().to_string())
      .unwrap_or_else(|| {
        path
          .trim_end_matches('/')
          .rsplit('/')
          .next()
          .unwrap_or("delete")
          .to_string()
      });
    let start = std::time::Instant::now();

    // Recursively delete with per-file progress events (op `delete`). The
    // callback aborts the loop when the user cancels.
    let mut on_progress = |done_files: u64,
                           total_files: u64,
                           done_bytes: u64,
                           total_bytes: u64|
     -> Result<(), String> {
      if control.cancelled.load(Ordering::SeqCst) {
        return Err("Transfer cancelled".to_string());
      }
      let _ = app.emit(
        "transfer-progress",
        serde_json::json!({
          "tabId": tab_id,
          "op": "delete",
          "dirName": dir_name,
          "filename": "",
          "relativePath": "",
          "transferred": done_files,
          "total": total_files,
          "doneFiles": done_files,
          "totalFiles": total_files,
          "doneBytes": done_bytes,
          "totalBytes": total_bytes,
          "elapsed": start.elapsed().as_millis()
        }),
      );
      Ok(())
    };
    delete_dir_recursive(&fs, &path, &mut on_progress).await?;
  } else {
    sftp
      .remove_file(&path)
      .await
      .map_err(|e| format!("Failed to delete file: {}", e))?;
  }

  Ok(true)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn a_cancelled_upload_only_deletes_files_it_created() {
    // A fresh destination is a half-written file we own: remove it.
    assert!(may_discard_partial(false));
    // `create()` truncated an existing file; deleting it would destroy the
    // user's original data, so the partial content has to stay.
    assert!(!may_discard_partial(true));
  }

  #[test]
  fn sanitize_relative_name_rejects_escapes_and_windows_specials() {
    // (input, expected)
    let cases: &[(&str, Option<&str>)] = &[
      ("normal.txt", Some("normal.txt")),
      ("报告 2024.log", Some("报告 2024.log")),
      ("..", None),
      (".", None),
      ("", None),
      ("../../evil", None),
      ("..\\..\\evil", None),
      ("/etc/passwd", None),
      ("C:\\Windows\\x", None),
      ("name:stream", None),
      ("nul\u{0}byte", None),
      ("trailing.", None),
      ("trailing ", None),
      ("CON", None),
      ("con.txt", None),
      ("AUX", None),
      ("COM1", None),
      ("lpt9.tar.gz", None),
      ("CONSOLE.log", Some("CONSOLE.log")),
    ];
    for (input, expected) in cases {
      let got = sanitize_relative_name(input);
      assert_eq!(got.as_deref(), *expected, "input={:?}", input);
    }
  }

  #[test]
  fn sanitized_names_never_escape_local_root() {
    let root = std::path::Path::new("C:/downloads");
    for evil in ["../evil", "..\\evil", "C:/Windows/x", "/etc/passwd"] {
      if let Some(name) = sanitize_relative_name(evil) {
        let joined = root.join(name);
        assert!(
          joined.starts_with(root),
          "{:?} escaped to {:?}",
          evil,
          joined
        );
      }
    }
  }

  #[test]
  fn retry_budget_resets_once_an_attempt_makes_progress() {
    let mut consecutive = 0;
    for attempts in 1..=3 {
      assert!(
        retry_or_give_up(
          CopyError::Retry("Timeout".into()),
          false,
          &mut consecutive,
          attempts
        )
        .is_ok(),
        "attempt {} should still retry",
        attempts
      );
    }
    assert_eq!(consecutive, 3);
    let err = retry_or_give_up(
      CopyError::Retry("Timeout".into()),
      false,
      &mut consecutive,
      4,
    )
    .unwrap_err();
    assert!(err.contains("gave up after 4 attempts"), "{}", err);

    // An attempt that moved bytes before failing gets the full budget again.
    let mut consecutive = 3;
    assert!(retry_or_give_up(
      CopyError::Retry("Timeout".into()),
      true,
      &mut consecutive,
      5
    )
    .is_ok());
    assert_eq!(consecutive, 1);
  }

  #[test]
  fn cancel_and_fatal_failures_surface_without_retry() {
    let mut consecutive = 0;
    assert_eq!(
      retry_or_give_up(CopyError::Cancelled, false, &mut consecutive, 1),
      Err("Transfer cancelled".to_string())
    );
    assert_eq!(
      retry_or_give_up(
        CopyError::Fatal("denied".into()),
        false,
        &mut consecutive,
        1
      ),
      Err("denied".to_string())
    );
  }

  #[test]
  fn only_transport_failures_are_retried() {
    // `File::read` reports through io::Error, which wraps the SFTP error; the
    // classifier has to look through it, because this is the wiring behind the
    // user-visible "Failed to read: Timeout".
    let timeout: std::io::Error = SftpError::Timeout.into();
    assert!(matches!(
      classify_read_error(timeout, "Failed to read"),
      CopyError::Retry(msg) if msg == "Failed to read: Timeout"
    ));
    assert!(matches!(
      classify_read_error(
        std::io::Error::from(std::io::ErrorKind::NotConnected),
        "read"
      ),
      CopyError::Retry(_)
    ));
    // A protocol status is the server answering "no" — a new connection cannot
    // change that, so it must not burn the retry budget.
    assert!(matches!(
      classify_client_error(SftpError::Limited("max packet".into()), "read"),
      CopyError::Fatal(_)
    ));
    assert!(matches!(
      classify_read_error(
        std::io::Error::from(std::io::ErrorKind::InvalidData),
        "read"
      ),
      CopyError::Fatal(_)
    ));
  }
}

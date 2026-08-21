use super::*;
// ==================== SFTP File Operations ====================

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
      is_sftp: true,
      shell_channel_id: None,
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
      {
        return Err("Authentication failed".into());
      }
    } else if let Some(ref key_path) = config.key_path {
      let resolved = expand_tilde(key_path);
      let key = load_secret_key(&resolved, config.passphrase.as_deref())
        .map_err(|e| format!("Failed to load key: {}", e))?;
      if !handle
        .authenticate_publickey(&config.username, Arc::new(key))
        .await
        .map_err(|e| format!("Key auth error: {}", e))?
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
        russh::ChannelMsg::ExitStatus { .. } | russh::ChannelMsg::Eof | russh::ChannelMsg::Close => {
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
  let _cleanup = TransferGuard {
    state_ptr: &*state as *const AppState,
    tab_id,
    control: control.clone(),
  };

  let sftp = open_sftp_session(&state, &app, tab_id).await?;

  let filename = std::path::Path::new(&remote_path)
    .file_name()
    .map(|n| n.to_string_lossy().to_string())
    .unwrap_or_else(|| remote_path.clone());

  // Get total file size
  let metadata = sftp
    .metadata(&remote_path)
    .await
    .map_err(|e| format!("Failed to stat remote file: {}", e))?;
  let total = metadata.size.unwrap_or(0);

  // Open file for chunked streaming read
  let mut file = sftp
    .open(&remote_path)
    .await
    .map_err(|e| format!("Failed to open remote file: {}", e))?;

  let mut all_data = Vec::with_capacity(total as usize);
  let mut buf = vec![0u8; 65536];
  let start = std::time::Instant::now();
  let mut offset: u64 = 0;

  loop {
    // Check for pause before each chunk
    check_pause(&control).await?;

    let n = file
      .read(&mut buf)
      .await
      .map_err(|e| format!("Failed to read: {}", e))?;
    if n == 0 {
      break;
    }
    all_data.extend_from_slice(&buf[..n]);
    offset += n as u64;

    let _ = app.emit(
      "transfer-progress",
      serde_json::json!({
        "tabId": tab_id,
        "op": "download",
        "filename": &filename,
        "transferred": offset,
        "total": total,
        "elapsed": start.elapsed().as_millis()
      }),
    );
  }

  // Write to local file
  if let Some(parent) = std::path::Path::new(&local_path).parent() {
    let _ = tokio::fs::create_dir_all(parent).await;
  }
  tokio::fs::write(&local_path, &all_data)
    .await
    .map_err(|e| format!("Failed to write local file: {}", e))?;

  Ok(true)
}

/// Recursively walk a remote directory over a single SFTP session, collecting
/// (absolute_path, relative_path, size) for files and the relative paths of all
/// directories. Symlinks are skipped so the walk cannot loop.
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
    let name = entry.file_name();
    let md = entry.metadata();
    if md.file_type().is_symlink() {
      *skipped += 1;
      continue;
    }
    let child_abs = format!("{}/{}", remote_root.trim_end_matches('/'), name);
    let child_rel = if rel.is_empty() {
      name.clone()
    } else {
      format!("{}/{}", rel, name)
    };
    if md.is_dir() {
      dirs.push(child_rel.clone());
      Box::pin(walk_sftp_dir(sftp, &child_abs, &child_rel, dirs, files, skipped)).await?;
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
  let _cleanup = TransferGuard {
    state_ptr: &*state as *const AppState,
    tab_id,
    control: control.clone(),
  };

  let sftp = open_sftp_session(&state, &app, tab_id).await?;

  // Single-session recursive walk (no per-file reconnects).
  let mut dirs = Vec::new();
  let mut files = Vec::new();
  let mut skipped = 0usize;
  walk_sftp_dir(&sftp, &remote_dir, "", &mut dirs, &mut files, &mut skipped).await?;

  // The selected local folder is the *parent*: the downloaded directory keeps
  // its own name so the tree appears as `<local_dir>/<dir_name>/...`.
  let dir_name = std::path::Path::new(&remote_dir)
    .file_name()
    .map(|n| n.to_string_lossy().to_string())
    .unwrap_or_else(|| remote_dir.trim_end_matches('/').rsplit('/').next().unwrap_or("download").to_string());
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

    let mut file = sftp
      .open(remote_path)
      .await
      .map_err(|e| format!("Failed to open remote file '{}': {}", remote_path, e))?;
    let local_path = local_root.join(rel);
    if let Some(parent) = local_path.parent() {
      let _ = tokio::fs::create_dir_all(parent).await;
    }
    let mut out = tokio::fs::File::create(&local_path)
      .await
      .map_err(|e| format!("Failed to create local file '{}': {}", local_path.display(), e))?;

    let mut buf = vec![0u8; 65536];
    let mut offset = 0u64;
    loop {
      check_pause(&control).await?;
      let n = file
        .read(&mut buf)
        .await
        .map_err(|e| format!("Failed to read '{}': {}", remote_path, e))?;
      if n == 0 {
        break;
      }
      out
        .write_all(&buf[..n])
        .await
        .map_err(|e| format!("Failed to write '{}': {}", local_path.display(), e))?;
      offset += n as u64;
      done_bytes += n as u64;

      let _ = app.emit(
        "transfer-progress",
        serde_json::json!({
          "tabId": tab_id,
          "op": "directory",
          "dirName": dir_name,
          "filename": rel,
          "relativePath": rel,
          "transferred": offset,
          "total": size,
          "doneFiles": done_files,
          "totalFiles": total_files,
          "doneBytes": done_bytes,
          "totalBytes": total_bytes,
          "elapsed": start.elapsed().as_millis()
        }),
      );
    }
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
  let _cleanup = TransferGuard {
    state_ptr: &*state as *const AppState,
    tab_id,
    control: control.clone(),
  };

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
  let mut file = sftp
    .create(&resolved_path)
    .await
    .map_err(|e| format!("Failed to create remote file '{}': {}", resolved_path, e))?;

  let start = std::time::Instant::now();
  let chunk_size: usize = 4 * 1024 * 1024;
  let mut buf = vec![0u8; chunk_size];
  let mut written: u64 = 0;

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

  // File is closed on drop

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
  let _cleanup = TransferGuard {
    state_ptr: &*state as *const AppState,
    tab_id,
    control: control.clone(),
  };

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
  let mut file = sftp
    .create(&resolved_path)
    .await
    .map_err(|e| format!("Failed to create remote file '{}': {}", resolved_path, e))?;

  let start = std::time::Instant::now();
  let chunk_size: usize = 4 * 1024 * 1024;
  let mut written: u64 = 0;

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
    let _cleanup = TransferGuard {
      state_ptr: &*state as *const AppState,
      tab_id,
      control: control.clone(),
    };

    let fs = crate::remote_fs::SftpFs::new(sftp);
    let dir_name = std::path::Path::new(&path)
      .file_name()
      .map(|n| n.to_string_lossy().to_string())
      .unwrap_or_else(|| path.trim_end_matches('/').rsplit('/').next().unwrap_or("delete").to_string());
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


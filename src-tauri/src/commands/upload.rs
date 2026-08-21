use super::*;
// ==================== Chunked (streaming) upload ====================
//
// HTML5 drag & drop hands the frontend a `File` object with no filesystem
// path, and the old code shipped the WHOLE file through the Tauri JSON IPC as
// `Array.from(new Uint8Array(buf))` — a `number[]` of every byte. For large
// files the JSON serialization blows up memory and the WebView2 postMessage
// payload, so uploads simply fail. These commands instead keep the remote
// file handle open in `AppState.upload_sessions` while the frontend streams
// the file in small (~64KB) chunks: one small invoke per chunk, no giant IPC
// payload, no full-file buffering.

/// Begin a streaming upload on the tab's SSH session. Creates the remote file
/// (and parent dirs) and returns an `upload_id` for `upload_chunk`/`upload_end`.
/// Open a shared SFTP connection for a directory-upload batch. All files in the
/// batch reuse this one connection (via `batch_id` on `upload_start`) instead
/// of performing a full SSH+SFTP handshake per file. Call `upload_batch_end`
/// once the batch finishes (or fails) to drop the session.
#[tauri::command]
pub async fn upload_batch_start(
  app: tauri::AppHandle,
  state: tauri::State<'_, AppState>,
  tab_id: u32,
) -> Result<u64, String> {
  let sftp = Arc::new(open_sftp_session(&state, &app, tab_id).await?);
  let batch_id = state.next_upload_batch_id.fetch_add(1, Ordering::SeqCst);
  state
    .upload_batch_sessions
    .lock()
    .map_err(|e| e.to_string())?
    .insert(batch_id, sftp);
  Ok(batch_id)
}

/// Close a directory-upload batch session opened by `upload_batch_start`.
#[tauri::command]
pub async fn upload_batch_end(
  state: tauri::State<'_, AppState>,
  batch_id: u64,
) -> Result<(), String> {
  state
    .upload_batch_sessions
    .lock()
    .map_err(|e| e.to_string())?
    .remove(&batch_id);
  Ok(())
}

#[tauri::command]
pub async fn upload_start(
  app: tauri::AppHandle,
  state: tauri::State<'_, AppState>,
  tab_id: u32,
  remote_path: String,
  total: u64,
  batch_id: Option<u64>,
) -> Result<u64, String> {
  // Set up pause control (kept registered until `upload_end`).
  let control = Arc::new(TransferControl {
    paused: AtomicBool::new(false),
    cancelled: AtomicBool::new(false),
    notify: tokio::sync::Notify::new(),
  });
  {
    let mut controls = state.transfer_controls.lock().map_err(|e| e.to_string())?;
    controls.entry(tab_id).or_default().push(control.clone());
  }

  // Reuse the batch's shared SFTP connection when one is open (directory
  // upload), avoiding a full SSH+SFTP handshake per file.
  let sftp = match batch_id {
    Some(bid) => state
      .upload_batch_sessions
      .lock()
      .map_err(|e| e.to_string())?
      .get(&bid)
      .cloned()
      .ok_or_else(|| format!("Upload batch {} not found", bid))?,
    None => Arc::new(open_sftp_session(&state, &app, tab_id).await?),
  };

  let filename = std::path::Path::new(&remote_path)
    .file_name()
    .map(|n| n.to_string_lossy().to_string())
    .unwrap_or_else(|| remote_path.clone());

  let resolved_path = resolve_sftp_path(&*sftp, &remote_path).await?;
  ensure_parent_dir(&*sftp, &resolved_path).await?;

  let file = sftp
    .create(&resolved_path)
    .await
    .map_err(|e| format!("Failed to create remote file '{}': {}", resolved_path, e))?;
  let upload_id = state.next_upload_id.fetch_add(1, Ordering::SeqCst);
  state
    .upload_sessions
    .lock()
    .map_err(|e| e.to_string())?
    .insert(
      upload_id,
      UploadSession {
        file,
        filename,
        total,
        written: 0,
        tab_id: Some(tab_id),
        started: std::time::Instant::now(),
        control,
      },
    );
  Ok(upload_id)
}

/// Begin a streaming upload on an arbitrary target (ProxyJump / Docker-ssh).
/// The target path is used as-is (same semantics as `target_upload_file_bytes`).
#[tauri::command]
pub async fn target_upload_start(
  app: tauri::AppHandle,
  state: tauri::State<'_, AppState>,
  target: TargetRef,
  remote_path: String,
  total: u64,
) -> Result<u64, String> {
  let sftp = build_sftp(&app, &state, &target).await?;

  let filename = std::path::Path::new(&remote_path)
    .file_name()
    .map(|n| n.to_string_lossy().to_string())
    .unwrap_or_else(|| remote_path.clone());

  ensure_parent_dir(&sftp, &remote_path).await?;

  let file = sftp
    .create(&remote_path)
    .await
    .map_err(|e| format!("Failed to create remote file '{}': {}", remote_path, e))?;

  let upload_id = state.next_upload_id.fetch_add(1, Ordering::SeqCst);
  state
    .upload_sessions
    .lock()
    .map_err(|e| e.to_string())?
    .insert(
      upload_id,
      UploadSession {
        file,
        filename,
        total,
        written: 0,
        tab_id: None,
        started: std::time::Instant::now(),
        control: Arc::new(TransferControl {
          paused: AtomicBool::new(false),
          cancelled: AtomicBool::new(false),
          notify: tokio::sync::Notify::new(),
        }),
      },
    );
  Ok(upload_id)
}

/// Append one chunk to a streaming upload. The remote handle is taken out of
/// the session table for the duration of the write (so a paused upload blocks
/// only itself, not other commands) and put back afterwards.
///
/// Chunks arrive base64-encoded: sending binary as a JSON array of numbers
/// (every byte → one JSON number) made both the WebView serialization and the
/// Rust `serde_json` parse the dominant CPU cost during large directory
/// uploads. A base64 string is a single JSON token — cheap on both sides.
#[tauri::command]
pub async fn upload_chunk(
  app: tauri::AppHandle,
  state: tauri::State<'_, AppState>,
  upload_id: u64,
  chunk_b64: String,
) -> Result<(), String> {
  use base64::Engine;
  let chunk = base64::engine::general_purpose::STANDARD
    .decode(chunk_b64.trim())
    .map_err(|e| format!("Failed to decode chunk: {}", e))?;

  let mut sess = {
    let mut sessions = state.upload_sessions.lock().map_err(|e| e.to_string())?;
    sessions
      .remove(&upload_id)
      .ok_or("Upload session not found (already finished or expired)")?
  };

  check_pause(&sess.control).await?;

  let result = async {
    sess.file
      .write_all(&chunk)
      .await
      .map_err(|e| format!("Failed to write chunk: {}", e))?;
    sess.written += chunk.len() as u64;
    if let Some(tab_id) = sess.tab_id {
      let _ = app.emit(
        "transfer-progress",
        serde_json::json!({
          "tabId": tab_id,
          "op": "upload",
          "filename": &sess.filename,
          "transferred": sess.written,
          "total": sess.total,
          "elapsed": sess.started.elapsed().as_millis()
        }),
      );
    }
    Ok::<(), String>(())
  }
  .await;

  // Put the handle back even on error so `upload_end` can close it cleanly.
  {
    let mut sessions = state.upload_sessions.lock().map_err(|e| e.to_string())?;
    sessions.insert(upload_id, sess);
  }
  result
}

/// Finish a streaming upload: close the remote handle and release pause state.
#[tauri::command]
pub async fn upload_end(
  state: tauri::State<'_, AppState>,
  upload_id: u64,
) -> Result<(), String> {
  let sess = {
    let mut sessions = state.upload_sessions.lock().map_err(|e| e.to_string())?;
    sessions.remove(&upload_id)
  };
  if let Some(sess) = sess {
    // Release the pause control we registered in `upload_start`, but only if
    // it is still ours — another transfer on the same tab may have replaced it.
    if let Some(tab) = sess.tab_id {
      let mut controls = state.transfer_controls.lock().map_err(|e| e.to_string())?;
      if let Some(list) = controls.get_mut(&tab) {
        list.retain(|c| !Arc::ptr_eq(c, &sess.control));
      }
    }
    // sess (and its remote file handle) drops here.
  }
  Ok(())
}

// ==================== P6: Target-based file operations ====================
//
// These commands address any `TargetRef` (main session / ProxyJump remote /
// Docker container) and operate directly on that target. The `Session` variant
// reproduces the behaviour of the `tab_id` commands above.

#[tauri::command]
pub async fn target_list_files(
  app: tauri::AppHandle,
  state: tauri::State<'_, AppState>,
  target: TargetRef,
  path: String,
) -> Result<Vec<FileEntry>, String> {
  let fs = build_fs(&app, &state, &target).await?;
  fs.list_dir(&path).await
}

#[tauri::command]
pub async fn target_file_exists(
  app: tauri::AppHandle,
  state: tauri::State<'_, AppState>,
  target: TargetRef,
  path: String,
) -> Result<bool, String> {
  let fs = build_fs(&app, &state, &target).await?;
  Ok(fs.metadata(&path).await.is_ok())
}

#[tauri::command]
pub async fn target_create_directory(
  app: tauri::AppHandle,
  state: tauri::State<'_, AppState>,
  target: TargetRef,
  path: String,
) -> Result<bool, String> {
  let fs = build_fs(&app, &state, &target).await?;
  fs.create_dir(&path).await?;
  Ok(true)
}

#[tauri::command]
pub async fn target_rename_file(
  app: tauri::AppHandle,
  state: tauri::State<'_, AppState>,
  target: TargetRef,
  old_path: String,
  new_path: String,
) -> Result<bool, String> {
  let fs = build_fs(&app, &state, &target).await?;
  fs.rename(&old_path, &new_path).await?;
  Ok(true)
}

#[tauri::command]
pub async fn target_delete_file(
  app: tauri::AppHandle,
  state: tauri::State<'_, AppState>,
  target: TargetRef,
  path: String,
  is_dir: bool,
) -> Result<bool, String> {
  let fs = build_fs(&app, &state, &target).await?;
  if is_dir {
    // No per-file progress UI for jump/docker/local targets (the panel only
    // routes `transfer-progress` for the main session), so pass a no-op
    // callback. Returns Err aborts the deletion.
    delete_dir_recursive(fs.as_ref(), &path, &mut |_d, _t, _b, _tb| Ok(())).await?;
  } else {
    fs.remove_file(&path).await?;
  }
  Ok(true)
}

#[tauri::command]
pub async fn target_download_directory(
  app: tauri::AppHandle,
  state: tauri::State<'_, AppState>,
  target: TargetRef,
  remote_dir: String,
  local_dir: String,
) -> Result<DirDownloadSummary, String> {
  let fs = build_fs(&app, &state, &target).await?;
  // The chosen local folder is the *parent*; keep the remote directory's own
  // name so the tree downloads as `<local_dir>/<dir_name>/...`.
  let dir_name = std::path::Path::new(&remote_dir)
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
  let local_root = std::path::Path::new(&local_dir).join(&dir_name);
  let mut done_bytes = 0u64;
  let mut done_files = 0usize;
  let start = std::time::Instant::now();
  let tab_id = match &target {
    TargetRef::Session { tab_id } | TargetRef::Local { tab_id } => *tab_id,
    TargetRef::JumpRemote { jump_tab_id, .. }
    | TargetRef::DockerSsh { jump_tab_id, .. }
    | TargetRef::Docker { jump_tab_id, .. } => *jump_tab_id,
  };
  let local_root_str = local_root.to_string_lossy().to_string();
  let summary = crate::remote_fs::download_dir_recursive(
    fs.as_ref(),
    &remote_dir,
    &local_root_str,
    |rel, transferred, _total| {
      done_bytes += transferred;
      done_files += 1;
      let _ = app.emit(
        "transfer-progress",
        serde_json::json!({
          "tabId": tab_id,
          "op": "directory",
          "dirName": dir_name,
          "filename": rel,
          "relativePath": rel,
          "transferred": transferred,
          "total": transferred,
          "doneFiles": done_files,
          "totalFiles": 0,
          "doneBytes": done_bytes,
          "totalBytes": 0,
          "elapsed": start.elapsed().as_millis()
        }),
      );
    },
  )
  .await?;
  Ok(summary)
}

#[tauri::command]
pub async fn target_read_file(
  app: tauri::AppHandle,
  state: tauri::State<'_, AppState>,
  target: TargetRef,
  path: String,
  max_size: Option<u64>,
  encoding: Option<String>,
) -> Result<FileContent, String> {
  let max_size = max_size.unwrap_or(DEFAULT_MAX_EDIT_SIZE);
  let fs = build_fs(&app, &state, &target).await?;

  let meta = fs
    .metadata(&path)
    .await
    .map_err(|e| format!("Failed to stat remote file: {}", e))?;
  let size = meta.size;
  let mode = meta.mode.clone();

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

  let data = fs
    .read_file(&path)
    .await
    .map_err(|e| format!("Failed to read remote file: {}", e))?;

  let is_binary = data.contains(&0);
  let (content, used_encoding, needs_encoding) = if is_binary {
    (
      String::new(),
      encoding.clone().unwrap_or_else(|| "utf-8".to_string()),
      false,
    )
  } else {
    decode_file_content(&data, encoding.as_deref())
  };
  let hex_base64 = if is_binary {
    use base64::Engine;
    Some(base64::engine::general_purpose::STANDARD.encode(&data))
  } else {
    None
  };
  let image_mime = if is_binary {
    image_mime_of(&data, &path)
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

#[tauri::command]
pub async fn target_write_file(
  app: tauri::AppHandle,
  state: tauri::State<'_, AppState>,
  target: TargetRef,
  path: String,
  content: String,
  encoding: Option<String>,
) -> Result<bool, String> {
  let fs = build_fs(&app, &state, &target).await?;

  let encoding_ref: &Encoding =
    Encoding::for_label(encoding.as_deref().unwrap_or("utf-8").as_bytes()).unwrap_or(UTF_8);
  let (bytes, _used, had_errors) = encoding_ref.encode(&content);
  if had_errors {
    return Err(format!(
      "Content cannot be encoded as {}",
      encoding_ref.name()
    ));
  }
  fs.write_file(&path, &bytes).await?;
  Ok(true)
}

#[tauri::command]
pub async fn target_download_file(
  app: tauri::AppHandle,
  state: tauri::State<'_, AppState>,
  target: TargetRef,
  remote_path: String,
  local_path: String,
) -> Result<bool, String> {
  let fs = build_fs(&app, &state, &target).await?;
  let data = fs
    .read_file(&remote_path)
    .await
    .map_err(|e| format!("Failed to read remote file: {}", e))?;
  if let Some(parent) = std::path::Path::new(&local_path).parent() {
    let _ = tokio::fs::create_dir_all(parent).await;
  }
  tokio::fs::write(&local_path, &data)
    .await
    .map_err(|e| format!("Failed to write local file: {}", e))?;
  Ok(true)
}

#[tauri::command]
pub async fn target_upload_file(
  app: tauri::AppHandle,
  state: tauri::State<'_, AppState>,
  target: TargetRef,
  local_path: String,
  remote_path: String,
) -> Result<bool, String> {
  // SFTP-backed targets stream the file in 64KB chunks so large files never
  // load fully into memory. Non-SFTP targets (Docker exec / local) keep the
  // single-shot `write_file` path.
  match build_sftp(&app, &state, &target).await {
    Ok(sftp) => {
      stream_upload_file(&sftp, &local_path, &remote_path).await?;
      Ok(true)
    }
    Err(_) => {
      let fs = build_fs(&app, &state, &target).await?;
      let data = tokio::fs::read(&local_path)
        .await
        .map_err(|e| format!("Failed to read local file: {}", e))?;
      fs.write_file(&remote_path, &data).await?;
      Ok(true)
    }
  }
}

/// Stream a local file into `remote_path` over an SFTP session in 64KB chunks
/// (no full-file buffering). Parent directories are created as needed.
async fn stream_upload_file(
  sftp: &russh_sftp::client::SftpSession,
  local_path: &str,
  remote_path: &str,
) -> Result<(), String> {
  let mut local = tokio::fs::File::open(local_path)
    .await
    .map_err(|e| format!("Failed to open local file: {}", e))?;
  ensure_parent_dir(sftp, remote_path).await?;
  let mut file = sftp
    .create(remote_path)
    .await
    .map_err(|e| format!("Failed to create remote file '{}': {}", remote_path, e))?;
  let mut buf = vec![0u8; 65536];
  loop {
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
      .map_err(|e| format!("Failed to write data to '{}': {}", remote_path, e))?;
  }
  Ok(())
}

// ==================== Local directory upload (walkdir) ====================
//
// Directory (or drag-dropped path) uploads scan the LOCAL filesystem on the
// Rust side with `walkdir` and stream every file directly over a single SFTP
// connection — no per-chunk IPC from the frontend (the previous HTML5
// drag-drop path shipped base64 chunks across the Tauri boundary).

/// Recursively walk `local_dir` and stream every file over a single SFTP
/// session. `local_dir` may be a single file (uploaded to
/// `remote_parent/<basename>`) or a directory (uploaded to
/// `remote_parent/<dirname>/...`). Symlinks are skipped (counted in the
/// summary). `on_progress` is invoked after each chunk with
/// (relative_path, done_bytes, total_bytes, done_files, total_files);
/// returning `Err` aborts the upload (e.g. user cancel). `control`, when
/// present, is checked before each chunk for pause/cancel.
async fn stream_upload_local_dir(
  sftp: &russh_sftp::client::SftpSession,
  local_dir: &str,
  remote_parent: &str,
  control: Option<&TransferControl>,
  on_progress: &mut (dyn FnMut(&str, u64, u64, u64, u64) -> Result<(), String> + Send),
) -> Result<DirUploadSummary, String> {
  let local_root = std::path::Path::new(local_dir);
  let is_dir = local_root.is_dir();
  let dir_name = local_root
    .file_name()
    .map(|n| n.to_string_lossy().to_string())
    .unwrap_or_else(|| "upload".to_string());
  let remote_root = if is_dir {
    format!("{}/{}", remote_parent.trim_end_matches('/'), dir_name)
  } else {
    remote_parent.trim_end_matches('/').to_string()
  };

  // One walkdir pass: collect relative dir paths and (abs, rel, size) files.
  // WalkDir yields pre-order (parents before children), which is the order
  // remote directories must be created in.
  let mut dirs = Vec::new();
  let mut files = Vec::new();
  let mut skipped = 0usize;
  for entry in WalkDir::new(local_dir).follow_links(false) {
    let entry = entry.map_err(|e| format!("Failed to scan '{}': {}", local_dir, e))?;
    if entry.file_type().is_symlink() {
      skipped += 1;
      continue;
    }
    let rel = entry
      .path()
      .strip_prefix(local_dir)
      .unwrap_or(entry.path())
      .to_string_lossy()
      .replace('\\', "/");
    if entry.file_type().is_dir() {
      if !rel.is_empty() {
        dirs.push(rel);
      }
    } else {
      // A single file passed directly has an empty relative path; fall back to
      // its basename so it uploads as `<remote_parent>/<basename>`.
      let file_rel = if rel.is_empty() {
        entry.file_name().to_string_lossy().to_string()
      } else {
        rel
      };
      let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
      files.push((entry.path().to_string_lossy().to_string(), file_rel, size));
    }
  }

  if is_dir {
    // Create the destination directory itself first — SFTP's `create`/`mkdir`
    // do not create parents implicitly, and the walkdir scan above only
    // collected *relative* subdirectories (the root's own relative path is
    // empty), so the top-level `remote_root` would otherwise be missing.
    if sftp.metadata(&remote_root).await.is_err() {
      let _ = sftp.create_dir(&remote_root).await;
    }
    for d in &dirs {
      let remote_dir_path = format!("{}/{}", remote_root, d);
      if sftp.metadata(&remote_dir_path).await.is_err() {
        let _ = sftp.create_dir(&remote_dir_path).await;
      }
    }
  }

  let total_files = files.len();
  let total_bytes: u64 = files.iter().map(|(_, _, s)| s).sum();
  let mut done_bytes = 0u64;
  let mut done_files = 0usize;

  // Upload files with bounded concurrency so a folder of many files keeps the
  // SSH pipe full. a945 achieved this by running several `upload_file` calls in
  // parallel from the frontend; here we keep one shared SFTP session (russh-sftp
  // multiplexes requests by id, strictly better than one session per file) and
  // run up to UPLOAD_CONCURRENCY file uploads at once.
  const UPLOAD_CONCURRENCY: usize = 8;
  let sftp_ref = &sftp;
  for chunk in files.chunks(UPLOAD_CONCURRENCY) {
    let mut tasks = Vec::with_capacity(chunk.len());
    let mut rels = Vec::with_capacity(chunk.len());
    for (local_abs, rel, _size) in chunk {
      rels.push(rel.clone());
      let remote_path = format!("{}/{}", remote_root, rel);
      let ctrl = control.clone();
      tasks.push(async move {
        if let Some(c) = &ctrl {
          check_pause(c).await?;
        }
        let mut local = tokio::fs::File::open(local_abs)
          .await
          .map_err(|e| format!("Failed to open local file '{}': {}", local_abs, e))?;
        let mut rf = sftp_ref
          .create(&remote_path)
          .await
          .map_err(|e| format!("Failed to create remote file '{}': {}", remote_path, e))?;
        let mut buf = vec![0u8; 4 * 1024 * 1024];
        let mut written: u64 = 0;
        loop {
          if let Some(c) = &ctrl {
            check_pause(c).await?;
          }
          let n = local
            .read(&mut buf)
            .await
            .map_err(|e| format!("Failed to read local file '{}': {}", local_abs, e))?;
          if n == 0 {
            break;
          }
          rf.write_all(&buf[..n])
            .await
            .map_err(|e| format!("Failed to write data to '{}': {}", remote_path, e))?;
          written += n as u64;
        }
        Ok::<u64, String>(written)
      });
    }
    for (res, rel) in futures_util::future::join_all(tasks).await.into_iter().zip(rels) {
      let written = res?;
      done_bytes += written;
      done_files += 1;
      on_progress(&rel, done_bytes, total_bytes, done_files as u64, total_files as u64)?;
    }
  }

  Ok(DirUploadSummary {
    total_files,
    done_files,
    total_bytes,
    done_bytes,
    skipped,
  })
}

/// Upload a local directory (or single file) into `remote_dir` on the tab's
/// session. The local directory keeps its own name (`<remote_dir>/<dirname>/...`);
/// a single local file is uploaded to `<remote_dir>/<basename>`. Scans once
/// with walkdir and streams over one shared SFTP connection. Emits
/// `transfer-progress` events (op "upload-dir") and supports pause/cancel.
#[tauri::command]
pub async fn upload_local_dir(
  app: tauri::AppHandle,
  state: tauri::State<'_, AppState>,
  tab_id: u32,
  local_dir: String,
  remote_dir: String,
) -> Result<DirUploadSummary, String> {
  // Set up pause control (registered until this command returns).
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
  let remote_parent = resolve_sftp_path(&sftp, &remote_dir).await?;
  let dir_key = local_dir.replace('\\', "/");
  let start = std::time::Instant::now();
  let mut on_progress =
    move |rel: &str, done_bytes: u64, total_bytes: u64, done_files: u64, total_files: u64| {
      let _ = app.emit(
        "transfer-progress",
        serde_json::json!({
          "tabId": tab_id,
          "op": "upload-dir",
          "dirName": dir_key,
          "relativePath": rel,
          "doneFiles": done_files,
          "totalFiles": total_files,
          "doneBytes": done_bytes,
          "totalBytes": total_bytes,
          "elapsed": start.elapsed().as_millis()
        }),
      );
      Ok(())
    };
  stream_upload_local_dir(&sftp, &local_dir, &remote_parent, Some(&control), &mut on_progress).await
}

/// Same as `upload_local_dir` but for an arbitrary target (ProxyJump remote /
/// Docker-ssh). SFTP-backed targets use the shared-streaming path; Docker exec
/// / local targets fall back to per-file `RemoteFs` writes.
#[tauri::command]
pub async fn target_upload_local_dir(
  app: tauri::AppHandle,
  state: tauri::State<'_, AppState>,
  target: TargetRef,
  local_dir: String,
  remote_dir: String,
) -> Result<DirUploadSummary, String> {
  let tab_id = match &target {
    TargetRef::Session { tab_id } | TargetRef::Local { tab_id } => *tab_id,
    TargetRef::JumpRemote { jump_tab_id, .. }
    | TargetRef::DockerSsh { jump_tab_id, .. }
    | TargetRef::Docker { jump_tab_id, .. } => *jump_tab_id,
  };
  let dir_key = local_dir.replace('\\', "/");
  let start = std::time::Instant::now();
  match build_sftp(&app, &state, &target).await {
    Ok(sftp) => {
      let mut on_progress =
        move |rel: &str, done_bytes: u64, total_bytes: u64, done_files: u64, total_files: u64| {
          let _ = app.emit(
            "transfer-progress",
            serde_json::json!({
              "tabId": tab_id,
              "op": "upload-dir",
              "dirName": dir_key,
              "relativePath": rel,
              "doneFiles": done_files,
              "totalFiles": total_files,
              "doneBytes": done_bytes,
              "totalBytes": total_bytes,
              "elapsed": start.elapsed().as_millis()
            }),
          );
          Ok(())
        };
      stream_upload_local_dir(&sftp, &local_dir, &remote_dir, None, &mut on_progress).await
    }
    Err(_) => {
      // Non-SFTP target (Docker exec / local): one-shot per-file uploads.
      let fs = build_fs(&app, &state, &target).await?;
      upload_local_dir_via_fs(fs.as_ref(), &local_dir, &remote_dir).await
    }
  }
}

/// Fallback directory upload through a generic `RemoteFs` (no shared SFTP
/// handle): walk the local tree with walkdir and upload each file in one shot.
async fn upload_local_dir_via_fs(
  fs: &dyn RemoteFs,
  local_dir: &str,
  remote_parent: &str,
) -> Result<DirUploadSummary, String> {
  let local_root = std::path::Path::new(local_dir);
  let is_dir = local_root.is_dir();
  let dir_name = local_root
    .file_name()
    .map(|n| n.to_string_lossy().to_string())
    .unwrap_or_else(|| "upload".to_string());
  let remote_root = if is_dir {
    format!("{}/{}", remote_parent.trim_end_matches('/'), dir_name)
  } else {
    remote_parent.trim_end_matches('/').to_string()
  };

  let mut dirs = Vec::new();
  let mut files = Vec::new();
  let mut skipped = 0usize;
  for entry in WalkDir::new(local_dir).follow_links(false) {
    let entry = entry.map_err(|e| format!("Failed to scan '{}': {}", local_dir, e))?;
    if entry.file_type().is_symlink() {
      skipped += 1;
      continue;
    }
    let rel = entry
      .path()
      .strip_prefix(local_dir)
      .unwrap_or(entry.path())
      .to_string_lossy()
      .replace('\\', "/");
    if entry.file_type().is_dir() {
      if !rel.is_empty() {
        dirs.push(rel);
      }
    } else {
      // Single-file fallback: empty relative path → use the basename.
      let file_rel = if rel.is_empty() {
        entry.file_name().to_string_lossy().to_string()
      } else {
        rel
      };
      files.push((entry.path().to_string_lossy().to_string(), file_rel));
    }
  }

  if is_dir {
    // Create the destination directory itself first, mirroring the SFTP path
    // (the walkdir scan only collects relative subdirectories).
    let _ = fs.create_dir(&remote_root).await;
  }
  for d in &dirs {
    let _ = fs.create_dir(&format!("{}/{}", remote_root, d)).await;
  }
  let mut done_bytes = 0u64;
  for (abs, rel) in &files {
    let data = tokio::fs::read(abs)
      .await
      .map_err(|e| format!("Failed to read local file '{}': {}", abs, e))?;
    let remote = format!("{}/{}", remote_root, rel);
    fs.write_file(&remote, &data).await?;
    done_bytes += data.len() as u64;
  }

  Ok(DirUploadSummary {
    total_files: files.len(),
    done_files: files.len(),
    total_bytes: done_bytes,
    done_bytes,
    skipped,
  })
}

/// Ensure the parent directory of `remote_path` exists on the target
/// filesystem, creating intermediate directories as needed. Mirrors the
/// session-path `ensure_parent_dir` but operates through the unified
/// [`RemoteFs`] trait so it works for jump/docker/local targets too (their
/// `write_file` does not auto-create parents).
async fn ensure_parent_dir_fs(fs: &dyn RemoteFs, remote_path: &str) -> Result<(), String> {
  let parent = match std::path::Path::new(remote_path).parent() {
    Some(p) => p.to_string_lossy().replace('\\', "/"),
    None => return Ok(()),
  };
  if parent.is_empty() || parent == "/" || parent == "." {
    return Ok(());
  }
  // Preserve a leading "./" prefix (relative-to-home uploads).
  let (prefix, stripped) = match parent.strip_prefix("./") {
    Some(rest) => ("./".to_string(), rest),
    None => (String::new(), parent.as_str()),
  };
  let segments: Vec<&str> = stripped.split('/').filter(|s| !s.is_empty()).collect();
  let mut acc = prefix;
  for seg in segments {
    acc = if acc.is_empty() {
      seg.to_string()
    } else if acc == "/" {
      format!("/{}", seg)
    } else {
      format!("{}/{}", acc, seg)
    };
    // Create if missing, tolerating an already-existing directory.
    if fs.metadata(&acc).await.is_err() {
      if let Err(e) = fs.create_dir(&acc).await {
        if fs.metadata(&acc).await.is_err() {
          return Err(e);
        }
      }
    }
  }
  Ok(())
}

#[tauri::command]
pub async fn target_upload_file_bytes(
  app: tauri::AppHandle,
  state: tauri::State<'_, AppState>,
  target: TargetRef,
  remote_path: String,
  file_data: Vec<u8>,
) -> Result<bool, String> {
  let fs = build_fs(&app, &state, &target).await?;
  ensure_parent_dir_fs(fs.as_ref(), &remote_path).await?;
  fs.write_file(&remote_path, &file_data).await?;
  Ok(true)
}

/// Append a " copy" (then " copy N") suffix to `path` so a duplicate copy lands
/// next to the original with a readable name, preserving any file extension
/// (e.g. `report.txt` -> `report copy.txt`, directory `docs` -> `docs copy`).
fn with_copy_suffix(path: &str) -> String {
  let (parent, base) = match path.rsplit_once('/') {
    Some((p, b)) => (p, b),
    None => ("", path),
  };
  let (stem, ext) = match base.rsplit_once('.') {
    Some((s, e)) if !s.is_empty() => (s, format!(".{}", e)),
    _ => (base, String::new()),
  };
  let new_base = format!("{} copy{}", stem, ext);
  if parent.is_empty() {
    new_base
  } else {
    format!("{}/{}", parent, new_base)
  }
}

/// Return `dest` unchanged if it's free, otherwise a unique variant via
/// `with_copy_suffix` (and a numeric suffix if those are taken too).
async fn unique_dest(fs: &dyn RemoteFs, dest: &str) -> Result<String, String> {
  if fs.metadata(dest).await.is_err() {
    return Ok(dest.to_string());
  }
  let mut candidate = with_copy_suffix(dest);
  let mut n = 2;
  while fs.metadata(&candidate).await.is_ok() {
    candidate = format!("{} {}", with_copy_suffix(dest), n);
    n += 1;
  }
  Ok(candidate)
}

/// Whether a file or directory exists at `path` on the target (remote-internal
/// existence check used to detect copy/paste name clashes before prompting).
#[tauri::command]
pub async fn target_path_exists(
  app: tauri::AppHandle,
  state: tauri::State<'_, AppState>,
  target: TargetRef,
  path: String,
) -> Result<bool, String> {
  let fs = build_fs(&app, &state, &target).await?;
  Ok(fs.metadata(&path).await.is_ok())
}

/// Copy a remote file or directory to a destination directory on the same
/// target (remote-internal copy/paste). The destination is named after the
/// source's basename inside `dest_dir` (copying `/a/b.txt` into `/c` yields
/// `/c/b.txt`). When `dest_name` is provided, that exact name is used and an
/// existing entry is NOT overwritten — the caller (frontend) prompts the user
/// to rename instead. Copying a directory into itself or a descendant is
/// rejected.
#[tauri::command]
pub async fn target_copy_file(
  app: tauri::AppHandle,
  state: tauri::State<'_, AppState>,
  target: TargetRef,
  src: String,
  dest_dir: String,
  dest_name: Option<String>,
) -> Result<(), String> {
  let name = src
    .rsplit('/')
    .next()
    .filter(|s| !s.is_empty())
    .unwrap_or(&src)
    .to_string();
  let dest_dir = dest_dir.trim_end_matches('/');

  // Resolve the final destination name: an explicit `dest_name` (the user's
  // rename choice) wins; otherwise fall back to the source basename.
  let final_name = match dest_name.as_deref() {
    Some(n) if !n.trim().is_empty() => n.trim().to_string(),
    _ => name,
  };
  let final_dest = format!("{}/{}", dest_dir, final_name);

  // Reject copying a directory into itself or a descendant. This must use the
  // *final* path — with a rename the destination differs from the source even
  // when pasting inside the same folder, so guarding on the basename would
  // wrongly reject a legitimate same-folder copy.
  if final_dest == src || final_dest.starts_with(&format!("{}/", src)) {
    return Err("Cannot copy a directory into itself".into());
  }

  let fs = build_fs(&app, &state, &target).await?;

  // With an explicit name we refuse to overwrite an existing entry (the
  // frontend prompts the user to rename); otherwise uniquify so we never
  // clobber.
  let final_dest = if dest_name.as_deref().map(|n| !n.trim().is_empty()).unwrap_or(false) {
    if fs.metadata(&final_dest).await.is_ok() {
      return Err(format!(
        "A file or folder named '{}' already exists",
        final_name
      ));
    }
    final_dest
  } else {
    unique_dest(fs.as_ref(), &final_dest).await?
  };

  copy_recursive(fs.as_ref(), &src, &final_dest).await
}

/// List Docker containers reachable from a connected (jump host) tab.
#[tauri::command]
pub async fn list_docker_containers(
  state: tauri::State<'_, AppState>,
  jump_tab_id: u32,
) -> Result<Vec<ContainerInfo>, String> {
  let jump = crate::remote_fs::get_jump_handle(&state, jump_tab_id)?;
  crate::docker_fs::list_docker_containers(jump).await
}

// ==================== SFTP User Switching ====================

#[tauri::command]
pub async fn switch_sftp_user(
  state: tauri::State<'_, AppState>,
  tab_id: u32,
  username: String,
  password: String,
) -> Result<(), String> {
  let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
  let session = sessions.get_mut(&tab_id).ok_or("Session not found")?;
  session.switched_sftp_user = Some(SwitchedUser { username, password });
  Ok(())
}

#[tauri::command]
pub async fn revert_sftp_user(
  state: tauri::State<'_, AppState>,
  tab_id: u32,
) -> Result<(), String> {
  let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
  let session = sessions.get_mut(&tab_id).ok_or("Session not found")?;
  session.switched_sftp_user = None;
  Ok(())
}

#[tauri::command]
pub async fn get_sftp_user(
  state: tauri::State<'_, AppState>,
  tab_id: u32,
) -> Result<Option<String>, String> {
  let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
  let session = sessions.get(&tab_id).ok_or("Session not found")?;
  Ok(
    session
      .switched_sftp_user
      .as_ref()
      .map(|su| su.username.clone()),
  )
}

// ==================== Transfer Pause/Resume ====================

#[tauri::command]
pub async fn pause_transfer(state: tauri::State<'_, AppState>, tab_id: u32) -> Result<(), String> {
  let controls = state.transfer_controls.lock().map_err(|e| e.to_string())?;
  if let Some(list) = controls.get(&tab_id) {
    for ctrl in list {
      ctrl.paused.store(true, Ordering::SeqCst);
    }
  }
  Ok(())
}

#[tauri::command]
pub async fn resume_transfer(state: tauri::State<'_, AppState>, tab_id: u32) -> Result<(), String> {
  let controls = state.transfer_controls.lock().map_err(|e| e.to_string())?;
  if let Some(list) = controls.get(&tab_id) {
    for ctrl in list {
      ctrl.paused.store(false, Ordering::SeqCst);
      ctrl.notify.notify_one();
    }
  }
  Ok(())
}

/// Cancel the in-flight transfer for a tab. The transfer loop checks the flag
/// before each chunk and aborts (also wakes a paused loop so it can bail out).
#[tauri::command]
pub async fn cancel_transfer(state: tauri::State<'_, AppState>, tab_id: u32) -> Result<(), String> {
  let controls = state.transfer_controls.lock().map_err(|e| e.to_string())?;
  if let Some(list) = controls.get(&tab_id) {
    for ctrl in list {
      ctrl.cancelled.store(true, Ordering::SeqCst);
      ctrl.notify.notify_one();
    }
  }
  Ok(())
}

use super::*;
// ==================== Local Shell (Local Terminal) ====================

/// Pick the default local shell command for the current platform.
fn default_local_shell() -> (String, Vec<String>) {
  if cfg!(windows) {
    // Default to cmd.exe on Windows
    ("cmd.exe".to_string(), vec![])
  } else {
    let s = std::env::var("SHELL").unwrap_or_else(|_| "bash".to_string());
    (s, vec![])
  }
}

/// Resolve a shell specifier (preset name or arbitrary command/path) into a
/// (command, args) pair suitable for portable_pty's CommandBuilder.
fn resolve_local_shell(spec: &str) -> (String, Vec<String>) {
  match spec {
    // Git Bash: locate the executable on the common install paths.
    "gitbash" => {
      let candidates = [
        r"C:\Program Files\Git\bin\bash.exe",
        r"C:\Program Files (x86)\Git\bin\bash.exe",
        r"C:\Program Files\Git\usr\bin\bash.exe",
      ];
      for c in candidates {
        if std::path::Path::new(c).exists() {
          return (c.to_string(), vec!["--login".to_string()]);
        }
      }
      ("bash".to_string(), vec![])
    }
    // WSL: `wsl.exe` has no `--login` flag (that's a bash option). Run bash as
    // a login+interactive shell inside the distro instead.
    "wsl" => ("wsl.exe".to_string(), vec!["bash".to_string(), "-li".to_string()]),
    // Anything else (cmd, pwsh, powershell, bash, or an explicit path) is used as-is.
    other => (other.to_string(), vec![]),
  }
}

/// Open a local shell (PTY-backed local process) for the given tab.
#[tauri::command]
pub async fn open_local_shell(
  app: tauri::AppHandle,
  state: tauri::State<'_, AppState>,
  tab_id: u32,
  shell: Option<String>,
  cwd: Option<String>,
  reuse_existing: bool,
  cols: u32,
  rows: u32,
) -> Result<(), String> {
  // Reuse path: if a live local shell already exists for this tab (e.g. the
  // terminal was floated and is now remounting), keep it — no process restart.
  if reuse_existing {
    let live = {
      let mut shells = state.local_shells.lock().map_err(|e| e.to_string())?;
      if let Some(s) = shells.get_mut(&tab_id) {
        s.child.try_wait().map_or(false, |exited| exited.is_none())
      } else {
        false
      }
    };
    if live {
      eprintln!(
        "[open_local_shell] reusing live local shell for tab={}",
        tab_id
      );
      return Ok(());
    }
  }

  // Clear any stale output for this tab
  {
    if let Ok(mut buffers) = state.output_buffers.lock() {
      buffers.remove(&tab_id);
    }
  }

  // Remove any existing local shell for this tab
  {
    let mut shells = state.local_shells.lock().map_err(|e| e.to_string())?;
    shells.remove(&tab_id);
  }

  let shell_for_history = shell.clone();
  let (shell_cmd, shell_args) = match shell {
    // An empty spec means "use the default shell" (e.g. the default Local-Terminal entry).
    Some(s) if !s.trim().is_empty() => resolve_local_shell(&s),
    _ => default_local_shell(),
  };

  // Per-tab output queue owned by this LocalShell. The reader thread holds an
  // `Arc` clone and writes here, so it never reaches back into the global
  // `AppState` (which behaves unreliably from a plain `std::thread`).
  //
  // IMPORTANT: do NOT push any banner/status text into this queue. ConPTY syncs
  // the screen with *absolute* cursor positioning (CUP) and assumes the
  // terminal's top-left corner is its own buffer origin. Any line we write
  // before the shell's own output shifts xterm down by that many rows while
  // ConPTY keeps addressing row 0 — which is exactly why typed input used to
  // land on the line *above* the prompt. Status goes to stderr instead.
  let output = Arc::new(StdMutex::new(Vec::<String>::new()));
  // Sink for AI-issued commands; `None` while no AI command is in flight.
  // Owned here (not in `AppState`) for the same reason as `output`.
  let ai_capture = Arc::new(StdMutex::new(None::<String>));
  eprintln!("[open_local_shell] starting '{}' (tab={})", shell_cmd, tab_id);

  // Create the PTY at the actual terminal size up front. If the size is left at
  // the default 80x24, the shell lays out its prompt/wrapping using the wrong
  // width and (on Windows ConPTY in particular) typed input ends up on the line
  // above the prompt. The frontend passes the real cols/rows from xterm's fit.
  let initial_cols = if cols == 0 { 80u16 } else { cols as u16 };
  let initial_rows = if rows == 0 { 24u16 } else { rows as u16 };

  // Offload the blocking Win32 ConPTY calls (CreatePseudoConsole +
  // CreateProcess) to tokio's dedicated blocking thread pool so they never
  // tie up an async worker and stall other commands / UI updates.
  let shell_cmd_clone = shell_cmd.clone();
  let cwd_clone = cwd.clone();
  let (master, child) = tokio::task::spawn_blocking(
    move || -> Result<
      (
        Box<dyn portable_pty::MasterPty + Send>,
        Box<dyn portable_pty::Child + Send + Sync>,
      ),
      String,
    > {
      let pty_system = portable_pty::native_pty_system();
      let pair = pty_system
        .openpty(portable_pty::PtySize {
          rows: initial_rows,
          cols: initial_cols,
          pixel_width: 0,
          pixel_height: 0,
        })
        .map_err(|e| format!("Failed to open PTY: {}", e))?;

      let mut cmd = portable_pty::CommandBuilder::new(&shell_cmd_clone);
      if !shell_args.is_empty() {
        cmd.args(&shell_args);
      }
      // An empty cwd means "use the default working directory"…
      if let Some(ref dir) = cwd_clone {
        if !dir.trim().is_empty() {
          cmd.cwd(dir);
        }
      }
      cmd.env("TERM", "xterm-256color");

      let child = pair.slave.spawn_command(cmd).map_err(|e| {
        format!("Failed to spawn shell '{}': {}", shell_cmd_clone, e)
      })?;
      Ok((pair.master, child))
    },
  )
  .await
  .map_err(|e| format!("spawn_blocking join error: {}", e))??;



  // On some Windows builds ConPTY ignores the size passed to `openpty` and only
  // honors an explicit resize issued *after* the child is spawned. Without this,
  // cmd.exe lays out its prompt using the default 80x24 and typed input then
  // appears on the line above the prompt. Force the real size now.
  eprintln!(
    "[open_local_shell] opening PTY for {} at {}x{}",
    shell_cmd, initial_cols, initial_rows
  );
  let _ = master.resize(portable_pty::PtySize {
    rows: initial_rows,
    cols: initial_cols,
    pixel_width: 0,
    pixel_height: 0,
  });
  eprintln!(
    "[open_local_shell] spawned '{}' ok (tab={})",
    shell_cmd, tab_id
  );

  let mut reader = master
    .try_clone_reader()
    .map_err(|e| format!("Failed to clone PTY reader: {}", e))?;

  let writer = master
    .take_writer()
    .map_err(|e| format!("Failed to take PTY writer: {}", e))?;

  let session_id = state.next_session_id.fetch_add(1, Ordering::SeqCst);

  // Register the shell so input/resize/close can find it
  {
    let mut shells = state.local_shells.lock().map_err(|e| e.to_string())?;
    shells.insert(
      tab_id,
      LocalShell {
        tab_id,
        master,
        writer: Box::new(writer),
        child,
        session_id,
        cwd: cwd.clone(),
        output: output.clone(),
        ai_capture: ai_capture.clone(),
      },
    );
  }

  // Remember cwd in history (start of list, de-duplicated)
  {
    if let Some(ref dir) = cwd {
      if !dir.trim().is_empty() {
        record_local_shell_dir(&state, dir, shell_for_history.as_deref());
      }
    }
  }

  // Background reader thread: drain PTY output into this tab's own output queue.
  // We hold an `Arc` clone of `output`, so we never reach back into the global
  // `AppState` (which is unreliable from a plain `std::thread`). Each (re)open
  // creates a fresh `output` Arc, so a superseded thread simply writes to an
  // orphaned queue the frontend no longer reads from — no stale-data corruption.
  let reader_tab = tab_id;
  let reader_output = output.clone();
  let reader_ai_capture = ai_capture.clone();
  std::thread::spawn(move || {
    use std::io::Read;
    let mut buf = [0u8; 4096];
    loop {
      match reader.read(&mut buf) {
        Ok(0) => break, // EOF: process exited
        Ok(n) => {
          let chunk = String::from_utf8_lossy(&buf[..n]).to_string();
          // Tee a copy to the AI sink first (the chunk is moved into the
          // frontend queue below). Only active while an AI command runs.
          if let Ok(mut cap) = reader_ai_capture.lock() {
            if let Some(sink) = cap.as_mut() {
              sink.push_str(&chunk);
            }
          }
          if let Ok(mut q) = reader_output.lock() {
            q.push(chunk);
          }
        }
        Err(_) => break,
      }
    }
    // Process exited — drop the shell registration and notify the frontend.
    if let Some(state) = app.try_state::<AppState>() {
      if let Ok(mut shells) = state.local_shells.lock() {
        shells.remove(&reader_tab);
      }
    }
    let _ = app.emit(
      "connection-closed",
      serde_json::json!({ "tabId": reader_tab }),
    );
  });

  Ok(())
}

/// Send input to a local shell.
#[tauri::command]
pub async fn local_send_input(
  state: tauri::State<'_, AppState>,
  tab_id: u32,
  data: String,
) -> Result<bool, String> {
  let mut shells = state.local_shells.lock().map_err(|e| e.to_string())?;
  let shell = shells.get_mut(&tab_id).ok_or("Local shell not found")?;
  use std::io::Write;
  shell
    .writer
    .write_all(data.as_bytes())
    .map_err(|e| format!("Failed to write to local shell: {}", e))?;
  let _ = shell.writer.flush();
  Ok(true)
}

/// Resize a local shell PTY.
#[tauri::command]
pub async fn local_resize(
  state: tauri::State<'_, AppState>,
  tab_id: u32,
  cols: u32,
  rows: u32,
) -> Result<bool, String> {
  let shells = state.local_shells.lock().map_err(|e| e.to_string())?;
  let shell = shells.get(&tab_id).ok_or("Local shell not found")?;
  shell
    .master
    .resize(portable_pty::PtySize {
      rows: rows as u16,
      cols: cols as u16,
      pixel_width: 0,
      pixel_height: 0,
    })
    .map_err(|e| format!("PTY resize failed: {}", e))?;
  Ok(true)
}

/// Close a local shell and return its last working directory (if known).
#[tauri::command]
pub async fn local_close(
  state: tauri::State<'_, AppState>,
  tab_id: u32,
) -> Result<Option<String>, String> {
  let cwd = {
    let mut shells = state.local_shells.lock().map_err(|e| e.to_string())?;
    match shells.remove(&tab_id) {
      Some(mut sh) => {
        let _ = sh.child.kill();
        sh.cwd.clone()
      }
      None => None,
    }
  };
  if let Some(ref dir) = cwd {
    record_local_shell_dir(&state, dir, None);
  }
  Ok(cwd)
}

/// Get the recorded working-directory history for local shells.
#[tauri::command]
pub async fn get_local_shell_dirs(
  state: tauri::State<'_, AppState>,
) -> Result<Vec<LocalShellDir>, String> {
  let dirs = state.local_shell_dirs.lock().map_err(|e| e.to_string())?;
  Ok(dirs.clone())
}

/// Remove a single entry (or all entries) from the local-shell directory history.
#[tauri::command]
pub async fn clear_local_shell_dirs(
  state: tauri::State<'_, AppState>,
  path: Option<String>,
) -> Result<(), String> {
  let mut dirs = state.local_shell_dirs.lock().map_err(|e| e.to_string())?;
  match path {
    Some(p) => dirs.retain(|d| d.path != p),
    None => dirs.clear(),
  }
  Ok(())
}

/// Helper: insert/update a directory in the MRU history (max 20 entries).
fn record_local_shell_dir(state: &AppState, path: &str, shell: Option<&str>) {
  let mut dirs = match state.local_shell_dirs.lock() {
    Ok(d) => d,
    Err(_) => return,
  };
  if let Some(existing) = dirs.iter_mut().find(|d| d.path == path) {
    existing.last_used = now_ms();
    if shell.is_some() {
      existing.shell = shell.map(|s| s.to_string());
    }
  } else {
    dirs.push(LocalShellDir {
      path: path.to_string(),
      shell: shell.map(|s| s.to_string()),
      last_used: now_ms(),
    });
  }
  dirs.sort_by(|a, b| b.last_used.cmp(&a.last_used));
  dirs.truncate(20);
}
